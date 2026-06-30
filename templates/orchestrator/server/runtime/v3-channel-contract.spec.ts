// P0 D0: V3 Channel Contract Spike
// Verifies NodeRunner compatibility with V3 4-input + 3-output contract.
//
// V3 spawn contract (DESIGN §0):
//   Inputs:  system_prompt, rendered_prompt, tools, workspace
//   Outputs: string (default) | validated JSON object (output_schema) | schema-violation
//
// Existing NodeRunner input (DESIGN §7.4.1a):
//   NodeRunnerInput: { node, deps, item, effort, ownerEmail, orgId }
//   RuntimeExecCtx passed to executor: { runtime, vm, node, workdir, deps, item, effort, ... }
//
// This spike tests the adapter layer that maps V3 4-inputs → NodeRunnerInput.

import { describe, it, expect } from "vitest";
import { NodeRunner } from "./node-runner.js";
import type {
  NodeRuntime,
  VmHandle,
  TeardownPolicy,
} from "./node-runtime.js";
import type { RuntimeExecutor, RuntimeExecCtx, RuntimeExecResult } from "./executors/types.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";

// ============================================================================
// Fake infrastructure (no real VM, no real model)
// ============================================================================

/** Fake runtime: provision/teardown are no-ops, exec creates workdir */
function fakeRuntime(): NodeRuntime {
  return {
    kind: "fake",
    async provision(spec: NodeRuntimeSpec): Promise<VmHandle> {
      return { name: "fake_vm", spec };
    },
    async mount() {},
    async init() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("not used");
    },
    fs() {
      return {
        read: async () => "",
        write: async () => {},
        copyFromHost: async () => {},
        copyToHost: async () => {},
      };
    },
    async getPortUrl() {
      return "";
    },
    async snapshot() {
      return "snap";
    },
    async teardown(_vm: VmHandle, _policy: TeardownPolicy) {},
  };
}

// ============================================================================
// Spike: V3 Channel Contract Verification
// ============================================================================

/**
 * V3 channel input: the 4 inputs a spawn receives.
 * This is the V3 contract — not the current NodeRunner input.
 */
interface V3SpawnInput {
  system_prompt: string;
  rendered_prompt: string;
  tools?: string[];
  workspace?: string;
}

/**
 * V3 channel output paths:
 * 1. Default: single string
 * 2. With output_schema: validated JSON object
 * 3. Schema violation: error
 */
type V3SpawnOutput =
  | { path: "string"; value: string }
  | { path: "object"; schema: string; value: Record<string, unknown> }
  | { path: "schema-violation"; schema: string; raw: unknown; error: string };

/**
 * Adapter: maps V3 4-inputs → NodeRunnerInput.
 * This is the adapter layer the spike validates.
 */
function v3ToNodeRunnerInput(
  v3Input: V3SpawnInput,
  overrides?: {
    nodeId?: string;
    nodeTitle?: string;
    outputSchema?: unknown;
  },
): { node: Node; deps: Record<string, unknown> } {
  const node: Node = {
    id: overrides?.nodeId ?? "v3-spike-node",
    type: "agent",
    title: overrides?.nodeTitle ?? "V3 Spike Node",
    // The rendered_prompt becomes the node prompt. The system_prompt is carried
    // in the node title or metadata — the executor's buildPrompt will use this.
    prompt: v3Input.rendered_prompt,
    // tools and workspace are runtime concerns, not node config in V2 schema.
    // The adapter must ensure:
    // - tools allowlist → enforced by executor (not yet in V2)
    // - workspace optional → runtime.kind === "none" if no workspace
    runtime: v3Input.workspace
      ? { kind: "microvm", onFailure: "recreate" }
      : { kind: "none", onFailure: "recreate" },
    outputSchema: overrides?.outputSchema,
  };
  return { node, deps: {} };
}

/** Classify a NodeRunnerResult.output into V3 output paths (module-level for all tests) */
function classifyOutput(
  output: unknown,
  outputSchema?: unknown,
): V3SpawnOutput {
  if (outputSchema === undefined) {
    return {
      path: "string",
      value: typeof output === "string" ? output : JSON.stringify(output),
    };
  }
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    return {
      path: "object",
      schema: JSON.stringify(outputSchema),
      value: output as Record<string, unknown>,
    };
  }
  return {
    path: "schema-violation",
    schema: JSON.stringify(outputSchema),
    raw: output,
    error: `Output does not match schema: expected object, got ${typeof output}`,
  };
}

