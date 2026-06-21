/**
 * Trigger dispatcher — bridges the event bus to the automation system.
 *
 * On startup, loads all event-triggered jobs from the resources store,
 * subscribes to their events, and dispatches them (condition eval → agent
 * loop) when matching events fire.
 */

import { subscribe, unsubscribe } from "../event-bus/index.js";
import type { EventMeta } from "../event-bus/types.js";
import { resourceListAllOwners, resourcePut } from "../resources/store.js";
import { runWithRequestContext } from "../server/request-context.js";
import {
  runAgentLoop,
  actionsToEngineTools,
  getOwnerActiveApiKey,
  type ActionEntry,
} from "../agent/production-agent.js";
import {
  getStoredModelForEngine,
  normalizeModelForEngine,
  resolveEngine,
} from "../agent/engine/index.js";
import { createThread } from "../chat-threads/store.js";
import { insertRoutineRun, finishRoutineRun } from "../routine-runs/store.js";
import type { AgentChatEvent } from "../agent/types.js";
import { evaluateCondition } from "./condition-evaluator.js";
import { runDeterministicStep } from "./deterministic.js";
import type { TriggerFrontmatter } from "./types.js";

// Re-use the job frontmatter parser — triggers extend the same format.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseTriggerFrontmatter(content: string): {
  meta: TriggerFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return {
      meta: {
        schedule: "",
        enabled: false,
        triggerType: "schedule",
        mode: "agentic",
      },
      body: content,
    };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();

  const meta: TriggerFrontmatter = {
    schedule: "",
    enabled: true,
    triggerType: "schedule",
    mode: "agentic",
  };

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case "schedule":
        meta.schedule = value;
        break;
      case "enabled":
        meta.enabled = value !== "false";
        break;
      case "triggerType":
        meta.triggerType =
          value === "event" || value === "schedule" ? value : "schedule";
        break;
      case "event":
        meta.event = value;
        break;
      case "sourceApp":
        meta.sourceApp = value;
        break;
      case "condition":
        meta.condition = value;
        break;
      case "mode":
        meta.mode =
          value === "deterministic" || value === "agentic" ? value : "agentic";
        break;
      case "domain":
        meta.domain = value;
        break;
      case "createdBy":
        meta.createdBy = value;
        break;
      case "orgId":
        meta.orgId = value;
        break;
      case "runAs":
        meta.runAs =
          value === "shared" || value === "creator" ? value : undefined;
        break;
      case "lastRun":
        meta.lastRun = value;
        break;
      case "lastStatus":
        meta.lastStatus = value as TriggerFrontmatter["lastStatus"];
        break;
      case "lastError":
        meta.lastError = value;
        break;
      case "nextRun":
        meta.nextRun = value;
        break;
    }
  }

  return { meta, body };
}

