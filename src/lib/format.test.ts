import { describe, expect, it } from "vitest";
import {
  contentDisposition,
  dedupeFilenames,
  formatBytes,
  formatDuration,
  sanitizeFilename,
} from "@/lib/format";

describe("formatDuration", () => {
  it("formats sub-hour durations as mm:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("formats hour-plus durations as h:mm:ss", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(7325)).toBe("2:02:05");
  });

  it("rounds fractional seconds", () => {
    expect(formatDuration(59.6)).toBe("1:00");
  });

  it("falls back to --:-- for missing or non-finite input", () => {
    expect(formatDuration(undefined)).toBe("--:--");
    expect(formatDuration(NaN)).toBe("--:--");
    expect(formatDuration(Infinity)).toBe("--:--");
  });

  it("clamps negative durations to zero", () => {
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("returns empty string for missing/invalid input", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(NaN)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });

  it("formats bytes below 1024 as whole B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up through KB/MB/GB at each 1024 threshold", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("does not step past GB", () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1024.0 GB");
  });
});

describe("sanitizeFilename", () => {
  it("strips every character illegal in filesystem/zip entry names", () => {
    // Deliberately one string per char so a failure names the offending char.
    expect(sanitizeFilename("a\\b")).toBe("ab");
    expect(sanitizeFilename("a/b")).toBe("ab");
    expect(sanitizeFilename("a:b")).toBe("ab");
    expect(sanitizeFilename("a*b")).toBe("ab");
    expect(sanitizeFilename("a?b")).toBe("ab");
    expect(sanitizeFilename('a"b')).toBe("ab");
    expect(sanitizeFilename("a<b")).toBe("ab");
    expect(sanitizeFilename("a>b")).toBe("ab");
    expect(sanitizeFilename("a|b")).toBe("ab");
  });

  it("strips control characters, including tab", () => {
    expect(sanitizeFilename("a\x00b\x1fc\td")).toBe("abcd");
  });

  it("keeps ordinary punctuation used in real titles", () => {
    expect(sanitizeFilename("Song - Artist (Remix) ft. Someone")).toBe(
      "Song - Artist (Remix) ft. Someone",
    );
  });

  it("collapses runs of space characters and trims the ends", () => {
    expect(sanitizeFilename("  a   b   c  ")).toBe("a b c");
  });

  it("falls back to 'untitled' when nothing legal remains", () => {
    expect(sanitizeFilename("///???")).toBe("untitled");
    expect(sanitizeFilename("")).toBe("untitled");
  });

  it("caps length at 120 characters", () => {
    const long = "x".repeat(200);
    const result = sanitizeFilename(long);
    expect(result.length).toBe(120);
  });
});

describe("dedupeFilenames", () => {
  it("passes through already-unique names unchanged", () => {
    expect(dedupeFilenames(["A", "B", "C"])).toEqual(["A", "B", "C"]);
  });

  it("suffixes repeated names sequentially", () => {
    expect(dedupeFilenames(["Song", "Song", "Song"])).toEqual([
      "Song",
      "Song (2)",
      "Song (3)",
    ]);
  });

  it("always returns names that are unique, even if a later name collides with an earlier one's suffix", () => {
    // "A" repeats (producing "A (2)"), then a third input arrives that is
    // itself literally "A (2)" — the naive "count occurrences of the
    // original name" approach would emit "A (2)" twice.
    const result = dedupeFilenames(["A", "A", "A (2)"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("handles an empty list", () => {
    expect(dedupeFilenames([])).toEqual([]);
  });
});

describe("contentDisposition", () => {
  it("quotes a plain ASCII filename and adds a matching UTF-8 filename*", () => {
    const header = contentDisposition("song.mp3");
    expect(header).toBe(`attachment; filename="song.mp3"; filename*=UTF-8''song.mp3`);
  });

  it("replaces non-ASCII characters in the ASCII fallback but preserves them in filename*", () => {
    const header = contentDisposition("Arcángel.mp3");
    expect(header).toContain('filename="Arc_ngel.mp3"');
    expect(header).toContain(`filename*=UTF-8''Arc%C3%A1ngel.mp3`);
  });

  it("escapes embedded double quotes in the ASCII fallback", () => {
    const header = contentDisposition('Song "Live".mp3');
    expect(header).toContain(`filename="Song 'Live'.mp3"`);
  });
});
