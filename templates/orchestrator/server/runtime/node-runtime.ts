// The `NodeRuntime` abstraction — the microVM seam the NodeRunner sees
// (DESIGN §7.4.2). Every node in a v2 workflow runs through the unified
// 7-stage NodeRunner (§7.4.1a); this interface is the *environment* axis of
// that lifecycle (provision → mount → init → exec/spawn → … → teardown). The
// *brain* axis (which model/executor runs at the EXECUTE stage) is the
// separate `NodeExecutor` seam in `server/engine/types.ts`; P2b plugs the three
// executors into that, handed an already-provisioned VM from here.
//
// P2a scope (this file + its implementations): the runtime ABSTRACTION and a
// real microVM smoke proof only. The 7-stage NodeRunner, the vLLM/remote/
// claude-code executors, the in-VM git wrapper, the prebaked base image, and
// credential injection are P2b/P2c — NOT implemented here. `mount`/`init` exist
// but are intentionally minimal (env capture + a no-op repo placeholder); the
// real git checkout lands in P2c.
//
// Two backends implement this interface (DESIGN §7.4.2 — microsandbox is the
// SOLE microVM backend; there is no Docker/Podman/E2B path):
//   • MicrosandboxRuntime (`microsandbox-runtime.ts`) — every node that runs
//     tools, code, or an agent. Drives libkrun/KVM microVMs via the `msb` CLI
//     inside WSL2.
//   • NoneRuntime (`none-runtime.ts`) — pure-reasoning nodes only (branch
//     conditions, planners with no file/git side effects). No VM; runs on the
//     host in a scoped temp dir.

import type { NodeRuntimeSpec } from "../../shared/types.js";

/**
 * The result of a one-shot command run inside a node's environment. Mirrors a
 * POSIX process result: `code` is the exit status (0 = success), with stdout
 * and stderr captured as whole strings. A non-zero `code` is NOT thrown — the
 * caller (the NodeRunner / an executor / the in-VM git wrapper) decides whether
 * a non-zero exit is a failure, because for many commands (e.g. `git push`
 * non-fast-forward, a failing test) a non-zero code is an expected, meaningful
 * outcome, not an exception (DESIGN §7.1).
 */
export interface ExecResult {
  /** Process exit code; 0 on success. Non-zero is returned, never thrown. */
  code: number;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
}

/** Options shared by `exec` and `spawn`: working dir + extra env for the command. */
export interface ExecOptions {
  /** Working directory inside the environment for this command. */
  cwd?: string;
  /** Extra environment variables, merged over the VM/host env for this command. */
  env?: Record<string, string>;
  /**
   * Hard wall-clock cap for this command in milliseconds. The runtime kills the
   * command (and its host-side driver) when exceeded — backs the acting-bridge
   * bash tool's advertised per-command timeout so a runaway in-VM command does
   * not hang a node. Omitted = the runtime's generous default.
   */
  timeoutMs?: number;
}

/**
 * A streamed process handle returned by `spawn` (DESIGN §7.4.2 — backs the
 * claude-code executor's `--output-format stream-json` consumption). `stdout`
 * and `stderr` are async iterables of decoded text chunks (line-ish, but not
 * guaranteed line-aligned); `wait()` resolves with the final exit code once the
 * process ends and both streams are drained. `kill()` requests cooperative
 * termination (used by cancel races, DESIGN §7.1a — teardown waits for exit).
 */
export interface SpawnHandle {
  /** Decoded stdout chunks, as they arrive. */
  stdout: AsyncIterable<string>;
  /** Decoded stderr chunks, as they arrive. */
  stderr: AsyncIterable<string>;
  /** Resolves with the process exit code once it exits and streams drain. */
  wait(): Promise<number>;
  /** Request cooperative termination of the running process. */
  kill(): void;
}

/**
 * The file-side-effect surface bound to a single VM (DESIGN §7.4.2). This is the
 * "acting bridge" for engine-model executors — a vLLM/cloud node's `read`/
 * `write` tools are re-pointed here so its file edits land INSIDE the microVM,
 * not on the host (§7.4.1a, the "re-point = reimplement against the VM" note).
 * All paths are absolute paths *inside* the environment.
 */
export interface RuntimeFs {
  /** Read a file inside the environment as UTF-8 text. */
  read(path: string): Promise<string>;
  /** Write a file inside the environment (creates/overwrites), binary-safe. */
  write(path: string, content: string): Promise<void>;
  /** Copy a host file/dir INTO the environment (e.g. seed inputs, mount creds). */
  copyFromHost(hostPath: string, vmPath: string): Promise<void>;
  /** Copy a file/dir OUT of the environment to the host (extract results). */
  copyToHost(vmPath: string, hostPath: string): Promise<void>;
}

/**
 * A handle to a provisioned environment (DESIGN §7.4.2). For the microsandbox
 * backend `name` is the `msb` sandbox name (our control identity for every
 * `exec`/`cp`/`stop`/`rm`). It carries the `spec` it was provisioned from so
 * later stages (mount/init/teardown) can read image/branch/creds/onSuccess
 * without threading the spec separately, and a free-form `meta` bag for
 * backend-specific bookkeeping (e.g. the NoneRuntime's host temp dir).
 */
