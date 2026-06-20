import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseGraph } from "../shared/types.js";

// One NodeRun's full inspector payload (DESIGN §4.4 / §0.6).
//   - P1 batch: status, iteration, dynamic, input+output artifact values,
//     timings, tokens, attempts.
//   - P2 batch (this enrichment): the executor tag (engine), and the node's
//     resolved RUNTIME info (microVM kind / image / branch / onFailure) read
//     from the template graph node — a template fully describes where each node
//     runs (shared/types `NodeRuntimeSpec`). The working branch defaults to the
//     per-run convention `an/run-<runId>` shared across a run's nodes.
//   - `logs` / `diff`: the in-VM `execStream` capture and committed code delivery
//     are P2c (deferred). We return what is durably journaled today — an empty
//     `logs` array and `diff: null` — so the run console renders honest empty
//     states (a terminal "no output yet", a diff placeholder) rather than faking
//     a live stream. The SHAPE is the bridge target for P2c.
export default defineAction({
  description:
    "Get one NodeRun: status, iteration, dynamic, resolved input + output artifact values, timings, tokens, attempts, executor + runtime (microVM/branch/onFailure), captured logs, and committed diff (when available).",
  schema: z.object({ runId: z.string(), nodeRunId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    const run = access.resource as Record<string, unknown>;
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.nodeRuns)
      .where(
        and(
          eq(schema.nodeRuns.runId, args.runId),
          eq(schema.nodeRuns.id, args.nodeRunId),
        ),
      )
      .limit(1);
    const nr = rows[0];
    if (!nr)
      throw new Error(
        `NodeRun ${args.nodeRunId} not found in run ${args.runId}`,
      );

    async function artifactValue(id: string | null): Promise<unknown> {
      if (!id) return null;
      const ar = await db
        .select({ ref: schema.artifacts.ref })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id))
        .limit(1);
      if (ar.length === 0) return null;
      try {
        return JSON.parse(ar[0].ref);
      } catch {
        return ar[0].ref;
      }
    }

    // ── runtime info (P2 batch): from the template graph node ────────────────
    // The runtime spec lives on the authored template node, not the NodeRun row
    // (shared/types). Look it up by the NodeRun's `nodeId` so the inspector can
    // show microVM kind / image / branch / onFailure honestly.
    const tplRows = await db
      .select({ graph: schema.workflowTemplates.graph })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, String(run.templateId)))
      .limit(1);
    const graphNode = tplRows[0]
      ? parseGraph(tplRows[0].graph).nodes.find((n) => n.id === nr.nodeId)
      : undefined;
    const rt = graphNode?.runtime ?? null;
    const runtime = rt
      ? {
          kind: rt.kind,
          image: rt.image ?? null,
          // The working branch defaults to the per-run convention shared across
          // a run's nodes (shared/types NodeRuntimeSpec.branch comment).
          branch: rt.branch ?? `an/run-${args.runId}`,
          baseRef: rt.baseRef ?? null,
          onFailure: rt.onFailure,
        }
      : null;

    return {
      id: nr.id,
      runId: nr.runId,
      nodeId: nr.nodeId,
      type: nr.type,
      title: nr.title,
      assignee: nr.assignee,
      // The executor tag is the resolved engine routing for this node.
      engine: nr.engine,
      model: nr.model,
      status: nr.status,
      iteration: nr.iteration,
      fanoutIndex: nr.fanoutIndex,
      dynamic: nr.dynamic === 1,
      inputRef: nr.inputRef,
      outputRef: nr.outputRef,
      input: await artifactValue(nr.inputRef),
      output: await artifactValue(nr.outputRef),
      error: nr.error,
      attempts: nr.attempts,
      tokensSpent: nr.tokensSpent,
      startedAt: nr.startedAt,
      completedAt: nr.completedAt,
      // P2 batch (runtime) + P2c placeholders (logs/diff).
      runtime,
      agentRunId: nr.agentRunId,
      // No captured terminal output is journaled yet (P2c wires execStream);
      // return an empty array so the xterm panel shows its empty state.
      logs: [] as string[],
      // No committed diff is journaled yet (P2c wires code delivery).
      diff: null as string | null,
    };
  },
});
