import { spawn } from "node:child_process";
import { withCookieArgs } from "@/lib/cookies";
import type { ResolveResult, Track } from "@/types";

const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";

/** Extra CLI args appended to every yt-dlp invocation, e.g. for cookies:
 *  YTDLP_EXTRA_ARGS="--cookies-from-browser chrome" */
function extraArgs(): string[] {
  const raw = process.env.YTDLP_EXTRA_ARGS;
  if (!raw) return [];
  // Simple whitespace split is enough for the flag-based args people set here.
  return raw.split(/\s+/).filter(Boolean);
}

// A locally-set --cookies/--cookies-from-browser (e.g. docker-compose's mounted
// cookies.txt) always wins over the admin-managed S3 copy — this keeps the
// local/docker flow byte-identical and avoids ever passing both flags to yt-dlp.
const COOKIE_OVERRIDE_RE = /(^|\s)--cookies(-from-browser)?(\s|=|$)/;
function hasLocalCookieOverride(): boolean {
  return COOKIE_OVERRIDE_RE.test(process.env.YTDLP_EXTRA_ARGS ?? "");
}

/** Runs `fn` with the yt-dlp cookie args to use: the admin-managed S3 cookie
 *  jar (see src/lib/cookies.ts), or none if a local override is set. */
function withYtdlpCookieArgs<T>(fn: (args: string[]) => Promise<T>): Promise<T> {
  return hasLocalCookieOverride() ? fn([]) : withCookieArgs(fn);
}

const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)music\.youtube\.com$/i;

export function isYoutubeUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return (u.protocol === "http:" || u.protocol === "https:") && YOUTUBE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

export class YtdlpError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
    /** True for YouTube's "confirm you're not a bot" challenge — lets callers
     *  react (e.g. drop cached cookies before retrying) without string-matching. */
    public readonly botCheck = false,
  ) {
    super(message);
    this.name = "YtdlpError";
  }
}

function friendlyError(stderrTail: string, fallback: string): YtdlpError {
  if (/sign in to confirm you.?re not a bot/i.test(stderrTail)) {
    return new YtdlpError(
      "YouTube is asking to confirm you're not a bot. An admin needs to upload " +
        "fresh YouTube cookies on the Admin page.",
      stderrTail,
      true,
    );
  }
  if (/private video|video unavailable|this video is unavailable/i.test(stderrTail)) {
    return new YtdlpError("This video is private or unavailable.", stderrTail);
  }
  return new YtdlpError(fallback, stderrTail);
}

const STDERR_TAIL_LINES = 20;

function pushTail(tail: string[], chunk: string) {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    tail.push(line);
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
  }
}

/** Resolve a YouTube URL (video or playlist) into track metadata, without downloading. */
export async function resolve(url: string): Promise<ResolveResult> {
  return withYtdlpCookieArgs(async (cookieArgs) => {
    const args = ["-J", "--flat-playlist", "--no-warnings", ...cookieArgs, ...extraArgs(), url];

    const stdout: Buffer[] = [];
    const stderrTail: string[] = [];

    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      // turbopackIgnore: this is a PATH lookup for an external binary, not a
      // project file — tracing it would pull the whole repo into the bundle.
      const child = spawn(/* turbopackIgnore: true */ YTDLP_BIN, args);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => pushTail(stderrTail, chunk.toString("utf8")));
      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolvePromise(code ?? 1));
    });

    if (exitCode !== 0) {
      throw friendlyError(stderrTail.join("\n"), "Failed to resolve that URL.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch {
      throw new YtdlpError("yt-dlp returned unexpected output.", stderrTail.join("\n"));
    }

    return toResolveResult(parsed);
  });
}

type RawEntry = {
  id?: string;
  title?: string;
  duration?: number | null;
  thumbnail?: string;
  thumbnails?: { url: string }[];
  uploader?: string;
  channel?: string;
};

type RawInfo = RawEntry & {
  _type?: string;
  entries?: RawEntry[];
};

function pickThumbnail(entry: RawEntry): string | undefined {
  if (entry.thumbnail) return entry.thumbnail;
  const thumbs = entry.thumbnails;
  if (thumbs && thumbs.length > 0) return thumbs[thumbs.length - 1].url;
  return undefined;
}

const UNAVAILABLE_TITLE_RE = /^\[(private|deleted|unavailable) video\]$/i;

