import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let clientInstance: S3Client | undefined;

function client(): S3Client {
  if (!clientInstance) clientInstance = new S3Client({});
  return clientInstance;
}

/**
 * Unlike storage.ts's bucketName(), this returns undefined rather than
 * throwing: a missing bucket just means "no cookies configured" (e.g. a
 * local/docker run with no S3 at all), not a broken download.
 */
function bucketName(): string | undefined {
  return process.env.FILES_BUCKET_NAME || undefined;
}

/**
 * Single object holding the admin-uploaded YouTube cookies.txt. Deliberately
 * outside jobs/ — the FilesBucket's lifecycle rule (infra/lib/data-stack.ts)
 * expires jobs/* after a day but must never touch this key.
 */
export const COOKIES_S3_KEY = "config/cookies.txt";

export const MAX_COOKIES_BYTES = 512 * 1024;

export type CookieStatus = {
  present: boolean;
  lastModified: string | null;
  size: number | null;
  uploadedBy: string | null;
};

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "NotFound" || name === "NoSuchKey";
}

/** Whether an admin-managed cookies.txt exists, and metadata about it — never the contents. */
export async function getCookieStatus(): Promise<CookieStatus> {
  const bucket = bucketName();
  if (!bucket) return { present: false, lastModified: null, size: null, uploadedBy: null };
  try {
    const res = await client().send(
      new HeadObjectCommand({ Bucket: bucket, Key: COOKIES_S3_KEY }),
    );
    return {
      present: true,
      lastModified: res.LastModified?.toISOString() ?? null,
      size: res.ContentLength ?? null,
      uploadedBy: res.Metadata?.["uploaded-by"] ?? null,
    };
  } catch (err) {
    if (isNotFound(err)) return { present: false, lastModified: null, size: null, uploadedBy: null };
    throw err;
  }
}

export async function putCookies(contents: string, uploadedBy: string): Promise<void> {
  const bucket = bucketName();
  if (!bucket) throw new Error("FILES_BUCKET_NAME is not set.");
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: COOKIES_S3_KEY,
      Body: contents,
      ContentType: "text/plain",
      Metadata: { "uploaded-by": uploadedBy },
    }),
  );
}

export async function deleteCookies(): Promise<void> {
  const bucket = bucketName();
  if (!bucket) return;
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: COOKIES_S3_KEY }));
}

const NETSCAPE_HEADER = "# Netscape HTTP Cookie File";
const YOUTUBE_DOMAIN_RE = /(^|\.)youtube\.com$|(^|\.)google\.com$/i;

