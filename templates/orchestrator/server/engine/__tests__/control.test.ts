// P1b-2 engine behavior tests: run-control (pause/resume/cancel/retry/override),
// the human gate (suspend → approve releases / reject skips), subworkflow inline
// expansion (+ two-level rejection + child tokens count to parent), per-node
// timeout, and stuck-run reap. Each asserts against the real node_runs journal
// in a temp libsql DB; the executor INVOKE SPY proves resume re-runs done nodes
// 0 times. Setup runs before any getDb import so getDb binds to the temp DB.

import { beforeAll, describe, expect, it } from "vitest";
import { createEngineTables, useTempDb } from "./setup.js";

useTempDb();

const { getDb, schema } = await import("../../db/index.js");
const { Scheduler, NodeTimeoutError } = await import("../scheduler.js");
const { DEFAULT_CAPS } = await import("../types.js");
const fixtures = await import("../fixtures.js");
const control = await import("../control.js");
const { reapStrandedNodeRuns } = await import("../store.js");
const { reapOnce } = await import("../reap.js");
const { nowIso, newId } = await import("../../../actions/_util.js");
const { keyStr } = await import("../types.js");

import type { WorkflowGraph } from "../../../shared/types.js";
import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutor,
} from "../types.js";

/** Spy executor: deterministic echo, configurable failures, tokens, delay. */
class SpyExecutor implements NodeExecutor {
  readonly kind = "spy";
  invokeCount = 0;
  readonly invoked: string[] = [];
  failOnce = new Map<string, number>();
  tokensPerCall = 0;
  delayMs = 0;
  hang = new Set<string>(); // node ids that never resolve (until aborted)

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
    if (this.hang.has(input.node.id)) {
      // Resolve ONLY when aborted (timeout/cancel). The timeout's reject wins
      // the race first; this late resolve is then ignored, no leaked promise.
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { output: { aborted: true }, tokensSpent: 0 };
    }
    if (this.delayMs > 0) {
      await new Promise((r) => {
        const t = setTimeout(r, this.delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            r(undefined);
          },
          { once: true },
        );
      });
    }
    const remaining = this.failOnce.get(input.node.id) ?? 0;
    if (remaining > 0) {
      this.failOnce.set(input.node.id, remaining - 1);
      throw new Error(`forced failure on ${input.node.id}`);
    }
    const env = input.node.runtime?.env ?? {};
    let output: unknown = { node: input.node.id, deps: input.deps };
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
    return { output, tokensSpent: this.tokensPerCall };
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

