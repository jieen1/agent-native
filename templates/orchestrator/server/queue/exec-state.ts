// The work-item execState machine (DESIGN §6.4 / §6.2a). execState is the
// AUTOMATION overlay — "is an orchestrator run active right now" — and is
// STRICTLY SEPARATE from the business `status` (the PM pipeline, §6.2a). The
// queue never reads or writes business status; that is transition-work-item's
// sole job (§6.2b). Conflating the two deletes the PM tool, so this module only
// ever touches exec_state / claimed_at / claimed_by.
//
//   idle → queued → claimed → running → done | failed
//   (+ paused, cancelled)
//
// The legal transitions below are the single source of truth the queue actions
// and the worker pool validate against, so an illegal move (e.g. claiming an
// idle item, or running a done one) is rejected rather than silently applied.

/** Every execState value (matches the work_items.exec_state column enum). */
export type ExecState =
  | "idle"
  | "queued"
  | "claimed"
  | "running"
  | "paused"
  | "failed"
  | "done";

/** The full set, for validation. */
export const EXEC_STATES: readonly ExecState[] = [
  "idle",
  "queued",
  "claimed",
  "running",
  "paused",
  "failed",
  "done",
] as const;

/**
 * The execState transition table (DESIGN §6.4). Each key maps to the states it
 * may move to. This is intentionally explicit (not derived) so the queue's
 * guarantees are auditable in one place:
 *
 *  - `idle    → queued`            enqueue-work-item
 *  - `queued  → claimed | idle`    a worker claims it / dequeue-work-item
 *  - `claimed → running | queued`  the run actually starts / reap returns it
 *  - `running → done | failed | paused | queued`  run finishes / reap returns it
 *  - `paused  → queued | running`  resume
 *  - `done    → queued`            re-run a finished item (a NEW workflow_run)
 *  - `failed  → queued`            retry a failed item
 */
export const EXEC_TRANSITIONS: Readonly<Record<ExecState, readonly ExecState[]>> =
  {
    idle: ["queued"],
    queued: ["claimed", "idle"],
    claimed: ["running", "queued", "failed"],
    running: ["done", "failed", "paused", "queued"],
    paused: ["queued", "running"],
    done: ["queued"],
    failed: ["queued"],
  };

/** True when `from → to` is a legal execState move. */
export function canTransitionExec(from: ExecState, to: ExecState): boolean {
  return (EXEC_TRANSITIONS[from] ?? []).includes(to);
}

/** Narrowing guard: is the string a known execState? */
export function isExecState(value: string): value is ExecState {
  return (EXEC_STATES as readonly string[]).includes(value);
}

/**
 * States that mean "an automation run is in flight" — used for the queue-status
 * counts and the reap heartbeat sweep (claimed is the transient grab; running
 * is the live workflow_run).
 */
export const ACTIVE_EXEC_STATES: readonly ExecState[] = [
  "claimed",
  "running",
] as const;
