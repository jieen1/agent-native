// V3 SSE — Server-Sent Events stream for run events (DESIGN §9, IMPLEMENTATION §D).
// GET /_v3/runs/:runId/events?since=<seq>
// Reads v3_events via getV3Db(), filters seq_num > since, and streams via
// EventSource with keep-alive ping.

import {
  defineEventHandler,
  getRouterParam,
  getQuery,
  createError,
  setHeader,
} from "h3";
import { and, eq, gt, sql } from "drizzle-orm";
import { v3Events } from "../db/v3-schema.js";
import { getV3Db } from "../db/v3.js";
import type { H3Event } from "h3";

/**
 * SSE event types emitted by the V3 reconciler pipeline.
 */
export type V3EventKind =
  | "run.created"
  | "run.started"
  | "node.ready"
  | "spawn.started"
  | "spawn.completed"
  | "node.resolved"
  | "run.completed"
  | "run.failed"
  | "patch_applied";

/**
 * SSE keep-alive comment.
 */
const KEEPALIVE = ": keepalive\n\n";

/**
 * Format a v3_event row as an SSE message.
 */
function formatEvent(
  id: string,
  kind: string,
  payload: Record<string, unknown> | null,
  seqNum: number | null,
  ts: Date | null,
): string {
  const lines: string[] = [];
  lines.push(`id: ${id}`);
  if (seqNum != null) {
    lines.push(`seq_num: ${seqNum}`);
  }
  if (ts) {
    lines.push(`ts: ${ts.toISOString()}`);
  }
  lines.push(`event: ${kind}`);
  lines.push(`data: ${JSON.stringify(payload ?? {})}`);
  return lines.join("\n") + "\n\n";
}

/**
 * GET /_v3/runs/:runId/events?since=<seq>
 *
 * Streams v3_events for the given runId. If `since` query param is provided,
 * only events with seq_num > since are returned. After delivering historical
 * events the connection stays open and sends a periodic keep-alive ping.
 */
export const v3SseEventHandler = defineEventHandler(async (event: H3Event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    throw createError({
      statusCode: 400,
      message: "runId is required",
    });
  }

  const query = getQuery(event);
  const since =
    typeof query.since === "string" ? parseInt(query.since, 10) : undefined;

  const db = getV3Db();

  // Build query: historical events since the given sequence
  const clauses: import("drizzle-orm").SQL<unknown>[] = [
    eq(v3Events.runId, runId),
  ];
  if (since !== undefined && !isNaN(since)) {
    clauses.push(gt(v3Events.seqNum, since));
  }

  const rows = await db
    .select({
      id: v3Events.id,
      kind: v3Events.kind,
      payload: v3Events.payload,
      seqNum: v3Events.seqNum,
      ts: v3Events.ts,
    })
    .from(v3Events)
    .where(and(...clauses))
    .orderBy(sql`${v3Events.seqNum} ASC`);

  // Send headers for EventSource
  setHeader(event, "Content-Type", "text/event-stream");
  setHeader(event, "Cache-Control", "no-cache");
  setHeader(event, "Connection", "keep-alive");
  setHeader(event, "X-Accel-Buffering", "no"); // Disable nginx buffering

  const nodeRes = event.node?.res;
  if (!nodeRes) {
    throw createError({
      statusCode: 500,
      message: "Response stream unavailable",
    });
  }

  // Write all historical events first
  for (const row of rows) {
    const data = formatEvent(
      row.id,
      row.kind,
      row.payload as Record<string, unknown> | null,
      row.seqNum,
      row.ts,
    );
    (nodeRes as any).write(data);
  }

  // Send initial heartbeat to keep connection alive
  (nodeRes as any).write(KEEPALIVE);

  // Keep-alive ping every 15 seconds
  const pingInterval = setInterval(() => {
    try {
      if (!(nodeRes as any).destroyed) {
        (nodeRes as any).write(KEEPALIVE);
      }
    } catch {
      // Connection closed — ignore
    }
  }, 15_000);
  if (typeof (pingInterval as any).unref === "function") {
    (pingInterval as any).unref();
  }

  // Clean up on disconnect
  (nodeRes as any).on("close", () => {
    clearInterval(pingInterval);
  });
  (nodeRes as any).on("error", () => {
    clearInterval(pingInterval);
  });
});
