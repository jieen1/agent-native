import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACP_PACKAGE,
  AcpHarnessSession,
  acpAutoPermissionDecision,
  acpContentBlockToText,
  acpFileChangeEventsFromToolContent,
  acpUpdateToHarnessEvents,
  buildAcpPromptBlocks,
  createAcpHarnessAdapter,
  resolveAcpWorkspacePath,
  selectAcpPermissionOption,
} from "./acp-adapter.js";
import { BUILTIN_ACP_PRESETS } from "./acp-builtin.js";

describe("acpUpdateToHarnessEvents", () => {
  it("maps agent message and thought chunks to text/thinking deltas", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual([{ type: "text-delta", text: "hello" }]);
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      }),
    ).toEqual([{ type: "thinking-delta", text: "thinking" }]);
  });

  it("ignores the user's own echoed message chunk", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "my prompt" },
      }),
    ).toEqual([]);
  });

  it("maps a tool_call to a tool-start event with raw input", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read README.md",
        kind: "read",
        rawInput: { path: "README.md" },
      }),
    ).toEqual([
      {
        type: "tool-start",
        id: "call-1",
        name: "Read README.md",
        input: { path: "README.md" },
      },
    ]);
  });

  it("prefers the real Claude tool name (_meta.claudeCode.toolName) over the display title/kind — task #119/SDLC-066 regression", () => {
    // `@agentclientprotocol/claude-agent-acp` renders its OWN human-readable
    // title/kind for built-in tools (Glob -> title "Find", kind "search";
    // Read with no file_path yet -> title "Read File") — NEITHER identifies
    // the real tool, so a phase's allow-list (brain-capability.ts's
    // ["Read","Grep","Glob"]) can never match against them and wrongly denies
    // every real, allowed Read/Grep/Glob call. The real name lives in
    // `_meta.claudeCode.toolName` and must win.
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "tool_call",
        toolCallId: "call-glob",
        title: "Find",
        kind: "search",
        rawInput: { pattern: "*.ts" },
        _meta: { claudeCode: { toolName: "Glob" } },
      }),
    ).toEqual([
      {
        type: "tool-start",
        id: "call-glob",
        name: "Glob",
        input: { pattern: "*.ts" },
      },
    ]);

    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "tool_call",
        toolCallId: "call-read",
        title: "Read File",
        kind: "read",
        rawInput: {},
        _meta: { claudeCode: { toolName: "Read" } },
      }),
    ).toEqual([
      {
        type: "tool-start",
        id: "call-read",
        name: "Read",
        input: {},
      },
    ]);
  });

  it("uses the real tool name on a terminal tool_call_update that carries its own _meta", () => {
    const events = acpUpdateToHarnessEvents({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-grep",
      status: "completed",
      title: 'grep -n "foo"',
      rawOutput: { matches: 0 },
      _meta: { claudeCode: { toolName: "Grep" } },
    });
    expect(events).toEqual([
      {
        type: "tool-done",
        id: "call-grep",
        name: "Grep",
        result: { matches: 0 },
      },
    ]);
  });

  it("falls back to a cached real name (nameFor) when a refining tool_call_update omits _meta", () => {
    const events = acpUpdateToHarnessEvents(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-read-2",
        status: "completed",
        rawOutput: { ok: true },
      },
      {
        nameFor: (id) => (id === "call-read-2" ? "Read" : undefined),
        titleFor: (id) => (id === "call-read-2" ? "Read File" : undefined),
      },
    );
    expect(events).toEqual([
      {
        type: "tool-done",
        id: "call-read-2",
        name: "Read",
        result: { ok: true },
      },
    ]);
  });

  it("falls back to title/kind when no agent-specific _meta is present (e.g. a non-Claude ACP agent)", () => {
    // Non-Claude ACP agents (e.g. Gemini CLI) never set `_meta.claudeCode`, so
    // this must keep behaving exactly as before this fix.
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "tool_call",
        toolCallId: "call-other",
        title: "Search files",
        kind: "search",
        rawInput: { query: "foo" },
      }),
    ).toEqual([
      {
        type: "tool-start",
        id: "call-other",
        name: "Search files",
        input: { query: "foo" },
      },
    ]);
  });

  it("passes an MCP tool call's real name through unaffected (default title === name already)", () => {
    // `claude-agent-acp` has no custom title-formatter for MCP tool names, so
    // its own `title` already equals the real name — confirms this fix leaves
    // the already-correct mcp__orchestrator__* case untouched.
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "tool_call",
        toolCallId: "call-mcp",
        title: "mcp__orchestrator__view-screen",
        kind: "other",
        rawInput: {},
        _meta: { claudeCode: { toolName: "mcp__orchestrator__view-screen" } },
      }),
    ).toEqual([
      {
        type: "tool-start",
        id: "call-mcp",
        name: "mcp__orchestrator__view-screen",
        input: {},
      },
    ]);
  });

  it("emits tool-done plus file-change when a tool_call_update completes with a diff", () => {
    const events = acpUpdateToHarnessEvents(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-2",
        status: "completed",
        content: [
          { type: "diff", path: "src/app.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "src/new.ts", oldText: null, newText: "x" },
        ],
        rawInput: { path: "src/app.ts" },
        rawOutput: { ok: true },
      },
      (id) => (id === "call-2" ? "Edit files" : undefined),
    );
    expect(events).toEqual([
      { type: "file-change", path: "src/app.ts", operation: "update" },
      { type: "file-change", path: "src/new.ts", operation: "create" },
      {
        type: "tool-done",
        id: "call-2",
        name: "Edit files",
        input: { path: "src/app.ts" },
        result: { ok: true },
      },
    ]);
  });

  it("uses stored raw input for terminal tool updates", () => {
    expect(
      acpUpdateToHarnessEvents(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-3",
          status: "completed",
          rawOutput: { ok: true },
        },
        {
          titleFor: (id) => (id === "call-3" ? "Edit files" : undefined),
          inputFor: (id) =>
            id === "call-3" ? { path: "src/app.ts" } : undefined,
        },
      ),
    ).toEqual([
      {
        type: "tool-done",
        id: "call-3",
        name: "Edit files",
        input: { path: "src/app.ts" },
        result: { ok: true },
      },
    ]);
  });

  it("summarizes a plan update as an activity", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "plan",
        entries: [
          { content: "Read code", status: "completed" },
          { content: "Make edit", status: "in_progress" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    ).toEqual([
      {
        type: "activity",
        label: "Updated plan (1/3) — Make edit",
        tool: "acp:plan",
      },
    ]);
  });

  it("maps a usage_update to a usage event with context fill", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "usage_update",
        used: 12_345,
        size: 200_000,
      }),
    ).toEqual([
      {
        type: "usage",
        contextUsedTokens: 12_345,
        contextWindowTokens: 200_000,
      },
    ]);
  });

  it("maps a usage_update's cost to costCents (dollars -> cents)", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "usage_update",
        used: 500,
        size: 1_000_000,
        cost: { amount: 0.42, currency: "USD" },
      }),
    ).toEqual([
      {
        type: "usage",
        contextUsedTokens: 500,
        contextWindowTokens: 1_000_000,
        costCents: 42,
      },
    ]);
  });

  it("ignores command and mode updates", () => {
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      }),
    ).toEqual([]);
    expect(
      acpUpdateToHarnessEvents({
        sessionUpdate: "current_mode_update",
        currentModeId: "code",
      }),
    ).toEqual([]);
  });
});

