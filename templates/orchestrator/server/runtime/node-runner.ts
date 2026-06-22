// The unified 7-stage NodeRunner (DESIGN §7.4.1a / §7.4). EVERY node — whatever
// its brain — runs through this one skeleton, which owns its per-node microVM
// and runs the identical 7-stage lifecycle. Only ONE stage (EXECUTE) varies by
// provider, behind the `RuntimeExecutor` seam (`executors/types.ts`).
//
//   1. PROVISION  runtime.provision(spec)                  — boot the microVM
//   2. MOUNT      runtime.mount(vm, {repo, folders, creds}) — dirs + creds (P2a seam)
//   3. INIT       runtime.init(vm, branch, env, setup)      — env + setup (git branch P2c)
//   4. EXECUTE ⭐ executor.run({ runtime, vm, node, deps }) — the only pluggable stage
//   5. COLLECT    output + tokens + timing + exit           — gather metrics
//   6. EXTRACT    copy results out (minimal P2b; git push P2c)
//   7. TEARDOWN   runtime.teardown(vm, onSuccess|onFailure) — destroy | snapshot | keep
//
// Stages 1–3 and 5–7 are shared infrastructure; stage 4 is the only
// provider-specific part. A try/finally guarantees TEARDOWN always runs. On
// failure the §7.4.5 recovery policy applies per node.runtime.onFailure:
//   "rollback" : reset the in-VM worktree, retry in the SAME VM (cheap)
//   "recreate" : teardown + re-provision + re-init, retry in a CLEAN VM
//   "keep"     : snapshot for inspection, mark failed
// capped by node.retry.max.
//
// The NodeRunner exposes itself to the deterministic scheduler as a
// `NodeExecutor` (`server/engine/types.ts`) via {@link NodeRunnerExecutor}: it
// turns a resolved DAG input into an output by running the 7 stages.

import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";

import type { Node, NodeRuntimeSpec } from "../../shared/types.js";
import type { NodeRuntime, TeardownPolicy, VmHandle } from "./node-runtime.js";
import {
  addAll,
  commit,
  pushBranch,
  type GitContext,
} from "./git-wrapper.js";
import { DEFAULT_WORKDIR } from "./executors/workdir.js";
import { getVmSemaphore, type VmSemaphore } from "./backpressure.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./executors/types.js";

/** The worktree dir created inside every microVM node (DESIGN §7.1a). */
const WORKDIR = DEFAULT_WORKDIR;

/** Structured outcome of one full 7-stage run (for journaling + assertions). */
export interface NodeRunnerResult {
  output: unknown;
  tokensSpent: number;
  toolCallCount: number;
  model: string;
  /** The sandbox name of the VM that ran the node (null for none-runtime). */
  vmName: string | null;
  /** Wall-clock duration of the EXECUTE stage in ms. */
  durationMs: number;
  /** How many provision attempts were made (1 = no recovery needed). */
  attempts: number;
  detail?: Record<string, unknown>;
}

/** Inputs to one node run (resolved by the scheduler before the runner starts). */
export interface NodeRunnerInput {
  node: Node;
  deps: Record<string, unknown>;
  item?: unknown;
  effort?: "low" | "medium" | "high";
  ownerEmail: string;
  orgId: string | null;
}

/** A node's effective runtime spec, with defaults filled (§7.4.3). */
function effectiveSpec(node: Node): NodeRuntimeSpec {
  return (
    node.runtime ?? {
      kind: "microvm",
      onFailure: "recreate",
      onSuccess: "destroy",
    }
  );
}

/** The teardown policy for a SUCCESSFUL run (default destroy, §7.4.3). */
function successPolicy(spec: NodeRuntimeSpec): TeardownPolicy {
  return spec.onSuccess ?? "destroy";
}

/** The teardown policy for a FAILED run, derived from onFailure (§7.4.5). */
function failurePolicy(spec: NodeRuntimeSpec): TeardownPolicy {
  // "keep" snapshots for inspection; rollback/recreate destroy the VM (a fresh
  // one is booted on retry). After retries are exhausted we still want the VM
  // gone unless the node asked to keep it.
  return spec.onFailure === "keep" ? "keep" : "destroy";
}