export function buildTriggerContent(
  meta: TriggerFrontmatter,
  body: string,
): string {
  const lines = ["---"];
  lines.push(`schedule: "${meta.schedule}"`);
  lines.push(`enabled: ${meta.enabled}`);
  lines.push(`triggerType: ${meta.triggerType}`);
  if (meta.event) lines.push(`event: ${meta.event}`);
  if (meta.sourceApp) lines.push(`sourceApp: ${meta.sourceApp}`);
  if (meta.condition)
    lines.push(`condition: "${meta.condition.replace(/"/g, '\\"')}"`);
  lines.push(`mode: ${meta.mode}`);
  if (meta.domain) lines.push(`domain: ${meta.domain}`);
  if (meta.createdBy) lines.push(`createdBy: ${meta.createdBy}`);
  if (meta.orgId) lines.push(`orgId: ${meta.orgId}`);
  if (meta.runAs) lines.push(`runAs: ${meta.runAs}`);
  if (meta.lastRun) lines.push(`lastRun: ${meta.lastRun}`);
  if (meta.lastStatus) lines.push(`lastStatus: ${meta.lastStatus}`);
  if (meta.lastError)
    lines.push(`lastError: "${meta.lastError.replace(/"/g, '\\"')}"`);
  if (meta.nextRun) lines.push(`nextRun: ${meta.nextRun}`);
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

// ─── Dispatcher deps (same pattern as SchedulerDeps) ────────────────────────

export interface TriggerDispatcherDeps {
  getActions: () => Record<string, ActionEntry>;
  getSystemPrompt: (owner: string) => Promise<string>;
  apiKey?: string;
  model?: string;
  /** App/template id used for org-scoped per-app model defaults. */
  appId?: string;
}

// Track active subscriptions (eventName -> subscription id) to avoid
// double-subscribing AND so subscriptions for events that no longer have any
// enabled trigger can be torn down — otherwise deleted/disabled triggers leave
// phantom bus listeners that fire handleEvent forever.
const _eventSubscriptions = new Map<string, string>();
// In-flight agentic dispatches keyed by `${owner}:${path}`. Guards against the
// check-then-write TOCTOU window in handleEvent: two near-simultaneous fires of
// the same event both pass the `lastStatus !== "running"` check (which has
// several awaits before the DB is marked running) and would otherwise launch
// two concurrent agent runs for one trigger. Sufficient for single-process
// deployments; multi-instance would need a conditional DB update.
const _dispatchingTriggers = new Set<string>();
let _deps: TriggerDispatcherDeps | null = null;

/**
 * Initialize the trigger dispatcher. Call once at server startup.
 * Loads all event-triggered jobs and subscribes to their events.
 */
export async function initTriggerDispatcher(
  deps: TriggerDispatcherDeps,
): Promise<void> {
  _deps = deps;
  await refreshEventSubscriptions();
}

/**
 * Refresh event subscriptions from the resource store.
 * Call after creating/updating triggers.
 */
export async function refreshEventSubscriptions(): Promise<void> {
  try {
    const jobResources = await resourceListAllOwners("jobs/");
    const eventNames = new Set<string>();

    for (const resource of jobResources) {
      if (!resource.path.endsWith(".md")) continue;
      const { meta } = parseTriggerFrontmatter(resource.content);
      if (meta.triggerType === "event" && meta.event && meta.enabled) {
        eventNames.add(meta.event);
      }
    }

    // Tear down subscriptions whose event no longer has any enabled trigger.
    for (const [eventName, subId] of [..._eventSubscriptions]) {
      if (!eventNames.has(eventName)) {
        unsubscribe(subId);
        _eventSubscriptions.delete(eventName);
      }
    }

    for (const eventName of eventNames) {
      if (!_eventSubscriptions.has(eventName)) {
        const subId = subscribe(eventName, (payload, eventMeta) =>
          handleEvent(eventName, payload, eventMeta),
        );
        _eventSubscriptions.set(eventName, subId);
      }
    }
  } catch (err) {
    console.error("[triggers] Failed to refresh event subscriptions:", err);
  }
}

async function handleEvent(
  eventName: string,
  payload: unknown,
  eventMeta: EventMeta,
): Promise<void> {
  // Same-process events: only triggers WITHOUT a `sourceApp` (self) match here.
  // Cross-app triggers (with a `sourceApp`) are delivered by the event-bridge
  // poller via `dispatchBridgedEvent`, never by this in-process handler.
  return dispatchMatchingTriggers(eventName, payload, eventMeta, undefined);
}

/**
 * Cross-process event-bridge entry point (Phase A3 §1.5.23).
 *
 * The Routines event-bridge poller pulls a sibling app's `event_log` over HTTP
 * and, for each new event, calls this with `sourceApp` set to the emitting app
 * id. It runs the SAME matching + condition-evaluation + `dispatchAgentic`
 * path as same-process `handleEvent`, except a trigger matches only when its
 * `sourceApp` frontmatter equals the given `sourceApp`. This keeps cross-app
 * and same-process dispatch on one code path — only the entry and the
 * sourceApp filter differ.
 */
export async function dispatchBridgedEvent(
  eventName: string,
  payload: unknown,
  eventMeta: EventMeta,
  sourceApp: string,
): Promise<void> {
  return dispatchMatchingTriggers(eventName, payload, eventMeta, sourceApp);
}

/**
 * Shared dispatch core for both same-process (`sourceApp === undefined`) and
 * cross-app (`sourceApp === "<appId>"`) events. Loads matching `jobs/*.md`
 * triggers, owner-scopes them, evaluates each condition, and dispatches the
 * agentic ones with the TOCTOU in-flight guard.
 */
async function dispatchMatchingTriggers(
  eventName: string,
  payload: unknown,
  eventMeta: EventMeta,
  sourceApp: string | undefined,
): Promise<void> {
  if (!_deps) return;

  try {
    const jobResources = await resourceListAllOwners("jobs/");
    const matchingTriggers = jobResources.filter((r) => {
      if (!r.path.endsWith(".md")) return false;
      const { meta } = parseTriggerFrontmatter(r.content);
      // Scope: only dispatch triggers owned by the event's owner,
      // or shared triggers. Prevents cross-tenant trigger execution.
      if (
        eventMeta.owner &&
        r.owner !== eventMeta.owner &&
        r.owner !== "__shared__"
      ) {
        return false;
      }
      // Source match: same-process events (sourceApp undefined) require the
      // trigger to carry NO sourceApp; cross-app events require an exact match.
      const triggerSource = meta.sourceApp || undefined;
      if (triggerSource !== sourceApp) {
        return false;
      }
      return (
        meta.triggerType === "event" &&
        meta.event === eventName &&
        meta.enabled &&
        meta.lastStatus !== "running"
      );
    });

    for (const resource of matchingTriggers) {
      const { meta, body } = parseTriggerFrontmatter(resource.content);
      if (!body.trim()) continue;

      // An LLM API key is required for agentic dispatch and for evaluating a
      // natural-language condition. A deterministic trigger with NO condition
      // needs no key at all — it must dispatch even on a key-less runtime.
      const needsApiKey =
        meta.mode !== "deterministic" || Boolean(meta.condition);

      // Resolve API key for condition evaluation / agentic dispatch.
      const owner = meta.createdBy || resource.owner;
      const userApiKey = await getOwnerActiveApiKey(owner);
      const apiKey =
        userApiKey || _deps.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey && needsApiKey) {
        console.warn(
          `[triggers] No API key for trigger "${resource.path}" — skipping`,
        );
        continue;
      }

      // Evaluate condition (a no-op `true` when no condition is set — see
      // evaluateCondition). The empty-key case only reaches here for
      // deterministic + no-condition triggers, where evaluateCondition returns
      // true without touching the classifier.
      const matches = await evaluateCondition(
        meta.condition,
        payload,
        apiKey ?? "",
      );
      if (!matches) continue;

      // Dispatch. Guard against concurrent duplicate dispatch of the same
      // trigger (TOCTOU on lastStatus) with an in-process lock keyed on the
      // trigger's identity. The lock wraps BOTH modes so a deterministic
      // trigger gets the same duplicate-dispatch protection as an agentic one.
      const dispatchKey = `${resource.owner}:${resource.path}`;
      if (_dispatchingTriggers.has(dispatchKey)) continue;
      _dispatchingTriggers.add(dispatchKey);
      try {
        if (meta.mode === "deterministic") {
          await dispatchDeterministic(resource, meta, body);
        } else {
          // The agentic branch only runs when `needsApiKey` was true and we did
          // not `continue` above, so `apiKey` is guaranteed present here.
          await dispatchAgentic(
            resource,
            meta,
            body,
            payload,
            eventMeta,
            apiKey as string,
          );
        }
      } finally {
        _dispatchingTriggers.delete(dispatchKey);
      }
    }
  } catch (err) {
    console.error(`[triggers] Error handling event "${eventName}":`, err);
  }
}

