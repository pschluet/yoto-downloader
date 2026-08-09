// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot, JobTrack, ResolveResult } from "@/types";
import Home from "./page";

// jsdom has no EventSource implementation; supply a controllable fake that
// the component's `new EventSource(url)` picks up via the global.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(snapshot: JobSnapshot) {
    this.onmessage?.({ data: JSON.stringify(snapshot) });
  }
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function makeTrack(overrides: Partial<JobTrack> & { id: string }): JobTrack {
  return {
    title: `Title ${overrides.id}`,
    duration: 100,
    thumbnail: undefined,
    uploader: undefined,
    status: "pending",
    pct: 0,
    etaSeconds: undefined,
    error: undefined,
    fileSize: undefined,
    attempts: 0,
    ...overrides,
  };
}

const playlistResult: ResolveResult = {
  kind: "playlist",
  title: "My Playlist",
  unavailableCount: 0,
  tracks: [
    { id: "a", title: "Track A", duration: 60, thumbnail: undefined, uploader: undefined },
    { id: "b", title: "Track B", duration: 60, thumbnail: undefined, uploader: undefined },
    { id: "c", title: "Track C", duration: 60, thumbnail: undefined, uploader: undefined },
  ],
};

/**
 * Track rows render a title but don't wrap their checkbox in a <label> (no
 * accessible name to query by), so scope by the row containing that title
 * instead of relying on getByRole's name matching.
 */
function trackRow(title: string) {
  return within(screen.getByText(title).closest("li")!);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function resolvePlaylist(user: ReturnType<typeof userEvent.setup>, result: ResolveResult) {
  fetchMock.mockImplementationOnce(async () => jsonResponse(result));
  render(<Home />);
  await user.type(screen.getByPlaceholderText(/watch\?v=/i), "https://www.youtube.com/playlist?list=x");
  await user.click(screen.getByRole("button", { name: /resolve/i }));
  await screen.findByText("My Playlist");
}

describe("resolve", () => {
  it("shows the server's error message when resolving fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "That doesn't look like a YouTube URL." }, false));
    render(<Home />);

    // The <input type="url"> only lets syntactically-valid URLs submit at
    // all (jsdom enforces this the same as a real browser); the "is this
    // actually a YouTube link" check happens server-side.
    await user.type(screen.getByPlaceholderText(/watch\?v=/i), "https://example.com");
    await user.click(screen.getByRole("button", { name: /resolve/i }));

    expect(await screen.findByText("That doesn't look like a YouTube URL.")).toBeInTheDocument();
  });

  it("renders one row per track, all selected by default", async () => {
    const user = userEvent.setup();
    await resolvePlaylist(user, playlistResult);

    for (const title of ["Track A", "Track B", "Track C"]) {
      expect(trackRow(title).getByRole("checkbox")).toBeChecked();
    }
  });
});

describe("select all", () => {
  it("is indeterminate when only some tracks are selected, and re-selects all when clicked", async () => {
    const user = userEvent.setup();
    await resolvePlaylist(user, playlistResult);

    const selectAll = screen.getByRole("checkbox", { name: /select all|deselect all/i });
    expect(selectAll).toBeChecked();
    expect((selectAll as HTMLInputElement).indeterminate).toBe(false);

    await user.click(trackRow("Track A").getByRole("checkbox"));

    expect((selectAll as HTMLInputElement).indeterminate).toBe(true);

    await user.click(selectAll);

    expect((selectAll as HTMLInputElement).indeterminate).toBe(false);
    for (const title of ["Track A", "Track B", "Track C"]) {
      expect(trackRow(title).getByRole("checkbox")).toBeChecked();
    }
  });

  it("clears all selections when clicked while everything is selected", async () => {
    const user = userEvent.setup();
    await resolvePlaylist(user, playlistResult);

    await user.click(screen.getByRole("checkbox", { name: /select all|deselect all/i }));

    for (const title of ["Track A", "Track B", "Track C"]) {
      expect(trackRow(title).getByRole("checkbox")).not.toBeChecked();
    }
  });
});

describe("starting a download", () => {
  it("posts only the checked tracks", async () => {
    const user = userEvent.setup();
    await resolvePlaylist(user, playlistResult);

    await user.click(trackRow("Track B").getByRole("checkbox"));
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobId: "job-1" }));

    await user.click(screen.getByRole("button", { name: /download 2 tracks as mp3/i }));

    const jobsCall = fetchMock.mock.calls.find(([url]) => url === "/api/jobs");
    expect(jobsCall).toBeDefined();
    const body = JSON.parse(jobsCall![1].body);
    expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(["a", "c"]);
  });
});

describe("live progress", () => {
  async function startJob(user: ReturnType<typeof userEvent.setup>) {
    await resolvePlaylist(user, playlistResult);
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobId: "job-1" }));
    await user.click(screen.getByRole("button", { name: /download 3 tracks as mp3/i }));
    // `job` state (and thus the JobPanel heading) is only set once the fake
    // EventSource emits its first snapshot, which the test does manually
    // below — so wait on the EventSource's construction, not on any text.
    const es = await vi.waitFor(() => {
      const instance = FakeEventSource.instances.at(-1);
      if (!instance) throw new Error("EventSource not constructed yet");
      return instance;
    });
    expect(es.url).toBe("/api/jobs/job-1/events");
    return es;
  }

  it("renders per-row status and the n / total counter from SSE snapshots", async () => {
    const user = userEvent.setup();
    const es = await startJob(user);

    es.emit({
      id: "job-1",
      kind: "playlist",
      title: "My Playlist",
      status: "running",
      createdAt: 0,
      tracks: [
        makeTrack({ id: "a", status: "done" }),
        makeTrack({ id: "b", status: "downloading", pct: 40 }),
        makeTrack({ id: "c", status: "pending" }),
      ],
    });

    expect(await screen.findByText("1 / 3 complete")).toBeInTheDocument();
    expect(screen.getByText("Waiting…")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("shows a Retry button only on failed rows, and it posts the retry endpoint", async () => {
    const user = userEvent.setup();
    const es = await startJob(user);

    es.emit({
      id: "job-1",
      kind: "playlist",
      title: "My Playlist",
      status: "done",
      createdAt: 0,
      tracks: [
        makeTrack({ id: "a", status: "done" }),
        makeTrack({ id: "b", status: "failed", error: "boom" }),
        makeTrack({ id: "c", status: "done" }),
      ],
    });

    await screen.findByText("boom");
    const retryButtons = screen.getAllByRole("button", { name: /retry/i });
    expect(retryButtons).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await user.click(retryButtons[0]);

    const retryCall = fetchMock.mock.calls.find(([url]) => url === "/api/jobs/job-1/tracks/b/retry");
    expect(retryCall).toBeDefined();
    expect(retryCall![1].method).toBe("POST");
  });

  it("does not show a Retry button, and shows a download link, for a done row", async () => {
    const user = userEvent.setup();
    const es = await startJob(user);

    es.emit({
      id: "job-1",
      kind: "playlist",
      title: "My Playlist",
      status: "done",
      createdAt: 0,
      tracks: [
        makeTrack({ id: "a", status: "done", fileSize: 1024 }),
        makeTrack({ id: "b", status: "done", fileSize: 2048 }),
        makeTrack({ id: "c", status: "done", fileSize: 4096 }),
      ],
    });

    await screen.findByText("3 / 3 complete");
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download zip \(3 files\)/i })).toHaveAttribute(
      "href",
      "/api/jobs/job-1/download",
    );
  });
});
