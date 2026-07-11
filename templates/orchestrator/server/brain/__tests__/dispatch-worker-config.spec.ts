// F4 覆盖补强(独立评审 item 4):V3Dispatcher.resolveAgentConfig 的 brain-kind
// 拒用门此前只有 f4-migration 源码文本锁覆盖。dispatchWorkerConfig 是该门背后
// 的纯决策函数 —— 遇 kind="brain" 行必须塌陷到 minimal prompt-only config
// (与 agent-not-found 回退同源),真 worker 行原样透传。
//
// 这补齐了 dispatcher 侧 F4 backstop 的确定性单测(手写 DAG 若把 brain 行填进
// 节点 agent 字段,不会以 brain 身份起 spawn)。

import { describe, it, expect } from "vitest";
import {
  dispatchWorkerConfig,
  minimalAgentConfig,
  type AgentConfig,
} from "../../agent-loader.js";

const worker: AgentConfig = {
  name: "vllm",
  description: "dev engine",
  runtime: "none",
  engine: "vllm",
  model: "qwen3.6",
  tools: ["Read", "Edit", "Write", "Bash"],
  systemPrompt: "you write code",
  kind: "worker",
  capabilityProfile: { develop: { tools: ["Read", "Edit"] } },
};

describe("minimalAgentConfig", () => {
  it("is prompt-only: no engine/model/tools, runtime none", () => {
    const m = minimalAgentConfig("some-agent");
    expect(m).toEqual({
      name: "some-agent",
      description: "",
      runtime: "none",
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "",
    });
  });
});

describe("dispatchWorkerConfig — resolveAgentConfig brain 拒用门(纯决策)", () => {
  it("passes a real worker row through unchanged", () => {
    expect(dispatchWorkerConfig(worker, "vllm")).toBe(worker);
  });

  it("collapses a kind=brain row to the minimal prompt-only config (never spawns as brain)", () => {
    const brain: AgentConfig = {
      name: "brain",
      description: "orchestrator brain capability row",
      runtime: "none",
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "",
      kind: "brain",
      capabilityProfile: {
        dispatch: { tools: ["mcp__orchestrator", "Read"] },
        review: { tools: ["mcp__orchestrator", "Read"] },
      },
    };
    const out = dispatchWorkerConfig(brain, "brain");
    expect(out).toEqual(minimalAgentConfig("brain"));
    // The brain row's identity (name aside) must not leak into the spawn.
    expect(out.tools).toEqual([]);
    expect(out.systemPrompt).toBe("");
    expect(out.kind).toBeUndefined();
    expect(out.capabilityProfile).toBeUndefined();
  });

  it("treats a missing/absent kind as a worker (default), passing it through", () => {
    const legacy = { ...worker };
    delete (legacy as { kind?: string }).kind;
    expect(dispatchWorkerConfig(legacy, "vllm")).toBe(legacy);
  });

  it("uses the passed agentName (not the row's name) for the brain fallback", () => {
    const brain: AgentConfig = {
      ...minimalAgentConfig("brain"),
      kind: "brain",
    };
    expect(dispatchWorkerConfig(brain, "n-review").name).toBe("n-review");
  });
});
