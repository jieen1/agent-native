// Engine correctness tests against a real temp sqlite DB. These cover the
// invariants that the echo CLI fixtures cannot easily prove: determinism
// (identical topology + artifact ids across runs), resume (executor invoke
// count is 0 for replayed nodes), budget gating, cancel, and the concurrency
// cap. The setup runs BEFORE importing anything that pulls in getDb.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngineTables, useTempDb } from "./setup.js";

useTempDb();

// Imported after DATABASE_URL is set so getDb binds to the temp DB.
const { getDb, schema } = await import("../../db/index.js");
const { Scheduler } = await import("../scheduler.js");
const { DEFAULT_CAPS } = await import("../types.js");
const fixtures = await import("../fixtures.js");
const { nowIso, newId } = await import("../../../actions/_util.js");
const { keyStr } = await import("../types.js");

import type { WorkflowGraph, Node } from "../../../shared/types.js";
import type {
  NodeExecutionInput,
  NodeExecutionResult,
  NodeExecutor,
  RunConfig,
} from "../types.js";

/** A spy executor: deterministic echo output, configurable failures + tokens. */
class SpyExecutor implements NodeExecutor {
  readonly kind = "spy";
  invokeCount = 0;
  readonly invoked: string[] = [];
  /** nodeId -> remaining number of times to fail before succeeding. */
  failOnce = new Map<string, number>();
  tokensPerCall = 0;
  delayMs = 0;

  async invoke(
    input: NodeExecutionInput,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    this.invokeCount += 1;
    this.invoked.push(keyStr({
      nodeId: input.node.id,
      iteration: input.iteration,
      fanoutIndex: input.fanoutIndex,
    }));
    if (this.delayMs > 0) {
      await new Promise((r) => {
        const t = setTimeout(r, this.delayMs);
        signal.addEventListener("abort", () => { clearTimeout(t); r(undefined); }, { once: true });
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
        output = Array.from({ length: asNum }, (_, i) => ({ id: `${input.node.id}-${i}` }));
      } else {
        try { output = JSON.parse(env.echoArray); } catch { /* keep */ }
      }
    }
    return { output, tokensSpent: this.tokensPerCall };
  }
}

beforeAll(async () => {
  await createEngineTables();
});

async function seedTemplate(graph: WorkflowGraph): Promise<string> {
  const db = getDb();
  const id = newId("tpl");
  const now = nowIso();
  await db.insert(schema.workflowTemplates).values({
    id, name: "t", description: "", graph: JSON.stringify(graph),
    version: 1, createdAt: now, updatedAt: now,
    ownerEmail: "local@localhost", orgId: null, visibility: "private",
  });
  return id;
}

async function seedRun(templateId: string, tokenBudget: number | null = null): Promise<string> {
  const db = getDb();
  const id = newId("run");
  const now = nowIso();
  await db.insert(schema.workflowRuns).values({
    id, templateId, workItemId: null, status: "pending", deliverable: null,
    tokenBudget, tokensSpent: 0, startedAt: now, completedAt: null,
    ownerEmail: "local@localhost", orgId: null, visibility: "private",
  });
  return id;
}

function makeCfg(runId: string, templateId: string, graph: WorkflowGraph, over: Partial<RunConfig> = {}): RunConfig {
  return {
    runId, templateId, graph,
    userEmail: "local@localhost", orgId: null,
    tokenBudget: null, seed: 1,
    caps: { ...DEFAULT_CAPS, ...(over.caps ?? {}) },
    echoDelayMs: 0,
    ...over,
  };
}

describe("scheduler — determinism", () => {
  it("produces identical NodeRun topology and artifact ids across two runs", async () => {
    const graph = fixtures.fanout;
    const t1 = await seedTemplate(graph);
    const r1 = await seedRun(t1);
    const r2 = await seedRun(t1);
    const e1 = new SpyExecutor();
    const e2 = new SpyExecutor();
    const o1 = await new Scheduler({ cfg: makeCfg(r1, t1, graph), db: getDb(), executor: e1 }).run();
    const o2 = await new Scheduler({ cfg: makeCfg(r2, t1, graph), db: getDb(), executor: e2 }).run();
    // Same number of NodeRuns and same per-(nodeId,iter,idx) structure.
    const sig = (o: typeof o1) =>
      o.nodeRuns
        .map((n) => `${n.key.nodeId}#${n.key.iteration}#${n.key.fanoutIndex}:${n.status}`)
        .sort()
        .join("|");
    expect(sig(o1)).toBe(sig(o2));
    expect(o1.status).toBe("done");
    // Artifact ids are derived from (runId,key) — same KEYS, run-prefixed.
    const outputs1 = o1.nodeRuns.map((n) => n.outputRef?.replace(r1, "<run>")).sort();
    const outputs2 = o2.nodeRuns.map((n) => n.outputRef?.replace(r2, "<run>")).sort();
    expect(outputs1).toEqual(outputs2);
  });
});

describe("scheduler — resume", () => {
  it("replays already-done nodes WITHOUT re-invoking the executor", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    // First run: force node `c` to fail once so the run ends failed at c.
    const e1 = new SpyExecutor();
    e1.failOnce.set("c", 99); // keep failing so the first run stops with c failed
    const o1 = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e1 }).run();
    expect(o1.status).toBe("failed");
    const cState1 = o1.nodeRuns.find((n) => n.key.nodeId === "c");
    expect(cState1?.status).toBe("failed");
    // a and b succeeded on the first run.
    expect(e1.invoked).toContain("a#0#0");
    expect(e1.invoked).toContain("b#0#0");

    // Resume: now let c succeed. a and b must NOT be re-invoked.
    const e2 = new SpyExecutor();
    const o2 = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e2 }).resume();
    expect(o2.status).toBe("done");
    expect(e2.invoked).not.toContain("a#0#0"); // replayed, not re-run
    expect(e2.invoked).not.toContain("b#0#0");
    expect(e2.invoked).toContain("c#0#0"); // the failed tail re-ran
  });

  it("invalidates an entire fanout subtree when the array-producer reruns", async () => {
    const graph = fixtures.fanout;
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    // Force the array producer `disc` to fail so the whole fanout never forms.
    const e1 = new SpyExecutor();
    e1.failOnce.set("disc", 99);
    const o1 = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e1 }).run();
    expect(o1.status).toBe("failed");

    // Resume: disc succeeds → the fanout forms and ALL work children run live.
    const e2 = new SpyExecutor();
    const o2 = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e2 }).resume();
    expect(o2.status).toBe("done");
    expect(e2.invoked).toContain("disc#0#0");
    // 4 fresh fanout children, none reused.
    const workInvokes = e2.invoked.filter((k) => k.startsWith("work#"));
    expect(workInvokes.length).toBe(4);
  });
});