function toTrack(entry: RawEntry): Track | undefined {
  if (!entry.id || !entry.title || UNAVAILABLE_TITLE_RE.test(entry.title)) return undefined;
  return {
    id: entry.id,
    title: entry.title,
    duration: entry.duration ?? undefined,
    thumbnail: pickThumbnail(entry),
    uploader: entry.uploader ?? entry.channel ?? undefined,
  };
}

function toResolveResult(parsed: unknown): ResolveResult {
  const info = parsed as RawInfo;

  if (info._type === "playlist" || Array.isArray(info.entries)) {
    const rawEntries = info.entries ?? [];
    const tracks: Track[] = [];
    let unavailableCount = 0;
    for (const entry of rawEntries) {
      const track = toTrack(entry);
      if (track) tracks.push(track);
      else unavailableCount++;
    }
    return {
      kind: "playlist",
      title: info.title || "Playlist",
      tracks,
      unavailableCount,
    };
  }

  const track = toTrack(info);
  if (!track) {
    throw new YtdlpError("That video is private or unavailable.", "");
  }
  return { kind: "video", track };
}

export type DownloadProgress =
  | { phase: "downloading"; pct: number; etaSeconds: number | undefined }
  | { phase: "converting" };

/**
 * Download+extract a single video's audio to `<tmpDir>/<videoId>.mp3`, embedding
 * metadata and cover art. One yt-dlp process per track keeps progress reporting
 * and failure isolation unambiguous.
 */
export async function downloadTrack(
  videoId: string,
  tmpDir: string,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  // Checked here too (before ever touching S3 for cookies), not just inside
  // the promise executor below — an already-canceled download shouldn't cost
  // a cookie fetch.
  if (signal.aborted) {
    throw new YtdlpError("Canceled.", "");
  }

  return withYtdlpCookieArgs(
    (cookieArgs) =>
      new Promise<void>((resolvePromise, reject) => {
        if (signal.aborted) {
          reject(new YtdlpError("Canceled.", ""));
          return;
        }

        const args = [
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0",
          "--embed-metadata",
          "--embed-thumbnail",
          "--no-playlist",
          "--no-part",
          "--no-warnings",
          "-o",
          `${tmpDir}/%(id)s.%(ext)s`,
          "--newline",
          "--progress-delta",
          "0.5",
          "--progress-template",
          "download:@P %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s %(progress.eta)s",
          "--progress-template",
          "postprocess:@C %(progress.status)s",
          ...cookieArgs,
          ...extraArgs(),
          `https://www.youtube.com/watch?v=${videoId}`,
        ];

        const child = spawn(/* turbopackIgnore: true */ YTDLP_BIN, args, {
          signal,
          killSignal: "SIGKILL",
        });
        const stderrTail: string[] = [];
        let stdoutRemainder = "";

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutRemainder += chunk.toString("utf8");
          const lines = stdoutRemainder.split("\n");
          stdoutRemainder = lines.pop() ?? "";
          for (const line of lines) handleProgressLine(line, onProgress);
        });

        child.stderr.on("data", (chunk: Buffer) => pushTail(stderrTail, chunk.toString("utf8")));

        child.on("error", (err) => {
          if (signal.aborted) reject(new YtdlpError("Canceled.", ""));
          else reject(err);
        });

        child.on("close", (code) => {
          if (signal.aborted) {
            reject(new YtdlpError("Canceled.", ""));
          } else if (code === 0) {
            resolvePromise();
          } else {
            reject(friendlyError(stderrTail.join("\n"), "Download failed."));
          }
        });
      }),
  );
}

function handleProgressLine(
  line: string,
  onProgress: (progress: DownloadProgress) => void,
) {
  if (line.startsWith("@P ")) {
    const [, downloaded, total, eta] = line.split(" ");
    const downloadedBytes = Number(downloaded);
    const totalBytes = Number(total);
    const pct =
      Number.isFinite(downloadedBytes) && Number.isFinite(totalBytes) && totalBytes > 0
        ? Math.min(100, (downloadedBytes / totalBytes) * 100)
        : 0;
    const etaSeconds = Number(eta);
    onProgress({
      phase: "downloading",
      pct,
      etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : undefined,
    });
  } else if (line.startsWith("@C ")) {
    onProgress({ phase: "converting" });
  }
}
