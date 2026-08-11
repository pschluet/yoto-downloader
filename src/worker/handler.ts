import { unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SQSEvent, SQSHandler, SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";
import { isCanceled, updateTrack } from "@/lib/db";
import { uploadTrackFile } from "@/lib/storage";
import { downloadTrack, YtdlpError, type DownloadProgress } from "@/lib/ytdlp";
import type { TrackMessage } from "@/lib/queue";

const MAX_AUTO_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackLocalPath(videoId: string): string {
  return path.join(tmpdir(), `${videoId}.mp3`);
}

/**
 * Processes one track message: runs the same auto-retry download loop the
 * local/Docker version ran in-process, but persists progress to DynamoDB
 * and uploads the result to S3 instead of mutating in-memory state.
 */
async function processTrack({ jobId, trackIndex, videoId }: TrackMessage): Promise<void> {
  if (await isCanceled(jobId)) {
    await updateTrack(jobId, trackIndex, { status: "canceled" });
    return;
  }

  const controller = new AbortController();

  for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
    if (await isCanceled(jobId)) {
      await updateTrack(jobId, trackIndex, { status: "canceled" });
      return;
    }

    await updateTrack(jobId, trackIndex, {
      status: "downloading",
      pct: 0,
      etaSeconds: undefined,
      error: undefined,
      attempts: attempt,
    });

    // downloadTrack's onProgress callback is synchronous (called straight
    // from the child process's stdout handler), so DynamoDB writes are
    // chained rather than awaited inline — but the chain IS awaited before
    // the final "done" write below, so a late-arriving progress update can
    // never land after (and clobber) the finished status.
    let progressChain: Promise<void> = Promise.resolve();
    const onProgress = (progress: DownloadProgress) => {
      progressChain = progressChain
        .then(() =>
          progress.phase === "downloading"
            ? updateTrack(jobId, trackIndex, {
                status: "downloading",
                pct: progress.pct,
                etaSeconds: progress.etaSeconds,
              })
            : updateTrack(jobId, trackIndex, { status: "converting" }),
        )
        .catch(() => {
          // Best-effort progress reporting; a dropped tick isn't fatal.
        });
    };

    try {
      await downloadTrack(videoId, tmpdir(), onProgress, controller.signal);
      await progressChain;

      const localPath = trackLocalPath(videoId);
      const info = await stat(localPath);
      await uploadTrackFile(jobId, videoId, localPath);
      await unlink(localPath).catch(() => {});

      await updateTrack(jobId, trackIndex, { status: "done", pct: 100, fileSize: info.size });
      return;
    } catch (err) {
      await progressChain;
      const message = err instanceof YtdlpError ? err.message : "Download failed.";
      await updateTrack(jobId, trackIndex, { status: "failed", error: message });
      if (attempt < MAX_AUTO_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as TrackMessage;
      await processTrack(message);
    } catch (err) {
      // An unexpected (not yt-dlp-reported) failure — e.g. a DynamoDB/S3
      // error — is worth retrying via SQS's own redelivery/DLQ mechanism,
      // separate from the download-level auto-retry inside processTrack.
      console.error("Failed to process track message:", record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
