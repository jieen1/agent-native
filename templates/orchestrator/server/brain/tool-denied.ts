// F4 — denied-tool attempts must land in a PERSISTENT engine-side sink
// (docs/sdlc-impl-f1-f4.md §4A Opus-review supplement + T-F4-06): the
// framework audit-log only covers the defineAction surface, so a HARNESS tool
// refusal (the brain's `claude` child asking for Bash/Edit/Write outside its
// phase's allowed face) previously had nowhere durable to land — it only
// flashed by in the transcript. This module writes each such attempt as a
// `spawn_events` row with `type: 'tool.denied'` (spawn_id is a plain text
// column with no FK; brain sessions use the `brain:<threadId>` key so the rows
// are query-separable from real worker spawns), plus — when the turn is an F4
// review of a known run — a run-scoped `v3_events` row (`kind: 'tool.denied'`)
// so the S7 run-detail page can surface the violation next to the run it
// happened in.
//
// Detection: we do NOT parse the CLI's denial wording. The engine's own
// permission gate (`--allowedTools` / the ACP `claudeCode.options.tools` list)
// is what actually refuses the call; we independently recompute "was this
// tool in the phase's allowed face?" from the SAME list the argv was built
// from (isToolAllowedForPhase) and log every tool_use that falls outside it.
//
// Best-effort by contract: a logging failure must never abort a brain turn.
// `db` is injected so the write path is unit-testable with a mock.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as v3SchemaTypes from "../db/v3-schema.js";
import { spawnEvents, v3Events } from "../db/v3-schema.js";
import { isToolAllowedForPhase, type BrainPhase } from "./brain-capability.js";

type V3Db = PostgresJsDatabase<typeof v3SchemaTypes>;

/** spawn_events.spawn_id prefix for brain-session (non-worker-spawn) rows. */
export const BRAIN_SPAWN_KEY_PREFIX = "brain:";

/** The spawn_events key a brain thread's denied-tool rows are filed under. */
export function brainSpawnKey(threadId: string): string {
  return `${BRAIN_SPAWN_KEY_PREFIX}${threadId}`;
}

export interface ToolDeniedLogArgs {
  threadId: string;
  ownerEmail: string;
  orgId: string | null;
  /** The phase whose tool face was in force for this turn. */
  phase: BrainPhase;
  /** The exact allow-list the turn's argv/session was built with. */
  allowedTools: string[];
  /** Tool name from the stream-json `tool_use` / ACP `tool-start` event. */
  toolName: string | null | undefined;
  toolUseId?: string | null;
  toolInput?: unknown;
  /** The run under review (phase='review' wakes) — enables the v3_events row. */
  reviewOfRunId?: string | null;
}

// Postgres text/jsonb reject the NUL byte — same guard as brain-session's
// appendEvent (kept local: this module must stay importable without it).
function stripNul<T>(value: T): T {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\u0000/g, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNul(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNul(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Log ONE tool_use event against the phase's allow-list; returns true when the
 * tool fell OUTSIDE the face and a `tool.denied` row was written, false when
 * it was allowed (or the write failed — best-effort, never throws).
 */
export async function maybeLogToolDenied(
  db: V3Db,
  args: ToolDeniedLogArgs,
): Promise<boolean> {
  const name = typeof args.toolName === "string" ? args.toolName : "";
  if (!name || isToolAllowedForPhase(name, args.allowedTools)) return false;

  try {
    const spawnKey = brainSpawnKey(args.threadId);

    // spawn_events row — the primary durable sink (unique (spawn_id, seq)).
    const [{ next }] = await db
      .select({
        next: sql<number>`coalesce(max(${spawnEvents.seq}), -1) + 1`.mapWith(
          Number,
        ),
      })
      .from(spawnEvents)
      .where(eq(spawnEvents.spawnId, spawnKey));

    await db.insert(spawnEvents).values({
      id: `se_${randomUUID()}`,
      spawnId: spawnKey,
      seq: next,
      type: "tool.denied",
      name,
      input: args.toolInput != null ? stripNul(args.toolInput) : null,
      result: null,
      text: `phase=${args.phase} threadId=${args.threadId}${
        args.reviewOfRunId ? ` runId=${args.reviewOfRunId}` : ""
      } toolUseId=${args.toolUseId ?? "-"}`,
      ownerEmail: args.ownerEmail,
      orgId: args.orgId,
    });

    // Run-scoped visibility (S7): when this turn reviews a known run, mirror
    // the denial as a v3_events row on that run.
    if (args.reviewOfRunId) {
      const [{ nextSeq }] = await db
        .select({
          nextSeq:
            sql<number>`COALESCE(MAX(${v3Events.seqNum}), 0) + 1`.mapWith(
              Number,
            ),
        })
        .from(v3Events)
        .where(eq(v3Events.runId, args.reviewOfRunId));

      await db.insert(v3Events).values({
        id: `ve_${randomUUID()}`,
        runId: args.reviewOfRunId,
        spawnId: spawnKey,
        kind: "tool.denied",
        payload: stripNul({
          threadId: args.threadId,
          phase: args.phase,
          toolName: name,
          toolUseId: args.toolUseId ?? null,
          allowedTools: args.allowedTools,
        }),
        seqNum: nextSeq,
        ts: new Date(),
        ownerEmail: args.ownerEmail,
        orgId: args.orgId,
      });
    }

    return true;
  } catch {
    // Best-effort: never abort the brain turn over an observability write.
    return false;
  }
}
