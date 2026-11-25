# AI PR Reviewer — container image (public starting point).
#
# This is a starting point for running the reviewer as a service. The internal
# cluster build (imagestream, registry mirror, corporate proxy/env) is
# intentionally NOT baked in — adapt FROM/installs/registry to your platform.
#
# Run locally:
#   docker build --build-arg APP_VERSION=0.4.2 -t ai-pr-reviewer .
#   docker run --rm -p 8123:8123 --env-file .env ai-pr-reviewer
#
# Build-time deps (fetched, not committed to the repo):
#   - opencode  (the CLI that runs the reviewer agents) via npm
#   - ripgrep   (used by opencode for search) via apt
#   - undici    (EnvHttpProxyAgent so fetch honors HTTP(S)_PROXY/NO_PROXY) via npm

FROM node:22-bookworm-slim

ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION:-dev} \
    HOME=/app \
    NODE_ENV=production \
    OPENCODE_STANDALONE=1 \
    OPENCODE_BIN=/usr/local/bin/opencode \
    PATH=/usr/local/bin:$PATH

WORKDIR /app
COPY . .

USER root

# System deps: git (shallow checkout of the reviewed commit), ripgrep (opencode search).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep unzip \
 && rm -rf /var/lib/apt/lists/*

# opencode — pin a specific version in your build (e.g. `@opencode/cli@1.0.9`).
# Do NOT fall back to `@latest`: on deployment it has drifted to v2.0.32, which
# never emits a `step_finish`/`tokens` event for tool-free agent runs — so the
# `pr-vision` screenshot transcription (a single tool-free response) loses its
# usage/cost and the dashboard shows `vision.cost: null` even though the
# transcription succeeds. v2.4.1 emits `step_finish` + `tokens` for tool-free
# runs (verified local + against npm `@opencode/cli`); bump deliberately here.
ARG OPENCODE_PKG="@opencode/cli@2.4.1"
RUN npm install -g "$OPENCODE_PKG" --no-audit --no-fund

# Image-only dependency: undici's EnvHttpProxyAgent so the app's outbound fetch
# honors HTTP(S)_PROXY/NO_PROXY (Node's built-in fetch ignores proxy env vars).
# Pinned; installed without saving to package.json.
RUN npm install --no-save --no-audit --no-fund undici@7.30.0 \
 && node -e "require('undici'); console.log('undici ok')"

# Prepare writable dirs and the opencode config/cache home for the non-root user.
RUN mkdir -p /app/data/jobs /app/.config/opencode \
 && chown -R node:node /app

USER node
EXPOSE 8123

# Materializes $HOME/.config/opencode/opencode.json from
# docker/opencode.json.template (secrets via env), then hands over to src/server.js.
ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
