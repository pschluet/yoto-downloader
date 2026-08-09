"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatDuration } from "@/lib/format";
import type { JobSnapshot, JobTrack, ResolveResult, Track } from "@/types";

type Stage = "input" | "resolved" | "job";

export default function Home() {
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("input");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const tracks: Track[] = useMemo(() => {
    if (!resolved) return [];
    return resolved.kind === "video" ? [resolved.track] : resolved.tracks;
  }, [resolved]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && selected.size < tracks.length;
    }
  }, [selected, tracks.length]);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  // Close any open SSE connection when the component unmounts.
  useEffect(() => closeStream, [closeStream]);

  function subscribeToJob(jobId: string) {
    closeStream();
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    esRef.current = es;
    es.onmessage = (event) => {
      const snapshot: JobSnapshot = JSON.parse(event.data);
      setJob(snapshot);
      if (snapshot.status !== "running") {
        es.close();
        esRef.current = null;
      }
    };
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setResolving(true);
    setResolveError(null);
    setResolved(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to resolve that URL.");
      const result = data as ResolveResult;
      setResolved(result);
      const ids = result.kind === "video" ? [result.track.id] : result.tracks.map((t) => t.id);
      setSelected(new Set(ids));
      setStage("resolved");
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to resolve that URL.");
    } finally {
      setResolving(false);
    }
  }

  function toggleTrack(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === tracks.length ? new Set() : new Set(tracks.map((t) => t.id)),
    );
  }

  async function startDownload() {
    if (!resolved || selected.size === 0) return;
    setStarting(true);
    setActionError(null);
    try {
      const selectedTracks = tracks.filter((t) => selected.has(t.id));
      const title =
        resolved.kind === "playlist" ? resolved.title : selectedTracks[0]?.title ?? "Download";
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: resolved.kind, title, tracks: selectedTracks }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start download.");
      setStage("job");
      subscribeToJob(data.jobId as string);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start download.");
    } finally {
      setStarting(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    closeStream();
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
    setJob((prev) => (prev ? { ...prev, status: "canceled" } : prev));
  }

  async function retryTrack(trackId: string) {
    if (!job) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/tracks/${trackId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to retry that track.");
      // The job may have already reached a terminal state and closed its SSE
      // connection; re-subscribe so we see this track's retry progress.
      subscribeToJob(job.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to retry that track.");
    }
  }

  function startOver() {
    closeStream();
    if (job) void fetch(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
    setJob(null);
    setResolved(null);
    setResolveError(null);
    setActionError(null);
    setUrl("");
    setStage("input");
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">YouTube → MP3</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Paste a playlist or single video link to download the audio as MP3.
          </p>
        </header>

        <form onSubmit={handleResolve} className="flex gap-2">
          <input
            type="url"
            required
            placeholder="https://www.youtube.com/watch?v=... or /playlist?list=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={resolving || stage === "job"}
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={resolving || !url.trim() || stage === "job"}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
        </form>
        {resolveError && <p className="text-sm text-red-400">{resolveError}</p>}

        {resolved && stage !== "job" && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-medium">
                  {resolved.kind === "playlist" ? resolved.title : "Single video"}
                </h2>
                <p className="text-xs text-zinc-500">
                  {tracks.length} track{tracks.length === 1 ? "" : "s"}
                  {resolved.kind === "playlist" && resolved.unavailableCount > 0 && (
                    <> · {resolved.unavailableCount} unavailable (skipped)</>
                  )}
                </p>
              </div>
              {tracks.length > 1 && (
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={tracks.length > 0 && selected.size === tracks.length}
                    onChange={toggleAll}
                    className="size-3.5 accent-zinc-300"
                  />
                  {selected.size === tracks.length ? "Deselect all" : "Select all"}
                </label>
              )}
            </div>

            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
              {tracks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-zinc-900">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggleTrack(t.id)}
                    className="size-4 accent-zinc-300"
                  />
                  {t.thumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.thumbnail} alt="" className="h-9 w-16 rounded object-cover" />
                  )}
                  <div className="flex-1 truncate">
                    <p className="truncate text-sm">{t.title}</p>
                    {t.uploader && <p className="truncate text-xs text-zinc-500">{t.uploader}</p>}
                  </div>
                  <span className="text-xs tabular-nums text-zinc-500">{formatDuration(t.duration)}</span>
                </li>
              ))}
            </ul>

            <button
              onClick={startDownload}
              disabled={starting || selected.size === 0}
              className="self-start rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              {starting
                ? "Starting…"
                : `Download ${selected.size} track${selected.size === 1 ? "" : "s"} as MP3`}
            </button>
          </section>
        )}

        {actionError && <p className="text-sm text-red-400">{actionError}</p>}

        {job && (
          <JobPanel job={job} onCancel={cancelJob} onStartOver={startOver} onRetryTrack={retryTrack} />
        )}
      </div>
    </main>
  );
}