/**
 * The unified NodeRunner. Owns the microVM lifecycle and delegates EXECUTE to
 * the provided `RuntimeExecutor` (DESIGN §7.4.1a). `runtimeFor` is injectable so
 * tests can pass a fake backend; production uses {@link runtimeForSpec}.
 */
export class NodeRunner {
  private readonly executor: RuntimeExecutor;
  /**
   * Injected backend selector, or null to lazily resolve the production one.
   * Kept LAZY (a dynamic import in {@link resolveRuntimeFor}) so importing this
   * module — e.g. from a unit test that injects a fake backend — does NOT pull
   * in the microsandbox/executor chain (and its OpenTelemetry deps the vitest
   * ESM runner cannot load). Mirrors the lazy import in engine/index.ts.
   */
  private readonly injectedRuntimeFor:
    | ((spec: NodeRuntimeSpec) => NodeRuntime)
    | null;
  private readonly vmSemaphore: VmSemaphore;
  private readonly acquireTimeoutMs?: number;

  constructor(args: {
    executor: RuntimeExecutor;
    runtimeFor?: (spec: NodeRuntimeSpec) => NodeRuntime;
    /**
     * The VM-capacity semaphore (DESIGN §4.1). Defaults to the process-wide one
     * sized to `maxConcurrentVMs`; tests inject a small one to prove the cap +
     * the distinct VMCapacityExhaustedError. Only `microvm` provisions take a
     * slot — `none` runs on the host and consumes no VM.
     */
    vmSemaphore?: VmSemaphore;
    /**
     * How long a provision waits for a free VM slot before surfacing
     * VMCapacityExhaustedError (DESIGN §4.1 backpressure). Default: wait
     * indefinitely (queue behind the cap). Tests pass 0 to fail fast and assert
     * the distinct error type.
     */
    acquireTimeoutMs?: number;
  }) {
    this.executor = args.executor;
    this.injectedRuntimeFor = args.runtimeFor ?? null;
    this.vmSemaphore = args.vmSemaphore ?? getVmSemaphore();
    this.acquireTimeoutMs = args.acquireTimeoutMs;
  }

  /** Resolve the backend selector, lazily loading the production one. */
  private async resolveRuntimeFor(): Promise<
    (spec: NodeRuntimeSpec) => NodeRuntime
  > {
    if (this.injectedRuntimeFor) return this.injectedRuntimeFor;
    const { runtimeForSpec } = await import("./index.js");
    return runtimeForSpec;
  }

