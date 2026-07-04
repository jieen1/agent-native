// Brain session — spawns the orchestrator brain's Claude Code child process,
// streams its stream-json output into the brain transcript, and keeps the SAME
// CC session resumable across tasks via the persisted session_id (--resume).
//
// The brain is the orchestrator BRAIN: a persistent, resumable Claude Code
// session that reaches the orchestrator actions as MCP tools and autonomously
// decides how to accomplish a task — it MAY author + run a DAG (workflowRun),
// or use spawnOnce / workspace ops / work directly. It monitors by POLLING the
// read actions and finishes.
//
// Spawn + env modeled on server/runtime/claude-code-worker.ts +
// server/claude-managed-auth.ts. Unlike that single-shot worker, this runs a
// NON-BLOCKING background process with a STREAMING line reader so the page can
// watch a live transcript, and it captures + reuses the CC session_id.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getV3Db, v3Schema } from "../db/v3.js";
import {
  claudeWorkerEnv,
  getManagedClaudeStatus,
} from "../claude-managed-auth.js";
import { refreshManagedTokenIfNeeded } from "../claude-login.js";
import { writeBrainMcpConfig } from "./brain-mcp-config.js";
import { ensureBrainSchema } from "../db/brain-schema.js";
import { getLocalWorkspaceDir } from "../v3-workspace-local.js";
import { getBrainModel } from "./brain-model.js";
import { deriveContextWindow } from "../../actions/brain-usage.js";
import { runSdkBrainTurn } from "./sdk-brain-session.js";

/**
 * The brain's system prompt. Appended via --append-system-prompt on every turn.
 * Teaches the brain that it is the orchestrator BRAIN reaching the orchestrator
 * actions as MCP tools (mcp__orchestrator__*), that workflowRun is ONE option,
 * that it must MONITOR by polling, and to report links when done.
 */
export const BRAIN_PROMPT = `You are the orchestrator brain — a persistent, resumable Claude Code session with the orchestrator's actions exposed as MCP tools (named mcp__orchestrator__<key>).

Your tools include:
- AUTHOR + RUN a DAG: mcp__orchestrator__workflowRun, mcp__orchestrator__workflowSave, mcp__orchestrator__workflowPatch
- One-shot work: mcp__orchestrator__spawnOnce
- MONITOR (poll these — there is NO push; the engine never tells you it is done): mcp__orchestrator__runState, mcp__orchestrator__v3RunNodes, mcp__orchestrator__v3RunEvents, mcp__orchestrator__runSummary, mcp__orchestrator__nodeSummary
- LIST/INSPECT: mcp__orchestrator__runsList, mcp__orchestrator__workspaceList, mcp__orchestrator__workspaceDiff
- DELIVER: mcp__orchestrator__workspaceCreate, mcp__orchestrator__workspaceCommitPush
- ITERATE: mcp__orchestrator__runFork

Given a task you decide AUTONOMOUSLY how to accomplish it. workflowRun is just ONE option — you MAY author a DAG and run it, use spawnOnce, do workspace operations, or work directly. Choose the lightest path that does the job.

CRITICAL — DO NOT BUSY-POLL. The orchestrator auto-re-invokes you (a fresh, resumed short turn) whenever a NODE finishes (node done/failed) AND on a PERIODIC TIMER while the run is active. So you must NOT sit in a loop calling runState/v3RunNodes over and over waiting for the run to finish — that burns tokens for nothing while you sleep between turns at ZERO cost. Instead: after you DISPATCH the work (workflowRun / spawnOnce), do ONE quick status check if you like, then END YOUR TURN immediately. You will be woken automatically when there is something to do — a node resolved, the run went terminal, or the periodic drift-check timer fired — and THAT is when you act: poll once, decide, intervene if needed, and end again.

When you ARE woken: poll the read actions (runState / v3RunNodes / v3RunEvents) ONCE to see where the run stands. If it is still progressing normally → a short confirmation and END the turn (keep waiting). If a node failed or the run drifted → intervene with workflowPatch / nodeRetry / runCancel or replan. If the run is terminal (done/failed/cancelled) → REVIEW with runSummary + nodeSummary and, when there are changes to ship, COMMIT. Never loop in-place; check, act, end.

Worker agents available inside DAGs: \`claude-code\` (analyze + review) and \`vllm\` (development).

OUTPUT SCHEMAS — use sparingly. Do NOT attach \`output_schema\` to analysis, design, or review nodes whose worker replies with a natural-language plan or prose verdict. A prose node returns a plain string; reference its WHOLE text downstream as \`{{deps.<id>.output}}\` (never a sub-field). Only set \`output_schema\` (an object schema) on a node that genuinely emits structured JSON, and only then read sub-fields as \`{{deps.<id>.output.field}}\`. Attaching \`output_schema:{type:"object"}\` to a prose node makes the node fail validation ("expected object, got string") for no benefit.

When you finish, report what you did and include links: the run id, the workspace, and any PR/MR. If a step needs a tool you should call it directly rather than asking permission — you run headless.

Read the \`orchestrating-v3\` skill (if present in this repo) for the canonical decompose → run → poll-monitor → review → commit recipe and the channel contract.`;

