# Node microVM base image (DESIGN §7.4.8)

A claude-code / code node's microVM needs **node + npm + git + the `claude` CLI**
before EXECUTE runs. There are two ways to get them in; P2c implements both seams
and the second is the default that works on the stock `alpine` image today.

## Option A — prebaked OCI image (preferred, fast INIT)

Bake one image per language/runtime with the toolchain already installed, version
it, and pin it on the node via `runtime.image` (e.g. `orchestrator/node-base:1`).
The registry in `server/runtime/images.ts` describes the catalog the Settings →
Images tab renders; a CLI bake step writes the real digests/status.

A minimal bake (illustrative — run on the WSL host where `msb`/OCI tooling lives):

```dockerfile
FROM alpine:3.24
RUN apk add --no-cache nodejs npm git curl github-cli ca-certificates \
 && npm install -g @anthropic-ai/claude-code
# (add the project language runtime here: python/uv, go, …)
```

Build + tag it as `orchestrator/node-base:1`, then set a node's
`runtime.image = "orchestrator/node-base:1"`. With everything prebaked,
`ensureToolchain` (below) detects the tools and **short-circuits** — INIT pays
~zero install cost.

## Option B — install on INIT via egress (default, no bake needed)

On the bare `alpine` base, `server/runtime/vm-setup.ts` `ensureToolchain()`
installs what's missing through the VM's public egress:

```sh
apk add --no-cache nodejs npm git curl
npm install -g @anthropic-ai/claude-code
```

**Proven on a real microVM (2026-06-21):** with the VM's DNS fixed for direct NAT
egress (`server/runtime/networking.ts`), `apk add` and the global npm install
succeed and `claude --version` runs in-VM. This is the slow cold path the prebake
exists to avoid, but it makes a claude node WORK on the stock image without a
bake. `ensureToolchain` only installs the missing tools, so a prebaked image
(Option A) skips it entirely.

## Networking & credentials (how the install reaches the network)

- **Egress (§7.4.9).** The microsandbox VM subnet (`172.16.0.0/12`) is NAT-
  masqueraded by the host, giving the VM **direct** public egress — once DNS
  works. The VM's built-in resolver was timing out, so MOUNT writes a public
  resolver to `/etc/resolv.conf` (`networking.ts` `fixVmDns`). A host
  `tinyproxy:8888` forward-proxy is an **alternate** egress path: it is a HOST
  PREREQUISITE (never installed from app code; `ensureHostProxy()` only warns).
  We **preflight** it from inside the VM and export `HTTP(S)_PROXY` only when a
  request through it actually succeeds AND direct egress did not — with
  `NO_PROXY` keeping the host vLLM direct (§7.4.9).
  - **Host prerequisite / persistence caveat.** Egress needs EITHER the
    `172.16.0.0/12` NAT-masquerade rule OR a running `tinyproxy`. Neither survives
    a `wsl --shutdown` by default (WSL does not persist iptables), so on a fresh
    WSL boot the host must re-establish one (e.g. `iptables -t nat -A POSTROUTING
    -s 172.16.0.0/12 ! -d 172.16.0.0/12 -j MASQUERADE`, or start tinyproxy). The
    runtime never mutates host firewall state; it probes both paths per boot and,
    if BOTH are down, a claude/git/install step fails with a clear egress error
    rather than hanging. Treat this as a host setup step alongside `msb` and the
    `kvm` group.
- **`~/.claude` subscription (§7.4.7).** MOUNT copies the host `~/.claude` into
  the VM's `$HOME` (landing at `$HOME/.claude`) so the in-VM `claude` reuses your
  Pro/Max login (`apiKeySource:none`). The copy is a disposable per-VM clone,
  left writable; the host dir is never modified.
- **`GITHUB_TOKEN` (§7.1/§7.4.7).** Resolved from the Vault at run time
  (`resolveSecret`) and injected as scoped VM env, used by the git wrapper via an
  ephemeral `https://x-access-token:<token>@github.com/...` push URL — never
  written to the repo config or any committed file.