describe("acpContentBlockToText", () => {
  it("reads text blocks and renders resource links", () => {
    expect(acpContentBlockToText({ type: "text", text: "hi" })).toBe("hi");
    expect(
      acpContentBlockToText({
        type: "resource_link",
        name: "spec",
        uri: "file:///spec.md",
      }),
    ).toBe("[spec](file:///spec.md)");
    expect(acpContentBlockToText({ type: "image", data: "..." })).toBe("");
    expect(acpContentBlockToText(undefined)).toBe("");
  });
});

describe("acpFileChangeEventsFromToolContent", () => {
  it("returns nothing for non-diff content", () => {
    expect(
      acpFileChangeEventsFromToolContent([
        { type: "content", content: { type: "text", text: "log" } },
      ]),
    ).toEqual([]);
    expect(acpFileChangeEventsFromToolContent(null)).toEqual([]);
  });
});

describe("acpAutoPermissionDecision", () => {
  it("auto-allows everything under allow-all", () => {
    expect(acpAutoPermissionDecision("execute", "allow-all")).toBe("allow");
    expect(acpAutoPermissionDecision("delete", "allow-all")).toBe("allow");
  });

  it("always allows read-like kinds", () => {
    for (const kind of ["read", "search", "fetch", "think"]) {
      expect(acpAutoPermissionDecision(kind, "allow-reads")).toBe("allow");
    }
  });

  it("allows edits only under allow-edits", () => {
    expect(acpAutoPermissionDecision("edit", "allow-reads")).toBe("prompt");
    expect(acpAutoPermissionDecision("edit", "allow-edits")).toBe("allow");
    expect(acpAutoPermissionDecision("move", "allow-edits")).toBe("allow");
    expect(acpAutoPermissionDecision("execute", "allow-edits")).toBe("prompt");
  });

  it("prompts for risky kinds under the default mode", () => {
    expect(acpAutoPermissionDecision("execute", "allow-reads")).toBe("prompt");
    expect(acpAutoPermissionDecision(undefined, "allow-reads")).toBe("prompt");
  });
});