function stripHttpOnlyPrefix(domain: string): string {
  return domain.replace(/^#HttpOnly_/, "");
}

/**
 * Returns an error message if `contents` doesn't look like a valid Netscape
 * cookie jar, or undefined if it looks fine. Netscape format is 7
 * tab-separated fields per line: domain, includeSubdomains, path, secure,
 * expires, name, value. Browser cookie-export extensions also emit
 * `#HttpOnly_`-prefixed domains for HttpOnly cookies — those are real data
 * lines, not comments, and must be treated as such.
 */
export function validateNetscapeCookies(contents: string): string | undefined {
  const lines = contents
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const dataLines = lines.filter((l) => !l.startsWith("#") || l.startsWith("#HttpOnly_"));

  if (dataLines.length === 0) {
    return "No cookies found. Export a cookies.txt from a real, signed-in YouTube session.";
  }

  let hasYoutubeDomain = false;
  for (const line of dataLines) {
    const fields = line.split("\t");
    if (fields.length !== 7) {
      return (
        "Lines must be tab-separated (7 fields). If you pasted from a viewer that " +
        'turned tabs into spaces, use "Choose file" instead.'
      );
    }
    const [domain, includeSubdomains, , secure, expires] = fields;
    if (includeSubdomains !== "TRUE" && includeSubdomains !== "FALSE") {
      return 'Invalid cookie line: the "include subdomains" field must be TRUE or FALSE.';
    }
    if (secure !== "TRUE" && secure !== "FALSE") {
      return 'Invalid cookie line: the "secure" field must be TRUE or FALSE.';
    }
    if (!/^-?\d+$/.test(expires)) {
      return "Invalid cookie line: the expiry field must be a number.";
    }
    if (YOUTUBE_DOMAIN_RE.test(stripHttpOnlyPrefix(domain))) {
      hasYoutubeDomain = true;
    }
  }

  if (!hasYoutubeDomain) {
    return (
      "No youtube.com or google.com cookies found in this file — make sure you " +
      "exported it while signed in to YouTube."
    );
  }

  return undefined;
}

/**
 * Normalizes line endings and ensures the Netscape magic header is present —
 * yt-dlp's cookie-jar loader requires it and errors out without it.
 */
export function normalizeCookies(contents: string): string {
  const normalized = contents.replace(/\r\n/g, "\n");
  return normalized.trimStart().startsWith(NETSCAPE_HEADER)
    ? normalized
    : `${NETSCAPE_HEADER}\n${normalized}`;
}

type CookieBlob = { contents: string | null };

// Present, or definitively absent (NoSuchKey): cheap to hold onto for a
// minute. A transient/access-denied failure gets a short TTL so it heals
// fast once the underlying problem (e.g. a not-yet-deployed IAM grant) clears.
const OK_TTL_MS = 60_000;
const ERROR_TTL_MS = 5_000;

let cached: { promise: Promise<CookieBlob>; expiresAt: number } | undefined;

async function loadCookies(): Promise<{ blob: CookieBlob; ttlMs: number }> {
  const bucket = bucketName();
  if (!bucket) return { blob: { contents: null }, ttlMs: OK_TTL_MS };
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: COOKIES_S3_KEY }));
    const contents = await res.Body?.transformToString("utf8");
    return { blob: { contents: contents ?? null }, ttlMs: OK_TTL_MS };
  } catch (err) {
    if (isNotFound(err)) return { blob: { contents: null }, ttlMs: OK_TTL_MS };
    // Notably covers AccessDenied before the worker's config/* read grant has
    // deployed — degrade to "no cookies" rather than fail every download.
    console.warn("Failed to load YouTube cookies from S3:", err);
    return { blob: { contents: null }, ttlMs: ERROR_TTL_MS };
  }
}

function cookieBlob(): Promise<CookieBlob> {
  if (cached && Date.now() < cached.expiresAt) return cached.promise;
  // expiresAt starts at +Infinity so a second caller that arrives while the
  // fetch is still in flight shares this same promise instead of firing a
  // second GetObject.
  const entry: { promise: Promise<CookieBlob>; expiresAt: number } = {
    promise: undefined as unknown as Promise<CookieBlob>,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  entry.promise = loadCookies().then(({ blob, ttlMs }) => {
    entry.expiresAt = Date.now() + ttlMs;
    return blob;
  });
  cached = entry;
  return entry.promise;
}

/**
 * Drops the in-memory cache so the next call re-reads S3 — call this right
 * after an admin uploads/removes cookies, and before retrying a download
 * that just hit YouTube's bot check (see src/worker/handler.ts).
 */
export function invalidateCookies(): void {
  cached = undefined;
}

/**
 * Materializes the admin-uploaded cookie jar to a throwaway /tmp file, runs
 * `fn` with the yt-dlp args for it, and always deletes the file afterwards.
 * Calls fn([]) when no cookies are configured — yt-dlp must still run.
 *
 * yt-dlp rewrites the cookie jar on exit, so every run gets its own copy: a
 * shared path would let two concurrent runs corrupt each other's file, and
 * there's nowhere to persist a refreshed jar back to anyway (re-upload when
 * YouTube's bot check reappears).
 */
export async function withCookieArgs<T>(fn: (args: string[]) => Promise<T>): Promise<T> {
  const { contents } = await cookieBlob();
  if (!contents) return fn([]);

  const file = path.join(tmpdir(), `yt-cookies-${randomUUID()}.txt`);
  await writeFile(file, contents, { mode: 0o600 });
  try {
    return await fn(["--cookies", file]);
  } finally {
    await unlink(file).catch(() => {});
  }
}
