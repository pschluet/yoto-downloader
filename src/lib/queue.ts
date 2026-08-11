import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

let clientInstance: SQSClient | undefined;

function client(): SQSClient {
  if (!clientInstance) clientInstance = new SQSClient({});
  return clientInstance;
}

function queueUrl(): string {
  const url = process.env.TRACKS_QUEUE_URL;
  if (!url) throw new Error("TRACKS_QUEUE_URL is not set.");
  return url;
}

/** One message per track: tells the worker Lambda which track to (re)download. */
export type TrackMessage = {
  jobId: string;
  trackIndex: number;
  videoId: string;
};

export async function enqueueTrack(message: TrackMessage): Promise<void> {
  await client().send(
    new SendMessageCommand({
      QueueUrl: queueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}
