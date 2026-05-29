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
#   - We only install production deps (--omit=dev). The pinned local kernel
#     tarball under vendor/ is referenced as a file: dependency in
#     package.json, so npm pulls it from the staged copy at install time.
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
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY vendor ./vendor

RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
 && npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 80
ENV PORT=80
CMD ["node", "dist/index.js"]
