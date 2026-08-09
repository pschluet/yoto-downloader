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

## Running it with Docker

Skips the `yt-dlp`/`ffmpeg` host install entirely — both are baked into the
image.

```bash
npm run docker:build   # docker compose build
npm run docker:up      # docker compose up -d
```

Then open [http://localhost:3000](http://localhost:3000). Bring it down with
`npm run docker:down`, or tail logs with `npm run docker:logs`.

The `yt-dlp` binary is **pinned** to a specific release (see `YTDLP_VERSION`
at the top of the `Dockerfile`) rather than always fetching the latest —
builds stay reproducible, but since YouTube changes often enough to break
older yt-dlp releases, you may need to bump it and rebuild:

```bash
YTDLP_VERSION=2026.06.01 docker compose build
```

(or just edit the default in the `Dockerfile` / `docker-compose.yml`).

The `--cookies-from-browser` trick below doesn't work in a container — there's
no browser profile to read. Instead, export your cookies to a `cookies.txt`
file, uncomment the volume mount in `docker-compose.yml`, and set
`YTDLP_EXTRA_ARGS=--cookies /cookies.txt` (e.g. in a `.env` file next to
`docker-compose.yml`).

## If YouTube asks you to sign in / blocks downloads

YouTube sometimes rate-limits or challenges automated traffic with
"Sign in to confirm you're not a bot." If that happens (outside Docker), pass
yt-dlp your browser's cookies via the `YTDLP_EXTRA_ARGS` environment
variable, e.g.:

```bash
YTDLP_EXTRA_ARGS="--cookies-from-browser chrome" npm run dev
```

Any extra yt-dlp flags can be passed this way (space-separated).

## Testing

```bash
npm test              # vitest run
npm run test:watch    # vitest, re-runs on change
npm run test:coverage # vitest run --coverage
```

Covers `src/lib/**` (mocking `node:child_process` for the yt-dlp wrapper, and
`@/lib/ytdlp` for the job store, so nothing here actually shells out or hits
the network), every API route (called directly with a real `Request`), and
the UI (jsdom + Testing Library, with a fake `EventSource`).

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
- `Dockerfile` / `docker-compose.yml` — multi-stage build (Next's standalone
  output, so the runtime image doesn't carry all of `node_modules`) with a
  pinned `yt-dlp` binary and `ffmpeg` baked in, running as a non-root user.
