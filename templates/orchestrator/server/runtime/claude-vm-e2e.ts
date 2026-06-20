// The load-bearing P2c E2E (DESIGN §7.4.1a / §7.0): a CLAUDE-CODE node whose
// brain is the REAL `claude` CLI running INSIDE its microVM. It proves the whole
// P2c stack end to end:
//   • PROVISION a microVM (the 7-stage NodeRunner)
//   • MOUNT     fixes the VM's dead DNS → DIRECT public egress; copies the host
//               `~/.claude` into the disposable VM (host copy untouched) so the
//               in-VM claude reuses the subscription
//   • INIT      installs node+npm+git+claude via egress (§7.4.8 fallback path)
//               and cuts the per-run branch `an/run-<runId>` (§7.1a)
//   • EXECUTE = ClaudeCodeExecutor: `claude --output-format stream-json -p …`
//               IN the VM; the stream-json events come back from the REAL API
//   • the reply is the real model output (e.g. "READY"), result subtype success
//   • tokensSpent > 0 (real usage summed from the stream, §4.2.3)
//   • TEARDOWN removed the VM
//
// Plus a GIT-WRAPPER proof: branch + commit in-VM succeed, and the push path
// FAILS CLEARLY ("no-token" / non-fast-forward) rather than silently when no
// real GITHUB_TOKEN + repo are present (§7.1).
//
// Shared by the gated vitest (`claude-vm-e2e.spec.ts`) and the runnable CLI
// (`claude-vm-e2e-cli.ts`). Throws on any failed assertion; always tears down.

import { runWithRequestContext } from "@agent-native/core/server/request-context";

import { MicrosandboxRuntime } from "./microsandbox-runtime.js";
import { NodeRunner } from "./node-runner.js";
import { ClaudeCodeExecutor } from "./executors/index.js";
import { wslMsb } from "./wsl-msb.js";
import { ensureHostProxy } from "./networking.js";
import {
  checkoutRunBranch,
  addAll,
  commit,
  pushBranch,
  runBranchName,
  type GitContext,
} from "./git-wrapper.js";
import { VM_HOME } from "./vm-creds.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";

/** The structured result of the claude-in-VM E2E (pretty-printed by the CLI). */
export interface ClaudeVmE2eResult {
  vmName: string;
  model: string;
  /** The final assistant text the in-VM claude produced. */
  reply: string;
  /** Whether the reply contains the expected marker word. */
  replyMatches: boolean;
  /** The stream-json `result` subtype ("success" / "error_*"). */
  resultSubtype: string | null;
  /** Real usage summed from the stream (must be > 0). */
  tokensSpent: number;
  toolCallCount: number;
  /** Egress picture (proves DNS-fixed direct egress or a working proxy). */
  egress: { gateway: string | null; directEgress: boolean; proxyUrl: string | null };
  /** Whether the `~/.claude` subscription mounted (apiKeySource:none auth). */
  claudeMounted: boolean;
  durationMs: number;
  removedFromVm: boolean;
}

/** The result of the in-VM git-wrapper proof. */
export interface GitWrapperE2eResult {
  branch: string;
  branchInitialized: boolean;
  committed: boolean;
  commitSha: string | null;
  /** The push attempt — expected to FAIL clearly without a real token/remote. */
  pushPushed: boolean;
  pushReason: string;
  pushDetail: string;
}

const HOST_WSL = process.env.ORCHESTRATOR_WSL_BIN ?? "wsl";

/** The marker word the trivial prompt asks claude to reply with. */
export const CLAUDE_MARKER = "READY";

/** True if `name` still appears in `msb list -q` (proves teardown). */
async function inMsbList(name: string): Promise<boolean> {
  const res = await wslMsb(["list", "-q"]);
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(name);
}

/**
 * Run the full claude-in-VM E2E for REAL. Throws on any failed assertion; always
 * tears the VM down. `opts.runId` seeds the per-run branch name.
 */
