// MsbRuntime — the microVM backend driven through the host-side microsandbox
// SDK bridge (DESIGN §7.0/§7.4.2, "Form B"). This is the SECOND microVM backend
// alongside MicrosandboxRuntime: same `NodeRuntime` contract, same 7-stage
// lifecycle (provision → mount → init → exec/spawn → fs → teardown), and it
// reuses ALL the existing lifecycle helpers (networking / vm-creds / vm-setup /
// git-wrapper) UNCHANGED because they are written against `runtime.exec`/`fs`.
//
// WHY A SEPARATE BACKEND: the `microsandbox` npm SDK is a native NAPI addon that
// boots the microVM IN-PROCESS via libkrun, which needs `/dev/kvm`. The
// orchestrator runs inside the `an-orchestrator` Docker container with no
// `/dev/kvm`, so it CANNOT load the SDK. Instead the SDK runs in a small host
// service (`server/runtime/msb-bridge/server.mjs`) and this runtime drives it
// over HTTP. The transport is the only difference from MicrosandboxRuntime:
//   • provision  → POST   /v1/sandbox                       (create from prebaked image)
//   • exec       → POST   /v1/sandbox/:name/exec            (buffered one-shot)
//   • spawn      → POST   /v1/sandbox/:name/exec-stream     (SSE → SpawnHandle)
//   • fs.read    → GET    /v1/sandbox/:name/fs/read
//   • fs.write   → POST   /v1/sandbox/:name/fs/write        (base64, binary-safe)
//   • fs.copy*   → POST   /v1/sandbox/:name/copy-from-host  (host→guest)
//   • teardown   → DELETE /v1/sandbox/:name                 (FORCE by name)
//   • health     → GET    /v1/health
//
// GATING: this backend is ACTIVE only when `ORCH_MSB_BRIDGE_URL` is set
// (`runtimeForSpec` falls back to MicrosandboxRuntime otherwise), so host-native
// deployments keep working unchanged. The container is wired with
// ORCH_MSB_BRIDGE_URL=http://host.docker.internal:8730 + ORCH_MSB_BRIDGE_TOKEN.
//
// PROVEN on this host (2026-06-26): create from the prebaked image in ~0.5s;
// guest kernel 6.12.68 ≠ host 6.6.x-WSL2 (real VM boundary); execStream is
// incremental (SSE flush-per-frame); fs roundtrip; force teardown ~0.11s.

import { newId } from "../../actions/_util.js";
import type {
  ExecOptions,
  ExecResult,
  MountSpec,
  NodeRuntime,
  RuntimeFs,
  SpawnHandle,
  TeardownPolicy,
  VmHandle,
} from "./node-runtime.js";
import type { NodeRuntimeSpec } from "../../shared/types.js";
import { resolveEgress } from "./networking.js";
import { mountVmCredentials, VM_HOME } from "./vm-creds.js";
import { ensureToolchain, type ToolchainNeeds } from "./vm-setup.js";
import {
  checkoutRunBranch,
  cloneRepo,
  type GitContext,
} from "./git-wrapper.js";

/**
 * True when `image` is a prebaked worker image that already carries the full
 * toolchain, so INIT must NOT run `ensureToolchain` (the whole point of the
 * bake). We treat any non-bare-OS ref as prebaked: only the bare bases
 * (`alpine`/`ubuntu`/`debian`/`busybox`, optionally tagged) still cold-install.
 * A custom ORCH_WORKER_IMAGE / a registry-qualified ref is always prebaked.
 * (Self-contained here so MsbRuntime does not depend on the legacy CLI runtime.)
 */
export function isPrebakedImage(image: string | undefined): boolean {
  const ref = (image ?? "").trim();
  if (ref === "") return false;
  const bareBases = /^(alpine|ubuntu|debian|busybox)(:[^/]*)?$/i;
  return !bareBases.test(ref);
}

/**
 * The PREBAKED worker image booted by every node (DESIGN §7.4.8). Built by
 * `server/runtime/msb-bridge/worker-image/Dockerfile`, pushed to the local
 * registry, and pulled into msb's cache, so a node boots straight into work with
 * NO per-task apk/npm install. Override with ORCH_WORKER_IMAGE (the container is
 * wired with this already).
 */
