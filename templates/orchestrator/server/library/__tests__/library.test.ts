// P3c node-library + finalize-status gate tests (DESIGN §3.7 / §6.2b / §1.9)
// against a real temp sqlite DB. Proves:
//   - save-node-def + list-node-defs round-trip (via the seed + raw rows)
//   - the starter set + bundled template seed is idempotent (no dup rows)
//   - delete-node-def is BLOCKED when a template graph references the key
//   - injectFinalizeStatusGate: a delivery graph WITHOUT the gate gets it before end
//   - the RUNTIME gate fails a run whose work item never reached a near-terminal
//     status, and passes once the agent moved it forward (via transition log)
// Setup runs BEFORE importing anything that pulls in getDb.

import { beforeAll, describe, expect, it } from "vitest";
import {
  createEngineTables,
  createPmTables,
  useTempDb,
} from "../../engine/__tests__/setup.js";

useTempDb();

const { getDb, schema } = await import("../../db/index.js");
const { runWithRequestContext } =
  await import("@agent-native/core/server/request-context");
const { eq } = await import("drizzle-orm");
const { nowIso, newId } = await import("../../../actions/_util.js");
const { seedStarterLibrary } = await import("../seed.js");
const { findTemplatesReferencingNodeDef } = await import("../references.js");
const { executeRun } = await import("../../engine/index.js");
const { EchoExecutor } = await import("../../engine/echo-executor.js");
const {
  injectFinalizeStatusGate,
  hasFinalizeStatusGate,
  isDeliveryGraph,
  FINALIZE_STATUS_KEY,
} = await import("../../../shared/finalize-gate.js");
const { STARTER_LIBRARY_KEYS, buildBundledTemplateGraph } =
  await import("../../../shared/library.js");
const { validateGraph } = await import("../../../shared/types.js");

const OWNER = "local@localhost";

beforeAll(async () => {
  await createEngineTables();
  await createPmTables();
});

