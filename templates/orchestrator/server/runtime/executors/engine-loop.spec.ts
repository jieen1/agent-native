// buildSystemPrompt — the vLLM/RemoteApi-routed executor path's system
// prompt builder. Previously every node ran on OPERATIONAL_SYSTEM_PROMPT
// alone (hardcoded, generic); the resolved agent's own agent_defs.system_prompt
// (v3-dispatcher.ts's Node.systemPromptOverride) was loaded but never reached
// here. This proves the persona is now prepended, and the load-bearing
// operational text is never dropped.

import { describe, it, expect } from "vitest";

import {
  buildSystemPrompt,
  buildPrompt,
  OPERATIONAL_SYSTEM_PROMPT,
} from "./engine-loop.js";
import type { RuntimeExecCtx } from "./types.js";

function fakeCtx(node: Partial<RuntimeExecCtx["node"]>): RuntimeExecCtx {
  return {
    node: { id: "n1", type: "agent", title: "Node", ...node },
  } as unknown as RuntimeExecCtx;
}

describe("buildSystemPrompt", () => {
  it("returns OPERATIONAL_SYSTEM_PROMPT unchanged when no systemPromptOverride is set", () => {
    expect(buildSystemPrompt(fakeCtx({}))).toBe(OPERATIONAL_SYSTEM_PROMPT);
  });

  it("prepends a configured persona ahead of the operational instructions", () => {
    const result = buildSystemPrompt(
      fakeCtx({ systemPromptOverride: "You are the QA agent." }),
    );
    expect(result).toBe(
      `You are the QA agent.\n\n${OPERATIONAL_SYSTEM_PROMPT}`,
    );
  });

  it("never drops the operational instructions even with a persona configured", () => {
    const result = buildSystemPrompt(
      fakeCtx({ systemPromptOverride: "You are the dev agent." }),
    );
    expect(result).toContain(OPERATIONAL_SYSTEM_PROMPT);
  });

  it("treats an empty/whitespace-only override the same as unset", () => {
    expect(buildSystemPrompt(fakeCtx({ systemPromptOverride: "   " }))).toBe(
      OPERATIONAL_SYSTEM_PROMPT,
    );
  });

  it("trims a persona with surrounding whitespace before prepending", () => {
    const result = buildSystemPrompt(
      fakeCtx({ systemPromptOverride: "  You are the reviewer.  \n" }),
    );
    expect(result).toBe(
      `You are the reviewer.\n\n${OPERATIONAL_SYSTEM_PROMPT}`,
    );
  });
});

describe("buildPrompt (unaffected by this change)", () => {
  it("still uses node.prompt as the user-turn instruction", () => {
    const ctx = fakeCtx({ prompt: "Implement the feature." });
    expect(buildPrompt(ctx)).toContain("Implement the feature.");
  });
});