const DEFAULT_IMAGE =
  process.env.ORCH_WORKER_IMAGE && process.env.ORCH_WORKER_IMAGE.trim() !== ""
    ? process.env.ORCH_WORKER_IMAGE.trim()
    : "localhost:5000/an-worker:latest";

/** The host bridge base URL (e.g. http://host.docker.internal:8730), trimmed. */
function bridgeBase(): string {
  const u = process.env.ORCH_MSB_BRIDGE_URL ?? "";
  const trimmed = u.replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error(
      "MsbRuntime requires ORCH_MSB_BRIDGE_URL to point at the host SDK bridge",
    );
  }
  return trimmed;
}

/** The bearer token the bridge requires (empty if unset). */
function bridgeToken(): string {
  return process.env.ORCH_MSB_BRIDGE_TOKEN ?? "";
}

function bridgeHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...extra };
  const t = bridgeToken();
  if (t) h["authorization"] = `Bearer ${t}`;
  return h;
}

/** A generous default; an in-VM command can run minutes (toolchain, tests). */
const DEFAULT_TIMEOUT_MS = 600_000;

// ── meta keys (same shape MicrosandboxRuntime uses) ──────────────────────────

const RUNTIME_ENV_META_KEY = "runtimeEnv";

function runtimeEnvOf(vm: VmHandle): Record<string, string> {
  const env = vm.meta?.[RUNTIME_ENV_META_KEY];
  return env && typeof env === "object" ? (env as Record<string, string>) : {};
}
function setRuntimeEnv(vm: VmHandle, env: Record<string, string>): void {
  if (vm.meta) vm.meta[RUNTIME_ENV_META_KEY] = env;
}

/** Decide which tools a node needs (mirrors MicrosandboxRuntime). */
function toolchainNeedsFor(vm: VmHandle): ToolchainNeeds {
  const wantClaude =
    vm.spec.env?.ORCHESTRATOR_WANT_CLAUDE === "1" ||
    runtimeEnvOf(vm).ORCHESTRATOR_WANT_CLAUDE === "1";
  return { node: wantClaude, git: true, claude: wantClaude };
}

/**
 * Merge the VM's persisted runtime env (egress + creds + HOME) UNDER the caller's
 * per-command env so explicit overrides win but every command inherits
 * DNS/proxy/HOME/GITHUB_TOKEN by default (DESIGN §7.4.7/§7.4.9).
 */
function withRuntimeEnv(
  vm: VmHandle,
  opts: ExecOptions | undefined,
): ExecOptions | undefined {
  const base = runtimeEnvOf(vm);
  if (Object.keys(base).length === 0) return opts;
  return { ...opts, env: { ...base, ...(opts?.env ?? {}) } };
}

/**
 * Hosts that must bypass the forward-proxy (§7.4.9): the vLLM endpoint stays
 * DIRECT so a vLLM node reaches the host engine without the proxy.
 */
function noProxyHostsFor(
  spec: NodeRuntimeSpec,
  mountEnv?: Record<string, string>,
): string[] {
  const env = { ...(spec.env ?? {}), ...(mountEnv ?? {}) };
  const urls = [env.OPENAI_BASE_URL, env.VLLM_BASE_URL].filter(
    (u): u is string => typeof u === "string" && u.trim() !== "",
  );
  const hosts: string[] = [];
  for (const u of urls) {
    try {
      hosts.push(new URL(u).hostname);
    } catch {
      /* ignore malformed url */
    }
  }
  return hosts;
}

// ── the runtime ──────────────────────────────────────────────────────────────

export class MsbRuntime implements NodeRuntime {
  readonly kind = "microsandbox-sdk";