/**
 * Validate that the run-as user still exists and (if scoped to an org) is
 * still a member of that org. Mirrors the recurring-jobs scheduler check
 * (audit 12 #10): event-triggered automations must stop firing when the
 * creator is removed/demoted.
 */
async function isTriggerRunAsStillValid(
  jobUserEmail: string,
  jobOrgId: string | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  if (jobUserEmail === "__shared__") return { ok: true };
  try {
    const { getDbExec } = await import("../db/client.js");
    const db = getDbExec();
    const userResult = await db.execute({
      sql: `SELECT 1 FROM "user" WHERE email = ? LIMIT 1`,
      args: [jobUserEmail],
    });
    if (!userResult.rows || userResult.rows.length === 0) {
      return { ok: false, reason: `user "${jobUserEmail}" no longer exists` };
    }
    if (jobOrgId) {
      const memberResult = await db.execute({
        sql: `SELECT 1 FROM org_members WHERE org_id = ? AND LOWER(email) = LOWER(?) LIMIT 1`,
        args: [jobOrgId, jobUserEmail],
      });
      if (!memberResult.rows || memberResult.rows.length === 0) {
        return {
          ok: false,
          reason: `user "${jobUserEmail}" is no longer a member of org "${jobOrgId}"`,
        };
      }
    }
    return { ok: true };
  } catch (err: any) {
    const msg = err?.message?.toLowerCase() ?? "";
    if (
      msg.includes("does not exist") ||
      msg.includes("no such table") ||
      msg.includes("undefined table")
    ) {
      return { ok: true };
    }
    console.warn(
      `[triggers] User/membership validation failed for "${jobUserEmail}":`,
      err?.message,
    );
    return { ok: true };
  }
}

