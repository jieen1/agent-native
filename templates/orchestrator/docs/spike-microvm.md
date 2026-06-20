# P0 Spike — microsandbox / KVM microVM feasibility

> Hard go/no-go gate for P2/P4 (IMPLEMENTATION.md P0 item 2). microsandbox is the
> **sole** runtime backend (D-2); there is no fallback. This document records the
> **real, measured** results on the target host — no estimates. Every number below
> came from an actual run on 2026-06-20.

## Verdict: **CONDITIONAL GO**

The decisive unknowns are resolved **GO**: KVM works, microVMs boot fast, host
capacity is ample, and the in-VM → host vLLM path (the user's primary model
substrate) works. **Two items remain open before P2/P4 can fully land** — neither
is a re-architecture, both are config/integration that belong in P2:

1. **Public internet egress from the VM is not yet working** (passt under WSL2
   reaches the host but not the public internet). This blocks the claude-API /
   remote-API / `git push` executors until resolved. The local-vLLM path is
   unaffected and works today.
2. **The ≤300 ms warm-restart** target needs the microsandbox **server + SDK**
   snapshot-fork path; the CLI one-shot path carries ~8.5 s of tooling overhead
   (the bare microVM boot is ~194 ms — see below).

**P1 (engine core) is fully unblocked and independent of all of the above** (DESIGN
§16): the scheduler treats a node's runtime as opaque, validated with an echo/None
executor. Proceed with P1 now; finish the two open items inside P2.

## Host environment (verified)

| Item | Value |
|---|---|
| OS | Windows 11 + WSL2 **Ubuntu 24.04.4 LTS** (default distro `ubuntu2404`) |
| Kernel (WSL) | 6.6.114.1-microsoft-standard-WSL2 |
| `/dev/kvm` | **present** (`crw-rw---- root kvm`) |
| KVM access | user `bot` was **not** in the `kvm` group; fixed with `wsl -u root usermod -aG kvm bot` (WSL root needs no Linux password). After `wsl --shutdown`, `bot` opens `/dev/kvm` (`KVM_OPEN_OK`). |
| Host RAM (WSL) | 24030 MB (~24 GB) |
| Local vLLM | `http://localhost:8000/v1` — model `qwen3.6` (Qwen3.6-27B-AWQ-INT4). **NOTE: design D-6 wrote `:8080`; the actual host endpoint is `:8000`.** |
| claude CLI (WSL) | `/home/bot/.local/bin/claude` v2.1.183; `~/.claude/.credentials.json` **present** (subscription login exists → RO mount feasible) |

## Install (real)

```bash
curl -sSL https://get.microsandbox.dev | sh     # installs msb 0.5.7 + libkrunfw to ~/.microsandbox
# binaries: ~/.microsandbox/bin/{msb,microsandbox}; libkrunfw.so.5.2.1 in ~/.microsandbox/lib
# NOTE: v0.5.7 ships only `msb` (no separate `msbserver`/`msbrun` binary; no `msb server` subcommand).
```

`msb 0.5.7` confirmed. Pinned in `package.json` as `microsandbox@0.5.7` (npm SDK).
**The npm `microsandbox` SDK ships POSIX-only native binaries** (darwin-arm64,
linux-arm64-gnu, linux-x64-gnu) as optional deps — **no win32 binary**. Install is
clean on Windows (optionals skipped, no postinstall), but the microVM-driving code
in P2 must execute inside WSL2/Linux (`linux-x64-gnu`), not on the Windows host.

## Measurements

### Boot latency (the make-or-break number)

`msb run --info alpine -- true` reports, per the microsandbox runtime itself:

```
sandbox ready  boot_time_ms=122  init_time_ms=71  ready_time_ms=194
```

- **microVM boot: 122 ms; ready (boot+init): 194 ms.** ✅ Well under the ≤2 s cold
  threshold; matches microsandbox's "<100 ms" headline.
- **Wall-clock of a full `msb run` CLI round-trip: ~8.5 s** (3 runs: 8.50 / 8.49 /
  8.51 s, image cached). This is **CLI tooling overhead** — sea_orm migration check,
  agent-relay connect, rootfs/upper-layer prep, teardown — **not** the VM boot. The
  persistent server + SDK path P2 uses amortizes this; the relevant figure for the
  VM itself is the 194 ms ready time.

### Concurrency + memory (host capacity)

8 detached alpine VMs (`msb run -d alpine -- sleep 25`), all reached `running`:

| | host used (MB) | host avail (MB) |
|---|---|---|
| before | 1435 | 22594 |
| with 8 VMs | 1857 | 22172 |
| delta | **+422 (≈ 53 MB / idle VM)** | |

✅ No OOM. Each VM *reports* 517 MB total internally, but actual host footprint is
~53 MB/idle-VM (lazy/ballooned). On 24 GB, dozens of concurrent VMs fit before real
workload memory. **Suggested initial `maxConcurrentVMs` = 8** (conservative; raise
after measuring real claude/node workload memory in P2).

