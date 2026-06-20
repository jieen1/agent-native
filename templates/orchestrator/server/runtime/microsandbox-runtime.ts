// MicrosandboxRuntime — the real microVM backend (DESIGN §7.0/§7.4.2).
// Implements `NodeRuntime` by driving the `msb` CLI inside WSL2 (the
// orchestrator runs on Windows; libkrun/KVM only run in WSL — see `wsl-msb.ts`).
// microsandbox is the SOLE microVM backend; there is no Docker/Podman/E2B path.
//
// P2a scope: provision / exec / spawn / fs / snapshot / teardown are fully real
// against a live alpine microVM. `mount` and `init` exist and apply env + run
// setup, but the real repo mount + git branch checkout + secret-value injection
// are P2c — `mount` records repo/creds on the handle without resolving secret
// values, and `init` does NOT assume a git repo is present. Documented inline.
//
// Verified msb 0.5.7 facts this build relies on (real probe, 2026-06-20):
//   • `msb run -d -n <name> <image>` (NO trailing command) boots a DETACHED
//     microVM that stays alive via its init and honors our `-n <name>`. (A
//     trailing `-- cmd` in `-d` mode is NOT run and makes msb fall back to the
//     host hostname as the sandbox name — so we never pass a `-- cmd` here.)
//   • The VM kernel (libkrun, e.g. 6.12.68) differs from the WSL host kernel
//     (6.6.x-microsoft-standard-WSL2) — proof of a real VM boundary.
//   • `msb exec <name> -- …`, `-w <cwd>`, `-e K=V`, `msb cp SRC DST` (with
//     `SANDBOX:/path`), `msb snapshot create --from <name> <dest>` (sandbox
//     must be STOPPED first), `msb stop`, `msb rm -f`, `msb list -q` all work.

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
import { shArg, wslMsb, wslMsbStream, type WslMsbOptions } from "./wsl-msb.js";

/** Default node image until the prebaked image lands (DESIGN §7.4.8, P2c). */
const DEFAULT_IMAGE = "alpine";

/**
 * Build the `sh -lc` argv tail for an in-VM command, applying `cwd` by `cd`-ing
 * first (portable across images; `-w` is also passed, this is belt-and-braces)
 * and leaving env to msb's `-e` flags. We always run the command through
 * `sh -lc` so shell features in the caller's `cmd` work and a single string is
 * accepted.
 */
function execArgs(
  name: string,
  cmd: string,
  opts: ExecOptions | undefined,
): string[] {
  const flags: string[] = [];
  if (opts?.cwd) flags.push("-w", opts.cwd);
  for (const [key, value] of Object.entries(opts?.env ?? {})) {
    flags.push("-e", `${key}=${value}`);
  }
  // `cd <cwd> &&` is redundant with `-w` but guarantees cwd even on images
  // where `-w` is a soft hint; harmless when cwd is unset.
  const body = opts?.cwd ? `cd ${shArg(opts.cwd)} && ${cmd}` : cmd;
  return ["exec", name, ...flags, "--", "sh", "-lc", body];
}

/**
 * Convert a Windows host path (`E:\a\b` or `E:/a/b`) to the WSL path msb sees
 * (`/mnt/e/a/b`). A path that already looks POSIX (`/…` or `~…`) is returned
 * unchanged — callers running inside WSL may already pass WSL paths. This is a
 * best-effort mapping for `msb cp`, whose process runs in WSL.
 */