export interface VmHandle {
  /** The msb sandbox name (microsandbox), or a synthetic id (NoneRuntime). */
  readonly name: string;
  /** The runtime spec this handle was provisioned from. */
  readonly spec: NodeRuntimeSpec;
  /** Backend-specific bookkeeping (e.g. NoneRuntime host dir, vm gateway). */
  readonly meta?: Record<string, unknown>;
}

/** What `mount` attaches to a freshly provisioned VM (DESIGN §7.4.2 stage 2). */
export interface MountSpec {
  /** Host repo path to attach (P2a: recorded only; real checkout is P2c). */
  repo?: string;
  /** Extra host folders to attach into the VM. */
  folders?: { host: string; path: string; mode?: "ro" | "rw" }[];
  /**
   * Secret KEYS to inject as scoped VM env (DESIGN §7.4.7). P2a records them on
   * the handle but does NOT resolve secret VALUES — `resolveSecret`-backed
   * injection is P2c. Values are NEVER baked into source.
   */
  creds?: string[];
  /** Extra plain env to set in the VM. */
  env?: Record<string, string>;
}

/** Cleanup policy applied by `teardown` (DESIGN §7.4.3 `onSuccess` / §7.4.5). */
export type TeardownPolicy = "destroy" | "snapshot" | "keep";

/**
 * The microVM abstraction the NodeRunner drives (DESIGN §7.4.2). One instance
 * is a backend; a fresh `VmHandle` is created per `provision` and threaded
 * through the rest of the calls. Implementations MUST be tolerant of
 * microsandbox's real latency (a full `msb` CLI round-trip is ~8.5 s — DESIGN
 * spike §"Boot latency"); do NOT impose tight internal timeouts.
 */
export interface NodeRuntime {
  /**
   * Stable backend tag for observability/logging (e.g. "microsandbox", "none").
   */
  readonly kind: string;

  /**
   * STAGE 1 — PROVISION. Boot a fresh environment from the node's spec and
   * return a handle. For microsandbox: `msb run -d -n <name> <image>` (a
   * detached microVM kept alive by its init). The returned handle is what every
   * later call addresses.
   */
  provision(spec: NodeRuntimeSpec): Promise<VmHandle>;

  /**
   * STAGE 2 — MOUNT. Attach the repo + extra folders and record creds/env on
   * the VM (DESIGN §7.4.2). P2a: env is applied per-exec; repo/creds are
   * recorded but the real mount/secret-injection is P2c. Never writes secret
   * values into source/files.
   */
  mount(vm: VmHandle, mounts: MountSpec): Promise<void>;

  /**
   * STAGE 3 — INIT. Create/switch to the per-run `branch` from `baseRef` and
   * run the one-time `setup` commands inside the environment (DESIGN §7.4.2/
   * §7.4.4). P2a: applies `env` and runs `setup` commands if present; the real
   * git checkout/branch creation is P2c (this method exists so the seam is
   * stable, but does not assume a git repo is present in P2a).
   */
  init(
    vm: VmHandle,
    branch?: string,
    env?: Record<string, string>,
    setup?: string[],
  ): Promise<void>;

  /**
   * STAGE 4 helper — run ONE command to completion inside the environment and
   * capture its full output (DESIGN §7.4.2 → `msb exec`). A non-zero exit code
   * is returned in `ExecResult.code`, NOT thrown.
   */
  exec(vm: VmHandle, cmd: string, opts?: ExecOptions): Promise<ExecResult>;

  /**
   * STAGE 4 helper — start a long-running command and stream its stdout/stderr
   * (DESIGN §7.4.2 → `msb exec` streamed; backs claude `--output-format
   * stream-json`). Returns a handle whose streams are consumed live and whose
   * `wait()` resolves with the exit code.
   */
  spawn(vm: VmHandle, cmd: string, opts?: ExecOptions): SpawnHandle;

  /**
   * The file-side-effect surface bound to this VM (DESIGN §7.4.2). The acting
   * bridge for engine-model executors and the result-extraction path.
   */
  fs(vm: VmHandle): RuntimeFs;

  /**
   * Map an in-VM port to a host-reachable URL (DESIGN §7.4.2). NOT needed by the
   * chosen v2 design (claude runs via `spawn`+stream-json, not a bridge port),
   * so implementations MAY throw "not supported in P2a". It stays on the
   * interface only for a future bridge-style executor.
   */
  getPortUrl(vm: VmHandle, port: number): Promise<string>;

  /**
   * Snapshot the current environment state for warm re-start / inspection
   * (DESIGN §7.4.2 → `msb snapshot create`). Returns a snapshot reference
   * (name/path). For microsandbox the VM must be stopped first; the
   * implementation handles that.
   */
  snapshot(vm: VmHandle): Promise<string>;

  /**
   * STAGE 7 — TEARDOWN. Dispose of the environment per `policy` (DESIGN §7.4.2/
   * §7.4.5): "destroy" = stop + remove the VM (the per-run branch survives only
   * via push, §7.1a); "snapshot" = snapshot then remove (keep the artifact for
   * inspection); "keep" = leave it running/stopped for manual inspection.
   */
  teardown(vm: VmHandle, policy: TeardownPolicy): Promise<void>;
}
