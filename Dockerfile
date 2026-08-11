# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-bookworm-slim
# Bump this (and rebuild) to pick up a newer yt-dlp — YouTube changes often
# enough that the version installed matters. See README.md.
ARG YTDLP_VERSION=2026.03.17

# ---- deps: install dependencies only, so this layer caches across source changes
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the standalone Next.js build
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- ytdlp: fetch the pinned, self-contained yt-dlp binary for the target
# architecture (no Python runtime needed — it's a PyInstaller bundle).
FROM node:${NODE_VERSION} AS ytdlp
ARG YTDLP_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ytdlp_asset=yt-dlp_linux ;; \
      arm64) ytdlp_asset=yt-dlp_linux_aarch64 ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytdlp_asset}"; \
    chmod a+rx /usr/local/bin/yt-dlp

# ---- runner: minimal final image
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is required by yt-dlp for audio extraction and embedding cover art.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ytdlp /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

# Lets this same image run as a Lambda function: it proxies the Lambda
# Runtime API to plain HTTP against the Next.js server below, so the app
# code doesn't need to know it's running on Lambda at all. It's an inert
# no-op layer under `docker compose` / plain `docker run` — nothing invokes
# a Lambda extension outside a real Lambda execution environment.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=3000
# Matches the Function URL's RESPONSE_STREAM invoke mode (see infra/), which
# the /api/jobs/[id]/events polling stream depends on.
ENV AWS_LWA_INVOKE_MODE=response_stream

# Next's traced standalone output — only the files the app actually needs,
# not the full node_modules tree.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
