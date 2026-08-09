import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeWith, createFakeChild, writeStderr, writeStdout } from "@/test/helpers";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { downloadTrack, isYoutubeUrl, resolve, YtdlpError } from "@/lib/ytdlp";

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  mockSpawn.mockReset();
  delete process.env.YTDLP_EXTRA_ARGS;
});

describe("isYoutubeUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://music.youtube.com/watch?v=abc",
    "http://youtube.com/watch?v=abc",
  ])("accepts %s", (url) => {
    expect(isYoutubeUrl(url)).toBe(true);
  });

  it.each([
    ["not a url at all", "garbage"],
    ["a lookalike host", "https://notyoutube.com/watch?v=abc"],
    ["a hyphenated lookalike host", "https://evil-youtube.com/watch?v=abc"],
    ["a spoofed subdomain suffix", "https://youtube.com.evil.com/watch?v=abc"],
    ["a non-http(s) scheme", "ftp://youtube.com/watch?v=abc"],
    ["a javascript: scheme", "javascript:alert(1)"],
    ["a file: scheme", "file:///etc/passwd"],
  ])("rejects %s", (_label, url) => {
    expect(isYoutubeUrl(url)).toBe(false);
  });
});

describe("resolve", () => {
  it("invokes yt-dlp with -J --flat-playlist and no extra options object", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);

    const promise = resolve("https://www.youtube.com/watch?v=abc");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe("yt-dlp");
    expect(args).toEqual([
      "-J",
      "--flat-playlist",
      "--no-warnings",
      "https://www.youtube.com/watch?v=abc",
    ]);
    expect(opts).toBeUndefined();

    writeStdout(child, JSON.stringify({ _type: "video", id: "abc", title: "T", duration: 1 }));
    closeWith(child, 0);
    await promise;
  });

  it("splices YTDLP_EXTRA_ARGS in before the url", async () => {
    process.env.YTDLP_EXTRA_ARGS = "--cookies-from-browser chrome";
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);

    const promise = resolve("https://www.youtube.com/watch?v=abc");
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual([
      "-J",
      "--flat-playlist",
      "--no-warnings",
      "--cookies-from-browser",
      "chrome",
      "https://www.youtube.com/watch?v=abc",
    ]);

    writeStdout(child, JSON.stringify({ _type: "video", id: "abc", title: "T", duration: 1 }));
    closeWith(child, 0);
    await promise;
  });

  it("parses a single-video result", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    writeStdout(
      child,
      JSON.stringify({
        _type: "video",
        id: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up",
        duration: 213,
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
        uploader: "Rick Astley",
        channel: "Rick Astley",
      }),
    );
    closeWith(child, 0);

    const result = await promise;
    expect(result).toEqual({
      kind: "video",
      track: {
        id: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up",
        duration: 213,
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
        uploader: "Rick Astley",
      },
    });
  });

  it("rejects a single unavailable video", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=xxx");

    writeStdout(child, JSON.stringify({ _type: "video", id: "xxx", title: "[Private video]" }));
    closeWith(child, 0);

    await expect(promise).rejects.toBeInstanceOf(YtdlpError);
  });

  it("parses a playlist, falling back to thumbnails[] and channel, and counts unavailable entries", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/playlist?list=abc");

    writeStdout(
      child,
      JSON.stringify({
        _type: "playlist",
        title: "Popular Music Videos",
        entries: [
          {
            _type: "url",
            id: "fOT0BUpITw8",
            title: "BELLAKEO",
            duration: 235,
            thumbnails: [
              { url: "https://example.com/small.jpg" },
              { url: "https://example.com/large.jpg" },
            ],
            channel: "Some Channel",
          },
          { _type: "url", id: "priv1", title: "[Private video]", duration: null },
          { _type: "url", id: "del1", title: "[Deleted video]", duration: null },
        ],
      }),
    );
    closeWith(child, 0);

    const result = await promise;
    expect(result).toEqual({
      kind: "playlist",
      title: "Popular Music Videos",
      tracks: [
        {
          id: "fOT0BUpITw8",
          title: "BELLAKEO",
          duration: 235,
          thumbnail: "https://example.com/large.jpg",
          uploader: "Some Channel",
        },
      ],
      unavailableCount: 2,
    });
  });

  it("throws a YtdlpError when yt-dlp output isn't valid JSON", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=abc");

    writeStdout(child, "not json");
    closeWith(child, 0);

    await expect(promise).rejects.toThrow(/unexpected output/i);
  });

  it("maps a bot-check stderr message to a friendly error", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=abc");

    writeStderr(child, "ERROR: Sign in to confirm you're not a bot\n");
    closeWith(child, 1);

    await expect(promise).rejects.toThrow(/YTDLP_EXTRA_ARGS/);
  });

  it("maps a private-video stderr message to a friendly error", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=abc");

    writeStderr(child, "ERROR: Private video. Sign in if you've been granted access\n");
    closeWith(child, 1);

    await expect(promise).rejects.toThrow(/private or unavailable/i);
  });

  it("falls back to a generic message for unrecognized stderr", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=abc");

    writeStderr(child, "ERROR: something totally unexpected\n");
    closeWith(child, 1);

    await expect(promise).rejects.toThrow("Failed to resolve that URL.");
  });

  it("keeps only the last 20 stderr lines", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const promise = resolve("https://www.youtube.com/watch?v=abc");

    for (let i = 1; i <= 25; i++) writeStderr(child, `line ${i}\n`);
    closeWith(child, 1);

    let error: YtdlpError | undefined;
    try {
      await promise;
    } catch (err) {
      error = err as YtdlpError;
    }
    expect(error).toBeInstanceOf(YtdlpError);
    const lines = error!.stderrTail.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 6");
    expect(lines[19]).toBe("line 25");
  });
});

