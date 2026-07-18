import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  loadDeployConfig,
  runDeployJob,
  type DeployApp,
} from "../server/deploy/deploy-runner.js";
import { newId, nowIso } from "./_util.js";

const DEPLOY_APPS = ["orchestrator", "tracker"] as const;
const ACTIVE_STATUSES = ["queued", "running"] as const;

// Callers allowed to actually execute a real deploy. Mirrors the
// tracker's `assertWritebackCaller` shape (server/lib/writeback-actor.ts):
// a positive allow-list, checked FIRST, before any read/write.
//
//  - "frontend": a real browser call via useActionMutation (DeployTab.tsx's
//    AlertDialog confirm) — tagged from the X-Agent-Native-Frontend header
//    by action-routes.ts. This is the human-clicked-the-button path.
//  - "tool": the in-app agent loop / sub-agents / agent-teams. Already
//    safely gated by `needsApproval: true` below BEFORE production-agent.ts
//    ever calls run() — a human approves/denies in chat first, so letting
//    this caller back in here does not reopen that hole.
//
// Everything else — "mcp" (build-server.ts's MCP tools/call handler, which
// calls entry.run() directly with no approval check at all), "http" (a bare
// programmatic POST to /_agent-native/actions/trigger-deploy with no
// frontend tag), "cli", "a2a" — is rejected. This is the confirmed gap: MCP
// and direct-HTTP calls reach run() with zero human confirmation of any
// kind, since needsApproval only intercepts the "tool" surface.
//
// Documented residual gap (not silently assumed away): `ctx.caller ===
// "frontend"` is derived from a request header action-routes.ts's own doc
// comment calls "no auth weight" — it only narrows the caller TAG, it is not
// a signed proof of a live human click. A caller that already holds a valid
// credential accepted by the action route's own auth chain (a session
// cookie, or an A2A bearer some deployment configured) could in theory
// replay that header directly against the REST route without a real human
// present. Closing that fully needs a core-level signed proof-of-interaction
// (out of scope here — a framework-wide change, not an in-action one) or a
// single-use approval token minted by a separate call; this check closes the
// two CONFIRMED gaps (MCP tools/call, bare direct-HTTP dispatch) using the
// same real, non-spoofable-for-those-two-surfaces signal the tracker already
// relies on for its own writeback-actor guard.
const ALLOWED_TRIGGER_CALLERS: ReadonlySet<string> = new Set([
  "frontend",
  "tool",
]);

function assertHumanTriggeredDeploy(caller: string | undefined): void {
  if (caller && ALLOWED_TRIGGER_CALLERS.has(caller)) return;
  throw new Error(
    `trigger-deploy can only run from the Settings → Deploy button (a live human session) or the orchestrator brain's own approval-gated tool call — rejected caller: '${caller ?? "unknown"}'. Ask a human to trigger this from Settings instead.`,
  );
}

function isUniqueConstraintViolation(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string } | null;
  if (!e) return false;
  const code = String(e.code ?? "");
  if (code === "23505") return true; // Postgres unique_violation
  if (code.startsWith("SQLITE_CONSTRAINT")) return true; // SQLite/libSQL
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("unique constraint") || msg.includes("duplicate key");
}

// Real "ship it" deploy trigger — backup -> build -> restart -> health-check
// (-> rollback on failure) against the configured host target (see
// server/deploy/deploy-runner.ts, server/plugins/deploy-secrets.ts).
//
// needsApproval:true gates the ORCHESTRATOR BRAIN's own ability to call this
// autonomously from chat — per packages/core's production-agent.ts, the gate
// only intercepts the in-app agent's tool-call loop; it does NOT pause a
// direct frontend `useActionMutation` call (a human clicking the Settings ->
// Deploy button already IS the human consent this whole mechanism exists to
// require, so nothing else needs to pause there — see the settings UI's own
// AlertDialog confirmation for that path instead). `assertHumanTriggeredDeploy`
// below is the redundant, in-action backstop for the surfaces needsApproval
// does NOT cover — direct MCP tools/call and bare HTTP dispatch (see
// action-routes.ts / build-server.ts, which both call entry.run() directly).
export default defineAction({
  description:
    "Trigger a real deploy: backup -> build -> restart -> health-check (-> rollback on failure) against the configured deploy host. Runs as a detached background job; returns immediately with a deployRunId to poll via deployStatus. Fails closed with a clear error if DEPLOY_* secrets are not configured in Settings.",
  schema: z.object({
    apps: z
      .array(z.enum(DEPLOY_APPS))
      .min(1)
      .default(["orchestrator", "tracker"]),
    target: z.literal("101").default("101"),
  }),
  needsApproval: true,
  run: async (args, ctx) => {
    assertHumanTriggeredDeploy(ctx?.caller);

    const db = getDb();

    const active = await db
      .select({ id: schema.deployRuns.id, target: schema.deployRuns.target })
      .from(schema.deployRuns)
      .where(
        and(
          eq(schema.deployRuns.target, args.target),
          inArray(schema.deployRuns.status, ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      throw new Error(
        `A deploy to '${args.target}' is already in progress (run ${active[0]!.id}).`,
      );
    }

    // Resolve secrets HERE, inside the live request context — the background
    // job below never calls resolveSecret itself (see loadDeployConfig doc).
    const cfg = await loadDeployConfig();

    const now = nowIso();
    const runId = newId("deploy");
    const triggeredBy = getRequestUserEmail() ?? null;
    try {
      await db.insert(schema.deployRuns).values({
        id: runId,
        target: args.target,
        apps: JSON.stringify(args.apps),
        status: "queued",
        stage: "queued",
        stageLog: "[]",
        createdAt: now,
        updatedAt: now,
        triggeredBy,
      });
    } catch (err) {
      // TOCTOU backstop: the `active` check above and this INSERT are not
      // atomic — two concurrent triggers can both pass the check. The DB's
      // own partial UNIQUE index (orchestrator_deploy_runs_active_target_idx,
      // server/plugins/db.ts v24) allows at most one queued/running row per
      // target, so the loser of the race hits a real constraint violation
      // here instead of silently starting a second deploy.
      if (isUniqueConstraintViolation(err)) {
        throw new Error(`A deploy to '${args.target}' is already in progress.`);
      }
      throw err;
    }

    void runDeployJob(runId, cfg, args.apps as DeployApp[]).catch(() => {
      // runDeployJob already records failure into the row itself; this catch
      // only guards against an unexpected throw escaping the detached
      // promise (which would otherwise surface as an unhandled rejection).
    });

    return { deployRunId: runId, status: "queued" as const };
  },
});