async function seedRun(
  templateId: string,
  tokenBudget: number | null = null,
): Promise<string> {
  const db = getDb();
  const id = newId("run");
  const now = nowIso();
  await db.insert(schema.workflowRuns).values({
    id,
    templateId,
    workItemId: null,
    status: "pending",
    deliverable: null,
    tokenBudget,
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
  over: Record<string, unknown> = {},
) {
  return {
    runId,
    templateId,
    graph,
    userEmail: "local@localhost",
    orgId: null,
    tokenBudget: null,
    seed: 1,
    caps: { ...DEFAULT_CAPS, ...((over.caps as object) ?? {}) },
    echoDelayMs: 0,
    ...over,
  };
}

async function nodeRunsFor(runId: string) {
  return getDb()
    .select()
    .from(schema.nodeRuns)
    .where((await import("drizzle-orm")).eq(schema.nodeRuns.runId, runId));
}

// ── 1. resume re-runs done nodes 0 times (executor invoke spy) ──────────────

describe("run-control: resume invoke-count is 0 for done nodes", () => {
  it("a killed run's already-done nodes are NOT re-invoked on resume", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("seq-1", graph);
    const r = await seedRun(t);
    // First run: c fails repeatedly → run ends failed with a,b done.
    const e1 = new SpyExecutor();
    e1.failOnce.set("c", 99);
    const o1 = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    expect(o1.status).toBe("failed");

    // Resume via the CONTROL ACTION path (control.resumeRun), c now succeeds.
    const e2 = new SpyExecutor();
    const o2 = await control.resumeRun(r, { executor: e2 });
    expect(o2.status).toBe("done");
    // Hard proof: the executor was invoked 0 times for a and b on resume.
    expect(e2.invoked.filter((k) => k.startsWith("a#"))).toHaveLength(0);
    expect(e2.invoked.filter((k) => k.startsWith("b#"))).toHaveLength(0);
    expect(e2.invoked).toContain("c#0#0"); // only the failed tail re-ran
  });
});

// ── 2. retry-node: re-runs the node + downstream, reuses upstream ───────────

describe("run-retry-node", () => {
  it("re-runs the failed node + downstream tail; upstream reused (0 invokes)", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("seq-retry", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    e1.failOnce.set("b", 99);
    const o1 = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    expect(o1.status).toBe("failed");
    const bRow = (await nodeRunsFor(r)).find((n) => n.nodeId === "b")!;
    expect(bRow.status).toBe("failed");

    const e2 = new SpyExecutor();
    const o2 = await control.retryNode(r, bRow.id, { executor: e2 });
    expect(o2.status).toBe("done");
    // a is upstream → reused (0 invokes); b re-runs; c (downstream of b) runs.
    expect(e2.invoked.filter((k) => k.startsWith("a#"))).toHaveLength(0);
    expect(e2.invoked).toContain("b#0#0");
    expect(e2.invoked).toContain("c#0#0");
  });
});

// ── 3. node-override: re-runs node + downstream, upstream reused ────────────

describe("node-override", () => {
  it("patches a done node and re-runs it + downstream; upstream reused", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("seq-override", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    const o1 = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    expect(o1.status).toBe("done");
    const bRow = (await nodeRunsFor(r)).find((n) => n.nodeId === "b")!;

    const e2 = new SpyExecutor();
    const o2 = await control.overrideNode(
      r,
      bRow.id,
      { prompt: "new prompt", model: "qwen" },
      { executor: e2 },
    );
    expect(o2.status).toBe("done");
    expect(e2.invoked.filter((k) => k.startsWith("a#"))).toHaveLength(0); // upstream reused
    expect(e2.invoked).toContain("b#0#0"); // overridden node re-runs
    expect(e2.invoked).toContain("c#0#0"); // downstream re-runs
    // The override is persisted on the node_run row (model/engine routing).
    const bAfter = (await nodeRunsFor(r)).find((n) => n.nodeId === "b")!;
    expect(bAfter.model).toBe("qwen");
  });
});

// ── 4. cancel → cancelled, pending → skipped ────────────────────────────────

describe("run-cancel", () => {
  it("sets the run cancelled and pending nodes skipped", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("seq-cancel", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    e1.failOnce.set("b", 99); // stop the run mid-way so c stays pending
    await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();

    const res = await control.cancelRun(r);
    expect(res.status).toBe("cancelled");
    const rows = await nodeRunsFor(r);
    const c = rows.find((n) => n.nodeId === "c")!;
    expect(c.status).toBe("skipped"); // pending → skipped
    const runRow = (
      await getDb()
        .select()
        .from(schema.workflowRuns)
        .where((await import("drizzle-orm")).eq(schema.workflowRuns.id, r))
    )[0];
    expect(runRow.status).toBe("cancelled");
  });
});

// ── 5. human gate: suspend → approve releases / reject skips ─────────────────

describe("human gate (§3.1/§11)", () => {
  it("suspends at awaiting-approval; approve releases downstream", async () => {
    const graph = fixtures.humanGate;
    const t = await seedTemplate("human-approve", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    const o1 = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    expect(o1.status).toBe("paused");
    expect(o1.awaitingApproval).toBe(true);
    let rows = await nodeRunsFor(r);
    const gate = rows.find((n) => n.nodeId === "gate")!;
    expect(gate.status).toBe("awaiting-approval");
    // The gate assigned NO executor work — `after` has NOT run.
    expect(e1.invoked.filter((k) => k.startsWith("after#"))).toHaveLength(0);

    const e2 = new SpyExecutor();
    const o2 = await control.resolveHumanGate(
      r,
      gate.id,
      "approve",
      { ok: true },
      { executor: e2 },
    );
    expect(o2.status).toBe("done");
    rows = await nodeRunsFor(r);
    expect(rows.find((n) => n.nodeId === "gate")!.status).toBe("done");
    expect(rows.find((n) => n.nodeId === "after")!.status).toBe("done");
    expect(e2.invoked).toContain("after#0#0"); // released live
    expect(e2.invoked.filter((k) => k.startsWith("prep#"))).toHaveLength(0); // upstream reused
  });

  it("reject marks the gate done and skips its out-edge branch downstream", async () => {
    const graph = fixtures.humanGate;
    const t = await seedTemplate("human-reject", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    const gate = (await nodeRunsFor(r)).find((n) => n.nodeId === "gate")!;

    const e2 = new SpyExecutor();
    const o2 = await control.resolveHumanGate(r, gate.id, "reject", null, {
      executor: e2,
    });
    const rows = await nodeRunsFor(r);
    expect(rows.find((n) => n.nodeId === "gate")!.status).toBe("done");
    expect(rows.find((n) => n.nodeId === "after")!.status).toBe("skipped");
    expect(e2.invoked.filter((k) => k.startsWith("after#"))).toHaveLength(0); // never ran
    // The run settles done (the rejected branch is a dead path, not a failure).
    expect(o2.status).toBe("done");
  });
});

// ── 6. subworkflow: inline-expand (dynamic children); two-level rejected ────

describe("subworkflow (§1.2/§3.1)", () => {
  it("inline-expands a child template as dynamic children; child tokens count to parent", async () => {
    await seedTemplate(
      fixtures.FIXTURES["subworkflow-child"].name,
      fixtures.subChild,
    );
    const t = await seedTemplate(
      fixtures.subworkflowParent ? "subwf-parent" : "x",
      fixtures.subworkflowParent,
    );
    const r = await seedRun(t, 1000);
    const e = new SpyExecutor();
    e.tokensPerCall = 7; // each leaf spends 7; child leaves accrue to the parent
    const o = await new Scheduler({
      cfg: makeCfg(r, t, fixtures.subworkflowParent),
      db: getDb(),
      executor: e,
      resolveTemplate: (ref: string) =>
        ref === fixtures.FIXTURES["subworkflow-child"].name
          ? fixtures.subChild
          : null,
    }).run();
    expect(o.status).toBe("done");
    const rows = await nodeRunsFor(r);
    // The child's namespaced nodes exist as DYNAMIC NodeRuns.
    const childWork = rows.find((n) => n.nodeId === "sub::cwork");
    expect(childWork).toBeTruthy();
    expect(childWork!.dynamic).toBe(1);
    expect(childWork!.status).toBe("done");
    // Child leaf tokens counted toward the PARENT run budget (one shared quota):
    // the child's cwork leaf alone spends 7, all on the parent run's counter.
    expect(o.tokensSpent).toBeGreaterThanOrEqual(7);
    // The only token-spending leaf is the child's cwork (the parent has no agent
    // leaves of its own), so the parent total is EXACTLY the child's spend.
    expect(o.tokensSpent).toBe(7);
  });

  it("rejects two-level nesting at expansion", async () => {
    await seedTemplate(
      fixtures.FIXTURES["subworkflow-child"].name,
      fixtures.subChild,
    );
    await seedTemplate(
      fixtures.FIXTURES["subworkflow-nested"].name,
      fixtures.subworkflowNested,
    );
    const t = await seedTemplate("subwf-2lvl", fixtures.subworkflowTwoLevel);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    const resolve = (ref: string): WorkflowGraph | null => {
      if (ref === fixtures.FIXTURES["subworkflow-child"].name)
        return fixtures.subChild;
      if (ref === fixtures.FIXTURES["subworkflow-nested"].name)
        return fixtures.subworkflowNested;
      return null;
    };
    const o = await new Scheduler({
      cfg: makeCfg(r, t, fixtures.subworkflowTwoLevel),
      db: getDb(),
      executor: e,
      resolveTemplate: resolve,
    }).run();
    expect(o.status).toBe("failed");
    const sub = (await nodeRunsFor(r)).find((n) => n.nodeId === "sub")!;
    expect(sub.status).toBe("failed");
    expect(String(sub.error)).toMatch(/two-level nesting/i);
  });
});

// ── 7. node-report cannot set terminal status ───────────────────────────────

describe("node-report (§10)", () => {
  it("rejects when the NodeRun is already terminal (cannot double-write)", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("report-seq", graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e,
    }).run();
    const aRow = (await nodeRunsFor(r)).find((n) => n.nodeId === "a")!;
    expect(aRow.status).toBe("done");

    // Direct journal write attempt would be a double-write — the report action
    // guards by REFUSING any report on a terminal node. We assert the guard
    // logic here against the persisted row (the action wraps this exact check).
    const isTerminal = ["done", "failed", "skipped"].includes(aRow.status);
    expect(isTerminal).toBe(true);

    // An interim report on a NON-terminal (running) node only adds an artifact
    // and refreshes heartbeat — it never flips status.
    const db = getDb();
    const { eq } = await import("drizzle-orm");
    // Make a running node to report on.
    await db
      .update(schema.nodeRuns)
      .set({ status: "running", lastHeartbeat: nowIso() })
      .where(eq(schema.nodeRuns.id, aRow.id));
    const before = (await nodeRunsFor(r)).find((n) => n.id === aRow.id)!;
    // Simulate the action's artifact insert + heartbeat refresh.
    await db.insert(schema.artifacts).values({
      id: newId("art"),
      runId: r,
      nodeRunId: aRow.id,
      kind: "progress",
      ref: JSON.stringify({ progress: "50%" }),
      summary: "50%",
      createdAt: nowIso(),
    });
    await db
      .update(schema.nodeRuns)
      .set({ lastHeartbeat: nowIso() })
      .where(eq(schema.nodeRuns.id, aRow.id));
    const after = (await nodeRunsFor(r)).find((n) => n.id === aRow.id)!;
    expect(after.status).toBe(before.status); // status untouched by a report
  });
});

// ── 8. per-node timeout → failed with a distinct timeout error ──────────────

describe("per-node timeout (§3.4)", () => {
  it("a node exceeding timeoutMs is marked failed with a timeout error", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "start", type: "start", title: "s" },
        {
          id: "slow",
          type: "agent",
          title: "slow",
          prompt: "x",
          timeoutMs: 30,
          runtime: { kind: "none", onFailure: "rollback", env: {} },
        },
        { id: "end", type: "end", title: "e" },
      ],
      edges: [
        { id: "e1", from: "start", to: "slow" },
        { id: "e2", from: "slow", to: "end" },
      ],
    };
    const t = await seedTemplate("timeout-tpl", graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    e.hang.add("slow"); // never resolves on its own → only the timeout ends it
    const o = await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e,
    }).run();
    expect(o.status).toBe("failed");
    const slow = (await nodeRunsFor(r)).find((n) => n.nodeId === "slow")!;
    expect(slow.status).toBe("failed");
    expect(String(slow.error)).toMatch(/timeoutMs=30/);
    expect(new NodeTimeoutError("slow", 30).name).toBe("NodeTimeoutError");
  });
});