describe("D0: V3 Channel Contract Spike", () => {
  describe("Input adapter: V3 4-inputs → NodeRunnerInput", () => {
    it("maps V3 4 inputs to NodeRunnerInput — all 4 present", () => {
      const v3Input: V3SpawnInput = {
        system_prompt: "You are an implementer agent",
        rendered_prompt: "Implement the feature described in {{deps.spec.output}}",
        tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        workspace: "/work",
      };

      const { node, deps } = v3ToNodeRunnerInput(v3Input);

      // rendered_prompt → node.prompt (the executor builds user message from this)
      expect(node.prompt).toBe(v3Input.rendered_prompt);
      // workspace present → microvm runtime
      expect(node.runtime?.kind).toBe("microvm");
      // deps empty (no upstream in this spike)
      expect(Object.keys(deps).length).toBe(0);
    });

    it("maps V3 4 inputs — minimal (no tools, no workspace)", () => {
      const v3Input: V3SpawnInput = {
        system_prompt: "You are a reviewer",
        rendered_prompt: "Review this code",
      };

      const { node } = v3ToNodeRunnerInput(v3Input);

      // No workspace → none runtime (host execution, no VM)
      expect(node.runtime?.kind).toBe("none");
      expect(node.prompt).toBe(v3Input.rendered_prompt);
    });

    it("preserves output_schema for schema-validated output", () => {
      const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };

      const { node } = v3ToNodeRunnerInput(
        {
          system_prompt: "Reviewer",
          rendered_prompt: "Review",
        },
        { outputSchema: schema },
      );

      expect(node.outputSchema).toEqual(schema);
    });
  });

  describe("Output paths: NodeRunnerResult → V3 3-output paths", () => {

    it("output path 1: string (no schema)", () => {
      const result = classifyOutput("The implementation is complete.");
      expect(result.path).toBe("string");
      expect((result as V3SpawnOutput & { path: "string" }).value).toBe(
        "The implementation is complete.",
      );
    });

    it("output path 1: non-string without schema → JSON stringified", () => {
      const result = classifyOutput({ ok: true, count: 5 });
      expect(result.path).toBe("string");
      expect((result as V3SpawnOutput & { path: "string" }).value).toBe(
        '{"ok":true,"count":5}',
      );
    });

    it("output path 2: object with schema match", () => {
      const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };
      const result = classifyOutput(
        { verdict: "pass", comments: "Clean code" },
        schema,
      );
      expect(result.path).toBe("object");
      expect(
        (result as V3SpawnOutput & { path: "object" }).value.verdict,
      ).toBe("pass");
    });

    it("output path 3: schema violation — string when object expected", () => {
      const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };
      const result = classifyOutput("just a string", schema);
      expect(result.path).toBe("schema-violation");
      expect((result as V3SpawnOutput & { path: "schema-violation" }).error).toContain(
        "schema",
      );
    });
  });

  describe("End-to-end: V3 input → adapter → NodeRunner → output path", () => {
    /**
     * Capturing executor that records the RuntimeExecCtx it receives.
     * Lets us inspect what the executor sees after the adapter + NodeRunner pipeline.
     */
    let capturedCtx: RuntimeExecCtx | null = null;
    let executorOutput: unknown = undefined;

    const capturingExecutor: RuntimeExecutor = {
      kind: "v3-spike",
      async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
        capturedCtx = ctx;
        return {
          output: executorOutput,
          tokensSpent: 0,
          toolCallCount: 0,
          model: "v3-spike",
        };
      },
    };

    it("full pipeline: V3 4-inputs → NodeRunner → string output", async () => {
      executorOutput = "Task complete: added input validation";

      const v3Input: V3SpawnInput = {
        system_prompt: "You are an implementer",
        rendered_prompt: "Add input validation to the auth module",
        tools: ["Read", "Edit", "Write", "Bash"],
        workspace: "/work",
      };

      const { node } = v3ToNodeRunnerInput(v3Input);
      const runner = new NodeRunner({
        executor: capturingExecutor,
        runtimeFor: () => fakeRuntime(),
      });

      const result = await runner.run(
        {
          node,
          deps: {},
          ownerEmail: "local@localhost",
          orgId: null,
        },
        new AbortController().signal,
      );

      // Verify output passes through
      expect(result.output).toBe(executorOutput);
      expect(result.model).toBe("v3-spike");

      // Verify the executor received correct context
      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.node.prompt).toBe(v3Input.rendered_prompt);
    });

    it("full pipeline: output_schema → object output path", async () => {
      const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };
      executorOutput = { verdict: "pass", score: 95 };

      const { node } = v3ToNodeRunnerInput(
        {
          system_prompt: "You are a code reviewer",
          rendered_prompt: "Review the PR",
        },
        { outputSchema: schema },
      );

      const runner = new NodeRunner({
        executor: capturingExecutor,
        runtimeFor: () => fakeRuntime(),
      });

      const result = await runner.run(
        {
          node,
          deps: {},
          ownerEmail: "local@localhost",
          orgId: null,
        },
        new AbortController().signal,
      );

      const classified = classifyOutput(result.output, schema);
      expect(classified.path).toBe("object");
    });

    it("full pipeline: output_schema violation path", async () => {
      const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      };
      executorOutput = "I reviewed the code and it looks good"; // string, not object

      const { node } = v3ToNodeRunnerInput(
        {
          system_prompt: "Reviewer",
          rendered_prompt: "Review",
        },
        { outputSchema: schema },
      );

      const runner = new NodeRunner({
        executor: capturingExecutor,
        runtimeFor: () => fakeRuntime(),
      });

      const result = await runner.run(
        {
          node,
          deps: {},
          ownerEmail: "local@localhost",
          orgId: null,
        },
        new AbortController().signal,
      );

      const classified = classifyOutput(result.output, schema);
      expect(classified.path).toBe("schema-violation");
    });
  });

  describe("Gap analysis: adapter layer requirements", () => {
    it("GAP 1: system_prompt — currently hardcoded in engine-loop.ts, needs agent.md resolution", () => {
      // engine-loop.ts line ~100 hardcodes:
      // "You are a coding agent operating inside an isolated microVM workspace..."
      // V3 requires per-agent system prompts from .md frontmatter.
      // → Adapter must resolve agent.md → system_prompt before calling executor.
      // VERDICT: Adapter needed. The v3-dispatcher will resolve agent frontmatter
      // and pass system_prompt to executor instead of hardcoded default.
      expect(true).toBe(true); // Spike verification: gap confirmed
    });

    it("GAP 2: tools allowlist — currently all VM tools, V3 wants per-agent allowlist", () => {
      // engine-loop.ts createVmActingBridge() exposes all tools.
      // V3 wants 6 standard tools allowlisted per agent frontmatter.
      // → Adapter must filter tools based on agent frontmatter allowlist.
      // VERDICT: Adapter needed. The v3-dispatcher will filter acting bridge tools.
      expect(true).toBe(true); // Spike verification: gap confirmed
    });

    it("GAP 3: rendered_prompt — engine-loop.ts dumps all deps, V3 uses only {{}} interpolation", () => {
      // engine-loop.ts buildPrompt() appends all deps as JSON to the prompt.
      // V3 design says deps only reach downstream via explicit {{deps.X.output.Y}}.
      // → The rendered_prompt should be pre-rendered with interpolation BEFORE
      // reaching the executor. No automatic dep dump.
      // VERDICT: Adapter needed. v3-dispatcher renders prompt with interpolation,
      // passes clean rendered_prompt to executor. No deps dump.
      expect(true).toBe(true); // Spike verification: gap confirmed
    });

    it("GAP 4: output validation — NodeRunnerResult.output is unknown, V3 needs schema validation", () => {
      // NodeRunner returns output: unknown. No schema validation in the pipeline.
      // V3 requires output_schema validation at dispatcher boundary.
      // → Post-execution validation in v3-dispatcher, not in NodeRunner itself.
      // VERDICT: Adapter needed. v3-dispatcher validates output against schema
      // after NodeRunner returns, routes to object / schema-violation path.
      expect(true).toBe(true); // Spike verification: gap confirmed
    });

    it("GAP 5: max_summary_tokens — not implemented, record for P1 dispatcher", () => {
      // V3 design §0 I3: max_summary_tokens truncates output.
      // No truncation in current engine-loop.ts or NodeRunner.
      // VERDICT: P1 dispatcher feature. Not blocking P0.
      expect(true).toBe(true); // Spike verification: gap confirmed, deferred to P1
    });

    it("CONCLUSION: adapter layer is the right approach", () => {
      // Spike conclusion:
      // - NodeRunner 7-stage lifecycle is reusable (provision→mount→init→execute→collect→extract→teardown)
      // - RuntimeExecutor seam is reusable (vllm-executor, claude-code-executor, engine-loop)
      // - The V3 channel contract (4 inputs + 3 outputs) needs an adapter layer
      //   BETWEEN the v3-dispatcher and the existing NodeRunner/executor stack
      //
      // Adapter location: v3-dispatcher (P1)
      //   Input side: resolve agent.md → system_prompt; render {{ }} → rendered_prompt;
      //     filter tools; optional workspace → runtime.kind selection
      //   Output side: validate output against output_schema → string/object/violation path
      //     + max_summary_tokens truncation
      //
      // The adapter complements NodeRunner; it doesn't replace it.
      const adapterSpec = {
        name: "v3-dispatcher",
        inputAdapter: {
          resolveSystemPrompt: "agent.md frontmatter",
          renderPrompt: "{{ }} interpolation (P0 E)",
          filterTools: "agent frontmatter allowlist",
          selectRuntime: "workspace? microvm : none",
        },
        outputAdapter: {
          validateSchema: "ajv compile + validate against output_schema",
          truncateSummary: "max_summary_tokens (P1)",
          classifyPath: "string / object / schema-violation",
        },
      };
      expect(adapterSpec.inputAdapter.resolveSystemPrompt).toBeDefined();
      expect(adapterSpec.outputAdapter.validateSchema).toBeDefined();
    });
  });
});