  /** Run one node through all 7 stages, with §7.4.5 recovery. */
  async run(
    input: NodeRunnerInput,
    signal: AbortSignal,
  ): Promise<NodeRunnerResult> {
    const spec = effectiveSpec(input.node);
    const runtimeFor = await this.resolveRuntimeFor();
    const runtime = runtimeFor(spec);
    const maxAttempts = Math.max(1, (input.node.retry?.max ?? 0) + 1);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runOnce(runtime, spec, input, signal, attempt);
      } catch (err: unknown) {
        lastErr = err;
        if (signal.aborted) break; // cancel is terminal, do not retry
        if (attempt >= maxAttempts) break;
        // rollback/recreate both re-provision a clean VM in `runOnce` (the VM is
        // disposable; for P2b rollback and recreate both boot fresh because the
        // in-VM git worktree reset is P2c). "keep" does not retry.
        if (spec.onFailure === "keep") break;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`node ${input.node.id} failed: ${String(lastErr)}`);
  }

  /** One full provision→teardown pass (stages 1–7) for a single attempt. */
  private async runOnce(
    runtime: NodeRuntime,
    spec: NodeRuntimeSpec,
    input: NodeRunnerInput,
    signal: AbortSignal,
    attempt: number,
  ): Promise<NodeRunnerResult> {
    // BACKPRESSURE (DESIGN §4.1): a microVM provision must hold a VM slot for
    // the WHOLE 7-stage pass (the VM is live until TEARDOWN). When the
    // maxConcurrentVMs ceiling is full this WAITS for a slot, or surfaces a
    // DISTINCT VMCapacityExhaustedError on timeout — never a budget error. The
    // `none` runtime runs on the host (no microVM) so it takes no slot.
    const needsVmSlot = spec.kind !== "none";
    if (needsVmSlot) {
      await this.vmSemaphore.acquire(this.acquireTimeoutMs);
    }
    let slotHeld = needsVmSlot;
    try {
      return await this.provisionAndRun(runtime, spec, input, signal, attempt);
    } finally {
      if (slotHeld) {
        slotHeld = false;
        this.vmSemaphore.release();
      }
    }
  }

  /** Stages 1–7 with the VM slot already held (or not needed). */
  private async provisionAndRun(
    runtime: NodeRuntime,
    spec: NodeRuntimeSpec,
    input: NodeRunnerInput,
    signal: AbortSignal,
    attempt: number,
  ): Promise<NodeRunnerResult> {
    // STAGE 1 — PROVISION.
    const vm: VmHandle = await runtime.provision(spec);
    // Stash the worktree + the claude-want flag on the VM meta so the runtime's
    // MOUNT/INIT (egress + ~/.claude RO mount + toolchain) know the cwd and
    // whether to install the claude CLI (DESIGN §7.1a/§7.4.7/§7.4.8).
    const wantClaude = this.executor.kind === "claude-code";
    if (vm.meta) vm.meta.workdir = WORKDIR;
    const mountEnv: Record<string, string> = {
      ...(spec.env ?? {}),
      ...(wantClaude ? { ORCHESTRATOR_WANT_CLAUDE: "1" } : {}),
    };
    let succeeded = false;
    try {
      // STAGE 2 — MOUNT (dirs + egress + creds; DESIGN §7.4.7/§7.4.9). Always
      // create the node worktree so the acting bridge / claude have a cwd that
      // exists; the runtime resolves egress + mounts ~/.claude + GITHUB_TOKEN.
      await runtime.mount(vm, {
        repo: spec.mounts?.find((m) => m.path === WORKDIR)?.host,
        folders: [
          { host: "", path: WORKDIR, mode: "rw" },
          ...(spec.mounts ?? []),
        ],
        creds: spec.creds,
        env: mountEnv,
      });
      const mk = await runtime.exec(vm, `mkdir -p ${WORKDIR}`);
      if (mk.code !== 0) {
        throw new Error(`init: mkdir ${WORKDIR} failed: ${mk.stderr}`);
      }

      // STAGE 3 — INIT (env + setup; real git branch is P2c).
      await runtime.init(vm, spec.branch, spec.env, spec.setup);

      // STAGE 4 — EXECUTE ⭐ (the only pluggable stage).
      const ctx: RuntimeExecCtx = {
        runtime,
        vm,
        node: input.node,
        workdir: WORKDIR,
        deps: input.deps,
        item: input.item,
        effort: input.effort,
        ownerEmail: input.ownerEmail,
        orgId: input.orgId,
        signal,
      };
      const startedAt = Date.now();
      const execResult: RuntimeExecResult = await this.executor.run(ctx);
      const durationMs = Date.now() - startedAt;

      // STAGE 5 — COLLECT (output + tokens + timing + exit already on result).
      // STAGE 6 — EXTRACT (DESIGN §7.1a/§7.4 P2c): a code node (gitRemote set on
      // its runtime) stages + commits the in-VM edits, pushes the per-run branch,
      // and opens a PR. The disposable VM's only durable artifact is that pushed
      // branch / PR. Delivery is best-effort-SURFACED: a push/PR failure is
      // recorded in `detail.delivery` (the node still returns its output) so the
      // run stays inspectable rather than silently dropping the work.
      let delivery: Record<string, unknown> | undefined;
      const deliverGate =
        spec.kind === "microvm" && !!spec.gitRemote && !!spec.branch;
      // eslint-disable-next-line no-console
      console.log(
        `[extract] node=${input.node.id} gate=${deliverGate} kind=${spec.kind} gitRemote=${spec.gitRemote ?? "(unset)"} branch=${spec.branch ?? "(unset)"}`,
      );
      if (deliverGate) {
        delivery = await this.deliver(runtime, vm, spec, input);
        // eslint-disable-next-line no-console
        console.log(`[extract] node=${input.node.id} delivery=${JSON.stringify(delivery)}`);
      }

      succeeded = true;
      return {
        output:
          delivery && execResult.output && typeof execResult.output === "object"
            ? { ...(execResult.output as Record<string, unknown>), delivery }
            : execResult.output,
        tokensSpent: execResult.tokensSpent,
        toolCallCount: execResult.toolCallCount,
        model: execResult.model,
        vmName: vm.name,
        durationMs,
        attempts: attempt,
        detail: delivery
          ? { ...(execResult.detail ?? {}), delivery }
          : execResult.detail,
      };
    } finally {
      // STAGE 7 — TEARDOWN. Always runs. Policy depends on success/failure.
      const policy = succeeded ? successPolicy(spec) : failurePolicy(spec);
      try {
        await runtime.teardown(vm, policy);
      } catch {
        // A teardown failure must not mask the original error / result; the
        // backend's `rm -f` fallback already minimizes leaks.
      }
    }
  }

  /**
   * EXTRACT delivery for a code node (DESIGN §7.1a). Stage + commit the in-VM
   * worktree, push `spec.branch` to `spec.gitRemote`, then open a PR against
   * `spec.baseRef`. Runs entirely in-VM over `runtime.exec` (the git-wrapper).
   * Never throws — a failure is returned structurally so the node still yields
   * its output. The GITHUB_TOKEN is read from the VM's persisted runtime env
   * (injected at MOUNT via resolveSecret); a "no-token" push surfaces clearly.
   */
  private async deliver(
    runtime: NodeRuntime,
    vm: VmHandle,
    spec: NodeRuntimeSpec,
    input: NodeRunnerInput,
  ): Promise<Record<string, unknown>> {
    const env =
      (vm.meta?.runtimeEnv as Record<string, string> | undefined) ?? {};
    const ctx: GitContext = { runtime, vm, workdir: WORKDIR, env };
    const itemTitle = (input.item as { title?: unknown } | undefined)?.title;
    const title =
      (typeof itemTitle === "string" && itemTitle.trim() !== ""
        ? itemTitle
        : undefined) ??
      input.node.title ??
      "Orchestrator change";
    try {
      await addAll(ctx);
      const committed = await commit(ctx, `orchestrator: ${title}`);
      const pushed = await pushBranch(ctx, {
        branch: spec.branch!,
        remoteUrl: spec.gitRemote,
      });
      // Open a PR for the pushed branch via the GitHub REST API from the HOST
      // (the orchestrator process has node `fetch` + the token). The repo's VM
      // has no `gh`, and a PR-open is an HTTPS call, not a git op — so it does not
      // need to run in-VM. Idempotent: a re-pushed branch returns the existing PR.
      let prUrl: string | null = null;
      let prReason: string | null = null;
      if (pushed.pushed && spec.gitRemote) {
        const prRes = await openPrViaApi({
          remoteUrl: spec.gitRemote,
          branch: spec.branch!,
          baseBranch: spec.baseRef ?? "main",
          title,
          body: `Automated by an orchestrator run on branch \`${spec.branch}\`.`,
          token: env.GITHUB_TOKEN,
        });
        prUrl = prRes.url;
        prReason = prRes.reason;
      }

      // Persist the run's durable deliverable (DESIGN §7.1a / §9): a PR when one
      // opened, else the pushed branch. runId is parsed from the per-run branch
      // (`an/run-<runId>`). Best-effort: the PR/branch already exists on the
      // remote regardless of whether this DB write lands, and it also rides in
      // the node output so the engine can propagate it to the work item.
      const runId = (spec.branch ?? "").replace(/^an\/run-/, "");
      const deliverable: { kind: string; ref: string } | null = prUrl
        ? { kind: "pr", ref: prUrl }
        : pushed.pushed && spec.branch
          ? { kind: "branch", ref: spec.branch }
          : null;
      if (runId && deliverable) {
        try {
          const { getDb, schema } = await import("../db/index.js");
          const { eq } = await import("drizzle-orm");
          await getDb()
            .update(schema.workflowRuns)
            .set({ deliverable: JSON.stringify(deliverable) })
            .where(eq(schema.workflowRuns.id, runId));
        } catch {
          // best-effort — the deliverable also rides in the node output below.
        }
      }

      return {
        committed: committed.committed,
        commitSha: committed.sha,
        branch: spec.branch,
        pushed: pushed.pushed,
        pushReason: pushed.reason,
        pushDetail: pushed.detail,
        prUrl,
        prReason,
        deliverable,
      };
    } catch (err) {
      return {
        committed: false,
        pushed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Open a PR for a pushed branch via the GitHub REST API (host-side; the node's
 * microVM has no `gh`, and a PR-open is an HTTPS call, not a git op). Idempotent:
 * a 422 "already exists" resolves the existing open PR's url. Never throws.
 */
async function openPrViaApi(opts: {
  remoteUrl: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  token?: string;
}): Promise<{ url: string | null; reason: string }> {
  const token = opts.token;
  if (!token || token.trim() === "") return { url: null, reason: "no-token" };
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(opts.remoteUrl);
  if (!m) return { url: null, reason: "bad-remote" };
  const owner = m[1];
  const repo = `${owner}/${m[2]}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "an-orchestrator",
    "Content-Type": "application/json",
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: opts.title,
        head: opts.branch,
        base: opts.baseBranch,
        body: opts.body,
      }),
    });
    const text = await res.text();
    if (res.status === 201) {
      const url = (JSON.parse(text) as { html_url?: string }).html_url ?? null;
      return { url, reason: url ? "ok" : "error" };
    }
    if (res.status === 422 && /already exists/i.test(text)) {
      const listRes = await fetch(
        `https://api.github.com/repos/${repo}/pulls?head=${owner}:${opts.branch}&state=open`,
        { headers },
      );
      const arr = (await listRes.json()) as Array<{ html_url?: string }>;
      const url = Array.isArray(arr) ? (arr[0]?.html_url ?? null) : null;
      return { url, reason: url ? "exists" : "exists-unresolved" };
    }
    return { url: null, reason: `error-${res.status}` };
  } catch (err) {
    return {
      url: null,
      reason: `error:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Adapter: expose a {@link NodeRunner} to the deterministic scheduler as a
 * `server/engine/types.ts` `NodeExecutor`. The scheduler hands a resolved DAG
 * input; this turns it into an output by running the 7 stages. Request context
 * (owner/org) is read from the ambient AsyncLocalStorage frame the engine
 * established (DESIGN §4.2 landmine 2) so secret/key resolution scopes
 * correctly.
 */
export class NodeRunnerExecutor {
  readonly kind: string;
  private readonly runner: NodeRunner;

  constructor(args: {
    executor: RuntimeExecutor;
    runtimeFor?: (spec: NodeRuntimeSpec) => NodeRuntime;
    /** VM-capacity semaphore (DESIGN §4.1). Forwarded to the NodeRunner. */
    vmSemaphore?: VmSemaphore;
    /** Provision wait bound before VMCapacityExhaustedError (DESIGN §4.1). */
    acquireTimeoutMs?: number;
  }) {
    this.runner = new NodeRunner(args);
    this.kind = args.executor.kind;
  }

  async invoke(
    input: {
      node: Node;
      deps: Record<string, unknown>;
      item?: unknown;
      effort?: "low" | "medium" | "high";
    },
    signal: AbortSignal,
  ): Promise<{ output: unknown; tokensSpent: number }> {
    const ownerEmail = getRequestUserEmail() ?? "";
    const orgId = getRequestOrgId() ?? null;
    const result = await this.runner.run(
      {
        node: input.node,
        deps: input.deps,
        item: input.item,
        effort: input.effort,
        ownerEmail,
        orgId,
      },
      signal,
    );
    return { output: result.output, tokensSpent: result.tokensSpent };
  }
}
