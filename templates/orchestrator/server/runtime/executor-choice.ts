// Pure executor-choice judgement for the orchestrator's workflow DAG nodes.
//
// This module ONLY decides which executor a node should route to. It performs
// no execution, instantiates no engine, and starts no microVM (those land in
// P2). The decision follows the D-7 priority order (HARD rule, DESIGN §0.6 /
// IMPLEMENTATION P0):
//
//   node.engine (explicit per-node)  >  orchestrator-runtime marker default  >  SYSTEM_DEFAULT
//
// The accepted choices form a closed set: "claude-code", the built-in framework
// engine ids, and every saved runtime_configs row id. Anything outside that set
// (including an empty/missing choice) is an explicit ConfigError — we never
// return undefined.

// Thrown for an unknown/empty executor choice or an invalid SYSTEM_DEFAULT.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// The resolved routing decision. "claude-code" is the harness (not an
// AgentEngine); "engine" carries the framework engine id or a runtime_config
// row id, both of which the executor layer resolves in P2.
export type ExecutorChoice =
  | { kind: "claude-code" }
  | { kind: "engine"; engine: string };

// Built-in framework engines, the white-list from DESIGN §8.2 (registered by
// `registerBuiltinEngines()` in @agent-native/core: agent/engine/builtin.ts).
// Kept as a literal so tests and startup validation share one source of truth.
export const BUILTIN_ENGINES: readonly string[] = [
  "builder",
  "anthropic",
  "ai-sdk:anthropic",
  "ai-sdk:openai",
  "ai-sdk:openrouter",
  "ai-sdk:google",
  "ai-sdk:groq",
  "ai-sdk:mistral",
  "ai-sdk:cohere",
  "ai-sdk:ollama",
] as const;

// Inputs to the pure core. `runtimeConfigKeys` are the ids of saved
// runtime_configs rows (each row's id is its key). `markerRuntime` is the
// orchestrator-runtime marker's `.runtime` choice; `systemDefault` is the
// final fallback. `builtinEngines` is injectable for testing.
export interface ExecutorChoiceContext {
  markerRuntime?: string | null;
  runtimeConfigKeys: readonly string[];
  builtinEngines?: readonly string[];
  systemDefault?: string | null;
}

// Treats null / undefined / whitespace-only as "no choice".
function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

// PURE CORE: no IO, fully unit-testable. Resolves the executor choice for a
// single node following the D-7 priority order against the closed accepted set.
export function resolveNodeExecutorChoice(
  node: { engine?: string | null },
  ctx: ExecutorChoiceContext,
): ExecutorChoice {
  // "claude-code" is intentionally absent from the accepted set: DAG worker
  // nodes are not permitted to use the CC subscription engine. The explicit
  // check below produces a clear error instead of a generic "unknown choice".
  const accepted = new Set<string>([
    ...(ctx.builtinEngines ?? BUILTIN_ENGINES),
    ...ctx.runtimeConfigKeys,
  ]);

  const choice =
    nonEmpty(node.engine) ??
    nonEmpty(ctx.markerRuntime) ??
    nonEmpty(ctx.systemDefault);

  // Check CC first so callers get the specific error, not the generic one.
  // CC subscription is reserved for the brain only — DAG worker nodes must use
  // an API-key runtime. Isolated microVM nodes have no ~/.claude access and
  // headless CC subscription use violates Anthropic's terms.
  if (choice === "claude-code") {
    throw new ConfigError(
      "claude-code cannot be used as a DAG worker node engine. " +
        "CC subscription is reserved for the brain only. " +
        "Use an API-key runtime instead: ai-sdk:anthropic, ai-sdk:openai, " +
        "or a saved vllm / remote-api runtime_config.",
    );
  }

  if (choice === undefined || !accepted.has(choice)) {
    throw new ConfigError(`unknown/empty executor choice: ${String(choice)}`);
  }

  return { kind: "engine", engine: choice };
}

// ASYNC ENV WRAPPER: gathers live context (orchestrator-runtime marker +
// saved runtime_configs ids) and delegates to the pure core. A throwing
// getSetting degrades to "no marker" rather than failing the whole decision.
export async function resolveNodeExecutorChoiceFromEnv(
  node: { engine?: string | null },
  opts?: { systemDefault?: string | null },
): Promise<ExecutorChoice> {
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
    .select({ id: schema.runtimeConfigs.id })
    .from(schema.runtimeConfigs);
  const runtimeConfigKeys = rows.map((row) => row.id);

  return resolveNodeExecutorChoice(node, {
    markerRuntime,
    runtimeConfigKeys,
    builtinEngines: BUILTIN_ENGINES,
    systemDefault: opts?.systemDefault ?? null,
  });
}

// STARTUP VALIDATION: a configured SYSTEM_DEFAULT must be a real runtime key
// (a built-in engine or a saved runtime_configs id). "claude-code" is NOT a
// valid system default — it is reserved for the brain only.
export async function assertSystemDefaultValid(
  systemDefault: string | null | undefined,
  runtimeConfigKeys: readonly string[],
): Promise<void> {
  const value = nonEmpty(systemDefault);
  if (value === undefined) return;

  if (value === "claude-code") {
    throw new ConfigError(
      "SYSTEM_DEFAULT cannot be 'claude-code': CC subscription is reserved " +
        "for the brain only and may not be used as the default DAG worker engine.",
    );
  }

  const accepted = new Set<string>([
    ...BUILTIN_ENGINES,
    ...runtimeConfigKeys,
  ]);

  if (!accepted.has(value)) {
    throw new ConfigError(`SYSTEM_DEFAULT is not a real runtime key: ${value}`);
  }
}