interface StartBrainTurnArgs {
  threadId?: string;
  ownerEmail: string;
  orgId?: string | null;
  message: string;
  /** Working directory for the CC child. Overrides workspace resolution. */
  cwd?: string;
  /** A v3_workspaces id whose checkout dir becomes the cwd. */
  workspaceId?: string;
  /** Optional title for a freshly-created thread. */
  title?: string;
  /**
   * Periodic drift-check cadence (seconds) for the brain monitor scheduler,
   * persisted on the thread. NULL/undefined → env default
   * (BRAIN_MONITOR_INTERVAL_SEC, default 120); 0 → disable the timer
   * (event-only). Only the FIRST turn that supplies it sets the column; later
   * wakes (event/timer/terminal) omit it and leave the stored value intact.
   */
  monitorIntervalSec?: number;
}

interface StartBrainTurnResult {
  threadId: string;
}

/**
 * Start (or resume) a brain turn for a thread. NON-BLOCKING: resolves the
 * thread, appends the user message to the transcript, kicks off the CC child
 * in the background, and returns `{ threadId }` immediately. The background
 * task streams events into brain_events and flips the thread status on exit.
 */
export async function startBrainTurn(
  args: StartBrainTurnArgs,
): Promise<StartBrainTurnResult> {
  await ensureBrainSchema();
  const db = getV3Db();

  // Check Claude Code login status. If CC is unavailable, fall through to the
  // SDK brain (vLLM). Only throw if BOTH CC and the SDK path fail.
  const login = getManagedClaudeStatus();
  const useSdkBrain = !login.loggedIn;

  // 1) Resolve / create the thread.
  //
  // A caller MAY supply a threadId to (a) resume an existing thread or (b) pin a
  // pre-generated id for a NEW thread (so it can be embedded in run tags BEFORE
  // the turn starts — this is how the terminal-wake auto-resume links a run back
  // to its brain thread). A supplied-but-unknown id is therefore CREATED, not an
  // error.
  let threadId = args.threadId;
  let sessionId: string | null = null;
  // The thread's persisted cwd + workspace, used to resume the SAME Claude Code
  // session. `claude --resume <sid>` resolves the session by cwd → project dir,
  // so a resume MUST run in the same dir the session was created in. The
  // auto-wake resumes WITHOUT a cwd/workspaceId, so we recover them here from
  // the thread row — otherwise the resume lands in the default /tmp dir, the
  // session JSONL isn't found there, and the turn dies with
  // `error_during_execution: No conversation found with session ID`.
  let storedCwd: string | null = null;
  let storedWorkspaceId: string | null = null;
  if (threadId) {
    const [row] = await db
      .select({
        id: v3Schema.brainThreads.id,
        sessionId: v3Schema.brainThreads.sessionId,
        cwd: v3Schema.brainThreads.cwd,
        workspaceId: v3Schema.brainThreads.workspaceId,
      })
      .from(v3Schema.brainThreads)
      .where(eq(v3Schema.brainThreads.id, threadId))
      .limit(1);
    if (row) {
      sessionId = row.sessionId ?? null;
      storedCwd = row.cwd ?? null;
      storedWorkspaceId = row.workspaceId ?? null;
    } else {
      // Pre-generated id for a brand-new thread — create the row.
      const title =
        args.title?.trim() || args.message.trim().slice(0, 60) || "New session";
      await db.insert(v3Schema.brainThreads).values({
        id: threadId,
        title,
        status: "idle",
        workspaceId: args.workspaceId ?? null,
        ownerEmail: args.ownerEmail,
        orgId: args.orgId ?? null,
      });
    }
  } else {
    threadId = `bt_${randomUUID()}`;
    const title =
      args.title?.trim() || args.message.trim().slice(0, 60) || "New session";
    await db.insert(v3Schema.brainThreads).values({
      id: threadId,
      title,
      status: "idle",
      workspaceId: args.workspaceId ?? null,
      ownerEmail: args.ownerEmail,
      orgId: args.orgId ?? null,
    });
  }

  // 2) Resolve the working directory.
  //
  // Priority (so a resume lands in the SAME project dir the session was created
  // in): explicit args.cwd → the thread's workspace dir → the thread's stored
  // cwd → a stable per-thread /tmp scratch dir. The workspace dir is preferred
  // over the stored cwd because the first turn of a workspace-backed thread runs
  // in the workspace (that's where the session JSONL is written), while the
  // stored cwd can be a stale /tmp fallback from a prior turn.
  let cwd = args.cwd;
  const effectiveWorkspaceId = args.workspaceId ?? storedWorkspaceId;
  if (!cwd && effectiveWorkspaceId) {
    const dir = await getLocalWorkspaceDir(effectiveWorkspaceId);
    if (dir) cwd = dir;
  }
  if (!cwd && storedCwd) {
    cwd = storedCwd;
  }
  if (!cwd) {
    // Stable scratch dir per thread so the .mcp.json + CC session live in one
    // place across turns.
    cwd = join(tmpdir(), "brain-threads", threadId);
  }
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  // Persist the resolved cwd so every subsequent turn (and the auto-wake)
  // resumes in the same dir.
  await db
    .update(v3Schema.brainThreads)
    .set({ cwd, updatedAt: new Date() })
    .where(eq(v3Schema.brainThreads.id, threadId));

  // 3) Append the user message to the transcript and mark the thread running.
  //
  // Also stamp last_wake_at = now() on EVERY turn start. This is the single
  // coordination point for the brain monitor scheduler: any wake (the initial
  // dispatch, an event-driven node/terminal wake, or a periodic timer wake) is
  // a turn start, so an event naturally resets the periodic timer and the
  // scheduler never double-fires (DESIGN: brain-monitor.ts).
  //
  // Persist monitor_interval_sec only when this turn explicitly supplied it
  // (the dispatching turn). Auto-wakes omit it so the stored cadence is kept.
  await appendEvent(threadId, args.ownerEmail, args.orgId ?? null, {
    type: "user",
    text: args.message,
  });
  const runningUpdate: Record<string, unknown> = {
    status: "running",
    cwd,
    error: null,
    lastWakeAt: new Date(),
    updatedAt: new Date(),
  };
  if (typeof args.monitorIntervalSec === "number") {
    runningUpdate.monitorIntervalSec = args.monitorIntervalSec;
  }
  await db
    .update(v3Schema.brainThreads)
    .set(runningUpdate)
    .where(eq(v3Schema.brainThreads.id, threadId));

  // 4) Run the brain in the background (do not await).
  // Use the SDK brain (vLLM) when CC is not logged in; otherwise CC path.
  const bgTask = useSdkBrain
    ? runSdkBrainTurn({
        threadId: threadId!,
        ownerEmail: args.ownerEmail,
        orgId: args.orgId ?? null,
        message: args.message,
      }).then(async (outcome) => {
        const db2 = getV3Db();
        if (!outcome.ok) {
          await db2
            .update(v3Schema.brainThreads)
            .set({ status: "error", error: outcome.error ?? "SDK brain failed", updatedAt: new Date() })
            .where(eq(v3Schema.brainThreads.id, threadId!));
        } else {
          await db2
            .update(v3Schema.brainThreads)
            .set({ status: "done", updatedAt: new Date() })
            .where(eq(v3Schema.brainThreads.id, threadId!));
        }
      })
    : runBrainChild({
        threadId: threadId!,
        ownerEmail: args.ownerEmail,
        orgId: args.orgId ?? null,
        message: args.message,
        cwd,
        resumeSessionId: sessionId,
      });

  void bgTask.catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await appendEvent(threadId!, args.ownerEmail, args.orgId ?? null, {
        type: "error",
        text: msg,
      });
      await getV3Db()
        .update(v3Schema.brainThreads)
        .set({ status: "error", error: msg, updatedAt: new Date() })
        .where(eq(v3Schema.brainThreads.id, threadId!));
    } catch {
      // Best-effort — the page surfaces the error via thread status.
    }
  });

  return { threadId };
}

