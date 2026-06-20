// Six control-flow fixture templates (P1 acceptance list). Each is a v2
// WorkflowGraph whose postcondition is provable from node_runs alone. The echo
// executor's per-node `runtime.env.echoDelayMs` and `echoArray` config drive
// observable timing and array width WITHOUT affecting topology.

import type { WorkflowGraph } from "../../shared/types.js";

/** Helper: a microvm-less runtime carrying echo config (kind:"none"). */
function echo(env: Record<string, string>) {
  return { kind: "none" as const, onFailure: "rollback" as const, env };
}

/**
 * 1. SEQUENTIAL — strict topological order: start → a → b → c → end.
 *    Postcondition: a node never starts before its predecessor is done.
 *    A delay on each makes the ordering provable from started_at/completed_at.
 */
export const sequential: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    { id: "a", type: "agent", title: "A", prompt: "a", runtime: echo({ echoDelayMs: "40" }) },
    { id: "b", type: "agent", title: "B", prompt: "b", runtime: echo({ echoDelayMs: "40" }) },
    { id: "c", type: "agent", title: "C", prompt: "c", runtime: echo({ echoDelayMs: "40" }) },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "a" },
    { id: "e2", from: "a", to: "b" },
    { id: "e3", from: "b", to: "c" },
    { id: "e4", from: "c", to: "end" },
  ],
};

/**
 * 2. PIPELINE — under a fanout, B_i starts as soon as A_i is done, NOT waiting
 *    for sibling A_j. disc emits a 3-array; fanout body is a→b; a is fast,
 *    so B_0 completes before A_1 completes (chains interleave). No join: each
 *    chain flows to end independently (end is a barrier over the fanout via a
 *    join-less aggregation — here we keep chains independent and prove
 *    interleave from a/b timings).
 */
export const pipeline: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    { id: "disc", type: "agent", title: "discover", prompt: "find", runtime: echo({ echoArray: "3", echoDelayMs: "5" }) },
    { id: "fan", type: "fanout", title: "per-item", itemsFrom: "disc", children: ["a", "b"] },
    // Stagger stage A by index: A_0 is fast (10ms), A_1 ~110ms, A_2 ~210ms.
    // Stage B is fast (10ms). The pipeline proof: B_0 completes (~20ms) BEFORE
    // A_1 completes (~110ms) — B_0 did NOT wait for sibling A_1 (no barrier).
    { id: "a", type: "agent", title: "A", prompt: "stageA", runtime: echo({ echoDelayMs: "10", echoDelayPerIndexMs: "100" }) },
    { id: "b", type: "agent", title: "B", prompt: "stageB", runtime: echo({ echoDelayMs: "10" }) },
    { id: "join", type: "join", title: "collect", runtime: echo({}) },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "disc" },
    { id: "e2", from: "disc", to: "fan" },
    { id: "e3", from: "a", to: "b" }, // index-preserving inside the fanout: B_i ← A_i
    { id: "e4", from: "b", to: "join" },
    { id: "e5", from: "join", to: "end" },
  ],
};

/**
 * 3. PARALLEL (barrier) — a parallel container with 2+ children that overlap in
 *    running; the node after the container is not ready until ALL children done.
 *    The container `parallel` node's successor `after` depends on the parallel
 *    node (a barrier: parallel settles done only after its children settle —
 *    enforced by `after` depending on each child via edges).
 */
export const parallel: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    { id: "p", type: "parallel", title: "parallel", children: ["x", "y", "z"] },
    { id: "x", type: "agent", title: "X", prompt: "x", runtime: echo({ echoDelayMs: "60" }) },
    { id: "y", type: "agent", title: "Y", prompt: "y", runtime: echo({ echoDelayMs: "60" }) },
    { id: "z", type: "agent", title: "Z", prompt: "z", runtime: echo({ echoDelayMs: "60" }) },
    { id: "after", type: "agent", title: "after", prompt: "after", runtime: echo({ echoDelayMs: "5" }) },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "p" },
    // The parallel container fans to its children; `after` waits for ALL three.
    { id: "e2", from: "p", to: "x" },
    { id: "e3", from: "p", to: "y" },
    { id: "e4", from: "p", to: "z" },
    { id: "e5", from: "x", to: "after" },
    { id: "e6", from: "y", to: "after" },
    { id: "e7", from: "z", to: "after" },
    { id: "e8", from: "after", to: "end" },
  ],
};

