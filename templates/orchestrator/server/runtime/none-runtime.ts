// NoneRuntime — the no-VM backend (DESIGN §7.4.2). For PURE-REASONING nodes
// only: branch conditions and planners that have no file/git side effects. It
// is the P2 replacement for P1's echo path on no-side-effect nodes — there is
// real exec/fs here, but it runs on the HOST (no microVM boundary), scoped to a
// per-handle temp directory so any incidental file writes are contained and
// disposable.
//
// IMPORTANT: this backend gives NO isolation. The scheduler/NodeRunner must only
// route a node here when `runtime.kind === "none"`, i.e. the node provably does
// no untrusted code execution and no repo/git work. Anything that runs tools,
// edits a repo, or runs an agent uses MicrosandboxRuntime (DESIGN §7.0).

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** A generous default; host commands here are lightweight (no VM boot). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolve an in-"VM" path against the handle's scoped temp root. Absolute paths
 * are re-rooted under the temp dir (so `/tmp/x` becomes `<root>/tmp/x`) — the
 * NoneRuntime never touches arbitrary host locations outside its scope, which
 * keeps "no side effects" honest even though it runs on the host.
 */
function scopedPath(root: string, p: string): string {
  const rel = isAbsolute(p) ? p.replace(/^[/\\]+/, "") : p;
  const full = resolve(root, rel);
  // Defense in depth: never let `..` escape the scoped root.
  if (
    full !== root &&
    !full.startsWith(root + (root.endsWith("/") ? "" : "/"))
  ) {
    throw new Error(`NoneRuntime: path escapes scope: ${p}`);
  }
  return full;
}

export class NoneRuntime implements NodeRuntime {
  readonly kind = "none";

  /** STAGE 1 — PROVISION. No VM: just a disposable scoped temp dir. */
  async provision(spec: NodeRuntimeSpec): Promise<VmHandle> {
    const root = await mkdtemp(join(tmpdir(), "an-none-"));
    return { name: `none-${root}`, spec, meta: { root } };
  }

  /** STAGE 2 — MOUNT. Copy any folders/repo into the scoped root (host cp). */
  async mount(vm: VmHandle, mounts: MountSpec): Promise<void> {
    const root = this.rootOf(vm);
    for (const folder of mounts.folders ?? []) {
      const dest = scopedPath(root, folder.path);
      await mkdir(dirname(dest), { recursive: true });
      await cp(folder.host, dest, { recursive: true });
    }
    // repo/creds/env are not meaningful for a pure-reasoning node; ignored.
    void mounts.repo;
    void mounts.creds;
    void mounts.env;
  }

  /** STAGE 3 — INIT. Run any `setup` commands on the host in the scoped root. */
  async init(
    vm: VmHandle,
    branch?: string,
    env?: Record<string, string>,
    setup?: string[],
  ): Promise<void> {
    void branch; // no git in a none-runtime node
    for (const cmd of setup ?? []) {
      const res = await this.exec(vm, cmd, { env });
      if (res.code !== 0) {
        throw new Error(
          `NoneRuntime init: setup failed (code ${res.code}): ${cmd}\n${res.stderr}`,
        );
      }
    }
  }

  /** STAGE 4 — one-shot host command, cwd defaulted to the scoped root. */
  async exec(
    vm: VmHandle,
    cmd: string,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const root = this.rootOf(vm);
    const cwd = opts?.cwd ? scopedPath(root, opts.cwd) : root;
    return new Promise<ExecResult>((resolveExec, reject) => {
      const child = spawn(cmd, {
        cwd,
        shell: true,
        env: { ...process.env, ...(opts?.env ?? {}) },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`NoneRuntime.exec timed out: ${cmd}`));
      }, DEFAULT_TIMEOUT_MS);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => (stdout += c));
      child.stderr?.on("data", (c: string) => (stderr += c));
      child.on("error", (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExec({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /** STAGE 4 — streamed host command. */
  spawn(vm: VmHandle, cmd: string, opts?: ExecOptions): SpawnHandle {
    const root = this.rootOf(vm);
    const cwd = opts?.cwd ? scopedPath(root, opts.cwd) : root;
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: { ...process.env, ...(opts?.env ?? {}) },
      windowsHide: true,
    });

    let exitCode: number | null = null;
    let exitErr: Error | null = null;
    const waitPromise = new Promise<number>((resolveWait, reject) => {
      child.on("error", (err: unknown) => {
        exitErr = err instanceof Error ? err : new Error(String(err));
        reject(exitErr);
      });
      child.on("close", (code: number | null) => {
        exitCode = code ?? -1;
        resolveWait(exitCode);
      });
    });
    waitPromise.catch(() => {});

    async function* decode(
      stream: NodeJS.ReadableStream | null,
    ): AsyncIterable<string> {
      if (!stream) return;
      stream.setEncoding("utf8");
      for await (const chunk of stream) {
        yield typeof chunk === "string" ? chunk : String(chunk);
      }
    }

    return {
      stdout: decode(child.stdout),
      stderr: decode(child.stderr),
      wait: () => {
        if (exitErr) return Promise.reject(exitErr);
        if (exitCode !== null) return Promise.resolve(exitCode);
        return waitPromise;
      },
      kill: () => {
        if (exitCode === null) child.kill("SIGTERM");
      },
    };
  }

  /** Host fs scoped to the handle's temp root. */
  fs(vm: VmHandle): RuntimeFs {
    const root = this.rootOf(vm);
    return {
      read: (path: string) => readFile(scopedPath(root, path), "utf8"),
      write: async (path: string, content: string): Promise<void> => {
        const full = scopedPath(root, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      },
      copyFromHost: async (hostPath: string, vmPath: string): Promise<void> => {
        const dest = scopedPath(root, vmPath);
        await mkdir(dirname(dest), { recursive: true });
        await cp(hostPath, dest, { recursive: true });
      },
      copyToHost: async (vmPath: string, hostPath: string): Promise<void> => {
        await mkdir(dirname(resolve(hostPath)), { recursive: true });
        await cp(scopedPath(root, vmPath), resolve(hostPath), {
          recursive: true,
        });
      },
    };
  }

  /** No ports without a VM. */
  async getPortUrl(_vm: VmHandle, _port: number): Promise<string> {
    throw new Error("getPortUrl is not supported by NoneRuntime (no VM)");
  }

  /** Nothing to snapshot — a pure-reasoning node has no durable VM state. */
  async snapshot(_vm: VmHandle): Promise<string> {
    throw new Error("snapshot is not supported by NoneRuntime (no VM)");
  }

  /** STAGE 7 — TEARDOWN. Remove the scoped temp dir unless "keep". */
  async teardown(vm: VmHandle, policy: TeardownPolicy): Promise<void> {
    if (policy === "keep") return;
    const root = this.rootOf(vm);
    await rm(root, { recursive: true, force: true });
  }

  /** Read the scoped root recorded on the handle, with a clear error if absent. */
  private rootOf(vm: VmHandle): string {
    const root = vm.meta?.root;
    if (typeof root !== "string") {
      throw new Error(
        "NoneRuntime: handle has no scoped root (not provisioned)",
      );
    }
    return root;
  }
}