/** Outcome of one streamed `claude` invocation, used to decide on a retry. */
interface BrainRunOutcome {
  /** True if the session_id passed via --resume could not be found. */
  resumeNotFound: boolean;
  /** The result subtype (success / error_during_execution / …), if any. */
  resultSubtype: string | null;
  /** True if the child produced a usable result. */
  sawResult: boolean;
  exitCode: number;
  stderr: string;
}

/**
 * The background CC child entrypoint. Resumes the SAME Claude Code session when
 * a `resumeSessionId` is given. If that resume fails because the session can no
 * longer be found (e.g. the original cwd/project dir moved, or the session was
 * pruned), it FALLS BACK to a fresh session seeded with a short recap so the
 * auto-wake still drives the brain to completion instead of dying with
 * `error_during_execution: No conversation found`.
 */
async function runBrainChild(opts: {
  threadId: string;
  ownerEmail: string;
  orgId: string | null;
  message: string;
  cwd: string;
  resumeSessionId: string | null;
}): Promise<void> {
  const db = getV3Db();
  const outcome = await streamBrainChild(opts);

  // Recovery: the resume target session is gone. Retry ONCE as a fresh session
  // (no --resume), prefixing a short recap so the new session has enough context
  // to continue the monitoring/delivery loop. The fresh init event will write a
  // new session_id, so subsequent wakes resume cleanly.
  if (opts.resumeSessionId && outcome.resumeNotFound) {
    await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
      type: "error",
      text:
        `Could not resume prior session ${opts.resumeSessionId} ` +
        `("No conversation found"). Starting a fresh session seeded with a ` +
        `recap so monitoring/delivery still completes.`,
    });
    const recap =
      `(Resuming work — the prior Claude Code session for this task could not ` +
      `be reloaded, so this is a fresh session. Re-establish context yourself: ` +
      `call mcp__orchestrator__runsList to find this task's run(s), then ` +
      `runState / v3RunNodes / runSummary to see where it stands, and finish ` +
      `the job.)\n\n` +
      opts.message;
    const fresh = await streamBrainChild({
      ...opts,
      message: recap,
      resumeSessionId: null,
    });
    await finalizeThreadStatus(db, opts.threadId, fresh);
    return;
  }

  await finalizeThreadStatus(db, opts.threadId, outcome);
}

