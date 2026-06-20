import { describe, it, expect } from "vitest";
import {
  resolveNodeExecutorChoice,
  ConfigError,
  type ExecutorChoiceContext,
} from "./executor-choice.js";

// P5 item3 (DESIGN §8.3 item1/item3, D-7). The per-node engine/model picked in
// the editor must ROUTE THROUGH resolveNodeExecutorChoice to the right executor,
// and a per-node engine OVERRIDES the orchestrator-runtime marker.
//
// We assert the routing DECISION (the resolved ExecutorChoice) — the pure judge
// the executor router (`executorForNode`) consumes. We do NOT instantiate the
// real Vllm/RemoteApi executors here on purpose: those drag in `runAgentLoop` /
// the OpenTelemetry chain, which the vitest ESM runner cannot load; the choice
// is the load-bearing decision and the routing table over it is trivial
// (executors/index.ts: claude-code → ClaudeCodeExecutor; a vllm/openai-compatible
// row → VllmExecutor with the row baseUrl; a built-in engine id → RemoteApiExecutor).
//
// The vLLM path is end-to-end runnable (the headless E2E in the task); the claude
// executor's in-VM run needs VM egress (deferred, §7.0/§14), so here we verify it
// is SELECTED, not run.

// A live routing context mirroring loadRuntimeConfigRows: one vLLM runtime row,
// one claude-code runtime row, the builtin engine white-list.
const ctx = (markerRuntime: string | null): ExecutorChoiceContext => ({
  markerRuntime,
  runtimeConfigKeys: ["rt_vllm", "rt_cc"],
  systemDefault: null,
});

describe("per-node routing decision (D-7: node engine > marker > default)", () => {
  it("a vLLM-runtime node selects its runtime_config row (→ VllmExecutor)", () => {
    const choice = resolveNodeExecutorChoice(
      { engine: "rt_vllm" },
      ctx("claude-code"),
    );
    expect(choice).toEqual({ kind: "engine", engine: "rt_vllm" });
  });

  it("a claude-code node selects claude-code (→ ClaudeCodeExecutor)", () => {
    const choice = resolveNodeExecutorChoice(
      { engine: "claude-code" },
      ctx(null),
    );
    expect(choice).toEqual({ kind: "claude-code" });
  });

  it("per-node engine OVERRIDES the orchestrator-runtime marker (D-7)", () => {
    // marker = claude-code, but the node explicitly picked the vLLM runtime →
    // the node wins.
    expect(
      resolveNodeExecutorChoice({ engine: "rt_vllm" }, ctx("claude-code")),
    ).toEqual({ kind: "engine", engine: "rt_vllm" });

    // inverse: marker = a vLLM runtime, node picked claude-code → node wins.
    expect(
      resolveNodeExecutorChoice({ engine: "claude-code" }, ctx("rt_vllm")),
    ).toEqual({ kind: "claude-code" });
  });

  it("no per-node engine → the marker default decides (claude-code)", () => {
    expect(resolveNodeExecutorChoice({}, ctx("claude-code"))).toEqual({
      kind: "claude-code",
    });
  });

  it("a built-in framework engine id selects that engine (→ RemoteApiExecutor)", () => {
    expect(
      resolveNodeExecutorChoice({ engine: "ai-sdk:anthropic" }, ctx(null)),
    ).toEqual({ kind: "engine", engine: "ai-sdk:anthropic" });
  });

  it("an unknown/empty choice with no marker/default throws ConfigError", () => {
    expect(() => resolveNodeExecutorChoice({}, ctx(null))).toThrow(ConfigError);
  });
});
