// F2 executor context management (SDLC docs §2A / 02-workflows.md §4.1 C3):
// "truncated retry = carry forward completed work, never re-run from zero."
//
// This module is the checkpoint half of that contract. It never talks to the
// model or the VM — it is a pure reducer over the SAME `RuntimeExecStep[]`
// transcript `engine-loop.ts` already builds for `spawn_events`, plus a tiny
// best-effort DB write that lands the result on `v3_spawns.context_checkpoint`
// at spawn termination so a future retry (dispatcher-side, not this module)
// can inject "already written: […]; keep going" instead of re-deriving it.
//
// Deliberately narrow: no dispatcher/workspace changes here (out of bounds for
// this slice — see the F2 implementation note in engine-loop.ts). The write
// targets the CURRENT node's `running` v3_spawns row by `node_id` — the only
// stable identifier `RuntimeExecCtx` carries today (see engine-loop.ts for why
// this is `ctx.node.id`, not the literal `v3_spawns.id`).

import type { RuntimeExecStep } from "./types.js";

/** The two tool names whose successful result means "a file changed." */
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

/** Structured checkpoint persisted to `v3_spawns.context_checkpoint` (JSONB). */
export interface ContextCheckpoint {
  /** De-duplicated, insertion-ordered list of files successfully written/edited. */
  writtenFiles: string[];
  /** Best-effort "what's left" hint for a future retry prompt. Null when unknown. */
  remainingTasksSummary: string | null;
  /** ISO timestamp of this checkpoint computation. */
  updatedAt: string;
}

/** Cap so a runaway summary never bloats the JSONB column. */
const MAX_SUMMARY_CHARS = 2000;

function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}…`;
}

/** Pull the `filePath` string arg out of a write/edit tool_use's `input`. */
function filePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).filePath;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/**
 * A write/edit tool_result's `result` string is success iff it starts with
 * the exact prefixes `createVmActingBridge` (acting-bridge.ts) returns on the
 * happy path ("Wrote <path> (…)" / "Edited <path> (…)"). Every failure path in
 * that module returns a string starting with "Error" instead (it never
 * throws), so this prefix check is the only reliable success/failure signal —
 * `tool_done`'s `isError` flag is NOT set for these (see engine-loop.ts).
 */
function isSuccessfulWriteResult(result: unknown): boolean {
  return typeof result === "string" && /^(Wrote |Edited )/.test(result);
}

/**
 * Extract the de-duplicated list of files SUCCESSFULLY written or edited from
 * an ordered step transcript (T-F2-01). Pairs each `write`/`edit` `tool_use`
 * with the NEXT `tool_result` of the same tool name (FIFO per name — steps are
 * emitted by a single serialized `send` sink, so calls of the same tool never
 * interleave out of order in practice). Failed writes/edits and any other tool
 * (bash/read/glob/grep) are ignored entirely.
 */
export function extractWrittenFiles(steps: RuntimeExecStep[]): string[] {
  const pendingByName = new Map<string, string[]>(); // tool name -> queue of filePaths
  const written: string[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    if (!step.name || !WRITE_TOOL_NAMES.has(step.name)) continue;

    if (step.type === "tool_use") {
      const filePath = filePathFromInput(step.input);
      const queue = pendingByName.get(step.name) ?? [];
      queue.push(filePath ?? "");
      pendingByName.set(step.name, queue);
      continue;
    }

    if (step.type === "tool_result") {
      const queue = pendingByName.get(step.name);
      const filePath = queue?.shift();
      if (!filePath) continue;
      if (isSuccessfulWriteResult(step.result) && !seen.has(filePath)) {
        seen.add(filePath);
        written.push(filePath);
      }
    }
  }

  return written;
}

/** Best-effort "what's left" hint: the last non-empty assistant text step. */
function summarizeRemaining(
  steps: RuntimeExecStep[],
  finalText?: string,
): string | null {
  const text = (finalText ?? "").trim();
  if (text) return truncateSummary(text);
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.type === "text" && step.text && step.text.trim() !== "") {
      return truncateSummary(step.text);
    }
  }
  return null;
}

/** Build a {@link ContextCheckpoint} from one attempt's transcript. */
export function buildContextCheckpoint(args: {
  steps: RuntimeExecStep[];
  finalText?: string;
}): ContextCheckpoint {
  return {
    writtenFiles: extractWrittenFiles(args.steps),
    remainingTasksSummary: summarizeRemaining(args.steps, args.finalText),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Merge a newly-computed checkpoint into a previously-persisted one. The
 * written-files list only GROWS (union, previous order preserved, new files
 * appended) — a later attempt's checkpoint must never make an earlier
 * attempt's completed work disappear (§2A: "`context_checkpoint` 只增不改").
 * The remaining-tasks hint prefers the NEWER attempt's summary (it reflects
 * the most current state) and only falls back to the previous one when the
 * newer attempt has nothing to say.
 */
export function mergeContextCheckpoints(
  previous: ContextCheckpoint | null | undefined,
  next: ContextCheckpoint,
): ContextCheckpoint {
  if (!previous) return next;
  const writtenFiles = [...previous.writtenFiles];
  const seen = new Set(writtenFiles);
  for (const file of next.writtenFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    writtenFiles.push(file);
  }
  return {
    writtenFiles,
    remainingTasksSummary:
      next.remainingTasksSummary ?? previous.remainingTasksSummary ?? null,
    updatedAt: next.updatedAt,
  };
}

/**
 * Persist a checkpoint onto the CURRENT `v3_spawns` row for `nodeId` (the row
 * dispatcher opened as `status='running'` before this node's executor started
 * — see v3-dispatcher.ts `openRunningSpawn`). Best-effort: merges with
 * whatever checkpoint already sits on that row (never destructively overwrites
 * — T-F2-07) and swallows every error (a logging/DB hiccup must never fail the
 * node). Dynamic import mirrors the existing `node-runner.ts` `deliver()`
 * pattern so importing this module never pulls in the DB/pg client for
 * callers that don't need it (e.g. pure-function unit tests).
 */
export async function persistContextCheckpoint(args: {
  nodeId: string;
  checkpoint: ContextCheckpoint;
}): Promise<void> {
  const { nodeId, checkpoint } = args;
  if (!nodeId) return;
  try {
    const { getV3Db, v3Schema } = await import("../../db/index.js");
    const { and, eq } = await import("drizzle-orm");
    const db = getV3Db();
    const matchCurrentRunningRow = and(
      eq(v3Schema.v3Spawns.nodeId, nodeId),
      eq(v3Schema.v3Spawns.status, "running"),
    );
    const existingRows = await db
      .select({
        contextCheckpoint: v3Schema.v3Spawns.contextCheckpoint,
      })
      .from(v3Schema.v3Spawns)
      .where(matchCurrentRunningRow)
      .limit(1);
    const existing =
      (existingRows[0]?.contextCheckpoint as ContextCheckpoint | null) ?? null;
    const merged = mergeContextCheckpoints(existing, checkpoint);
    await db
      .update(v3Schema.v3Spawns)
      .set({ contextCheckpoint: merged })
      .where(matchCurrentRunningRow);
  } catch (err) {
    console.warn(
      `[context-checkpoint] persist failed for node ${nodeId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