/** Flip the thread to done/error based on a run outcome. */
async function finalizeThreadStatus(
  db: ReturnType<typeof getV3Db>,
  threadId: string,
  outcome: BrainRunOutcome,
): Promise<void> {
  if (outcome.exitCode !== 0 && !outcome.sawResult) {
    const msg = `claude exited ${outcome.exitCode}${
      outcome.stderr.trim()
        ? `: ${outcome.stderr.slice(0, 800)}`
        : " without a result"
    }`;
    await db
      .update(v3Schema.brainThreads)
      .set({ status: "error", error: msg, updatedAt: new Date() })
      .where(eq(v3Schema.brainThreads.id, threadId));
    return;
  }
  await db
    .update(v3Schema.brainThreads)
    .set({
      status:
        outcome.resultSubtype && outcome.resultSubtype !== "success"
          ? "error"
          : "done",
      updatedAt: new Date(),
    })
    .where(eq(v3Schema.brainThreads.id, threadId));
}

/**
 * Spawn `claude`, stream its stream-json output into the transcript, and return
 * an outcome. Captures session_id from the init event and persists it so the
 * next turn resumes the SAME session.
 */
async function streamBrainChild(opts: {
  threadId: string;
  ownerEmail: string;
  orgId: string | null;
  message: string;
  cwd: string;
  resumeSessionId: string | null;
}): Promise<BrainRunOutcome> {
  const db = getV3Db();

  // Write the .mcp.json the CC session loads (fresh bearer per turn — 24h TTL).
  // SECURITY: the config carries a live A2A bearer, so it is written to a
  // managed per-thread dir OUTSIDE the workspace cwd (keyed by threadId), NOT
  // into opts.cwd. Writing it inside the workspace let `git add -A` sweep it
  // into a commit once and leak the token to remote main — never again.
  const mcpConfigPath = writeBrainMcpConfig(opts.threadId, opts.ownerEmail);

  // VERIFIED invocation (proven against the live an-orchestrator container).
  // --allowedTools "mcp__orchestrator" + --permission-mode acceptEdits gives
  // the MCP tools with no prompts/denials. --dangerously-skip-permissions is
  // REFUSED as root, so it is NOT used.
  // A saved brain-model override threads `--model <id>` right after `-p
  // <message>` so the brain child runs as that model; unset → the CLI default.
  const brainModel = await getBrainModel();

  const argv = [
    "-p",
    opts.message,
    ...(brainModel ? ["--model", brainModel] : []),
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__orchestrator",
    "Bash",
    "Read",
    "Edit",
    "Write",
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    BRAIN_PROMPT,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (opts.resumeSessionId) {
    argv.push("--resume", opts.resumeSessionId);
  }

  // Proactively refresh the managed OAuth access token before spawning the CC
  // child. The managed access token lives only ~8h; each brain turn is a fresh
  // short-lived `claude -p` process that cannot renew a token that already
  // expired between turns, so it 403s and the operator is forced to re-login
  // "after a day". refreshManagedTokenIfNeeded() is a no-op that touches no
  // network unless the token is within the 5-minute expiry skew (single-flight),
  // so calling it on every spawn adds ~zero cost while keeping the credential
  // valid as long as the (long-lived) refresh token survives. Failure here is
  // non-fatal — the CLI still tries with the current token.
  try {
    await refreshManagedTokenIfNeeded();
  } catch {
    // Advisory; proceed with whatever credential is on disk.
  }

  const child = spawn("claude", argv, {
    cwd: opts.cwd,
    env: claudeWorkerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let capturedSessionId: string | null = opts.resumeSessionId;
  let capturedModel: string | null = null;
  // The context window persisted so far (early model-family derivation at init,
  // then refined by the authoritative result.modelUsage window). Tracked so the
  // early set never overwrites an authoritative value already captured.
  let capturedWindow: number | null = null;
  let capturedContextUsed = 0;
  let stderr = "";
  let sawResult = false;
  let resultSubtype: string | null = null;
  let resumeNotFound = false;

  // "No conversation found" is emitted on stderr AND surfaced in the result
  // event's `errors`. Detect it either way so the fresh-session fallback fires.
  const NO_CONVO_RE = /No conversation found with session ID/i;

  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (NO_CONVO_RE.test(s)) resumeNotFound = true;
  });

  // Stream stdout line-by-line. Each stream-json event becomes one or more
  // brain_events rows, appended in order.
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown> | null;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // skip non-JSON noise
    }
    if (!event || typeof event !== "object") continue;

    const type = event.type;

    if (type === "system") {
      // system/init carries the session_id — capture + persist immediately so
      // a crash mid-turn still leaves the thread resumable.
      const sid = event.session_id;
      if (typeof sid === "string" && sid && sid !== capturedSessionId) {
        capturedSessionId = sid;
        await db
          .update(v3Schema.brainThreads)
          .set({ sessionId: sid, updatedAt: new Date() })
          .where(eq(v3Schema.brainThreads.id, opts.threadId));
      }
      // system/init also carries the resolved model id (e.g.
      // claude-opus-4-8[1m]) — persist it so the usage panel shows the live
      // model and a model switch is reflected on the next turn's init.
      const initModel = event.model;
      if (
        typeof initModel === "string" &&
        initModel &&
        initModel !== capturedModel
      ) {
        capturedModel = initModel;
        // Set context_window EARLY from the model family so a running thread in
        // its first/current turn shows "used / window / %" immediately, instead
        // of "used / —" (the authoritative window only lands at turn-END from the
        // result event's modelUsage, which then refines this). Only set it when
        // not already captured so we never downgrade an authoritative value.
        const earlyWindow = deriveContextWindow(initModel);
        const set: Record<string, unknown> = {
          model: initModel,
          updatedAt: new Date(),
        };
        if (earlyWindow != null && capturedWindow == null) {
          set.contextWindow = earlyWindow;
          capturedWindow = earlyWindow;
        }
        await db
          .update(v3Schema.brainThreads)
          .set(set)
          .where(eq(v3Schema.brainThreads.id, opts.threadId));
      }
    } else if (type === "rate_limit_event") {
      // The stream emits an incremental rate-limit signal (5h window) that was
      // previously dropped. Persist the raw payload as a free incremental usage
      // signal the panel can fall back to between oauth/usage polls. Best-effort
      // — never blocks the turn.
      const payload = asRecord(event.rate_limit) ?? asRecord(event) ?? null;
      if (payload) {
        await db
          .update(v3Schema.brainThreads)
          .set({ lastUsage: { rateLimit: payload }, updatedAt: new Date() })
          .where(eq(v3Schema.brainThreads.id, opts.threadId))
          .catch(() => {});
      }
    } else if (type === "assistant") {
      // Capture the latest assistant usage = real-time context "used" tokens
      // (input + cache_read + cache_creation input tokens). Persisted so the
      // panel shows live context fill against the window.
      const usage = asRecord(asRecord(event.message)?.usage);
      if (usage) {
        const used =
          numFrom(usage.input_tokens) +
          numFrom(usage.cache_read_input_tokens) +
          numFrom(usage.cache_creation_input_tokens);
        if (used > 0) {
          capturedContextUsed = used;
          await db
            .update(v3Schema.brainThreads)
            .set({
              contextUsed: used,
              lastUsage: usage,
              updatedAt: new Date(),
            })
            .where(eq(v3Schema.brainThreads.id, opts.threadId))
            .catch(() => {});
        }
      }
      const message = asRecord(event.message);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b) continue;
          if (
            b.type === "text" &&
            typeof b.text === "string" &&
            b.text.trim()
          ) {
            await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
              type: "assistant",
              text: b.text,
            });
          } else if (b.type === "tool_use") {
            await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
              type: "tool_use",
              toolName: typeof b.name === "string" ? b.name : null,
              toolUseId: typeof b.id === "string" ? b.id : null,
              toolInput: b.input ?? null,
            });
          }
        }
      }
    } else if (type === "user") {
      // tool_result blocks come back on user events.
      const message = asRecord(event.message);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b || b.type !== "tool_result") continue;
          await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
            type: "tool_result",
            toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
            toolResult: b.content ?? null,
          });
        }
      }
    } else if (type === "result") {
      sawResult = true;
      if (typeof event.subtype === "string") resultSubtype = event.subtype;
      // result.modelUsage[<model>].contextWindow is the authoritative window for
      // the model that actually ran (read it — opus-4-8[1m] = 1000000; never
      // hardcode). Key by the captured init model when present, else the single
      // modelUsage entry. Also refresh contextUsed from the result usage so a
      // turn with no streamed assistant usage still reports a fill.
      const modelUsage = asRecord(event.modelUsage);
      if (modelUsage) {
        const keys = Object.keys(modelUsage);
        const key =
          capturedModel && modelUsage[capturedModel] != null
            ? capturedModel
            : keys[0];
        const mu = key ? asRecord(modelUsage[key]) : null;
        const window = mu ? numFrom(mu.contextWindow) : 0;
        const update: Record<string, unknown> = { updatedAt: new Date() };
        if (window > 0) {
          update.contextWindow = window;
          capturedWindow = window; // authoritative — refines the early derive
        }
        // Prefer the model key from modelUsage if the init event didn't carry it.
        if (!capturedModel && key) {
          capturedModel = key;
          update.model = key;
        }
        if (Object.keys(update).length > 1) {
          await db
            .update(v3Schema.brainThreads)
            .set(update)
            .where(eq(v3Schema.brainThreads.id, opts.threadId))
            .catch(() => {});
        }
      }
      // Quiet the unused-var lint while keeping the captured fill available for
      // future inline reporting; the DB already holds the authoritative value.
      void capturedContextUsed;
      // The CLI reports a missing resume session via the result event's
      // `errors` array (subtype error_during_execution, num_turns 0).
      if (Array.isArray(event.errors)) {
        for (const e of event.errors) {
          if (typeof e === "string" && NO_CONVO_RE.test(e))
            resumeNotFound = true;
        }
      }
      const resultText = typeof event.result === "string" ? event.result : null;
      // Suppress the empty/opaque error_during_execution result event when it is
      // really a missing-session resume that we are about to retry fresh — it
      // would otherwise clutter the transcript with a scary non-event.
      if (!(opts.resumeSessionId && resumeNotFound && !resultText)) {
        await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
          type: "result",
          text: resultText ?? `(${resultSubtype ?? "done"})`,
        });
      }
    }
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 0));
  });

  // Persist the captured session id (a fresh session writes a new one) unless
  // this was a failed resume we are about to retry — in that case keep the old
  // id untouched so a concurrent reader still sees the last good session.
  if (!(opts.resumeSessionId && resumeNotFound)) {
    await db
      .update(v3Schema.brainThreads)
      .set({ sessionId: capturedSessionId, updatedAt: new Date() })
      .where(eq(v3Schema.brainThreads.id, opts.threadId));
  }

  const failed = exitCode !== 0 && !sawResult;
  if (failed && !resumeNotFound) {
    await appendEvent(opts.threadId, opts.ownerEmail, opts.orgId, {
      type: "error",
      text: `claude exited ${exitCode}${
        stderr.trim() ? `: ${stderr.slice(0, 800)}` : " without a result"
      }`,
    });
  }

  return { resumeNotFound, resultSubtype, sawResult, exitCode, stderr };
}