describe("selectAcpPermissionOption", () => {
  const options = [
    { optionId: "a1", name: "Allow", kind: "allow_once" as const },
    { optionId: "a2", name: "Always", kind: "allow_always" as const },
    { optionId: "r1", name: "Reject", kind: "reject_once" as const },
  ];

  it("prefers the once variant for approvals and rejections", () => {
    expect(selectAcpPermissionOption(options, true)).toBe("a1");
    expect(selectAcpPermissionOption(options, false)).toBe("r1");
  });

  it("falls back to always-allow when no once option exists", () => {
    expect(
      selectAcpPermissionOption(
        [{ optionId: "a2", name: "Always", kind: "allow_always" }],
        true,
      ),
    ).toBe("a2");
  });

  it("returns undefined when no matching option exists", () => {
    expect(
      selectAcpPermissionOption(
        [{ optionId: "a1", name: "Allow", kind: "allow_once" }],
        false,
      ),
    ).toBeUndefined();
  });
});

describe("buildAcpPromptBlocks", () => {
  it("uses the prompt string when present", () => {
    expect(buildAcpPromptBlocks({ prompt: "do it" })).toEqual([
      { type: "text", text: "do it" },
    ]);
  });

  it("falls back to the last user message", () => {
    expect(
      buildAcpPromptBlocks({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      }),
    ).toEqual([{ type: "text", text: "second" }]);
  });

  it("flattens array message content", () => {
    expect(
      buildAcpPromptBlocks({
        messages: [{ role: "user", content: [{ text: "a" }, { text: "b" }] }],
      }),
    ).toEqual([{ type: "text", text: "ab" }]);
  });
});

describe("resolveAcpWorkspacePath", () => {
  const root = path.join(os.tmpdir(), "acp-workspace");

  it("resolves relative and absolute paths inside the workspace", () => {
    expect(resolveAcpWorkspacePath(root, "src/app.ts")).toBe(
      path.join(root, "src/app.ts"),
    );
    expect(resolveAcpWorkspacePath(root, path.join(root, "a.ts"))).toBe(
      path.join(root, "a.ts"),
    );
  });

  it("refuses paths that escape the workspace", () => {
    expect(() => resolveAcpWorkspacePath(root, "../escape.ts")).toThrow(
      /outside the session workspace/,
    );
    expect(() => resolveAcpWorkspacePath(root, "/etc/passwd")).toThrow(
      /outside the session workspace/,
    );
  });

  it("rejects empty paths", () => {
    expect(() => resolveAcpWorkspacePath(root, "")).toThrow(/non-empty string/);
  });
});

describe("createAcpHarnessAdapter", () => {
  it("describes a local, file-aware, non-sandboxed harness", () => {
    const adapter = createAcpHarnessAdapter({
      command: "gemini",
      args: ["--experimental-acp"],
    });
    expect(adapter.name).toBe("acp");
    expect(adapter.installPackage).toBe(ACP_PACKAGE);
    expect(adapter.capabilities).toMatchObject({
      sandbox: false,
      approvals: true,
      fileEvents: true,
      hostTools: false,
    });
  });

  it("fails fast when no command is configured", async () => {
    await expect(createAcpHarnessAdapter({}).createSession({})).rejects.toThrow(
      /requires a command/,
    );
  });
});