  /**
   * STAGE 1 — PROVISION. POST /v1/sandbox → the bridge boots a detached microVM
   * from the prebaked image and returns its name. We pass our chosen name so the
   * control identity is stable across every later call.
   */
  async provision(spec: NodeRuntimeSpec): Promise<VmHandle> {
    if (spec.kind !== "microvm") {
      throw new Error(
        `MsbRuntime.provision called with kind="${spec.kind}"; use NoneRuntime for non-microvm nodes`,
      );
    }
    const image =
      spec.image && spec.image.trim() !== "" ? spec.image : DEFAULT_IMAGE;
    // sandbox names allow [a-z0-9-]; newId() yields lowercase+digits.
    const name = newId("an-node").replace(/_/g, "-");

    const body: Record<string, unknown> = { image, name };
    if (spec.resources?.cpus) body.cpus = spec.resources.cpus;
    if (spec.resources?.memMB) body.memMb = spec.resources.memMB;

    const res = await fetch(`${bridgeBase()}/v1/sandbox`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `provision failed (bridge ${res.status}): ${text.slice(0, 400)}`,
      );
    }
    const json = (await res.json()) as { name?: string };
    const sandboxName = json.name && json.name.trim() !== "" ? json.name : name;
    return {
      name: sandboxName,
      spec,
      meta: { image, [RUNTIME_ENV_META_KEY]: {} },
    };
  }

  /**
   * STAGE 2 — MOUNT (DESIGN §7.4.7/§7.4.9). Identical policy to
   * MicrosandboxRuntime: fix DNS + decide direct-vs-proxy egress (keeping the
   * host vLLM direct), resolve GITHUB_TOKEN from the Vault as scoped VM env, and
   * stash the combined runtime env on the handle's meta so every later
   * exec/spawn inherits it. Secret VALUES live only in that in-process map.
   */
  async mount(vm: VmHandle, mounts: MountSpec): Promise<void> {
    for (const folder of mounts.folders ?? []) {
      const res = await this.exec(vm, `mkdir -p ${shArg(folder.path)}`);
      if (res.code !== 0) {
        throw new Error(
          `mount: mkdir ${folder.path} failed (code ${res.code}): ${res.stderr}`,
        );
      }
    }

    const vllmHosts = noProxyHostsFor(vm.spec, mounts.env);
    const egress = await resolveEgress(this, vm, { noProxyHosts: vllmHosts });

    const creds = await mountVmCredentials(vm, {
      home: VM_HOME,
      nodeRunId: (vm.meta?.nodeRunId as string | undefined) ?? null,
    });

    const runtimeEnv: Record<string, string> = {
      HOME: VM_HOME,
      ...(mounts.env ?? {}),
      ...egress.env,
      ...creds.env,
    };
    setRuntimeEnv(vm, runtimeEnv);

    if (vm.meta) {
      vm.meta.egress = {
        gateway: egress.gateway,
        directEgress: egress.directEgress,
        proxyUrl: egress.proxyUrl,
      };
      vm.meta.creds = {
        claudeMounted: creds.claudeMounted,
        githubTokenPresent: creds.githubTokenPresent,
      };
    }
    void mounts.repo;
  }

  /**
   * STAGE 3 — INIT (DESIGN §7.4.4/§7.4.8/§7.1a). Identical to MicrosandboxRuntime:
   *   1. SKIP toolchain for a prebaked image (the whole point of the bake); the
   *      bare-alpine fallback cold-installs via the wired egress.
   *   2. CLONE the project repo in-VM via git-wrapper (short-lived GITHUB_TOKEN)
   *      and pick up the run branch if a prior node already pushed to it.
   *   3. CHECKOUT the per-run branch from baseRef when not already picked up.
   *   4. run the one-time `setup` commands.
   */
  async init(
    vm: VmHandle,
    branch?: string,
    env?: Record<string, string>,
    setup?: string[],
  ): Promise<void> {
    const baseEnv = runtimeEnvOf(vm);
    const runEnv: Record<string, string> = { ...(env ?? {}), ...baseEnv };
    setRuntimeEnv(vm, runEnv);

    const image = (vm.meta?.image as string | undefined) ?? vm.spec.image;
    if (isPrebakedImage(image)) {
      if (vm.meta) vm.meta.toolchain = { prebaked: true, image, installed: false };
    } else {
      const tc = await ensureToolchain(this, vm, toolchainNeedsFor(vm), runEnv);
      if (vm.meta)
        vm.meta.toolchain = { prebaked: false, image, installed: tc.installed };
    }

    const workdir =
      (vm.meta?.workdir as string | undefined) ??
      vm.spec.mounts?.find((m) => m.mode === "rw")?.path ??
      "/work";
    const gitCtx: GitContext = { runtime: this, vm, workdir, env: runEnv };

    let branchPickedUp = false;
    if (vm.spec.gitRemote && vm.spec.gitRemote.trim() !== "") {
      const cloned = await cloneRepo(gitCtx, { remoteUrl: vm.spec.gitRemote, branch });
      if (!cloned.cloned) {
        throw new Error(
          `init: clone ${vm.spec.gitRemote} failed (${cloned.reason}): ${cloned.detail}`,
        );
      }
      branchPickedUp = cloned.branchPickedUp;
    }

    if (branch && branch.trim() !== "" && !branchPickedUp) {
      await checkoutRunBranch(gitCtx, { branch, baseRef: vm.spec.baseRef });
    }

    for (const cmd of setup ?? []) {
      const res = await this.exec(vm, cmd, { env: runEnv });
      if (res.code !== 0) {
        throw new Error(
          `init: setup command failed (code ${res.code}): ${cmd}\n${res.stderr}`,
        );
      }
    }
  }

  /**
   * STAGE 4 — one-shot command. POST /v1/sandbox/:name/exec. We run through
   * `sh -lc "<cmd>"` (cmd is the program, the user command is one arg) so shell
   * features work and a single command string is accepted — exactly like
   * MicrosandboxRuntime's `msb exec … -- sh -lc <body>`.
   */
  async exec(vm: VmHandle, cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const o = withRuntimeEnv(vm, opts);
    const body = this.execBody(cmd, o);
    const timeoutMs = o?.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 30_000);
    try {
      const res = await fetch(
        `${bridgeBase()}/v1/sandbox/${encodeURIComponent(vm.name)}/exec`,
        {
          method: "POST",
          headers: bridgeHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // A bridge-level failure (not an in-VM non-zero exit) is surfaced as a
        // failed ExecResult so callers see the detail; never throw a non-zero exit.
        return { code: -1, stdout: "", stderr: `exec bridge ${res.status}: ${text.slice(0, 400)}` };
      }
      const json = (await res.json()) as Partial<ExecResult> & { error?: string; detail?: string };
      if (json.error) {
        return { code: -1, stdout: "", stderr: `${json.error}: ${json.detail ?? ""}` };
      }
      return {
        code: typeof json.code === "number" ? json.code : -1,
        stdout: typeof json.stdout === "string" ? json.stdout : "",
        stderr: typeof json.stderr === "string" ? json.stderr : "",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * STAGE 4 — streamed command. POST /v1/sandbox/:name/exec-stream (SSE) decoded
   * into the SpawnHandle contract so the live `spawn_events` capture + run-detail
   * timeline keep working unchanged. Backs claude `--output-format stream-json`.
   */
  spawn(vm: VmHandle, cmd: string, opts?: ExecOptions): SpawnHandle {
    const o = withRuntimeEnv(vm, opts);
    const body = this.execBody(cmd, o);
    return sseSpawn(
      `${bridgeBase()}/v1/sandbox/${encodeURIComponent(vm.name)}/exec-stream`,
      body,
      bridgeHeaders(),
    );
  }

  /** Build the {cmd:"sh", args:["-lc", body], cwd, env, timeoutMs} request body. */
  private execBody(cmd: string, opts: ExecOptions | undefined): Record<string, unknown> {
    // cd into cwd belt-and-braces (the SDK also honors `cwd`); harmless if unset.
    const body = opts?.cwd ? `cd ${shArg(opts.cwd)} && ${cmd}` : cmd;
    const out: Record<string, unknown> = { cmd: "sh", args: ["-lc", body] };
    if (opts?.cwd) out.cwd = opts.cwd;
    if (opts?.env && Object.keys(opts.env).length > 0) out.env = opts.env;
    if (opts?.timeoutMs && opts.timeoutMs > 0) out.timeoutMs = opts.timeoutMs;
    return out;
  }

  /** The VM-bound file surface — the acting bridge + extraction path. */
  fs(vm: VmHandle): RuntimeFs {
    const base = bridgeBase();
    const name = encodeURIComponent(vm.name);
    return {
      read: async (path: string): Promise<string> => {
        const res = await fetch(
          `${base}/v1/sandbox/${name}/fs/read?path=${encodeURIComponent(path)}`,
          { method: "GET", headers: bridgeHeaders() },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`fs.read ${path} failed (bridge ${res.status}): ${text.slice(0, 300)}`);
        }
        const json = (await res.json()) as { contentB64?: string };
        return Buffer.from(json.contentB64 ?? "", "base64").toString("utf8");
      },
      write: async (path: string, content: string): Promise<void> => {
        const res = await fetch(`${base}/v1/sandbox/${name}/fs/write`, {
          method: "POST",
          headers: bridgeHeaders(),
          body: JSON.stringify({
            path,
            contentB64: Buffer.from(content, "utf8").toString("base64"),
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`fs.write ${path} failed (bridge ${res.status}): ${text.slice(0, 300)}`);
        }
      },
      copyFromHost: async (hostPath: string, vmPath: string): Promise<void> => {
        const res = await fetch(`${base}/v1/sandbox/${name}/copy-from-host`, {
          method: "POST",
          headers: bridgeHeaders(),
          body: JSON.stringify({ hostPath, guestPath: vmPath }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `fs.copyFromHost ${hostPath} → ${vmPath} failed (bridge ${res.status}): ${text.slice(0, 300)}`,
          );
        }
      },
      copyToHost: async (vmPath: string, hostPath: string): Promise<void> => {
        // Read the guest file via the bridge and write it on the host (the bridge
        // runs on the host, but THIS runtime runs in the container — so we stream
        // the bytes back and write them locally).
        const text = await this.fs(vm).read(vmPath);
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, text, "utf8");
      },
    };
  }

  /** Not needed by the chosen design (claude streams via spawn, not a port). */
  async getPortUrl(_vm: VmHandle, _port: number): Promise<string> {
    throw new Error("getPortUrl is not supported by MsbRuntime (DESIGN §7.4.2)");
  }

  /** Snapshot is an MVP no-op for the SDK bridge (the bridge exposes no snapshot endpoint yet). */
  async snapshot(_vm: VmHandle): Promise<string> {
    throw new Error("snapshot is not supported by MsbRuntime (MVP — no bridge endpoint)");
  }

  /**
   * STAGE 7 — TEARDOWN. DELETE /v1/sandbox/:name → the bridge force-removes the
   * sandbox BY NAME (stopWithTimeout(0) + remove). "keep" leaves it for
   * inspection; "snapshot" is unsupported (MVP) and falls back to destroy.
   */
  async teardown(vm: VmHandle, policy: TeardownPolicy): Promise<void> {
    if (policy === "keep") return;
    const res = await fetch(
      `${bridgeBase()}/v1/sandbox/${encodeURIComponent(vm.name)}`,
      { method: "DELETE", headers: bridgeHeaders() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `teardown: DELETE ${vm.name} failed (bridge ${res.status}): ${text.slice(0, 300)}`,
      );
    }
  }
}

/**
 * Health gate for the SDK bridge: GET /v1/health → { ok }. Used by `msbAvailable`
 * style checks so the engine only routes to this backend when the host bridge is
 * reachable and KVM is up.
 */
export async function msbBridgeAvailable(): Promise<boolean> {
  const u = process.env.ORCH_MSB_BRIDGE_URL ?? "";
  const base = u.replace(/\/+$/, "");
  if (!base) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(`${base}/v1/health`, {
      method: "GET",
      headers: bridgeHeaders(),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean };
    return json.ok === true;
  } catch {
    return false;
  }
}

/** Single-quote a value for safe interpolation into the in-VM POSIX shell. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── SSE → SpawnHandle decoder ────────────────────────────────────────────────

/**
 * Drive the bridge's SSE exec-stream and expose it as a {@link SpawnHandle}. The
 * bridge emits `event: started|stdout|stderr|exited` with a JSON `data:` payload;
 * stdout/stderr carry base64 (`{b64}`) so any bytes round-trip. Each frame is
 * flushed by the bridge as it arrives, so the in-container consumer's transcript
 * grows live. `kill()` aborts the fetch → the bridge kills the SDK exec.
 */
function sseSpawn(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): SpawnHandle {
  const controller = new AbortController();
  const stdoutQ = new ChunkQueue();
  const stderrQ = new ChunkQueue();

  let exitResolve: ((code: number) => void) | null = null;
  let exitReject: ((err: Error) => void) | null = null;
  let exitCode: number | null = null;
  let exitErr: Error | null = null;
  let settled = false;
  const waitPromise = new Promise<number>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });
  waitPromise.catch(() => {});

  const settle = (code: number | null, err: Error | null) => {
    if (settled) return;
    settled = true;
    stdoutQ.end();
    stderrQ.end();
    if (err) {
      exitErr = err;
      exitReject?.(err);
    } else {
      exitCode = code ?? -1;
      exitResolve?.(exitCode);
    }
  };

  void (async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...headers, accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      settle(null, asError(err, "msb bridge exec-stream connect failed"));
      return;
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      settle(null, new Error(`msb bridge exec-stream ${response.status}: ${text.slice(0, 300)}`));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf8");
    let buffer = "";
    let sawExit = false;

    // Parse SSE frames separated by a blank line; each frame has an `event:` and
    // a `data:` line.
    const handleFrame = (raw: string) => {
      let event = "message";
      let data = "";
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data === "" && event === "message") return;
      let payload: { b64?: string; code?: number; pid?: number; message?: string } = {};
      try {
        payload = data ? JSON.parse(data) : {};
      } catch {
        return;
      }
      if (event === "stdout" && typeof payload.b64 === "string") {
        stdoutQ.push(Buffer.from(payload.b64, "base64").toString("utf8"));
      } else if (event === "stderr" && typeof payload.b64 === "string") {
        stderrQ.push(Buffer.from(payload.b64, "base64").toString("utf8"));
      } else if (event === "exited") {
        sawExit = true;
        settle(typeof payload.code === "number" ? payload.code : -1, null);
      } else if (event === "error" && payload.message) {
        // Surface the error on stderr; the trailing `exited` settles the code.
        stderrQ.push(`[bridge] ${payload.message}\n`);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        // SSE frames end with a blank line ("\n\n").
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleFrame(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() !== "") handleFrame(buffer);
      if (!sawExit) settle(-1, null);
    } catch (err) {
      if (controller.signal.aborted) settle(-1, null);
      else settle(null, asError(err, "msb bridge exec-stream read failed"));
    }
  })();

  return {
    stdout: stdoutQ.iterable(),
    stderr: stderrQ.iterable(),
    wait: () => {
      if (exitErr) return Promise.reject(exitErr);
      if (exitCode !== null) return Promise.resolve(exitCode);
      return waitPromise;
    },
    kill: () => {
      if (!settled) controller.abort();
    },
  };
}

/**
 * A tiny backpressured producer/consumer queue (same contract as wsl-msb's): the
 * SpawnHandle stdout/stderr async-iterables yield chunks in order, awaiting when
 * empty and draining on end.
 */
class ChunkQueue {
  private chunks: string[] = [];
  private ended = false;
  private resolveNext: (() => void) | null = null;

  push(chunk: string): void {
    if (this.ended) return;
    this.chunks.push(chunk);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  private wake(): void {
    const r = this.resolveNext;
    if (r) {
      this.resolveNext = null;
      r();
    }
  }
  async *iterable(): AsyncIterable<string> {
    for (;;) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift() as string;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
  }
}

function asError(err: unknown, context: string): Error {
  if (err instanceof Error) return new Error(`${context}: ${err.message}`);
  return new Error(`${context}: ${String(err)}`);
}