describe("downloadTrack", () => {
  function start(signal = new AbortController().signal) {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as never);
    const onProgress = vi.fn();
    const promise = downloadTrack("videoId1", "/tmp/job", onProgress, signal);
    return { child, onProgress, promise };
  }

  it("builds the expected argv and passes signal/killSignal in the options", () => {
    start();
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe("yt-dlp");
    expect(args).toEqual(
      expect.arrayContaining([
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "-o",
        "/tmp/job/%(id)s.%(ext)s",
        "https://www.youtube.com/watch?v=videoId1",
      ]),
    );
    expect(opts).toMatchObject({ killSignal: "SIGKILL" });
    expect(opts).toHaveProperty("signal");
  });

  it("splices YTDLP_EXTRA_ARGS in before the url", () => {
    process.env.YTDLP_EXTRA_ARGS = "--cookies /cookies.txt";
    start();
    const [, args] = mockSpawn.mock.calls[0];
    const url = "https://www.youtube.com/watch?v=videoId1";
    expect(args.indexOf("--cookies")).toBeGreaterThan(-1);
    expect(args.indexOf("--cookies")).toBeLessThan(args.indexOf(url));
    expect(args[args.indexOf("--cookies") + 1]).toBe("/cookies.txt");
  });

  it("parses download progress, clamping pct at 100 and passing NA fields through as undefined", async () => {
    const { child, onProgress, promise } = start();

    writeStdout(child, "@P 500 1000 30\n");
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "downloading",
      pct: 50,
      etaSeconds: 30,
    });

    writeStdout(child, "@P 2000 1000 5\n");
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "downloading",
      pct: 100,
      etaSeconds: 5,
    });

    writeStdout(child, "@P NA NA NA\n");
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "downloading",
      pct: 0,
      etaSeconds: undefined,
    });

    writeStdout(child, "@C converting\n");
    expect(onProgress).toHaveBeenLastCalledWith({ phase: "converting" });

    closeWith(child, 0);
    await promise;
  });

  it("reassembles a progress line split across multiple stdout chunks", () => {
    const { child, onProgress } = start();

    writeStdout(child, "@P 500 ");
    expect(onProgress).not.toHaveBeenCalled();
    writeStdout(child, "1000 30\n");
    expect(onProgress).toHaveBeenCalledWith({
      phase: "downloading",
      pct: 50,
      etaSeconds: 30,
    });
  });

  it("resolves on exit code 0", async () => {
    const { child, promise } = start();
    closeWith(child, 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with a friendly error on a nonzero exit code", async () => {
    const { child, promise } = start();
    writeStderr(child, "ERROR: something broke\n");
    closeWith(child, 1);
    await expect(promise).rejects.toThrow("Download failed.");
  });

  it("rejects with 'Canceled.' if the signal is already aborted before spawning, without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const onProgress = vi.fn();
    const promise = downloadTrack("videoId1", "/tmp/job", onProgress, controller.signal);
    expect(mockSpawn).not.toHaveBeenCalled();
    await expect(promise).rejects.toThrow("Canceled.");
  });

  it("rejects with 'Canceled.' if the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const { child, promise } = start(controller.signal);
    controller.abort();
    // The real Node spawn({signal}) integration kills the process on abort,
    // which surfaces as a close event; simulate that here.
    closeWith(child, null);
    await expect(promise).rejects.toThrow("Canceled.");
  });

  it("rejects with the raw spawn error when the process never starts, unless already aborted", async () => {
    const { child, promise } = start();
    const spawnError = new Error("spawn ENOENT");
    child.emit("error", spawnError);
    await expect(promise).rejects.toBe(spawnError);
  });
});

afterEach(() => {
  delete process.env.YTDLP_EXTRA_ARGS;
});