export function toWslPath(hostPath: string): string {
  if (hostPath.startsWith("/") || hostPath.startsWith("~")) return hostPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (!m) return hostPath.replace(/\\/g, "/");
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export class MicrosandboxRuntime implements NodeRuntime {
  readonly kind = "microsandbox";

  /** Per-call timeout override (CLI is ~8.5 s/round-trip; generous default). */
  private readonly opts: WslMsbOptions;

  constructor(opts: WslMsbOptions = {}) {
    this.opts = opts;
  }

  /**
   * STAGE 1 — PROVISION. `msb run -d -n <name> <image>`. We generate the
   * sandbox name ourselves so we never depend on parsing msb's stdout (which,
   * in `-d` mode with a trailing command, falls back to the host hostname). The
   * printed name is still parsed as a sanity check and recorded.
   */
  async provision(spec: NodeRuntimeSpec): Promise<VmHandle> {
    if (spec.kind !== "microvm") {
      throw new Error(
        `MicrosandboxRuntime.provision called with kind="${spec.kind}"; ` +
          `use NoneRuntime for non-microvm nodes`,
      );
    }
    const image =
      spec.image && spec.image.trim() !== "" ? spec.image : DEFAULT_IMAGE;
    // msb sandbox names allow [a-z0-9-]; newId() yields lowercase+digits.
    const name = newId("an-node").replace(/_/g, "-");

    const args = ["run", "-d", "-n", name];
    if (spec.resources?.cpus) args.push("-c", String(spec.resources.cpus));
    if (spec.resources?.memMB) args.push("-m", `${spec.resources.memMB}M`);
    args.push(image);

    const res = await wslMsb(args, this.opts);
    if (res.code !== 0) {
      throw new Error(
        `provision failed (msb run, code ${res.code}): ${res.stderr || res.stdout}`,
      );
    }
    // Sanity: the last non-warning stdout line should echo our chosen name.
    const printed = lastNonEmptyLine(res.stdout);
    return {
      name,
      spec,
      meta: { image, printedName: printed },
    };
  }

  /**
   * STAGE 2 — MOUNT. P2a: applies extra plain `env` (recorded on the handle for
   * later execs via the executor; msb has no "set persistent env on a running
   * VM" call, so env is threaded per-exec by the NodeRunner) and records
   * repo/folders/creds for P2c. Secret VALUES are NOT resolved here and never
   * written to source. Real `--mount-dir` + `resolveSecret` injection is P2c.
   */
  async mount(vm: VmHandle, mounts: MountSpec): Promise<void> {
    // P2a no-op-with-bookkeeping: stash what would be mounted so P2c can wire
    // the real `--mount-dir` / cred injection. We avoid mutating the readonly
    // handle; the NodeRunner owns mount state. For folders we *can* already
    // create their target dirs in the VM so later copies have a destination.
    for (const folder of mounts.folders ?? []) {
      const res = await this.exec(vm, `mkdir -p ${shArg(folder.path)}`);
      if (res.code !== 0) {
        throw new Error(
          `mount: mkdir ${folder.path} failed (code ${res.code}): ${res.stderr}`,
        );
      }
    }
    // repo / creds are intentionally not acted on in P2a (see method doc).
    void mounts.repo;
    void mounts.creds;
    void mounts.env;
  }

  /**
   * STAGE 3 — INIT. P2a: runs the one-time `setup` commands (each via the VM
   * shell, with `env` applied) so a node can install extra deps. The real git
   * `checkout -b <branch> <baseRef>` is P2c — this method does NOT assume a git
   * repo exists, so `branch` is recorded/validated but not acted upon here.
   */
  async init(
    vm: VmHandle,
    branch?: string,
    env?: Record<string, string>,
    setup?: string[],
  ): Promise<void> {
    // branch/baseRef checkout is P2c (needs the repo mount). Recorded only.
    void branch;
    for (const cmd of setup ?? []) {
      const res = await this.exec(vm, cmd, { env });
      if (res.code !== 0) {
        throw new Error(
          `init: setup command failed (code ${res.code}): ${cmd}\n${res.stderr}`,
        );
      }
    }
  }

  /** STAGE 4 — one-shot command. `msb exec <name> -- sh -lc "<cmd>"`. */
  async exec(
    vm: VmHandle,
    cmd: string,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return wslMsb(execArgs(vm.name, cmd, opts), this.opts);
  }

  /** STAGE 4 — streamed command. Backs claude `--output-format stream-json`. */
  spawn(vm: VmHandle, cmd: string, opts?: ExecOptions): SpawnHandle {
    return wslMsbStream(execArgs(vm.name, cmd, opts));
  }

  /** The VM-bound file surface (the acting bridge + extraction path). */
  fs(vm: VmHandle): RuntimeFs {
    const name = vm.name;
    const opts = this.opts;
    return {
      read: async (path: string): Promise<string> => {
        const res = await wslMsb(["exec", name, "--", "cat", path], opts);
        if (res.code !== 0) {
          throw new Error(
            `fs.read ${path} failed (code ${res.code}): ${res.stderr}`,
          );
        }
        return res.stdout;
      },
      write: async (path: string, content: string): Promise<void> => {
        // Binary-safe: base64-encode on the host, pipe to `base64 -d > path`
        // inside the VM. The content never touches the command string, so any
        // bytes (quotes, NULs, newlines) round-trip intact.
        const b64 = Buffer.from(content, "utf8").toString("base64");
        const body = `base64 -d > ${shArg(path)}`;
        const res = await wslMsb(["exec", name, "--", "sh", "-lc", body], {
          ...opts,
          stdin: b64,
        });
        if (res.code !== 0) {
          throw new Error(
            `fs.write ${path} failed (code ${res.code}): ${res.stderr}`,
          );
        }
      },
      copyFromHost: async (hostPath: string, vmPath: string): Promise<void> => {
        const res = await wslMsb(
          ["cp", toWslPath(hostPath), `${name}:${vmPath}`],
          opts,
        );
        if (res.code !== 0) {
          throw new Error(
            `fs.copyFromHost ${hostPath} → ${vmPath} failed (code ${res.code}): ${res.stderr}`,
          );
        }
      },
      copyToHost: async (vmPath: string, hostPath: string): Promise<void> => {
        const res = await wslMsb(
          ["cp", `${name}:${vmPath}`, toWslPath(hostPath)],
          opts,
        );
        if (res.code !== 0) {
          throw new Error(
            `fs.copyToHost ${vmPath} → ${hostPath} failed (code ${res.code}): ${res.stderr}`,
          );
        }
      },
    };
  }

  /**
   * NOT needed by the chosen v2 design (claude streams via `spawn`, not a bridge
   * port) — DESIGN §7.4.2. Kept on the interface for a future bridge executor.
   */
  async getPortUrl(_vm: VmHandle, _port: number): Promise<string> {
    throw new Error("getPortUrl is not supported in P2a (DESIGN §7.4.2)");
  }

  /**
   * Snapshot for warm re-start / inspection. msb requires the sandbox to be
   * STOPPED, so we stop it first, then `snapshot create --from <name> <dest>`.
   * Returns the snapshot name (resolved under ~/.microsandbox/snapshots/).
   */
  async snapshot(vm: VmHandle): Promise<string> {
    const stopRes = await wslMsb(["stop", vm.name], this.opts);
    if (stopRes.code !== 0) {
      throw new Error(
        `snapshot: stop ${vm.name} failed (code ${stopRes.code}): ${stopRes.stderr}`,
      );
    }
    const snapName = `${vm.name}-snap-${newId("s").replace(/_/g, "-")}`;
    const res = await wslMsb(
      ["snapshot", "create", "--from", vm.name, snapName],
      this.opts,
    );
    if (res.code !== 0) {
      throw new Error(
        `snapshot create failed (code ${res.code}): ${res.stderr || res.stdout}`,
      );
    }
    return snapName;
  }

  /**
   * STAGE 7 — TEARDOWN (DESIGN §7.4.2/§7.4.5):
   *   "destroy"  → `msb stop` then `msb rm` (the branch survives only via push).
   *   "snapshot" → snapshot (which stops it), then `msb rm` (keep the artifact).
   *   "keep"     → leave the VM as-is for manual inspection.
   * `rm -f` is used as a robust fallback so a stop hiccup never leaks a VM.
   */
  async teardown(vm: VmHandle, policy: TeardownPolicy): Promise<void> {
    if (policy === "keep") return;
    if (policy === "snapshot") {
      await this.snapshot(vm); // stops the VM as a side effect
      await wslMsb(["rm", "-f", vm.name], this.opts);
      return;
    }
    // destroy: stop, then remove. Use rm -f so a half-stopped VM still goes.
    await wslMsb(["stop", vm.name], this.opts);
    const res = await wslMsb(["rm", "-f", vm.name], this.opts);
    if (res.code !== 0) {
      throw new Error(
        `teardown: rm ${vm.name} failed (code ${res.code}): ${res.stderr}`,
      );
    }
  }
}

/** Last non-empty, non-warning line of msb stdout (the printed sandbox name). */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("warn:") && !l.startsWith("✓"));
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}
