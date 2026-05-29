# Dockerfile for open-managed-agent runtime as a CloudBase CloudRun container.
#
# Used by `magent cloudrun:create` (and any other deploy tool that points at
# this directory). The CLI only stages the build artifacts; this file is the
# source of truth for how the container is built.
#
# Notes:
#   - CloudBase CloudRun's container probe defaults to :80, so the runtime
#     listens on PORT=80. Override at the cloudrun service level if you need
#     a different port (Port field in cloudbaserc.json `cloudrun`).
#   - Base image is debian-bullseye-slim (not alpine). The Claude Agent SDK
#     spawns a `claude-code` child process that pulls in shared libs that
#     Alpine's musl can't provide; bullseye has them out of the box.
#   - Runs as a non-root user (`agent`, uid=1001). The SDK's CLI refuses to
#     run with `--dangerously-skip-permissions` under uid==0, so root is a
#     non-starter for our use case.
#   - We only install production deps (--omit=dev). The pinned local kernel
#     tarball under vendor/ is referenced as a file: dependency in
#     package.json, so npm pulls it from the staged copy at install time.
#   - We also force-install @anthropic-ai/claude-agent-sdk-linux-x64
#     because npm's optionalDependencies platform-detection sometimes
#     skips it in containerized environments where the matching package
#     would silently never be installed (the SDK then exits with code 1
#     when the kernel tries to spawn a turn).
#   - Tencent npm mirror gives a few-minutes-faster build inside CloudBase CI.

FROM node:20-bullseye-slim
WORKDIR /app

ENV TZ=Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        git \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash --uid 1001 agent \
 && chown -R agent:agent /app

USER agent

COPY --chown=agent:agent package*.json ./
COPY --chown=agent:agent vendor ./vendor

RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
 && npm install --omit=dev --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund \
        @anthropic-ai/claude-agent-sdk-linux-x64@$(node -p "require('@anthropic-ai/claude-agent-sdk/package.json').version")

COPY --chown=agent:agent . .

EXPOSE 8080
ENV PORT=8080 HOME=/home/agent
CMD ["node", "dist/index.js"]