describe("AcpHarnessSession — mcpServers + metadata forwarding", () => {
  // `createSession`'s dynamic import of the optional ACP transport package
  // deliberately defeats static analysis (see the `dynamicImport` comment
  // above), which also makes it unmockable via `vi.mock` — confirmed: it
  // throws "A dynamic import callback was not specified" under vitest's
  // module runner. So these tests construct `AcpHarnessSession` (exported
  // above solely for this purpose) directly with a fake `acp` transport,
  // exercising the real `initialize()` forwarding logic without going
  // through `createAcpHarnessAdapter`'s dynamic import. A real (trivial)
  // child process is still spawned because `initialize()` wires its stdio
  // through `Writable.toWeb` / `Readable.toWeb`, which require real streams.
  function fakeAcp(calls: { newSession: unknown[]; loadSession: unknown[] }) {
    return {
      PROTOCOL_VERSION: 1,
      ndJsonStream: () => ({}) as never,
      ClientSideConnection: class {
        constructor(_toClient: unknown, _stream: unknown) {}
        async initialize() {
          return { agentCapabilities: { loadSession: true } };
        }
        async newSession(params: unknown) {
          calls.newSession.push(params);
          return { sessionId: "fresh-session-id" };
        }
        async loadSession(params: unknown) {
          calls.loadSession.push(params);
          return {};
        }
        async prompt() {
          return { stopReason: "end_turn" };
        }
        async cancel() {}
      },
    };
  }

  async function withTrivialChild(
    fn: (child: ChildProcessWithoutNullStreams) => Promise<void>,
  ): Promise<void> {
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000);",
    ]);
    try {
      await fn(child);
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("forwards mcpServers and metadata as ACP _meta on a fresh session (newSession), not hardcoded []", async () => {
    await withTrivialChild(async (child) => {
      const calls = {
        newSession: [] as unknown[],
        loadSession: [] as unknown[],
      };
      const session = new AcpHarnessSession({
        acp: fakeAcp(calls),
        child,
        command: process.execPath,
        cwd: os.tmpdir(),
        permissionMode: "allow-all",
      });
      const mcpServers = [
        { type: "http", name: "orchestrator", url: "http://x", headers: [] },
      ];
      const metadata = { claudeCode: { options: { tools: ["Bash"] } } };
      await session.initialize({ mcpServers, metadata });

      expect(calls.newSession).toEqual([
        expect.objectContaining({ mcpServers, _meta: metadata }),
      ]);
      expect(calls.loadSession).toEqual([]);
      expect(session.id).toBe("fresh-session-id");
    });
  });

  it("forwards mcpServers and metadata as ACP _meta on a resumed session (loadSession), not hardcoded []", async () => {
    await withTrivialChild(async (child) => {
      const calls = {
        newSession: [] as unknown[],
        loadSession: [] as unknown[],
      };
      const session = new AcpHarnessSession({
        acp: fakeAcp(calls),
        child,
        command: process.execPath,
        cwd: os.tmpdir(),
        permissionMode: "allow-all",
      });
      const mcpServers = [
        { type: "http", name: "orchestrator", url: "http://x", headers: [] },
      ];
      const metadata = {
        claudeCode: { options: { model: "claude-sonnet-5" } },
      };
      await session.initialize({
        mcpServers,
        metadata,
        resumeState: { sessionId: "resume-id-123" },
      });

      expect(calls.loadSession).toEqual([
        expect.objectContaining({
          sessionId: "resume-id-123",
          mcpServers,
          _meta: metadata,
        }),
      ]);
      expect(calls.newSession).toEqual([]);
      // The brain's fallback-detection (`session.id !== resumeSessionId`)
      // depends on `session.id` reflecting the real resumed ACP session id.
      expect(session.id).toBe("resume-id-123");
    });
  });
});

describe("BUILTIN_ACP_PRESETS", () => {
  it("registers gemini and claude-code presets", () => {
    expect(BUILTIN_ACP_PRESETS.map((preset) => preset.name)).toEqual([
      "acp:gemini",
      "acp:claude-code",
    ]);
    for (const preset of BUILTIN_ACP_PRESETS) {
      expect(preset.command).toBeTruthy();
      expect(preset.args.length).toBeGreaterThan(0);
    }
  });
});
