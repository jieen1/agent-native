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
import { resolveEgress } from "./networking.js";
import { mountVmCredentials, VM_HOME } from "./vm-creds.js";
import { ensureToolchain, type ToolchainNeeds } from "./vm-setup.js";
import {
  checkoutRunBranch,
  type GitContext,
} from "./git-wrapper.js";

/** Default node image until the prebaked image lands (DESIGN §7.4.8, P2c). */
const DEFAULT_IMAGE = "alpine";

/**
 * Per-VM env the runtime threads into EVERY in-VM `exec`/`spawn` (DESIGN §7.4.7
 * / §7.4.9): HOME, GITHUB_TOKEN, and the egress env (DNS-fixed VM + any working
 * forward-proxy). Computed at MOUNT/INIT and stashed on the handle's `meta` so
 * later executor calls (claude/git) inherit it without re-resolving secrets.
 */
const RUNTIME_ENV_META_KEY = "runtimeEnv";

/** Read the persisted per-VM runtime env off a handle's meta (empty if unset). */
function runtimeEnvOf(vm: VmHandle): Record<string, string> {
  const env = vm.meta?.[RUNTIME_ENV_META_KEY];
  return env && typeof env === "object" ? (env as Record<string, string>) : {};
}

/** Decide which tools a node needs in its VM (§7.4.8). */
function toolchainNeedsFor(vm: VmHandle): ToolchainNeeds {
  // Every microvm node may run git (commit/push). The claude CLI + node are only
  // required for a claude-code node, signalled by `ORCHESTRATOR_WANT_CLAUDE=1`
  // in the node env (set by the NodeRunner when the executor is claude-code) —
  // checked in BOTH the spec env and the persisted runtime env so the flag is
  // honored however it was threaded.
  const wantClaude =
    vm.spec.env?.ORCHESTRATOR_WANT_CLAUDE === "1" ||
    runtimeEnvOf(vm).ORCHESTRATOR_WANT_CLAUDE === "1";
  return { node: wantClaude, git: true, claude: wantClaude };
}

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
    // `meta` is a MUTABLE bag (the property ref is readonly, the object is not):
    // MOUNT/INIT fill `runtimeEnv` (egress + creds + HOME) here so every later
    // exec/spawn inherits it (DESIGN §7.4.7/§7.4.9).
    return {
      name,
      spec,
      meta: { image, printedName: printed, [RUNTIME_ENV_META_KEY]: {} },
    };
  }

  /**
   * STAGE 2 — MOUNT (DESIGN §7.4.7/§7.4.9, P2c REAL). Creates folder targets,
   * then:
   *   • resolves PUBLIC EGRESS for this boot — fixes the VM's dead DNS, probes
   *     direct NAT egress, falls back to the host forward-proxy only if it truly
   *     works, and keeps the host vLLM in NO_PROXY (§7.4.9);
   *   • copies the `~/.claude` subscription into the disposable VM (for a claude
   *     node; the host copy is never modified — left writable in-VM so claude can
   *     refresh its OAuth token within the run) and resolves GITHUB_TOKEN from the
   *     Vault as scoped VM env (§7.4.7).
   * The combined env (egress + HOME + GITHUB_TOKEN + the node's plain `env`) is
   * stashed on `vm.meta.runtimeEnv` so EVERY later exec/spawn (claude/git)
   * inherits it. Secret VALUES live only in that in-process env map — never
   * written to source or files. `resolveSecret` must run inside the run's
   * request context, which the NodeRunner/engine establishes.
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

    const wantClaude =
      (mounts.creds ?? []).includes("~/.claude") ||
      mounts.env?.ORCHESTRATOR_WANT_CLAUDE === "1" ||
      vm.spec.env?.ORCHESTRATOR_WANT_CLAUDE === "1";

    // 1) Egress: fix DNS + decide direct-vs-proxy. Keep the host vLLM direct.
    const vllmHosts = noProxyHostsFor(vm.spec, mounts.env);
    const egress = await resolveEgress(this, vm, { noProxyHosts: vllmHosts });

    // 2) Credentials: ~/.claude RO mount (claude nodes) + GITHUB_TOKEN env.
    const creds = await mountVmCredentials(this, vm, {
      wantClaude,
      home: VM_HOME,
      nodeRunId: (vm.meta?.nodeRunId as string | undefined) ?? null,
    });

    // Compose the per-VM runtime env: HOME first, then the node's plain env, then
    // egress, then creds (creds/egress win). Stash on the mutable meta bag.
    const runtimeEnv: Record<string, string> = {
      HOME: VM_HOME,
      ...(mounts.env ?? {}),
      ...egress.env,
      ...creds.env,
    };
    setRuntimeEnv(vm, runtimeEnv);

    // Record the mount picture on meta for journaling (value-safe booleans).
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
   * STAGE 3 — INIT (DESIGN §7.4.4/§7.4.8/§7.1a, P2c REAL). In order:
   *   1. ENSURE TOOLCHAIN (§7.4.8): a prebaked image short-circuits; the bare
   *      `alpine` base installs node+npm+git (+ the `claude` CLI for a claude
   *      node) via the egress wired in MOUNT.
   *   2. CHECKOUT the per-run branch `an/run-<runId>` from `baseRef` (§7.1a) when
   *      a worktree exists — a fresh `git init` otherwise, so branch+commit work
   *      even without a remote (the push step is where a remote is required).
   *   3. run the one-time `setup` commands.
   * All run with the persisted runtime env (egress + creds + HOME).
   */
  async init(
    vm: VmHandle,
    branch?: string,
    env?: Record<string, string>,
    setup?: string[],
  ): Promise<void> {
    // Fold any late `env` into the persisted runtime env (creds/egress win).
    const baseEnv = runtimeEnvOf(vm);
    const runEnv: Record<string, string> = { ...(env ?? {}), ...baseEnv };
    setRuntimeEnv(vm, runEnv);

    // 1) Toolchain (§7.4.8). Uses the egress env so installs can reach the net.
    await ensureToolchain(this, vm, toolchainNeedsFor(vm), runEnv);

    // 2) Branch checkout (§7.1a). Only when a workdir is known; the NodeRunner
    //    mounts `/work`, so we cut the run branch there.
    const workdir =
      (vm.meta?.workdir as string | undefined) ??
      vm.spec.mounts?.find((m) => m.mode === "rw")?.path ??
      "/work";
    if (branch && branch.trim() !== "") {
      const gitCtx: GitContext = {
        runtime: this,
        vm,
        workdir,
        env: runEnv,
      };
      await checkoutRunBranch(gitCtx, {
        branch,
        baseRef: vm.spec.baseRef,
      });
    }

    // 3) Setup commands.
    for (const cmd of setup ?? []) {
      const res = await this.exec(vm, cmd, { env: runEnv });
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
    // Forward a per-command timeout to the WSL→msb driver so the bash tool's
    // advertised timeoutMs actually kills a runaway in-VM command.
    const wslOpts =
      opts?.timeoutMs && opts.timeoutMs > 0
        ? { ...this.opts, timeoutMs: opts.timeoutMs }
        : this.opts;
    return wslMsb(execArgs(vm.name, cmd, withRuntimeEnv(vm, opts)), wslOpts);
  }

  /** STAGE 4 — streamed command. Backs claude `--output-format stream-json`. */
  spawn(vm: VmHandle, cmd: string, opts?: ExecOptions): SpawnHandle {
    return wslMsbStream(execArgs(vm.name, cmd, withRuntimeEnv(vm, opts)));
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

/**
 * Merge the VM's persisted runtime env (egress + creds + HOME) UNDER the
 * caller's per-command `opts.env`, so explicit overrides win but every command
 * inherits DNS/proxy/HOME/GITHUB_TOKEN by default (DESIGN §7.4.7/§7.4.9).
 */
function withRuntimeEnv(
  vm: VmHandle,
  opts: ExecOptions | undefined,
): ExecOptions | undefined {
  const base = runtimeEnvOf(vm);
  if (Object.keys(base).length === 0) return opts;
  return { ...opts, env: { ...base, ...(opts?.env ?? {}) } };
}

/** Persist the per-VM runtime env on the handle's mutable meta bag. */
function setRuntimeEnv(vm: VmHandle, env: Record<string, string>): void {
  if (vm.meta) vm.meta[RUNTIME_ENV_META_KEY] = env;
}

/**
 * The hosts that must bypass the forward-proxy (§7.4.9): the vLLM endpoint stays
 * DIRECT so a vLLM node reaches the host engine without traversing the proxy.
 * Extracts the hostname from any OPENAI_BASE_URL/VLLM_BASE_URL in the node env.
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
      // ignore malformed url
    }
  }
  return hosts;
}

/** Last non-empty, non-warning line of msb stdout (the printed sandbox name). */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("warn:") && !l.startsWith("✓"));
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}
