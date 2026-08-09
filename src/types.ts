// Shared types between the yt-dlp wrapper, the in-memory job store, the API
// routes, and the client UI. Keep these JSON-serializable — job snapshots are
// sent to the browser verbatim over SSE.

/** A single track as resolved from a YouTube URL, before any download starts. */
export type Track = {
  id: string;
  title: string;
  /** Seconds. Undefined if yt-dlp couldn't determine it (e.g. a live stream). */
  duration: number | undefined;
  thumbnail: string | undefined;
  uploader: string | undefined;
};

export type ResolveResult =
  | { kind: "video"; track: Track }
  | {
      kind: "playlist";
      title: string;
      tracks: Track[];
      /** Entries yt-dlp reported but that are private/deleted/unavailable. */
      unavailableCount: number;
    };

export type TrackStatus =
  | "pending"
  | "downloading"
  | "converting"
  | "done"
  | "failed"
  | "canceled";

export type JobTrack = Track & {
  status: TrackStatus;
  /** 0-100. Only meaningful while status is "downloading". */
  pct: number;
  etaSeconds: number | undefined;
  error: string | undefined;
  /** Byte size of the finished mp3, once known. */
  fileSize: number | undefined;
};

export type JobStatus = "running" | "done" | "failed" | "canceled";

/** JSON-serializable snapshot of a job, as sent to the client over SSE. */
export type JobSnapshot = {
  id: string;
  kind: "video" | "playlist";
  title: string;
  status: JobStatus;
  tracks: JobTrack[];
  createdAt: number;
};