/**
 * 4. FANOUT — N child NodeRuns == upstream array length; N independent
 *    index-preserving chains. disc emits a 4-array; the fanout body work runs
 *    once per item.
 */
export const fanout: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    { id: "disc", type: "agent", title: "discover", prompt: "find", runtime: echo({ echoArray: "4", echoDelayMs: "5" }) },
    { id: "fan", type: "fanout", title: "per-item", itemsFrom: "disc", children: ["work"] },
    { id: "work", type: "agent", title: "work", prompt: "process item", runtime: echo({ echoDelayMs: "20" }) },
    { id: "join", type: "join", title: "collect", runtime: echo({}) },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "disc" },
    { id: "e2", from: "disc", to: "fan" },
    { id: "e3", from: "work", to: "join" },
    { id: "e4", from: "join", to: "end" },
  ],
};

/**
 * 5. BRANCH — only the when-true out-edge target is scheduled; the other edge
 *    target is status=skipped. The branch reads a dep value via jsonpath.
 *    `gate` emits { flag: true }; the true edge (truthy) selects `yes`,
 *    the false edge selects `no` → `no` is skipped.
 */
export const branch: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    { id: "gate", type: "agent", title: "gate", prompt: "decide", runtime: echo({ echoArray: '[{"flag":true}]' }) },
    { id: "br", type: "branch", title: "branch", runtime: echo({}) },
    { id: "yes", type: "agent", title: "yes-path", prompt: "yes", runtime: echo({ echoDelayMs: "10" }) },
    { id: "no", type: "agent", title: "no-path", prompt: "no", runtime: echo({ echoDelayMs: "10" }) },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "gate" },
    { id: "e2", from: "gate", to: "br" },
    // The branch's two out-edges: truthy selects yes; the negation selects no.
    {
      id: "e3",
      from: "br",
      to: "yes",
      when: { kind: "jsonpath", path: "deps.gate[0].flag", op: "truthy", value: true },
    },
    {
      id: "e4",
      from: "br",
      to: "no",
      when: { kind: "jsonpath", path: "deps.gate[0].flag", op: "falsy", value: true },
    },
    { id: "e5", from: "yes", to: "end" },
    { id: "e6", from: "no", to: "end" },
  ],
};

/**
 * 6. LOOP-UNTIL-DRY — inject repeated items; the loop stops after dryRounds
 *    rounds add nothing new to `seen`. The finder echoes a fixed array every
 *    iteration (same ids), so iteration 0 adds 2 new keys, then every later
 *    iteration adds nothing → with dryRounds=2 it stops after 2 dry rounds.
 *    Dedupe is vs SEEN, never confirmed.
 */
export const loopUntilDry: WorkflowGraph = {
  nodes: [
    { id: "start", type: "start", title: "start" },
    {
      id: "loop",
      type: "loop",
      title: "find-until-dry",
      children: ["finder"],
      condition: { kind: "jsonpath", path: "loop.dry", op: "truthy", value: true },
      maxIterations: 6,
      dedupeKey: "id",
      dryRounds: 2,
    },
    // Finder always returns the SAME two items → after round 0 nothing is new.
    {
      id: "finder",
      type: "agent",
      title: "finder",
      prompt: "find items",
      runtime: echo({ echoArray: '[{"id":"x"},{"id":"y"}]', echoDelayMs: "5" }),
    },
    { id: "end", type: "end", title: "end" },
  ],
  edges: [
    { id: "e1", from: "start", to: "loop" },
    { id: "e2", from: "loop", to: "end" },
  ],
};

/** All fixtures by name, for headless seeding via the CLI. */
export const FIXTURES: Record<string, { name: string; description: string; graph: WorkflowGraph }> = {
  sequential: { name: "fixture: sequential", description: "strict topological order", graph: sequential },
  pipeline: { name: "fixture: pipeline", description: "index-preserving pipeline under fanout", graph: pipeline },
  parallel: { name: "fixture: parallel", description: "parallel barrier", graph: parallel },
  fanout: { name: "fixture: fanout", description: "N children == array length", graph: fanout },
  branch: { name: "fixture: branch", description: "only the chosen edge schedules", graph: branch },
  "loop-until-dry": { name: "fixture: loop-until-dry", description: "stop after K dry rounds", graph: loopUntilDry },
};