describe("scheduler — budget", () => {
  it("stops scheduling new dynamic nodes once the token budget is exhausted", async () => {
    const graph = fixtures.fanout;
    const t = await seedTemplate(graph);
    const r = await seedRun(t, 10); // budget 10
    const e = new SpyExecutor();
    e.tokensPerCall = 10; // disc alone spends the whole budget
    const o = await new Scheduler({ cfg: makeCfg(r, t, graph, { tokenBudget: 10 }), db: getDb(), executor: e }).run();
    // disc (static) ran; the 4 dynamic fanout children are skipped past budget.
    const work = o.nodeRuns.filter((n) => n.key.nodeId === "work");
    expect(work.length).toBe(4);
    expect(work.every((w) => w.status === "skipped")).toBe(true);
  });
});

describe("scheduler — cancel", () => {
  it("stops scheduling new nodes and ends cancelled", async () => {
    const graph = fixtures.sequential;
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    e.delayMs = 50;
    const s = new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e });
    const p = s.run();
    // Cancel almost immediately (while `a` is in its delay).
    setTimeout(() => s.cancel(), 10);
    const o = await p;
    expect(o.status).toBe("cancelled");
    // `c` (the last leaf) never ran because scheduling stopped.
    expect(e.invoked).not.toContain("c#0#0");
  });
});

describe("scheduler — concurrency cap", () => {
  it("never exceeds maxConcurrentModelCalls in flight", async () => {
    // A fanout of width 4 with a cap of 2 should never run >2 leaves at once.
    const graph = fixtures.fanout;
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    let peak = 0;
    let inFlight = 0;
    class CountingExecutor extends SpyExecutor {
      override async invoke(input: NodeExecutionInput, signal: AbortSignal) {
        if (input.node.id === "work") {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((res) => setTimeout(res, 30));
          inFlight -= 1;
        }
        return super.invoke(input, signal);
      }
    }
    const e = new CountingExecutor();
    const o = await new Scheduler({
      cfg: makeCfg(r, t, graph, { caps: { ...DEFAULT_CAPS, maxConcurrentModelCalls: 2 } }),
      db: getDb(),
      executor: e,
    }).run();
    expect(o.status).toBe("done");
    expect(peak).toBeGreaterThanOrEqual(2); // genuinely overlapped
    expect(peak).toBeLessThanOrEqual(2); // never exceeded the cap
  });
});

describe("graph fixtures — structural assertions", () => {
  it("branch skips the not-taken edge target", async () => {
    const graph = fixtures.branch;
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    const o = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e }).run();
    const no = o.nodeRuns.find((n) => n.key.nodeId === "no");
    const yes = o.nodeRuns.find((n) => n.key.nodeId === "yes");
    expect(no?.status).toBe("skipped");
    expect(yes?.status).toBe("done");
    expect(o.status).toBe("done");
  });

  it("fanout width equals the upstream array length", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "start", type: "start", title: "s" },
        { id: "disc", type: "agent", title: "d", runtime: { kind: "none", onFailure: "rollback", env: { echoArray: "5" } } } as Node,
        { id: "fan", type: "fanout", title: "f", itemsFrom: "disc", children: ["w"] },
        { id: "w", type: "agent", title: "w" },
        { id: "end", type: "end", title: "e" },
      ],
      edges: [
        { id: "e1", from: "start", to: "disc" },
        { id: "e2", from: "disc", to: "fan" },
        { id: "e3", from: "w", to: "end" },
      ],
    };
    const t = await seedTemplate(graph);
    const r = await seedRun(t);
    const e = new SpyExecutor();
    const o = await new Scheduler({ cfg: makeCfg(r, t, graph), db: getDb(), executor: e }).run();
    const work = o.nodeRuns.filter((n) => n.key.nodeId === "w");
    expect(work.length).toBe(5);
    expect(work.every((w) => w.status === "done")).toBe(true);
  });
});
