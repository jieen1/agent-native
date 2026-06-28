# Prebaked worker microVM image (an-worker) — DESIGN §7.4.8.
#
# Built ONCE on the host, pushed to the local registry (localhost:5000) and
# pulled into msb's image cache, then booted by EVERY worker node's microVM via
# the SDK bridge (server/runtime/msb-bridge/server.mjs, .pullPolicy("if-missing")).
# A node boots STRAIGHT into work with NO per-task apk/apt/npm-install — the whole
# point of the bake. The runtime's INIT skips `ensureToolchain` for this image
# (isPrebakedImage()).
#
# What's prebaked and why:
#   • node 22 + npm     — the repo engines require node >= 22; backs in-VM tool
#     side-effects and the claude CLI (a node pkg) for a claude-code node.
#   • pnpm (corepack)   — the repo is a pnpm@10 workspace; a worker that needs the
#     project's deps runs `pnpm install` against its own clone (its choice — NOT a
#     forced boot-time install). Prebaking pnpm itself removes that round-trip.
#   • typescript (tsc)  — fixes the dogfood self-verify gap: a worker can typecheck
#     its OWN output (`tsc --noEmit`) without a per-task global install.
#   • git               — the delivery path: clone the repo, branch, commit, push.
#   • bash + coreutils  — the acting bridge runs `sh -lc <cmd>`; coreutils backs
#     base64 (binary-safe fs ops), printf, cat, mkdir, etc.
#   • ca-certificates   — alpine ships no CA bundle; without it `git clone https`
#     and `curl https` fail with a TLS "unexpected EOF" (proven 2026-06-21).
#   • curl              — the egress probes (networking.ts) + general fetches.
#   • openssh-client    — git-over-ssh remotes if a run uses one.
#
# Base: node:22-alpine (alpine is msb's proven base; tiny rootfs → fast boot, and
# node:22-alpine ships node 22 + npm without a manual nodejs apk). The microVM
# boots this image's rootfs directly via libkrun — there is no docker daemon in
# the VM.
#
# Rebuild + publish (on the host, no sudo):
#   docker build -t an-worker:latest \
#     templates/orchestrator/server/runtime/msb-bridge/worker-image
#   docker tag an-worker:latest localhost:5000/an-worker:latest
#   docker push localhost:5000/an-worker:latest
#   msb pull localhost:5000/an-worker:latest   # into msb's image cache
FROM node:22-alpine

# Single layer, no cache, so the saved image stays small and reproducible.
RUN apk add --no-cache \
      bash \
      coreutils \
      ca-certificates \
      git \
      curl \
      openssh-client \
 && update-ca-certificates \
 && corepack enable \
 && corepack prepare pnpm@10.29.1 --activate \
 && npm install -g typescript@5 \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 # Prove the toolchain at build time so a broken bake fails the build, not a run.
 && bash --version >/dev/null \
 && git --version \
 && node --version \
 && npm --version \
 && pnpm --version \
 && tsc --version \
 && curl --version >/dev/null

# A stable label so `msb image inspect` / `docker inspect` identify the bake.
LABEL org.agent-native.image="an-worker" \
      org.agent-native.purpose="orchestrator worker microVM (prebaked toolchain: node22+pnpm+tsc+git)"

# msb boots a DETACHED microVM kept alive by its init; no CMD side-effect is run
# in detached mode, but keep a sane default so an attached boot has a shell.
CMD ["/bin/sh"]
