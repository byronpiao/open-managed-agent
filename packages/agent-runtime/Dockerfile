# Dockerfile for open-managed-agent runtime as a CloudBase CloudRun container.
#
# Used by `magent cloudrun:create` (and any other deploy tool that points at
# this directory). The CLI only stages the build artifacts; this file is the
# source of truth for how the container is built.
#
# Notes:
#   - Runtime listens on PORT=8080 (non-root can't bind <1024). The CloudRun
#     service is configured to probe :8080 via the Port field in
#     `magent cloudrun:create` Items form.
#   - Base image is debian-bullseye-slim (not alpine). The Claude Agent SDK
#     spawns a `claude-code` child process that pulls in shared libs that
#     Alpine's musl can't provide; bullseye has them out of the box.
#   - Runs as a non-root user (`agent`, uid=1001). The SDK's CLI refuses to
#     run with `--dangerously-skip-permissions` under uid==0, so root is a
#     non-starter for our use case. To preserve a "write anywhere I'd
#     normally write as root" experience, the build chowns the common
#     working dirs (/app /workspace /data /cache /tmp /var/tmp) to agent
#     so business code can freely create files there. System dirs
#     (/etc /usr /bin) intentionally stay read-only.
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
 && mkdir -p /workspace /data /cache \
 && chown -R agent:agent /app /workspace /data /cache /tmp /var/tmp \
 && chmod 1777 /tmp /var/tmp

USER agent

COPY --chown=agent:agent package*.json ./
COPY --chown=agent:agent vendor ./vendor

RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
 && npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
 && CLAUDE_SDK_VER=$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version") \
 && npm install --no-save --no-audit --no-fund --legacy-peer-deps \
        @anthropic-ai/claude-agent-sdk-linux-x64@${CLAUDE_SDK_VER}

COPY --chown=agent:agent . .

EXPOSE 8080
ENV PORT=8080 HOME=/home/agent
CMD ["node", "dist/index.js"]
