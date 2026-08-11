import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { JobSnapshot, JobStatus, JobTrack } from "@/types";

// 30 minutes, matching the local/Docker deployment's sweep interval.
const TTL_SECONDS = 30 * 60;

let clientInstance: DynamoDBDocumentClient | undefined;

function client(): DynamoDBDocumentClient {
  if (!clientInstance) {
    clientInstance = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return clientInstance;
}

function tableName(): string {
  const name = process.env.JOBS_TABLE_NAME;
  if (!name) throw new Error("JOBS_TABLE_NAME is not set.");
  return name;
}

/**
 * The persisted shape. Deliberately doesn't store a top-level "status" —
 * it's derived from `tracks`/`canceled` at read time (see deriveStatus),
 * so concurrent per-track worker writes never race over a shared field.
 */
export type JobItem = {
  jobId: string;
  kind: "video" | "playlist";
  title: string;
  tracks: JobTrack[];
  canceled: boolean;
  createdAt: number;
  expiresAt: number;
};

function deriveStatus(item: Pick<JobItem, "tracks" | "canceled">): JobStatus {
  if (item.canceled) return "canceled";
  if (item.tracks.length > 0 && item.tracks.every((t) => t.status === "failed")) {
    return "failed";
  }
  if (
    item.tracks.some(
      (t) => t.status === "pending" || t.status === "downloading" || t.status === "converting",
    )
  ) {
    return "running";
  }
  return "done";
}

function toSnapshot(item: JobItem): JobSnapshot {
  return {
    id: item.jobId,
    kind: item.kind,
    title: item.title,
    status: deriveStatus(item),
    tracks: item.tracks,
    createdAt: item.createdAt,
  };
}

export async function putJob(
  jobId: string,
  kind: "video" | "playlist",
  title: string,
  tracks: JobTrack[],
): Promise<void> {
  const now = Date.now();
  const item: JobItem = {
    jobId,
    kind,
    title,
    tracks,
    canceled: false,
    createdAt: now,
    expiresAt: Math.floor(now / 1000) + TTL_SECONDS,
  };
  await client().send(new PutCommand({ TableName: tableName(), Item: item }));
}

export async function getJobItem(jobId: string): Promise<JobItem | undefined> {
  const res = await client().send(new GetCommand({ TableName: tableName(), Key: { jobId } }));
  return res.Item as JobItem | undefined;
}

export async function getSnapshot(jobId: string): Promise<JobSnapshot | undefined> {
  const item = await getJobItem(jobId);
  return item ? toSnapshot(item) : undefined;
}

const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === CONDITIONAL_CHECK_FAILED;
}

/**
 * Updates just the named fields of one track, addressed by its stable index
 * in the tracks list. Uses a targeted UpdateExpression (`tracks[i].field`)
 * rather than a read-modify-write of the whole item, so concurrent worker
 * invocations updating *different* tracks in the same job never clobber
 * each other.
 */
export async function updateTrack(
  jobId: string,
  index: number,
  patch: Partial<JobTrack>,
): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = entries.map(([key, value], i) => {
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    names[nameKey] = key;
    values[valueKey] = value;
    return `tracks[${index}].${nameKey} = ${valueKey}`;
  });

  try {
    await client().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { jobId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(jobId)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    // The job was deleted/expired out from under an in-flight worker —
    // nothing meaningful to update. Not an error worth surfacing.
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

export async function markCanceled(jobId: string): Promise<void> {
  try {
    await client().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { jobId },
        UpdateExpression: "SET canceled = :true",
        ConditionExpression: "attribute_exists(jobId)",
        ExpressionAttributeValues: { ":true": true },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

export async function isCanceled(jobId: string): Promise<boolean> {
  const item = await getJobItem(jobId);
  return item?.canceled ?? false;
}

export async function deleteJobItem(jobId: string): Promise<void> {
  await client().send(new DeleteCommand({ TableName: tableName(), Key: { jobId } }));
}