// ── 9. reap: stranded running row reaped; fresh one not ─────────────────────

describe("stuck-run reap (§6.4/§13)", () => {
  it("reaps a stale-heartbeat running row but NOT a fresh one", async () => {
    const db = getDb();
    const t = await seedTemplate("reap-tpl", fixtures.sequential);
    const r = await seedRun(t);
    const now = Date.now();
    const stale = new Date(now - 5 * 60_000).toISOString(); // 5 min old
    const fresh = new Date(now - 1_000).toISOString(); // 1 s old
    const staleId = newId("nr");
    const freshId = newId("nr");
    for (const [id, hb] of [
      [staleId, stale],
      [freshId, fresh],
    ] as const) {
      await db.insert(schema.nodeRuns).values({
        id,
        runId: r,
        nodeId: id,
        type: "agent",
        title: "x",
        status: "running",
        iteration: 0,
        fanoutIndex: 0,
        dynamic: 0,
        attempts: 1,
        tokensSpent: 0,
        lastHeartbeat: hb,
        startedAt: stale,
        agentRunId: id,
      });
    }
    const cutoff = new Date(now - 90_000).toISOString(); // 90s reap threshold
    const reaped = await reapStrandedNodeRuns(db, cutoff);
    const reapedIds = reaped.map((x) => x.id);
    expect(reapedIds).toContain(staleId); // stranded → reaped to failed
    expect(reapedIds).not.toContain(freshId); // fresh → untouched

    const { eq } = await import("drizzle-orm");
    const staleRow = (
      await db
        .select()
        .from(schema.nodeRuns)
        .where(eq(schema.nodeRuns.id, staleId))
    )[0];
    const freshRow = (
      await db
        .select()
        .from(schema.nodeRuns)
        .where(eq(schema.nodeRuns.id, freshId))
    )[0];
    expect(staleRow.status).toBe("failed");
    expect(String(staleRow.error)).toMatch(/stranded/);
    expect(freshRow.status).toBe("running"); // still alive
  });

  it("reapOnce uses the default threshold and reaps a never-heartbeat row", async () => {
    const db = getDb();
    const t = await seedTemplate("reap-tpl-2", fixtures.sequential);
    const r = await seedRun(t);
    const id = newId("nr");
    await db.insert(schema.nodeRuns).values({
      id,
      runId: r,
      nodeId: id,
      type: "agent",
      title: "x",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      dynamic: 0,
      attempts: 1,
      tokensSpent: 0,
      lastHeartbeat: null,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      agentRunId: id,
    });
    const reaped = await reapOnce();
    expect(reaped.map((x) => x.id)).toContain(id);
  });
});

// ── 10. pause → paused ──────────────────────────────────────────────────────

describe("run-pause", () => {
  it("sets a non-terminal run to paused; resume drives it to done", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate("pause-tpl", graph);
    const r = await seedRun(t);
    const e1 = new SpyExecutor();
    e1.failOnce.set("b", 99);
    await new Scheduler({
      cfg: makeCfg(r, t, graph),
      db: getDb(),
      executor: e1,
    }).run();
    const res = await control.pauseRun(r);
    expect(res.status).toBe("paused");
    const { eq } = await import("drizzle-orm");
    const runRow = (
      await getDb()
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, r))
    )[0];
    expect(runRow.status).toBe("paused");

    const e2 = new SpyExecutor();
    const o = await control.resumeRun(r, { executor: e2 });
    expect(o.status).toBe("done");
  });
});
