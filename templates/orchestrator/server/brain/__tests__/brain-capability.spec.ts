// F4 capability matrix — argv/tool-face unit tests (docs/sdlc-impl-f1-f4.md
// §6.4: T-F4-01 dispatch-phase tool face, T-F4-09 review-phase tool face,
// T-F4-03 unit half — capability_profile drives the assembled face with zero
// code changes). Pure functions only; no DB/process access.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_BRAIN_CAPABILITY,
  NO_DIRECT_WRITE_PROMPT_CLAUSE,
  REVIEW_PHASE_PROMPT_ADDENDUM,
  buildBrainArgv,
  harnessBuiltinTools,
  isToolAllowedForPhase,
  resolveBrainAllowedTools,
} from "../brain-capability.js";

/** The `--allowedTools` values segment of a built argv (up to the next flag). */
function allowedToolsSegment(argv: string[]): string[] {
  const start = argv.indexOf("--allowedTools");
  expect(start).toBeGreaterThan(-1);
  const out: string[] = [];
  for (let i = start + 1; i < argv.length && !argv[i].startsWith("--"); i++) {
    out.push(argv[i]);
  }
  return out;
}

describe("T-F4-01 — dispatch-phase tool face (brain argv 构造纯函数)", () => {
  it("resolves EXACTLY mcp__orchestrator + Read/Grep/Glob — no Bash/Write/Edit", () => {
    const tools = resolveBrainAllowedTools("dispatch", null);
    expect(tools).toEqual(["mcp__orchestrator", "Read", "Grep", "Glob"]);
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });

  it("buildBrainArgv places exactly that face after --allowedTools", () => {
    const argv = buildBrainArgv({
      message: "dispatch task",
      brainModel: null,
      mcpConfigPath: "/tmp/x/.mcp.json",
      allowedTools: resolveBrainAllowedTools("dispatch", null),
      systemPrompt: "PROMPT",
      resumeSessionId: null,
    });
    expect(allowedToolsSegment(argv)).toEqual([
      "mcp__orchestrator",
      "Read",
      "Grep",
      "Glob",
    ]);
    // No resume flag when no session id.
    expect(argv).not.toContain("--resume");
    // Core invocation shape retained.
    expect(argv.slice(0, 2)).toEqual(["-p", "dispatch task"]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("stream-json");
  });

  it("threads model + resume through unchanged", () => {
    const argv = buildBrainArgv({
      message: "m",
      brainModel: "claude-opus-4-8",
      mcpConfigPath: "/tmp/x/.mcp.json",
      allowedTools: ["mcp__orchestrator", "Read"],
      systemPrompt: "P",
      resumeSessionId: "sess-1",
    });
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("claude-opus-4-8");
    const resumeIdx = argv.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(argv[resumeIdx + 1]).toBe("sess-1");
  });
});

describe("T-F4-09 — review-phase tool face (评审相位 argv 单测)", () => {
  it("resolves EXACTLY mcp__orchestrator + Read/Grep/Glob — no Bash/Write/Edit", () => {
    const tools = resolveBrainAllowedTools("review", null);
    expect(tools).toEqual(["mcp__orchestrator", "Read", "Grep", "Glob"]);
    for (const forbidden of ["Bash", "Write", "Edit"]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  it("review argv's --allowedTools segment carries no write tool", () => {
    const argv = buildBrainArgv({
      message: "review run r-1",
      brainModel: null,
      mcpConfigPath: "/tmp/x/.mcp.json",
      allowedTools: resolveBrainAllowedTools("review", null),
      systemPrompt: `PROMPT\n\n${REVIEW_PHASE_PROMPT_ADDENDUM}`,
      resumeSessionId: null,
    });
    const segment = allowedToolsSegment(argv);
    expect(segment).toEqual(["mcp__orchestrator", "Read", "Grep", "Glob"]);
    for (const forbidden of ["Bash", "Write", "Edit"]) {
      expect(segment).not.toContain(forbidden);
    }
  });

  it("default faces for BOTH phases are identical and read-only (§5.3: 全相位无写工具)", () => {
    expect(DEFAULT_BRAIN_CAPABILITY.dispatch.tools).toEqual(
      DEFAULT_BRAIN_CAPABILITY.review.tools,
    );
    expect(DEFAULT_BRAIN_CAPABILITY.dispatch.workspaceAccess).toBe("ro");
    expect(DEFAULT_BRAIN_CAPABILITY.review.workspaceAccess).toBe("ro");
  });
});

describe("T-F4-03 (unit) — capability_profile 配置驱动装配,零代码改动", () => {
  it("a configured profile entry overrides the default face", () => {
    const profile = {
      review: {
        tools: ["mcp__orchestrator", "Read"],
        workspaceAccess: "ro" as const,
      },
    };
    expect(resolveBrainAllowedTools("review", profile)).toEqual([
      "mcp__orchestrator",
      "Read",
    ]);
    // Other phase untouched → default.
    expect(resolveBrainAllowedTools("dispatch", profile)).toEqual(
      DEFAULT_BRAIN_CAPABILITY.dispatch.tools,
    );
  });

  it("adding a tool in config shows up; removing one disappears", () => {
    const widened = {
      dispatch: {
        tools: ["mcp__orchestrator", "Read", "Grep", "Glob", "WebFetch"],
      },
    };
    expect(resolveBrainAllowedTools("dispatch", widened)).toContain("WebFetch");
    const narrowed = { dispatch: { tools: ["mcp__orchestrator"] } };
    expect(resolveBrainAllowedTools("dispatch", narrowed)).toEqual([
      "mcp__orchestrator",
    ]);
  });

  it("malformed/empty profile entries fall back to the default (never fail-open wider)", () => {
    expect(resolveBrainAllowedTools("review", {})).toEqual(
      DEFAULT_BRAIN_CAPABILITY.review.tools,
    );
    expect(
      resolveBrainAllowedTools("review", { review: { tools: [] } }),
    ).toEqual(DEFAULT_BRAIN_CAPABILITY.review.tools);
    expect(
      resolveBrainAllowedTools("review", {
        review: { tools: "Bash" as unknown as string[] },
      }),
    ).toEqual(DEFAULT_BRAIN_CAPABILITY.review.tools);
    expect(resolveBrainAllowedTools("review", undefined)).toEqual(
      DEFAULT_BRAIN_CAPABILITY.review.tools,
    );
  });
});

describe("isToolAllowedForPhase — 拒绝判定与 MCP 通配", () => {
  const face = ["mcp__orchestrator", "Read", "Grep", "Glob"];

  it("bare mcp__orchestrator entry admits every namespaced orchestrator tool", () => {
    expect(isToolAllowedForPhase("mcp__orchestrator__workflowRun", face)).toBe(
      true,
    );
    expect(isToolAllowedForPhase("mcp__orchestrator__runVerdict", face)).toBe(
      true,
    );
    expect(isToolAllowedForPhase("mcp__orchestrator", face)).toBe(true);
  });

  it("admits listed builtins, denies write tools and foreign MCP servers", () => {
    expect(isToolAllowedForPhase("Read", face)).toBe(true);
    expect(isToolAllowedForPhase("Grep", face)).toBe(true);
    expect(isToolAllowedForPhase("Bash", face)).toBe(false);
    expect(isToolAllowedForPhase("Write", face)).toBe(false);
    expect(isToolAllowedForPhase("Edit", face)).toBe(false);
    expect(isToolAllowedForPhase("mcp__other__x", face)).toBe(false);
    expect(isToolAllowedForPhase("", face)).toBe(false);
  });
});

describe("harnessBuiltinTools — ACP 通道剥离 MCP 通配项", () => {
  it("strips only the bare mcp__orchestrator entry", () => {
    expect(
      harnessBuiltinTools(["mcp__orchestrator", "Read", "Grep", "Glob"]),
    ).toEqual(["Read", "Grep", "Glob"]);
  });
});

describe("prompt clauses — 机制之上的提示重申(非替代)", () => {
  it("both clauses state the no-write rule and the workflowRun exit", () => {
    expect(NO_DIRECT_WRITE_PROMPT_CLAUSE).toMatch(/NO Bash\/Edit\/Write/);
    expect(NO_DIRECT_WRITE_PROMPT_CLAUSE).toContain("workflowRun");
    expect(REVIEW_PHASE_PROMPT_ADDENDUM).toContain("runVerdict");
    expect(REVIEW_PHASE_PROMPT_ADDENDUM).toContain("CHANGES_REQUESTED");
    expect(REVIEW_PHASE_PROMPT_ADDENDUM).toContain("workflowRun");
  });
});
