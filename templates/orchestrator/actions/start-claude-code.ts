import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import {
  resolveAgentHarness,
  startAgentHarnessRun,
  ensureAgentHarnessSessionTables,
} from "@agent-native/core/agent/harness";
import { z } from "zod";
import { newId } from "./_util.js";
import { registerOrchestratorRuntime } from "../server/register-runtime.js";
import { getClaudeCodeAuthStatus } from "../server/claude-code-status.js";

// Run a prompt on the local Claude Code harness (uses the machine's `claude`
// login = your Pro/Max subscription, not an API key). By default it AWAITS the
// run and returns the actual Claude Code output text + any error, so the caller
// (Settings "Test run") can show a real result and confirm the subscription
// chain works — not just that a run was kicked off.
export default defineAction({
  description:
    "Run a prompt on the local Claude Code harness (subscription) and return its output. Use for code/agentic work the orchestrator should run on Claude Code.",
  schema: z.object({
    prompt: z.string().describe("What Claude Code should do"),
    instructions: z.string().optional(),
    cwd: z.string().optional().describe("Working directory for the run"),
    wait: z
      .boolean()
      .default(true)
      .describe("Await the run and return its output (default true)"),
    timeoutMs: z.number().default(120_000),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();

    // Pre-flight: the harness reuses the local `claude` login. If it's missing or
    // expired, the harness silently produces no output — so surface a real,
    // actionable error here instead of a fake "success".
    // Structured (not thrown) so the message reaches the UI — action-routes
    // genericizes thrown errors to "Internal server error".
    const fail = (error: string, needsLogin = false) => ({
      ok: false as const,
      runId: null,
      threadId: null,
      output: null,
      error,
      needsLogin,
      completed: false,
    });

    const auth = getClaudeCodeAuthStatus();
    if (!auth.credentialsFound) {
      return fail(
        "Claude Code is not logged in on this machine. Run `claude login` in a terminal, then retry.",
        true,
      );
    }
    if (auth.expired || !auth.loggedIn) {
      return fail(
        `Claude Code login expired${auth.expiresAt ? ` (on ${auth.expiresAt})` : ""}. Run \`claude login\` to refresh the subscription token, then retry.`,
        true,
      );
    }

    registerOrchestratorRuntime();
    let adapter;
    try {
      adapter = resolveAgentHarness("ai-sdk-harness:claude-code");
    } catch (err) {
      return fail(
        `Could not resolve Claude Code harness: ${err instanceof Error ? err.message : String(err)}. ` +
          "Install: pnpm --filter orchestrator add @ai-sdk/harness@canary @ai-sdk/harness-claude-code@canary",
      );
    }

    await ensureAgentHarnessSessionTables();

    const runId = newId("ccrun");
    const threadId = newId("ccthread");
    const chunks: string[] = [];
    const activity: string[] = [];
    let harnessError = "";
    let completed = false;

    const finished = new Promise<void>((resolve) => {
      try {
        startAgentHarnessRun({
          runId,
          threadId,
          adapter,
          input: { prompt: args.prompt },
          createSession: {
            permissionMode: "allow-edits",
            ...(args.instructions ? { instructions: args.instructions } : {}),
            ...(args.cwd ? { cwd: args.cwd } : {}),
          },
          ownerEmail,
          orgId,
          onHarnessEvent: (e) => {
            activity.push(e.type); // diagnostic: record every event type
            if (e.type === "text-delta" && typeof e.text === "string") {
              chunks.push(e.text);
            } else if (e.type === "thinking-delta" && typeof e.text === "string") {
              chunks.push(e.text);
            } else if (e.type === "error") {
              harnessError = String(e.error ?? "harness error");
            } else if (e.type === "done") {
              completed = true;
            }
          },
          onRunComplete: () => {
            completed = true;
            resolve();
          },
        });
      } catch (err) {
        harnessError = err instanceof Error ? err.message : String(err);
        resolve();
      }
    });

    if (!args.wait) {
      return { ok: true, runId, threadId, goalId: "agent-harness" };
    }

    let timedOut = false;
    await Promise.race([
      finished,
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true;
          r();
        }, args.timeoutMs),
      ),
    ]);

    const output = chunks.join("").trim();
    return {
      ok: !harnessError && (completed || output.length > 0),
      runId,
      threadId,
      output: output || null,
      error: harnessError || null,
      completed,
      timedOut,
      activity,
    };
  },
});