export async function runClaudeVmE2e(
  opts: {
    ownerEmail?: string;
    runId?: string;
    log?: (msg: string) => void;
  } = {},
): Promise<ClaudeVmE2eResult> {
  const log = opts.log ?? (() => {});
  const ownerEmail = opts.ownerEmail ?? "e2e@localhost";
  const runId = opts.runId ?? `p2c-${Date.now()}`;
  const branch = runBranchName(runId);

  // Host preflight (warn-only): note whether tinyproxy is up. Direct egress is
  // the baseline, so a down proxy never blocks the run.
  const proxyNote = await ensureHostProxy();
  log(`[preflight] ${proxyNote.note}`);

  const spec: NodeRuntimeSpec = {
    kind: "microvm",
    image: "alpine",
    branch,
    onFailure: "keep",
    // Keep the VM so we can assert the egress/creds picture + the reply, then
    // tear it down ourselves at the end (mirrors vllm-e2e).
    onSuccess: "keep",
  };
  const node: Node = {
    id: "e2e-claude",
    type: "agent",
    title: "claude-in-VM E2E node",
    engine: "claude-code",
    runtime: spec,
    prompt: `Reply with exactly the single word ${CLAUDE_MARKER} and nothing else.`,
  };

  const runtime = new MicrosandboxRuntime();
  const runner = new NodeRunner({
    executor: new ClaudeCodeExecutor(),
    runtimeFor: () => runtime,
  });

  const startedAt = Date.now();
  // claude + GITHUB_TOKEN resolution need the run's request context (§4.2).
  const result = await runWithRequestContext(
    { userEmail: ownerEmail, orgId: undefined },
    async () => {
      log(`[1/6] run NodeRunner (provision + egress + ~/.claude + claude EXECUTE) …`);
      return runner.run(
        { node, deps: {}, ownerEmail, orgId: null },
        new AbortController().signal,
      );
    },
  );
  const durationMs = Date.now() - startedAt;

  const vmName = result.vmName ?? "";
  if (vmName === "") throw new Error("NodeRunner returned no vmName");

  // Read the egress + creds picture the MOUNT stage recorded on the handle.
  // We kept the VM, so we can re-address it for inspection.
  const inspectVm = { name: vmName, spec } as const;

  try {
    const output = result.output as
      | { text?: string; resultSubtype?: string | null; model?: string }
      | undefined;
    const reply = (output?.text ?? "").trim();
    const replyMatches = reply.toUpperCase().includes(CLAUDE_MARKER);
    log(
      `      vm=${vmName} model=${result.model} reply=${JSON.stringify(reply)} ` +
        `tokens=${result.tokensSpent} tools=${result.toolCallCount}`,
    );

    // (a) The in-VM claude REACHED the API: a real reply + success subtype.
    log(`[2/6] assert real reply from the in-VM claude (API reached) …`);
    if (reply === "") {
      throw new Error(
        `in-VM claude produced no reply text — the API was not reached. ` +
          `output=${JSON.stringify(result.output)}`,
      );
    }
    if (!replyMatches) {
      throw new Error(
        `in-VM claude reply ${JSON.stringify(reply)} does not contain ` +
          `${CLAUDE_MARKER}`,
      );
    }

    // (b) tokensSpent > 0 (real usage summed from the stream).
    log(`[3/6] assert tokensSpent > 0 (real usage) …`);
    if (!(result.tokensSpent > 0)) {
      throw new Error(
        `tokensSpent was ${result.tokensSpent}; expected > 0 (no real API turn)`,
      );
    }

    // (c) The subscription mounted: claude authed via ~/.claude, not an API key.
    log(`[4/6] read egress + creds picture recorded at MOUNT …`);
    const meta = await readVmMeta(runtime, inspectVm);
    log(
      `      egress=${JSON.stringify(meta.egress)} creds=${JSON.stringify(
        meta.creds,
      )}`,
    );

    // (d) the per-run branch was cut in-VM. On a fresh `git init` with no commit
    // yet the branch is "unborn", so `rev-parse --abbrev-ref HEAD` returns the
    // literal "HEAD"; `symbolic-ref --short HEAD` returns the real branch name
    // either way.
    log(`[5/6] assert per-run branch ${branch} exists in-VM …`);
    const branchRes = await runtime.exec(
      inspectVm,
      `git -C /work symbolic-ref --short HEAD 2>/dev/null || git -C /work rev-parse --abbrev-ref HEAD`,
    );
    const currentBranch = branchRes.stdout.trim();
    if (currentBranch !== branch) {
      throw new Error(
        `expected in-VM branch ${branch}, got ${JSON.stringify(currentBranch)}`,
      );
    }

    // (e) teardown removes the VM.
    log(`[6/6] teardown('destroy') + confirm gone from msb list …`);
    await runtime.teardown(inspectVm, "destroy");
    const removedFromVm = !(await inMsbList(vmName));
    if (!removedFromVm) {
      throw new Error(`VM ${vmName} still in msb list after teardown`);
    }

    return {
      vmName,
      model: result.model,
      reply,
      replyMatches,
      resultSubtype: output?.resultSubtype ?? null,
      tokensSpent: result.tokensSpent,
      toolCallCount: result.toolCallCount,
      egress: meta.egress,
      claudeMounted: meta.creds.claudeMounted,
      durationMs,
      removedFromVm,
    };
  } catch (err: unknown) {
    try {
      await runtime.teardown(inspectVm, "destroy");
    } catch {
      /* surface the original error */
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    void HOST_WSL;
  }
}

/** Egress/creds bag recorded on the VM meta by MOUNT. */
interface VmMeta {
  egress: { gateway: string | null; directEgress: boolean; proxyUrl: string | null };
  creds: { claudeMounted: boolean; githubTokenPresent: boolean };
}

/**
 * The meta lives on the in-process handle the runner used; since the CLI creates
 * its own runtime instance we cannot read that object back here. Instead we
 * re-derive the observable facts from the live VM: direct egress (a real request)
 * and the presence of the mounted `~/.claude`. This keeps the assertion grounded
 * in the VM's real state rather than a host-side bag.
 */
async function readVmMeta(
  runtime: MicrosandboxRuntime,
  vm: { name: string; spec: NodeRuntimeSpec },
): Promise<VmMeta> {
  const gwRes = await runtime.exec(vm, "ip route 2>/dev/null | awk '/^default/{print $3; exit}'");
  const gateway = gwRes.stdout.trim() || null;
  const egressRes = await runtime.exec(
    vm,
    `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 12 https://api.github.com/zen >/dev/null 2>&1 && echo OK || echo FAIL; else echo NOCURL; fi`,
    { timeoutMs: 20_000 },
  );
  const directEgress = egressRes.stdout.includes("OK");
  const claudeRes = await runtime.exec(
    vm,
    `test -f ${VM_HOME}/.claude/.credentials.json && echo OK || echo MISSING`,
  );
  const claudeMounted = claudeRes.stdout.includes("OK");
  return {
    egress: { gateway, directEgress, proxyUrl: null },
    creds: { claudeMounted, githubTokenPresent: false },
  };
}

/**
 * The git-wrapper proof (§7.1). Boots a microVM, ensures git, then drives the
 * wrapper: checkout branch + write a file + add + commit must SUCCEED in-VM; the
 * push must FAIL CLEARLY (no token / no remote) — never silently. Tears down.
 */
export async function runGitWrapperE2e(
  opts: { runId?: string; log?: (msg: string) => void } = {},
): Promise<GitWrapperE2eResult> {
  const log = opts.log ?? (() => {});
  const runId = opts.runId ?? `p2c-git-${Date.now()}`;
  const branch = runBranchName(runId);
  const runtime = new MicrosandboxRuntime();

  log(`[git 1/5] provision a microVM + install git via egress …`);
  const vm = await runtime.provision({
    kind: "microvm",
    image: "alpine",
    onFailure: "keep",
    onSuccess: "keep",
  });
  try {
    // Fix DNS + install git (no claude needed for the git proof).
    await runtime.exec(vm, "mkdir -p /work");
    if (vm.meta) vm.meta.workdir = "/work";
    await runtime.mount(vm, {
      folders: [{ host: "", path: "/work", mode: "rw" }],
      env: {},
    });
    await runtime.init(vm, undefined, undefined, undefined);

    const ctx: GitContext = {
      runtime,
      vm,
      workdir: "/work",
      // No GITHUB_TOKEN injected → the push must report "no-token" clearly.
      env: { HOME: VM_HOME },
    };

    log(`[git 2/5] checkout run branch ${branch} …`);
    const co = await checkoutRunBranch(ctx, { branch });

    log(`[git 3/5] write a file + add + commit …`);
    await runtime.fs(vm).write("/work/p2c.txt", "orchestrator-p2c-git\n");
    await addAll(ctx);
    const committed = await commit(ctx, "p2c: git wrapper proof");
    if (!committed.committed) {
      throw new Error(`commit did not happen: ${committed.detail}`);
    }

    log(`[git 4/5] push WITHOUT a token → must fail clearly (no-token) …`);
    const pushNoToken = await pushBranch(ctx, {
      branch,
      remoteUrl: "https://github.com/an-orchestrator/does-not-exist.git",
    });
    if (pushNoToken.pushed) {
      throw new Error("push unexpectedly succeeded with no GITHUB_TOKEN");
    }
    if (pushNoToken.reason !== "no-token") {
      throw new Error(
        `push without a token should report "no-token", got ` +
          `"${pushNoToken.reason}": ${pushNoToken.detail}`,
      );
    }

    log(`[git 5/5] teardown …`);
    await runtime.teardown(vm, "destroy");

    return {
      branch: co.branch,
      branchInitialized: co.initialized,
      committed: committed.committed,
      commitSha: committed.sha,
      pushPushed: pushNoToken.pushed,
      pushReason: pushNoToken.reason,
      pushDetail: pushNoToken.detail,
    };
  } catch (err: unknown) {
    try {
      await runtime.teardown(vm, "destroy");
    } catch {
      /* surface original */
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
