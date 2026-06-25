// Run a single Claude Code spawn using the CONTAINER'S OWN subscription login
// (DESIGN §7.3 / §13: `runtime: acp:claude-code`, local CLI with its own auth,
// NO host credential copying). The orchestrator spawns the `claude` CLI in
// headless print mode against its managed, isolated CLAUDE_CONFIG_DIR, streams
// the result, and returns it in the same shape the NodeRunner produces so the
// dispatcher tail (classify → artifact → node done) is unchanged.
//
// This is the host-native equivalent of `executors/claude-code-executor.ts`
// (which runs claude inside a microVM). Here there is no VM: the worker runs in
// the orchestrator's own process space, authenticated by the managed login.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeStreamJson } from "./executors/claude-stream.js";
import type { NodeRunnerResult } from "./node-runner.js";
import {
  claudeWorkerEnv,
  getManagedClaudeStatus,
} from "../claude-managed-auth.js";

/** True when an agent's runtime selects Claude Code via ACP (DESIGN §7.3). */
export function isClaudeCodeRuntime(runtime: string | undefined | null): boolean {
  if (!runtime) return false;
  const r = runtime.toLowerCase();
  return r === "acp:claude-code" || r === "claude-code" || r.startsWith("acp:claude");
}

/**
 * Execute one Claude Code spawn. Returns the same {@link NodeRunnerResult} shape
 * the microVM NodeRunner produces, so the dispatcher tail is unchanged. Throws a
 * clear, actionable error if the container has no managed login yet (the operator
 * must Connect in Settings → Claude Code).
 */
export async function runClaudeCodeWorker(opts: {
  prompt: string;
  model?: string;
  /** Working directory for the agent's tools. Defaults to a fresh temp dir. */
  cwd?: string;
  signal?: AbortSignal;
}): Promise<NodeRunnerResult> {
  const startedAt = Date.now();
  const status = getManagedClaudeStatus();
  if (!status.loggedIn) {
    throw new Error(
      status.expired
        ? "Claude Code login expired — reconnect in Settings → Claude Code."
        : "Claude Code is not connected — connect it in Settings → Claude Code " +
          "(the orchestrator runs its own login; it never uses your host credentials).",
    );
  }

  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    // Headless: no human to approve edits, and claude refuses
    // --dangerously-skip-permissions under root, so auto-accept edits.
    "--permission-mode",
    "acceptEdits",
    "-p",
    opts.prompt,
  ];
  if (opts.model && opts.model.trim() !== "") {
    args.push("--model", opts.model);
  }

  const cwd = opts.cwd || mkdtempSync(join(tmpdir(), "v3-claude-"));
  const child = spawn("claude", args, {
    cwd,
    env: claudeWorkerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  if (opts.signal) {
    if (opts.signal.aborted) child.kill("SIGTERM");
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  let exitCode = 0;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const parsed = parseClaudeStreamJson(stdout);
  if (exitCode !== 0 && !parsed.sawResult) {
    throw new Error(
      `claude exited ${exitCode} without a result. stderr: ${
        stderr.slice(0, 500) || "(empty)"
      }`,
    );
  }

  const model = parsed.model ?? opts.model ?? "claude";
  return {
    output: {
      text: parsed.finalText,
      toolCallCount: parsed.toolCallCount,
      model,
      resultSubtype: parsed.resultSubtype,
    },
    tokensSpent: parsed.tokensSpent,
    toolCallCount: parsed.toolCallCount,
    model,
    vmName: null,
    durationMs: Date.now() - startedAt,
    attempts: 1,
    detail: {
      finalText: parsed.finalText,
      totalCostUsd: parsed.totalCostUsd,
      exitCode,
    },
  };
}