### Snapshot warm-restart

`msb snapshot create --from <vm> <name>` works (4.0 GiB disk snapshot). Boot **from
snapshot** via CLI: 10.50 / 8.62 / 8.47 s — i.e. the **same ~8.5 s CLI overhead**,
NOT a ≤300 ms memory-fork. ❌ The ≤300 ms warm target is **not** met by the CLI; it
requires the microsandbox **server + SDK** snapshot/fork API. **Defer to P2** (the
NodeRuntime uses the SDK, not the CLI).

### Networking

**Backend: microsandbox uses libkrun's built-in networking** (`libkrunfw.so`) with its
own policy engine — **not** passt/gvproxy (no such host process spawns; installing
passt was a red herring and is irrelevant). The running `msb sandbox` process carries
a `--network-config` JSON. Its **default policy** is:

```
default_egress: deny, default_ingress: allow
allow egress → group "host", udp/tcp, port 53      (DNS only)
allow egress → group "public", all protocols/ports (public internet allowed by policy)
```

`msb run` flags: `-p/--port` (host→guest forward), `--net-default-egress`,
`--net-rule` (`allow@host` / `allow@public` / `allow@<ip>:tcp:<port>`).

| Target | Result |
|---|---|
| VM → **host vLLM** at `http://<VM-default-gateway>:8000/v1/models` with `--net-default-egress allow` | ✅ **WORKS** — returned the `qwen3.6` model list (1392 bytes). **D-6 answer: the in-VM reachable host-vLLM address is the VM's own default-gateway IP at port 8000** (per-boot, e.g. `172.16.0.x`). Needs egress allowed to the **host group on :8000** (the default policy only opens host:53/DNS, so `--net-default-egress allow` or a scoped `--net-rule allow@host:tcp:8000` is required). |
| VM → public internet (`1.1.1.1` raw IP; `example.com`) | ❌ **fails** even though the default policy **allows** the `public` group. The block is **below** the policy layer — libkrun's egress routing to the public internet does not function under this WSL2 host. The host group (the WSL gateway) is reachable, the public internet is not. **Open P2 item** — blocks claude-API / remote-API / `git push` executors; the local-vLLM path (host group) is unaffected. Fix is a libkrun-TSI-under-WSL2 routing investigation, not a policy change. |

### Items still PENDING (blocked on public egress — to finish in P2)

These P0-acceptance items could **not** be completed yet and are **not** faked:

- [ ] in-VM `claude --output-format stream-json` real run + event sample — needs a
  prebaked image carrying `@anthropic-ai/claude-code` **and** public egress (claude
  API). Subscription login (`~/.claude`) is present; RO mount is feasible.
- [ ] `~/.claude` RO mount end-to-end verification (in-VM claude reuses subscription).
- [ ] `git push` of a test branch + PR URL — needs public egress + a `GITHUB_TOKEN`
  and a throwaway test repo.

## Thresholds vs measured (IMPLEMENTATION.md P0 acceptance)

| Threshold | Target | Measured | Pass? |
|---|---|---|---|
| VM cold boot | ≤ 2 s | **194 ms** (VM ready); ~8.5 s CLI round-trip | ✅ (VM); CLI overhead noted |
| Warm-snapshot restart | ≤ 300 ms | ~8.5 s via CLI | ❌ via CLI; needs SDK/server (P2) |
| Destroy + restart clean re-run | succeeds | ✅ destroy + fresh boot verified | ✅ |
| Concurrent VMs without OOM | ≥ N (N≈8) | 8 VMs, +422 MB, no OOM | ✅ |
| Per-VM resident memory | ≤ threshold | ~53 MB/idle-VM | ✅ |
| RO `~/.claude` mount verified | yes | login present; mount not yet run | ⏳ pending (egress) |
| In-VM host vLLM reachable + address form | yes | ✅ `<gateway>:8000` + egress allow | ✅ |
| `git push` test-branch URL | yes | — | ⏳ pending (egress) |

## Decisions / config to carry into P2

- **In-VM host vLLM address** = the VM's default-gateway IP (per-boot, `172.16.0.x`)
  at **port 8000** (not 8080), passed as the node's `baseUrl` env; run VMs with
  egress allowed (or a scoped `--net-rule` to the host).
- **Public egress must be fixed** before claude/remote/git executors work. It is a
  libkrun-TSI-under-WSL2 routing issue (the network policy already allows the public
  group; the host group works, public does not). Investigate libkrun networking in
  WSL2 + the server/SDK path, not the one-shot CLI. The local-vLLM (host group) path
  is unaffected.
- **`maxConcurrentVMs` initial = 8** (24 GB host, ~53 MB/idle-VM overhead).
- **microVM code runs in WSL2/Linux** (the SDK's win32 binary is absent by design).
- **Snapshot/fork fast path** = SDK/server, not CLI; (re)measure the ≤300 ms target
  there in P2.
