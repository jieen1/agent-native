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
import { createInterface } from "node:readline";

import {
  claudeWorkerEnv,
  getManagedClaudeStatus,
} from "../claude-managed-auth.js";
import {
  parseClaudeStreamJson,
  stepsFromEvent,
} from "./executors/claude-stream.js";
import type { RuntimeExecStep } from "./executors/types.js";
import type { NodeRunnerResult } from "./node-runner.js";

/** True when an agent's runtime selects Claude Code via ACP (DESIGN §7.3). */
export function isClaudeCodeRuntime(
  runtime: string | undefined | null,
): boolean {
  if (!runtime) return false;
  const r = runtime.toLowerCase();
  return (
    r === "acp:claude-code" || r === "claude-code" || r.startsWith("acp:claude")
  );
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
  /**
   * Live step sink (DESIGN §8.5). Called for EACH intermediate step (reasoning
   * text / tool_use / tool_result) AS THE CLI STREAMS IT, so a RUNNING node
   * grows its `spawn_events` transcript in real time rather than only after the
   * CLI exits. Best-effort: a sink error never aborts the run.
   */
  onStep?: (step: RuntimeExecStep) => void;
  /**
   * The resolved agent's own `agent_defs.system_prompt` (Agents page),
   * threaded via `--append-system-prompt` — mirrors brain-capability.ts's
   * `buildBrainArgv`. Omitted/empty runs on the CLI's own built-in persona
   * only, unchanged from before this field existed.
   */
  systemPrompt?: string;
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
  if (opts.systemPrompt && opts.systemPrompt.trim() !== "") {
    args.push("--append-system-prompt", opts.systemPrompt);
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
  child.stderr.on("data", (d) => (stderr += d.toString()));

  // Stream stdout LINE-BY-LINE (mirrors brain-session). Each stream-json event
  // is (a) accumulated into `stdout` for the terminal parse below, and (b)
  // parsed immediately so its steps stream out through `opts.onStep` live — so
  // the dispatcher appends `spawn_events` for this RUNNING node as the CLI acts,
  // not only after it exits.
  let seq = 0;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    stdout += line + "\n";
    if (!opts.onStep) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown> | null;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // skip non-JSON noise
    }
    if (!event || typeof event !== "object") return;
    for (const s of stepsFromEvent(event)) {
      try {
        opts.onStep({ seq: seq++, ...s } as RuntimeExecStep);
      } catch {
        // A sink error must never break the stream drain.
      }
    }
  });

  let exitCode = 0;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      // Resolve on `close` (after stdio EOF) so the readline drain completes.
      child.on("close", (code) => resolve(code ?? 0));
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    rl.close();
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
    // F7 telemetry split (04 §7/§13, SDLC-051): forward the FINAL cumulative
    // input/output values the parser extracted, so the dispatcher persists a
    // real `v3_spawns.tokens_input` instead of defaulting it to 0. These are the
    // single final usage values (never a per-chunk sum) — see parseClaudeStreamJson.
    tokensInput: parsed.tokensInput,
    tokensOutput: parsed.tokensOutput,
    toolCallCount: parsed.toolCallCount,
    model,
    steps: parsed.steps,
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
