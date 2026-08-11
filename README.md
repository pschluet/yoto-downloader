# YouTube → MP3

Paste a YouTube playlist or single video link, pick which tracks you want,
and download the audio as MP3 (individually, or as a ZIP for playlists).
Tracks are tagged with title/artist metadata and embedded cover art. The app
is gated behind sign-in (AWS Cognito), and runs as a scale-to-zero deployment
on AWS Lambda at **https://yoto.pauldev.io**.

Only use this on content you have the right to download.

## Architecture

- **Web Lambda** — the Next.js app itself, run via the [Lambda Web
  Adapter](https://github.com/awslabs/aws-lambda-web-adapter), behind a
  Function URL, fronted by CloudFront at the custom domain.
- **Worker Lambda** — SQS-triggered, one message per track. Runs
  `yt-dlp`/`ffmpeg`, uploads the finished file to S3, writes progress to
  DynamoDB.
- **DynamoDB** — job/track state (replaces the in-memory store an
  always-on server would use).
- **S3** — finished files. Single-track downloads redirect to a presigned
  URL; playlist ZIPs are built by streaming each track in from S3.
- **Cognito** — username/password auth (custom login form, no Hosted UI).
  An `/admin` page lets the admin create further users.
- **CDK** (`infra/`) — all of the above, plus the CloudFront distribution,
  ACM cert, and Route53 record.

Because there's no long-lived server process, cancel is **best-effort**: it
sets a flag the worker checks between attempts, rather than killing an
in-flight download outright the way a local process could.

## Local development

The app now depends on real AWS resources (DynamoDB/S3/SQS/Cognito) even
when running locally — there's no offline stand-in for them. Point it at a
deployed environment's resources (see [Deploying to
AWS](#deploying-to-aws) below) via a `.env.local`:

```bash
# From `cd infra && npx cdk deploy`'s outputs, or the AWS console/CLI.
AWS_REGION=us-east-2
JOBS_TABLE_NAME=...
FILES_BUCKET_NAME=...
TRACKS_QUEUE_URL=...
COGNITO_USER_POOL_ID=...
COGNITO_CLIENT_ID=...
```

Plus AWS credentials in your environment (`aws sso login`, `aws configure`,
etc. — anything the AWS SDK's default credential chain picks up) with
permission to use those resources, and `yt-dlp`/`ffmpeg` on your `PATH`
(`brew install yt-dlp ffmpeg`) since the web server itself resolves URLs
locally even though downloading happens in the worker Lambda.

```bash
npm install
npm run dev
```

Note the web server only *resolves* URLs and orchestrates jobs — actually
downloading a track requires the **worker Lambda to be deployed**, since
nothing consumes the SQS queue locally. For end-to-end local testing, either
run the worker via the Lambda Runtime Interface Emulator, or just test
against the deployed environment directly.

## Running it with Docker

```bash
npm run docker:build
npm run docker:up
```

Runs the exact same container image deployed to Lambda, against your real
AWS backend (see the env vars above — `docker compose` reads them from your
shell or a `.env` file). The `worker` service is Lambda-only (its entrypoint
is the Lambda Runtime Interface Client) — it's included so `docker compose
build` can smoke-test that it still builds, not for standalone use. To
actually exercise it locally, use the Runtime Interface Emulator:

```bash
docker run -d --rm -p 9000:8080 <worker-image>
curl -X POST "http://localhost:9000/2015-03-31/functions/function/invocations" \
  -d '{"Records":[{"messageId":"1","body":"{\"jobId\":\"x\",\"trackIndex\":0,\"videoId\":\"dQw4w9WgXcQ\"}"}]}'
```

The `yt-dlp` binary is **pinned** to a specific release (`YTDLP_VERSION` at
the top of `Dockerfile`/`Dockerfile.worker`) rather than always fetching the
latest — builds stay reproducible, but since YouTube changes often enough to
break older yt-dlp releases, you may need to bump it and redeploy:

```bash
YTDLP_VERSION=2026.06.01 npm run infra:deploy
```

There's no `--cookies-from-browser` equivalent on Lambda (no browser
profile) — if YouTube challenges the worker with "Sign in to confirm you're
not a bot," export cookies to a file, put it in S3, and have the worker pull
it down and pass `--cookies` to yt-dlp instead.

## Deploying to AWS

Everything here is defined in `infra/` (a separate CDK app — see its own
`package.json`). Prerequisites: an AWS account with CDK already bootstrapped
in both your target region and `us-east-1` (CloudFront certs must live
there), and a Route53 hosted zone for the domain you're pointing at.

**One-time manual step**, before the pipeline can deploy anything:

```bash
cd infra
npm install
npx cdk deploy YotoGithubDeployStack
```

This creates the IAM role GitHub Actions assumes via OIDC — chicken-and-egg,
since the pipeline needs a role to exist before it can deploy anything,
including that role. It trusts a specific GitHub repo (`sub` claim scoped to
`repo:<owner>/<repo>:*`) and can only assume CDK's own bootstrap roles, not
touch AWS resources directly.

After that, `.github/workflows/ci-cd.yml` handles the rest:

- **Every PR / push**: lint, typecheck, test, build the app; `cdk synth` the
  infra (no AWS credentials needed — the Route53 lookup is cached in the
  committed `infra/cdk.context.json`).
- **On push to `main`, after those checks pass**: assumes the deploy role via
  OIDC (no long-lived AWS keys in GitHub secrets) and runs `cdk deploy
  --all`. Since both Lambdas are container-image assets, this single command
  builds and ships new app code *and* applies any infra changes.

To deploy everything else manually instead:

```bash
npm run infra:diff     # review first
npm run infra:deploy
```

### First login

The initial admin (`paul@paulschlueter.com`, provisioned by a CDK custom
resource — see `infra/lib/auth-stack.ts`) gets emailed a temporary password
by Cognito on first deploy. Sign in with it at the deployed URL; you'll be
prompted to set a real password (Cognito's `NEW_PASSWORD_REQUIRED`
challenge). From there, use the **Admin** link in the header to create
further users the same way.

## Testing

```bash
npm test              # vitest run
npm run test:watch    # vitest, re-runs on change
npm run test:coverage # vitest run --coverage
```

Covers `src/lib/**` (mocking the AWS SDK clients, `node:child_process` for
the yt-dlp wrapper, and Cognito's REST API via `fetch` — nothing here
actually hits AWS or the network), every API route and the auth
proxy/middleware (called directly with a real `Request`), the worker
handler (mocking `downloadTrack`, exercising the real retry loop), and the
UI (jsdom + Testing Library, with a fake `EventSource`).

## How it works

- `src/lib/ytdlp.ts` — spawns `yt-dlp` to resolve a URL into track metadata,
  and to download+extract one track's audio (progress via `@P`/`@C` stdout
  sentinels, cancellation via `AbortSignal`). Unchanged by the AWS move —
  it's called the same way from the worker Lambda as it would be anywhere.
- `src/lib/db.ts` / `storage.ts` / `queue.ts` — DynamoDB, S3, and SQS
  helpers. `db.ts` derives a job's overall status from its tracks' statuses
  at *read* time rather than storing it, so concurrent per-track worker
  writes never race over a shared field.
- `src/lib/jobs.ts` — orchestration: creates a job, enqueues one SQS message
  per track, and exposes the retry/cancel/snapshot operations the API
  routes need. Doesn't do any downloading itself anymore.
- `src/worker/handler.ts` — the SQS-triggered Lambda handler. Runs the same
  auto-retry-once logic the old in-process version did, calling
  `downloadTrack()` unchanged, but persists progress to DynamoDB and
  uploads to S3 instead of mutating memory.
- `src/app/api/**` — REST + SSE endpoints. `/events` is a bounded
  poll-DynamoDB-and-stream loop (not a live subscription, since nothing
  keeps running between requests on Lambda) that closes every ~25s; the
  browser's `EventSource` reconnects automatically.
- `src/lib/auth.ts` / `src/proxy.ts` — Cognito auth. Login/refresh/challenge
  calls are plain `fetch` against Cognito's REST API (no AWS SDK, no
  SigV4), which is what lets the auth check run in Next's proxy
  (middleware) — `src/lib/auth-admin.ts` is the one place that needs real
  IAM credentials, for the privileged `AdminCreateUser`/`AdminAddUserToGroup`
  calls behind `/admin`.
- `src/app/page.tsx` — the UI: URL input → track picker → live progress →
  download.
- `Dockerfile` — the web Lambda's image: Next's standalone output plus the
  Lambda Web Adapter, `ffmpeg`, and a pinned `yt-dlp` binary. Also runs fine
  as a plain container (the adapter is inert outside a real Lambda
  environment), which is what `docker-compose.yml` uses.
- `Dockerfile.worker` — the worker Lambda's image: AWS's own Node.js Lambda
  base (no Web Adapter needed — it's not HTTP-triggered), plus static
  `ffmpeg`/`yt-dlp` binaries baked in the same way.
- `infra/` — the CDK app: `data-stack.ts` (DynamoDB/S3/SQS),
  `auth-stack.ts` (Cognito), `worker-stack.ts` / `web-stack.ts` (the two
  Lambdas), `edge-stack.ts` (CloudFront/ACM/Route53, in us-east-1),
  `github-deploy-stack.ts` (the OIDC deploy role).
