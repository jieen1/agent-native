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
import { runtimeForSpec } from "./index.js";
import type { NodeRuntime, TeardownPolicy, VmHandle } from "./node-runtime.js";
import { DEFAULT_WORKDIR } from "./executors/engine-loop.js";
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
  private readonly runtimeFor: (spec: NodeRuntimeSpec) => NodeRuntime;

  constructor(args: {
    executor: RuntimeExecutor;
    runtimeFor?: (spec: NodeRuntimeSpec) => NodeRuntime;
  }) {
    this.executor = args.executor;
    this.runtimeFor = args.runtimeFor ?? runtimeForSpec;
  }

  /** Run one node through all 7 stages, with §7.4.5 recovery. */
  async run(
    input: NodeRunnerInput,
    signal: AbortSignal,
  ): Promise<NodeRunnerResult> {
    const spec = effectiveSpec(input.node);
    const runtime = this.runtimeFor(spec);
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
    // STAGE 1 — PROVISION.
    const vm: VmHandle = await runtime.provision(spec);
    let succeeded = false;
    try {
      // STAGE 2 — MOUNT (dirs + creds; minimal P2a seam). Always create the
      // node worktree so the acting bridge / claude have a cwd that exists.
      await runtime.mount(vm, {
        repo: spec.mounts?.find((m) => m.path === WORKDIR)?.host,
        folders: [
          { host: "", path: WORKDIR, mode: "rw" },
          ...(spec.mounts ?? []),
        ],
        creds: spec.creds,
        env: spec.env,
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
      // STAGE 6 — EXTRACT (minimal P2b: nothing copied out yet; git push is
      // P2c). The output value IS the extracted result for P2b.
      succeeded = true;
      return {
        output: execResult.output,
        tokensSpent: execResult.tokensSpent,
        toolCallCount: execResult.toolCallCount,
        model: execResult.model,
        vmName: vm.name,
        durationMs,
        attempts: attempt,
        detail: execResult.detail,
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