function echoOpts() {
  return { executor: new EchoExecutor(0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTER LIBRARY + BUNDLED TEMPLATE SEED (DESIGN §3.7 / §1.9)
// ─────────────────────────────────────────────────────────────────────────────

describe("starter library seed (DESIGN §3.7)", () => {
  it("seeds all 11 starter node defs + the bundled template, idempotently", async () => {
    const db = getDb();
    const first = await seedStarterLibrary(db, OWNER, null);

    // All expected keys present (7 tool + 4 agent).
    const expectedKeys = [
      "run-tests",
      "lint",
      "apply-patch",
      "git-commit",
      "git-push",
      "open-pr",
      "finalize-status",
      "code-review",
      "security-review",
      "secret-scan",
      "pr-description",
    ];
    expect(STARTER_LIBRARY_KEYS.sort()).toEqual([...expectedKeys].sort());
    for (const k of expectedKeys) {
      expect(first.nodeDefs[k]).toBeTruthy();
    }
    expect(first.bundledTemplateId).toBeTruthy();

    // Round-trip: every key is a real row, list-able.
    const rows = await db
      .select()
      .from(schema.nodeDefs)
      .where(eq(schema.nodeDefs.ownerEmail, OWNER));
    expect(rows.length).toBe(expectedKeys.length);

    // Idempotent: re-seeding creates 0 new node_defs / templates.
    const second = await seedStarterLibrary(db, OWNER, null);
    const rows2 = await db
      .select()
      .from(schema.nodeDefs)
      .where(eq(schema.nodeDefs.ownerEmail, OWNER));
    expect(rows2.length).toBe(expectedKeys.length);
    expect(second.bundledTemplateId).toBe(first.bundledTemplateId);
    const tpls = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.name, "code-change-with-review"));
    expect(tpls.length).toBe(1);
  });

  it("the bundled template graph is valid and ends with finalize-status before end", async () => {
    const graph = buildBundledTemplateGraph();
    expect(validateGraph(graph).ok).toBe(true);
    expect(hasFinalizeStatusGate(graph)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE BLOCKED WHEN REFERENCED (DESIGN §3.7)
// ─────────────────────────────────────────────────────────────────────────────

describe("delete-node-def reference guard (DESIGN §3.7)", () => {
  it("findTemplatesReferencingNodeDef lists templates whose graph uses the key", async () => {
    const db = getDb();
    const now = nowIso();
    const key = "git-push";

    // A template whose graph references the library key via nodeDefKey.
    const tplId = newId("tpl");
    await db.insert(schema.workflowTemplates).values({
      id: tplId,
      name: "ref-tpl",
      description: "",
      graph: JSON.stringify({
        nodes: [
          { id: "start", type: "start", title: "Start" },
          {
            id: "push",
            type: "tool",
            title: "Push",
            nodeDefKey: key,
            action: "git-push",
          },
          { id: "end", type: "end", title: "End" },
        ],
        edges: [
          { id: "e1", from: "start", to: "push" },
          { id: "e2", from: "push", to: "end" },
        ],
      }),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: null,
      visibility: "private",
    });

    // accessFilter needs a request context (owner scoping).
    await runWithRequestContext(
      { userEmail: OWNER, orgId: undefined },
      async () => {
        const refs = await findTemplatesReferencingNodeDef(key);
        expect(refs.some((r) => r.templateId === tplId)).toBe(true);
        const ref = refs.find((r) => r.templateId === tplId)!;
        expect(ref.nodeIds).toContain("push");

        // An unreferenced key returns no rows (safe to delete).
        const none = await findTemplatesReferencingNodeDef(
          "definitely-not-referenced-key",
        );
        expect(none.length).toBe(0);
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finalize-status GATE — STRUCTURAL injection (DESIGN §6.2b L1)
// ─────────────────────────────────────────────────────────────────────────────

describe("finalize-status gate injection (DESIGN §6.2b L1)", () => {
  it("injects the gate before end for a delivery graph that lacks it", () => {
    const graph = {
      nodes: [
        { id: "start", type: "start" as const, title: "Start" },
        { id: "work", type: "agent" as const, title: "Work" },
        { id: "end", type: "end" as const, title: "End" },
      ],
      edges: [
        { id: "e1", from: "start", to: "work" },
        { id: "e2", from: "work", to: "end" },
      ],
    };
    expect(isDeliveryGraph(graph)).toBe(true);
    expect(hasFinalizeStatusGate(graph)).toBe(false);

    const res = injectFinalizeStatusGate(graph);
    expect(res.injected).toBe(true);
    expect(hasFinalizeStatusGate(res.graph)).toBe(true);

    // The gate node exists, references the library, and feeds end.
    const gate = res.graph.nodes.find(
      (n) => n.nodeDefKey === FINALIZE_STATUS_KEY,
    );
    expect(gate).toBeTruthy();
    expect(
      res.graph.edges.some((e) => e.from === gate!.id && e.to === "end"),
    ).toBe(true);
    // The old work→end edge was rerouted to work→gate; no edge feeds end except
    // the gate.
    const feedersOfEnd = res.graph.edges.filter((e) => e.to === "end");
    expect(feedersOfEnd.length).toBe(1);
    expect(feedersOfEnd[0].from).toBe(gate!.id);
    // The injected graph still validates.
    expect(validateGraph(res.graph).ok).toBe(true);
  });

  it("is a no-op when the gate already sits before end", () => {
    const graph = buildBundledTemplateGraph();
    const res = injectFinalizeStatusGate(graph);
    expect(res.injected).toBe(false);
    expect(hasFinalizeStatusGate(res.graph)).toBe(true);
  });

  it("is a no-op for a non-delivery graph (no body)", () => {
    const graph = {
      nodes: [
        { id: "start", type: "start" as const, title: "Start" },
        { id: "end", type: "end" as const, title: "End" },
      ],
      edges: [{ id: "e1", from: "start", to: "end" }],
    };
    expect(isDeliveryGraph(graph)).toBe(false);
    const res = injectFinalizeStatusGate(graph);
    expect(res.injected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finalize-status GATE — RUNTIME assertion (DESIGN §6.2b L1)
// ─────────────────────────────────────────────────────────────────────────────

async function makeProject(): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = newId("proj");
  await db.insert(schema.projects).values({
    id,
    name: "P",
    key: "P",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

async function makeItem(projectId: string, status: string): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = newId("wi");
  await db.insert(schema.workItems).values({
    id,
    projectId,
    type: "task",
    title: "T",
    status,
    statusCategory: status === "待办" ? "todo" : "in-progress",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

/** A delivery template: start → finalize-status → end. */
async function makeFinalizeTemplate(): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = newId("tpl");
  const graph = injectFinalizeStatusGate({
    nodes: [
      { id: "start", type: "start", title: "Start" },
      { id: "work", type: "agent", title: "Work" },
      { id: "end", type: "end", title: "End" },
    ],
    edges: [
      { id: "e1", from: "start", to: "work" },
      { id: "e2", from: "work", to: "end" },
    ],
  }).graph;
  await db.insert(schema.workflowTemplates).values({
    id,
    name: "finalize-tpl-" + id,
    description: "",
    graph: JSON.stringify(graph),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

async function makeRun(
  templateId: string,
  workItemId: string,
): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = newId("run");
  await db.insert(schema.workflowRuns).values({
    id,
    templateId,
    workItemId,
    status: "pending",
    tokensSpent: 0,
    startedAt: now,
    completedAt: null,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

describe("finalize-status gate runtime (DESIGN §6.2b L1)", () => {
  it("FAILS the run when the item is still parked in an early stage", async () => {
    const proj = await makeProject();
    const tpl = await makeFinalizeTemplate();
    const item = await makeItem(proj, "待办"); // todo — not finalized
    const runId = await makeRun(tpl, item);

    const outcome = await executeRun(runId, echoOpts());
    expect(outcome.status).toBe("failed");

    // The finalize-status node specifically failed.
    const db = getDb();
    const nodeRows = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.runId, runId));
    const gate = nodeRows.find(
      (n) => n.nodeId === "finalize-status" || n.type === "tool",
    );
    expect(gate).toBeTruthy();
    expect(gate!.status).toBe("failed");
    expect(gate!.error ?? "").toMatch(/finalize-status gate/i);
  });

  it("PASSES the run once the item reached its near-terminal stage (task → 待验收)", async () => {
    const proj = await makeProject();
    const tpl = await makeFinalizeTemplate();
    // For a `task`, the last in-progress stage = 待验收 (the near-terminal the
    // agent reaches when it produces the deliverable). 待发布 belongs to
    // requirement/bug schemes, not task.
    const item = await makeItem(proj, "待验收");
    const runId = await makeRun(tpl, item);

    const outcome = await executeRun(runId, echoOpts());
    expect(outcome.status).toBe("done");
  });
});