async function dispatchAgentic(
  resource: { path: string; owner: string; content: string },
  meta: TriggerFrontmatter,
  body: string,
  payload: unknown,
  eventMeta: EventMeta,
  apiKey: string,
): Promise<void> {
  if (!_deps) return;

  const triggerName = resource.path.replace(/^jobs\//, "").replace(/\.md$/, "");
  const now = new Date();

  const jobUserEmail = meta.createdBy || resource.owner;
  const jobOrgId = meta.orgId ?? undefined;

  // SECURITY (audit 12 #10): re-validate the run-as user/membership on
  // every dispatch. Sharing revocation, user deletion, and org-member
  // removal must take effect for already-scheduled triggers. Skip the
  // dispatch on failure; leave the trigger entry alone for admin review.
  const validity = await isTriggerRunAsStillValid(jobUserEmail, jobOrgId);
  if (!validity.ok) {
    console.warn(
      `[triggers] Skipping trigger "${triggerName}": ${validity.reason}. ` +
        `User/membership no longer valid — leaving entry for admin review.`,
    );
    meta.lastRun = now.toISOString();
    meta.lastStatus = "skipped";
    meta.lastError = validity.reason;
    await resourcePut(
      resource.owner,
      resource.path,
      buildTriggerContent(meta, body),
    );
    return;
  }

  // Mark as running
  meta.lastRun = now.toISOString();
  meta.lastStatus = "running";
  meta.lastError = undefined;
  await resourcePut(
    resource.owner,
    resource.path,
    buildTriggerContent(meta, body),
  );

  // routine_runs history row id, declared outside the try so the catch branch
  // can mark it errored. Stays undefined if the run failed before the row was
  // inserted (e.g. createThread threw), in which case the finish call no-ops.
  let runRowId: string | undefined;

  await runWithRequestContext(
    { userEmail: jobUserEmail, orgId: jobOrgId },
    async () => {
      try {
        const actions = _deps!.getActions();
        const systemPrompt = await _deps!.getSystemPrompt(jobUserEmail);
        const tools = actionsToEngineTools(actions);

        const engine = await resolveEngine({
          apiKey,
          appId: _deps!.appId,
        });
        const modelCandidate =
          _deps!.model ??
          (await getStoredModelForEngine(engine, { appId: _deps!.appId })) ??
          engine.defaultModel;
        const model = normalizeModelForEngine(engine, modelCandidate);
        const thread = await createThread(jobUserEmail, {
          title: `Trigger: ${triggerName} — ${now.toLocaleDateString()}`,
        });

        // Record a `running` routine_runs history row (best-effort; never
        // throws). Terminal status is written in the success/catch branches.
        runRowId = await insertRoutineRun({
          ownerEmail: jobUserEmail,
          orgId: jobOrgId,
          routineName: triggerName,
          kind: "event",
          trigger: meta.event,
          threadId: thread.id,
          status: "running",
          startedAt: now.getTime(),
        });

        let payloadStr: string;
        try {
          payloadStr = JSON.stringify(payload, null, 2);
        } catch {
          payloadStr = String(payload);
        }

        const triggerText = `[Automation Trigger: ${triggerName}]
Event: ${meta.event}
Event ID: ${eventMeta.eventId}
Fired at: ${eventMeta.emittedAt}

Event payload:
${payloadStr}

Execute the following automation instructions:

${body}`;

        const messages = [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: triggerText }],
          },
        ];

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

        const events: AgentChatEvent[] = [];

        try {
          await runAgentLoop({
            engine,
            model,
            systemPrompt,
            tools,
            messages,
            actions,
            send: (event) => events.push(event),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        meta.lastStatus = "success";
        await resourcePut(
          resource.owner,
          resource.path,
          buildTriggerContent(meta, body),
        );

        if (runRowId) {
          await finishRoutineRun(runRowId, {
            status: "success",
            finishedAt: Date.now(),
          });
        }

        console.log(`[triggers] "${triggerName}" completed successfully`);
      } catch (err: any) {
        meta.lastStatus = "error";
        meta.lastError = err?.message?.slice(0, 200) || "Unknown error";
        await resourcePut(
          resource.owner,
          resource.path,
          buildTriggerContent(meta, body),
        );

        if (runRowId) {
          await finishRoutineRun(runRowId, {
            status: "error",
            error: meta.lastError,
            finishedAt: Date.now(),
          });
        }

        console.error(`[triggers] "${triggerName}" failed:`, err?.message);
      }
    },
  );
}

/**
 * Deterministic event-trigger dispatch (Phase A4 §1.5.10). Mirrors
 * `dispatchAgentic`'s run-as validation, `lastStatus` state machine, and
 * `routine_runs` bookkeeping, but runs a single fixed step via
 * `runDeterministicStep` instead of the agent loop — no engine/model resolution,
 * no system prompt, no LLM. The condition gate (`evaluateCondition`) ran in the
 * caller, identical to the agentic path, so deterministic event triggers honour
 * the same condition門 (§1.5.10 「两触发都支持」).
 *
 * Identity flows through `runWithRequestContext`, so the step's action /
 * web-request executes under the trigger's run-as user with no per-call context
 * threading (parity with the agentic tool path).
 */
async function dispatchDeterministic(
  resource: { path: string; owner: string; content: string },
  meta: TriggerFrontmatter,
  body: string,
): Promise<void> {
  if (!_deps) return;

  const triggerName = resource.path.replace(/^jobs\//, "").replace(/\.md$/, "");
  const now = new Date();

  const jobUserEmail = meta.createdBy || resource.owner;
  const jobOrgId = meta.orgId ?? undefined;

  // SECURITY (audit 12 #10): re-validate the run-as user/membership on every
  // dispatch, same as the agentic path.
  const validity = await isTriggerRunAsStillValid(jobUserEmail, jobOrgId);
  if (!validity.ok) {
    console.warn(
      `[triggers] Skipping deterministic trigger "${triggerName}": ${validity.reason}. ` +
        `User/membership no longer valid — leaving entry for admin review.`,
    );
    meta.lastRun = now.toISOString();
    meta.lastStatus = "skipped";
    meta.lastError = validity.reason;
    await resourcePut(
      resource.owner,
      resource.path,
      buildTriggerContent(meta, body),
    );
    return;
  }

  // Mark as running
  meta.lastRun = now.toISOString();
  meta.lastStatus = "running";
  meta.lastError = undefined;
  await resourcePut(
    resource.owner,
    resource.path,
    buildTriggerContent(meta, body),
  );

  // routine_runs history row id, declared outside the try so the catch branch
  // can mark it errored. Stays undefined if the run failed before the row was
  // inserted (e.g. createThread threw), in which case the finish call no-ops.
  let runRowId: string | undefined;

  await runWithRequestContext(
    { userEmail: jobUserEmail, orgId: jobOrgId },
    async () => {
      try {
        const actions = _deps!.getActions();
        const thread = await createThread(jobUserEmail, {
          title: `Trigger: ${triggerName} — ${now.toLocaleDateString()}`,
        });

        // Record a `running` routine_runs history row (best-effort; never
        // throws). Terminal status is written in the success/catch branches.
        runRowId = await insertRoutineRun({
          ownerEmail: jobUserEmail,
          orgId: jobOrgId,
          routineName: triggerName,
          kind: "event",
          trigger: meta.event,
          threadId: thread.id,
          status: "running",
          startedAt: now.getTime(),
        });

        // Run the single fixed step with NO agent loop / LLM.
        await runDeterministicStep(body, {
          actions,
          threadId: thread.id,
        });

        meta.lastStatus = "success";
        await resourcePut(
          resource.owner,
          resource.path,
          buildTriggerContent(meta, body),
        );

        if (runRowId) {
          await finishRoutineRun(runRowId, {
            status: "success",
            finishedAt: Date.now(),
          });
        }

        console.log(
          `[triggers] "${triggerName}" (deterministic) completed successfully`,
        );
      } catch (err: any) {
        meta.lastStatus = "error";
        meta.lastError = err?.message?.slice(0, 200) || "Unknown error";
        await resourcePut(
          resource.owner,
          resource.path,
          buildTriggerContent(meta, body),
        );

        if (runRowId) {
          await finishRoutineRun(runRowId, {
            status: "error",
            error: meta.lastError,
            finishedAt: Date.now(),
          });
        }

        console.error(
          `[triggers] "${triggerName}" (deterministic) failed:`,
          err?.message,
        );
      }
    },
  );
}
