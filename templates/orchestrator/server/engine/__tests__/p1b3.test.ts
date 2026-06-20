// P1b-3 tests: await:false (async, §3.2), promote-run-to-template distill
// (§6.5), and the run-events derived event log (§4.4). Each asserts against the
// real node_runs journal in a temp libsql DB. Setup runs before any getDb import
// so getDb binds to the temp DB.

import { beforeAll, describe, expect, it } from "vitest";
import { createEngineTables, useTempDb } from "./setup.js";

useTempDb();

const { getDb, schema } = await import("../../db/index.js");
const { Scheduler } = await import("../scheduler.js");
const { DEFAULT_CAPS } = await import("../types.js");
const fixtures = await import("../fixtures.js");
const { distillRun } = await import("../promote.js");
const { nowIso, newId } = await import("../../../actions/_util.js");
const { keyStr } = await import("../types.js");

import type { WorkflowGraph } from "../../../shared/types.js";
import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutor,
  RunConfig,
} from "../types.js";

/** Spy executor: deterministic echo + a configurable per-node delay/hang. */
class SpyExecutor implements NodeExecutor {
  readonly kind = "spy";
  invokeCount = 0;
  readonly invoked: string[] = [];
  /** node ids that resolve only when their delay elapses. */
  delayByNode = new Map<string, number>();

  async invoke(
    input: NodeExecutionInput,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    this.invokeCount += 1;
    this.invoked.push(
      keyStr({
        nodeId: input.node.id,
        iteration: input.iteration,
        fanoutIndex: input.fanoutIndex,
      }),
    );
    const env = input.node.runtime?.env ?? {};
    const delay =
      this.delayByNode.get(input.node.id) ??
      (Number(env.echoDelayMs ?? 0) || 0);
    if (delay > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            r();
          },
          { once: true },
        );
      });
    }
    let output: unknown = {
      node: input.node.id,
      deps: input.deps,
      effort: input.effort,
    };
    if (typeof env.echoArray === "string") {
      const asNum = Number(env.echoArray);
      if (Number.isInteger(asNum)) {
        output = Array.from({ length: asNum }, (_, i) => ({
          id: `${input.node.id}-${i}`,
        }));
      } else {
        try {
          output = JSON.parse(env.echoArray);
        } catch {
          /* keep */
        }
      }
    }
    return { output, tokensSpent: 0 };
  }
}

beforeAll(async () => {
  await createEngineTables();
});

async function seedTemplate(
  name: string,
  graph: WorkflowGraph,
): Promise<string> {
  const db = getDb();
  const id = newId("tpl");
  const now = nowIso();
  await db.insert(schema.workflowTemplates).values({
    id,
    name,
    description: "",
    graph: JSON.stringify(graph),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: "local@localhost",
    orgId: null,
    visibility: "private",
  });
  return id;
}

async function seedRun(templateId: string): Promise<string> {
  const db = getDb();
  const id = newId("run");
  const now = nowIso();
  await db.insert(schema.workflowRuns).values({
    id,
    templateId,
    workItemId: null,
    status: "pending",
    deliverable: null,
    tokenBudget: null,
    tokensSpent: 0,
    startedAt: now,
    completedAt: null,
    ownerEmail: "local@localhost",
    orgId: null,
    visibility: "private",
  });
  return id;
}

function makeCfg(
  runId: string,
  templateId: string,
  graph: WorkflowGraph,
  over: Partial<RunConfig> = {},
): RunConfig {
  return {
    runId,
    templateId,
    graph,
    userEmail: "local@localhost",
    orgId: null,
    tokenBudget: null,
    seed: 1,
    caps: { ...DEFAULT_CAPS, ...(over.caps ?? {}) },
    echoDelayMs: 0,
    ...over,
  };
}

async function nodeRunsFor(runId: string) {
  const { eq } = await import("drizzle-orm");
  return getDb()
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runId));
}

// ── 1. await:false — barrier released early, run still waits for settle ──────

