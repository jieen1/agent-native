// RoutingNodeExecutor — the scheduler-facing `NodeExecutor` (server/engine/
// types.ts) that plugs the P2b real executors into the SAME seam the P1 echo
// executor used (DESIGN §4.2 / §7.4.1a). The deterministic `Scheduler` owns one
// `NodeExecutor`; this one inspects EACH node and routes it:
//
//   • node.runtime.kind === "microvm"  → resolve the brain (claude-code / vLLM /
//     remote-API) via the P0 choice judge, then run the 7-stage NodeRunner
//     (`NodeRunnerExecutor`) which provisions a microVM, executes, and tears
//     down. THIS is where a real model acts inside a VM.
//   • otherwise (none-runtime / no runtime / pure-reasoning fixtures) → fall
//     back to the injected `fallback` executor (the P1 EchoExecutor), so the
//     existing non-microVM test fixtures stay green.
//
// Routing inputs (the orchestrator-runtime marker default + the saved
// runtime_configs rows) are gathered ONCE per run via {@link loadRuntimeConfigRows}
// and passed in, so a single node invoke does no extra DB round-trips.

import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutor,
} from "../engine/types.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";
import { NodeRunnerExecutor } from "./node-runner.js";
import { executorForNode, type RuntimeConfigRow } from "./executors/index.js";
import type { NodeRuntime } from "./node-runtime.js";

/** Live routing context, gathered once per run. */
export interface RoutingContext {
  /** The orchestrator-runtime marker's `.runtime` default (DESIGN §0.6). */
  markerRuntime?: string | null;
  /** Saved runtime_configs rows (id + kind + baseUrl + model). */
  runtimeConfigs: readonly RuntimeConfigRow[];
  /** Final fallback executor choice. */
  systemDefault?: string | null;
}

/** True when a node should run through the microVM NodeRunner. */
function isMicrovmNode(node: Node): boolean {
  const spec: NodeRuntimeSpec | undefined = node.runtime;
  // Default to microvm ONLY when a runtime spec is present and not "none".
  // Fixture nodes with no runtime spec stay on the echo fallback.
  return spec != null && spec.kind === "microvm";
}

/**
 * Route every node to its real executor + the 7-stage NodeRunner, or to the
 * fallback (echo) executor for non-microVM nodes.
 */
export class RoutingNodeExecutor implements NodeExecutor {
  readonly kind = "routing";
  private readonly fallback: NodeExecutor;
  private readonly ctx: RoutingContext;
  private readonly runtimeFor?: (spec: NodeRuntimeSpec) => NodeRuntime;

  constructor(args: {
    /** Executor for non-microVM nodes (P1 EchoExecutor in tests/fixtures). */
    fallback: NodeExecutor;
    ctx: RoutingContext;
    /** Inject a fake runtime backend in tests; production uses runtimeForSpec. */
    runtimeFor?: (spec: NodeRuntimeSpec) => NodeRuntime;
  }) {
    this.fallback = args.fallback;
    this.ctx = args.ctx;
    this.runtimeFor = args.runtimeFor;
  }

  async invoke(
    input: NodeExecutionInput,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    if (!isMicrovmNode(input.node)) {
      return this.fallback.invoke(input, signal);
    }

    const executor = executorForNode(input.node, {
      markerRuntime: this.ctx.markerRuntime,
      runtimeConfigs: this.ctx.runtimeConfigs,
      systemDefault: this.ctx.systemDefault,
    });

    const runner = new NodeRunnerExecutor({
      executor,
      runtimeFor: this.runtimeFor,
    });

    const result = await runner.invoke(
      {
        node: input.node,
        deps: input.deps,
        item: input.item,
        effort: input.effort,
      },
      signal,
    );
    return { output: result.output, tokensSpent: result.tokensSpent };
  }
}

/**
 * Gather the routing context for a run: the orchestrator-runtime marker default
 * + every saved runtime_configs row. A throwing getSetting degrades to "no
 * marker" (mirrors `resolveNodeExecutorChoiceFromEnv`).
 */
export async function loadRuntimeConfigRows(opts?: {
  systemDefault?: string | null;
}): Promise<RoutingContext> {
  const { getSetting } = await import("@agent-native/core/settings");
  const { getDb, schema } = await import("../db/index.js");

  let markerRuntime: string | null = null;
  try {
    const marker = (await getSetting("orchestrator-runtime")) as {
      runtime?: string;
    } | null;
    markerRuntime = marker?.runtime ?? null;
  } catch {
    markerRuntime = null;
  }

  const rows = await getDb()
    .select({
      id: schema.runtimeConfigs.id,
      kind: schema.runtimeConfigs.kind,
      baseUrl: schema.runtimeConfigs.baseUrl,
      model: schema.runtimeConfigs.model,
    })
    .from(schema.runtimeConfigs);

  return {
    markerRuntime,
    runtimeConfigs: rows as RuntimeConfigRow[],
    systemDefault: opts?.systemDefault ?? null,
  };
}
