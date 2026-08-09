# YouTube → MP3

A small local Next.js app: paste a YouTube playlist or single video link, pick
which tracks you want, and download the audio as MP3 (individually, or as a
ZIP for playlists). Tracks are tagged with title/artist metadata and embedded
cover art.

Only use this on content you have the right to download.

## Prerequisites

The app shells out to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and
[`ffmpeg`](https://ffmpeg.org) — install both and make sure they're on your
`PATH`:

```bash
brew install yt-dlp ffmpeg
```

## Running it

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a link, hit
**Resolve**, pick your tracks, and hit **Download**.

- A single video link resolves to one track and downloads as `Title.mp3`.
- A playlist link resolves to the full track list; uncheck anything you don't
  want, then download everything selected as a `.zip`. Individual files can
  also be downloaded from the per-track progress list once they finish.

Downloads run server-side into a temporary directory that's cleaned up once
you download the result (or after ~30 minutes if you leave a job open).
Nothing is written outside of `os.tmpdir()`.

## If YouTube asks you to sign in / blocks downloads

YouTube sometimes rate-limits or challenges automated traffic with
"Sign in to confirm you're not a bot." If that happens, pass yt-dlp your
browser's cookies via the `YTDLP_EXTRA_ARGS` environment variable, e.g.:

```bash
YTDLP_EXTRA_ARGS="--cookies-from-browser chrome" npm run dev
```

Any extra yt-dlp flags can be passed this way (space-separated).

## How it works

- `src/lib/ytdlp.ts` — spawns `yt-dlp` to resolve a URL into track metadata,
  and to download+extract one track's audio at a time (one process per
  track, for clean per-track progress and failure isolation).
- `src/lib/jobs.ts` — an in-memory job store that runs selected tracks
  through a small concurrency pool (3 at a time) and streams progress to
  subscribers.
- `src/app/api/**` — REST + SSE endpoints the UI talks to: resolve a URL,
  start a job, stream its progress, cancel it, and download the finished
  file(s).
- `src/app/page.tsx` — the UI: URL input → track picker → live progress →
  download.