describe("await:false (async, §3.2)", () => {
  it("downstream barrier proceeds while the async node runs; run waits for it", async () => {
    const graph = fixtures.asyncAwaitFalse;
    const t = await seedTemplate("async-1", graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    // slow takes much longer than quick so the ordering is unambiguous.
    e.delayByNode.set("slow", 150);
    e.delayByNode.set("quick", 5);
    const o = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e,
    }).run();
    expect(o.status).toBe("done");

    const rows = await nodeRunsFor(r);
    const slow = rows.find((n) => n.nodeId === "slow")!;
    const join = rows.find((n) => n.nodeId === "join")!;
    const end = rows.find((n) => n.nodeId === "end")!;

    // The async node actually ran and settled done.
    expect(slow.status).toBe("done");
    expect(slow.startedAt).not.toBeNull();
    expect(slow.completedAt).not.toBeNull();

    // BARRIER RELEASED EARLY: the join (barrier over the await:false slow) and
    // end completed BEFORE slow settled — they did NOT wait for it.
    expect(join.completedAt! < slow.completedAt!).toBe(true);
    expect(end.completedAt! < slow.completedAt!).toBe(true);

    // RUN STILL WAITED: slow is settled done by the time the run finished, so
    // the run did not finish before its fire-and-forget node settled.
    expect(rows.every((n) => n.status === "done")).toBe(true);
  });

  it("effort passes through to the executor input (node-get can prove it)", async () => {
    const graph = fixtures.asyncAwaitFalse;
    const t = await seedTemplate("async-effort", graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    e.delayByNode.set("slow", 20);
    await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e,
    }).run();
    const rows = await nodeRunsFor(r);
    const slow = rows.find((n) => n.nodeId === "slow")!;
    // slow declares effort:"high" in the fixture; the output artifact records it.
    const { eq } = await import("drizzle-orm");
    const art = await getDb()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, slow.outputRef!))
      .limit(1);
    const out = JSON.parse(art[0].ref) as { effort?: string };
    expect(out.effort).toBe("high");
  });
});

// ── 2. promote-run-to-template distill — node/edge set equality ──────────────

describe("promote distill (§6.5)", () => {
  it("collapses a fanout run's dynamic indices back to the static node/edge set", async () => {
    const graph = fixtures.fanout; // disc → fan → work(×N) → join → end
    const t = await seedTemplate("fanout-promote", graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    const o = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e,
    }).run();
    expect(o.status).toBe("done");

    const rows = await nodeRunsFor(r);
    // The run really did fan out (>1 `work` NodeRun) — there ARE dynamic indices.
    expect(rows.filter((n) => n.nodeId === "work").length).toBeGreaterThan(1);

    const distilled = distillRun(
      graph,
      rows.map((nr) => ({
        nodeId: nr.nodeId,
        type: nr.type,
        title: nr.title,
        assignee: nr.assignee,
        engine: nr.engine,
        model: nr.model,
        iteration: nr.iteration,
        fanoutIndex: nr.fanoutIndex,
        dynamic: nr.dynamic,
      })),
    );

    // NODE SET equality: distilled nodes == the static template node ids.
    const distilledNodes = new Set(distilled.graph.nodes.map((n) => n.id));
    const templateNodes = new Set(graph.nodes.map((n) => n.id));
    expect(distilledNodes).toEqual(templateNodes);
    // Exactly one distilled node per logical id — fanout indices collapsed.
    expect(distilled.graph.nodes.length).toBe(graph.nodes.length);
    expect(distilled.collapsed.work).toBeGreaterThan(1); // many → one

    // EDGE SET equality: distilled edges == the template edges (as from→to set).
    const edgeSig = (es: { from: string; to: string }[]) =>
      new Set(es.map((x) => `${x.from}->${x.to}`));
    expect(edgeSig(distilled.graph.edges)).toEqual(edgeSig(graph.edges));

    // The fanout node is preserved as a real fanout container (genuine fanout).
    const fan = distilled.graph.nodes.find((n) => n.id === "fan");
    expect(fan?.type).toBe("fanout");
    expect(fan?.itemsFrom).toBe("disc");
  });

  it("re-running the distilled template reaches the same executed shape", async () => {
    const graph = fixtures.fanout;
    const t = await seedTemplate("fanout-reuse", graph);
    const r1 = await seedRun(t);
    await new Scheduler({
      cfg: makeCfg(r1, t, graph),
      db: getDb(),
      executor: new SpyExecutor(),
    }).run();
    const rows1 = await nodeRunsFor(r1);
    const distilled = distillRun(
      graph,
      rows1.map((nr) => ({
        nodeId: nr.nodeId,
        type: nr.type,
        title: nr.title,
        assignee: nr.assignee,
        engine: nr.engine,
        model: nr.model,
        iteration: nr.iteration,
        fanoutIndex: nr.fanoutIndex,
        dynamic: nr.dynamic,
      })),
    );

    // Seed the distilled template and re-run it.
    const t2 = await seedTemplate("distilled", distilled.graph);
    const r2 = await seedRun(t2);
    const o2 = await new Scheduler({
      cfg: makeCfg(r2, t2, distilled.graph),
      db: getDb(),
      executor: new SpyExecutor(),
    }).run();
    expect(o2.status).toBe("done");

    // The set of executed logical nodeIds is identical to the original run.
    const ids = (rs: { nodeId: string }[]) => new Set(rs.map((x) => x.nodeId));
    const rows2 = await nodeRunsFor(r2);
    expect(ids(rows2)).toEqual(ids(rows1));
  });
});