interface AppendEventInput {
  type: string;
  text?: string | null;
  toolName?: string | null;
  toolUseId?: string | null;
  toolInput?: unknown;
  toolResult?: unknown;
}

/**
 * Append one event to a thread's transcript with a monotonic `seq`. The unique
 * (thread_id, seq) constraint plus a COALESCE(MAX)+1 keeps ordering stable
 * even under concurrent appends.
 */
// Postgres text AND jsonb reject the NUL byte (U+0000); strip it (deep) from
// every persisted value so no tool_result file content can crash the transcript.
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

async function appendEvent(
  threadId: string,
  ownerEmail: string,
  orgId: string | null,
  input: AppendEventInput,
): Promise<void> {
  const db = getV3Db();
  const [{ next }] = await db
    .select({
      next: sql<number>`coalesce(max(${v3Schema.brainEvents.seq}), -1) + 1`.mapWith(
        Number,
      ),
    })
    .from(v3Schema.brainEvents)
    .where(eq(v3Schema.brainEvents.threadId, threadId));

  await db.insert(v3Schema.brainEvents).values({
    id: `be_${randomUUID()}`,
    threadId,
    seq: next,
    type: input.type,
    // Strip NUL bytes: Postgres text/jsonb reject U+0000, and tool_results
    // carry raw file content that may contain one.
    text: input.text != null ? stripNul(input.text) : null,
    toolName: input.toolName ?? null,
    toolUseId: input.toolUseId ?? null,
    toolInput: input.toolInput != null ? stripNul(input.toolInput) : null,
    toolResult: input.toolResult != null ? stripNul(input.toolResult) : null,
    ownerEmail,
    orgId,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Coerce an unknown to a finite non-negative number, else 0. */
function numFrom(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
