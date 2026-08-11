import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { contentDisposition } from "@/lib/format";

let clientInstance: S3Client | undefined;

function client(): S3Client {
  if (!clientInstance) clientInstance = new S3Client({});
  return clientInstance;
}

function bucketName(): string {
  const name = process.env.FILES_BUCKET_NAME;
  if (!name) throw new Error("FILES_BUCKET_NAME is not set.");
  return name;
}

function objectKey(jobId: string, videoId: string): string {
  return `jobs/${jobId}/${videoId}.mp3`;
}

/** Uploads a finished track's mp3 from local disk (the worker's /tmp) to S3. */
export async function uploadTrackFile(
  jobId: string,
  videoId: string,
  localPath: string,
): Promise<void> {
  const upload = new Upload({
    client: client(),
    params: {
      Bucket: bucketName(),
      Key: objectKey(jobId, videoId),
      Body: createReadStream(localPath),
      ContentType: "audio/mpeg",
    },
  });
  await upload.done();
}

/** A readable stream of one track's mp3, for feeding into a zip archive. */
export async function getObjectReadStream(jobId: string, videoId: string): Promise<Readable> {
  const res = await client().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: objectKey(jobId, videoId) }),
  );
  return res.Body as Readable;
}

/** A short-lived presigned URL for a single-file download, with the given filename. */
export async function getPresignedDownloadUrl(
  jobId: string,
  videoId: string,
  filename: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName(),
    Key: objectKey(jobId, videoId),
    ResponseContentDisposition: contentDisposition(filename),
    ResponseContentType: "audio/mpeg",
  });
  return getSignedUrl(client(), command, { expiresIn: 300 });
}

/** Removes every object under a job's prefix (used when a job is deleted). */
export async function deleteJobFiles(jobId: string): Promise<void> {
  const prefix = `jobs/${jobId}/`;
  const listed = await client().send(
    new ListObjectsV2Command({ Bucket: bucketName(), Prefix: prefix }),
  );
  const objects = (listed.Contents ?? [])
    .map((o) => o.Key)
    .filter((key): key is string => Boolean(key))
    .map((Key) => ({ Key }));
  if (objects.length === 0) return;
  await client().send(
    new DeleteObjectsCommand({ Bucket: bucketName(), Delete: { Objects: objects } }),
  );
}
