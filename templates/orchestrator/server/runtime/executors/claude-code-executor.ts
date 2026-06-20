// ClaudeCodeExecutor — the EXECUTE stage for a node whose brain is the REAL
// `claude` CLI running INSIDE the node's microVM (DESIGN §7.4.1a, §7.0). This
// is the "zero nesting" path: no second sandbox, no framework harness — just
// `runtime.spawn(vm, "claude --output-format stream-json -p …")` in the VM the
// NodeRunner handed us, parse the stream-json events, and sum usage.
//
// Unlike the engine-model executors (vLLM/remote), here the AGENT LOOP runs in
// the VM (claude owns its own tools + loop). The host only spawns the process
// and reads its stdout stream.
//
// E2E is DEFERRED to P2c: a live in-VM `claude` needs VM public egress (to reach
// the Anthropic API) + a read-only `~/.claude` mount for the subscription, and
// the prebaked image must carry the `claude` CLI — all P2c. This file builds the
// executor and is unit-tested against a captured stream-json sample
// (`claude-stream.ts` + its spec). The command construction + stream draining +
// usage summing are real now; only the live boot is deferred.

import { parseClaudeStreamJson } from "./claude-stream.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";

/** Single-quote a value for safe interpolation into the in-VM shell. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the in-VM `claude` command for a node. We pass the prompt with `-p`
 * (print/headless mode) and request `--output-format stream-json` so we can
 * parse per-turn events + usage. `--verbose` is required by the CLI for
 * stream-json in print mode. The model is forwarded when the node pins one.
 */
export function buildClaudeCommand(ctx: RuntimeExecCtx): string {
  const prompt = ctx.node.prompt ?? ctx.node.title ?? "Complete the task.";
  const parts = [
    "claude",
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
    shArg(prompt),
  ];
  if (ctx.node.model && ctx.node.model.trim() !== "") {
    parts.push("--model", shArg(ctx.node.model));
  }
  return parts.join(" ");
}

/** Drain an async-iterable text stream into a single string. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

export class ClaudeCodeExecutor implements RuntimeExecutor {
  readonly kind = "claude-code";

  async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
    const command = buildClaudeCommand(ctx);
    const workdir = ctx.workdir || "/work";

    const proc = ctx.runtime.spawn(ctx.vm, command, { cwd: workdir });

    // Cooperative cancel: if the run is aborted, kill the in-VM process. The
    // microVM teardown (NodeRunner stage 7) waits for actual exit (§7.1a).
    const onAbort = (): void => proc.kill();
    if (ctx.signal.aborted) proc.kill();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";
    let exitCode: number;
    try {
      // Drain both streams concurrently, then await exit.
      const [out, err] = await Promise.all([
        drain(proc.stdout),
        drain(proc.stderr),
      ]);
      stdout = out;
      stderr = err;
      exitCode = await proc.wait();
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const parsed = parseClaudeStreamJson(stdout);

    if (exitCode !== 0 && !parsed.sawResult) {
      throw new Error(
        `claude exited ${exitCode} without a result event. stderr: ${
          stderr.slice(0, 500) || "(empty)"
        }`,
      );
    }

    return {
      output: {
        text: parsed.finalText,
        toolCallCount: parsed.toolCallCount,
        model: parsed.model ?? ctx.node.model ?? "claude",
        resultSubtype: parsed.resultSubtype,
      },
      tokensSpent: parsed.tokensSpent,
      toolCallCount: parsed.toolCallCount,
      model: parsed.model ?? ctx.node.model ?? "claude",
      detail: {
        finalText: parsed.finalText,
        totalCostUsd: parsed.totalCostUsd,
        exitCode,
      },
    };
  }
}