function JobPanel({
  job,
  onCancel,
  onStartOver,
  onRetryTrack,
}: {
  job: JobSnapshot;
  onCancel: () => void;
  onStartOver: () => void;
  onRetryTrack: (trackId: string) => void;
}) {
  const total = job.tracks.length;
  const doneCount = job.tracks.filter((t) => t.status === "done").length;
  const failedCount = job.tracks.filter((t) => t.status === "failed").length;
  const isRunning = job.status === "running";
  const canDownload = doneCount > 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium">{job.title}</h2>
          <p className="text-xs text-zinc-500">
            {doneCount} / {total} complete
            {failedCount > 0 && <> · {failedCount} failed</>}
            {job.status === "canceled" && <> · canceled</>}
          </p>
        </div>
        {isRunning ? (
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onStartOver}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
          >
            Start over
          </button>
        )}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
        />
      </div>

      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
        {job.tracks.map((t) => (
          <TrackRow key={t.id} jobId={job.id} track={t} onRetry={onRetryTrack} />
        ))}
      </ul>

      {canDownload && (
        <a
          href={`/api/jobs/${job.id}/download`}
          className="self-start rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400"
        >
          {job.kind === "video"
            ? "Download MP3"
            : `Download ZIP (${doneCount} file${doneCount === 1 ? "" : "s"})`}
        </a>
      )}
    </section>
  );
}

function TrackRow({
  jobId,
  track,
  onRetry,
}: {
  jobId: string;
  track: JobTrack;
  onRetry: (trackId: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded px-2 py-1.5">
      {track.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={track.thumbnail} alt="" className="h-9 w-16 rounded object-cover" />
      )}
      <div className="flex-1 truncate">
        <p className="truncate text-sm">{track.title}</p>
        <StatusLine track={track} />
      </div>
      {track.status === "done" ? (
        <a
          href={`/api/jobs/${jobId}/file/${track.id}`}
          className="text-xs text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200"
        >
          {formatBytes(track.fileSize) || "download"}
        </a>
      ) : track.status === "failed" ? (
        <button
          onClick={() => onRetry(track.id)}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
        >
          Retry
        </button>
      ) : (
        <span className="text-xs tabular-nums text-zinc-500">{formatDuration(track.duration)}</span>
      )}
    </li>
  );
}

function StatusLine({ track }: { track: JobTrack }) {
  switch (track.status) {
    case "pending":
      return <p className="text-xs text-zinc-500">Waiting…</p>;
    case "downloading":
      return (
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 w-24 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-sky-500 transition-all"
              style={{ width: `${Math.max(2, track.pct)}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-zinc-500">
            {track.pct.toFixed(0)}%
            {track.etaSeconds != null && ` · ${formatDuration(track.etaSeconds)} left`}
            {track.attempts > 1 && ` · retry ${track.attempts}`}
          </span>
        </div>
      );
    case "converting":
      return (
        <p className="text-xs text-sky-400">
          Converting to MP3…{track.attempts > 1 && ` (retry ${track.attempts})`}
        </p>
      );
    case "done":
      return <p className="text-xs text-emerald-400">Done</p>;
    case "failed":
      return <p className="truncate text-xs text-red-400">{track.error ?? "Failed"}</p>;
    case "canceled":
      return <p className="text-xs text-zinc-500">Canceled</p>;
  }
}
