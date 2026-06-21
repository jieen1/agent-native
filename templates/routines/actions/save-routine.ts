/**
 * Create or update a routine. Phase A2 adds the `event` kind alongside the
 * A1 `schedule` (cron) kind.
 *
 * Hard rules enforced here:
 *  - `kind` is "schedule" (cron) or "event" (bus event).
 *    - schedule: `schedule` is a 5-field cron, validated with `isValidCron`
 *      BEFORE any write, so a bad cron never produces a file (§ acceptance).
 *      The `event`/`condition` fields are cleared.
 *    - event: `event` (the bus event name) is required; `schedule` is written
 *      as an empty string so the cron scheduler skips it (§1.5.8 — exactly one
 *      engine path runs each routine). `condition` is an optional NL gate.
 *  - serialization goes exclusively through `buildTriggerContent` with an
 *    explicit `triggerType` (§1.5.8) — never `buildJobContent`. `mode` is
 *    selectable (A4 §1.5.10): "agentic" (default) runs the full agent loop over
 *    `instructions`; "deterministic" runs a single fixed step declared in
 *    `stepDeclaration`, validated with `deterministicStepSchema` before any
 *    write and stored as a fenced ```json block in the routine body. An illegal
 *    declaration is rejected with a field-level reason and never produces a file.
 *  - the file name is slugged to `[a-z0-9-]+` (§1.5.15), decoupled from the
 *    human display name.
 *  - create vs update is explicit: `mode: "create"` refuses to overwrite an
 *    existing routine; `mode: "update"` refuses to create a missing one.
 *  - kind switching is clean (§1.5.8): switching to schedule clears
 *    `event`/`condition`; switching to event blanks `schedule`.
 *  - after any write, `refreshEventSubscriptions()` is called so event
 *    routines are (un)subscribed immediately without a restart.
 *  - owner-scope read/write provides cross-user isolation.
 *
 * Usage:
 *   pnpm action save-routine --mode=create --kind=schedule \
 *     --displayName="Morning Briefing" --schedule="30 8 * * *" \
 *     --instructions="Compile my morning briefing."
 *
 *   pnpm action save-routine --mode=create --kind=event \
 *     --displayName="On new plan" --event="plan.created" \
 *     --condition="the plan is a recap" \
 *     --instructions="Summarize the new plan and notify me."
 */

import { defineAction } from "@agent-native/core/action";
import {
  buildTriggerContent,
  deterministicStepSchema,
  parseTriggerFrontmatter,
  refreshEventSubscriptions,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";
import { isValidCron } from "@agent-native/core/jobs";
import { resourcePut } from "@agent-native/core/resources/store";
import { getRequestOrgId } from "@agent-native/core/server/request-context";
import { z } from "zod";
import {
  getOwnerRoutineResource,
  requireOwnerEmail,
  routinePath,
  slugifyRoutineName,
  toRoutineSummary,
} from "./_routines-lib.js";

export default defineAction({
  description:
    "Create or update a routine. `mode` must be 'create' (fails if the routine already exists) or 'update' (fails if it does not). `kind` is 'schedule' (cron) or 'event' (fires on a bus event). For schedule routines pass a 5-field cron `schedule` (rejected if invalid). For event routines pass the `event` name to subscribe to and an optional natural-language `condition` that gates dispatch. `displayName` is the human label (any characters); `name` is the slug file name and is auto-derived from `displayName` when omitted. `executionMode` is 'agentic' (default; runs the full agent loop over `instructions`) or 'deterministic' (runs a single fixed web-request/action step with no LLM — pass `stepDeclaration` JSON, validated before any write).",
  schema: z.object({
    mode: z
      .enum(["create", "update"])
      .describe(
        "'create' refuses to overwrite an existing routine; 'update' refuses to create a missing one.",
      ),
    kind: z
      .enum(["schedule", "event"])
      .default("schedule")
      .describe(
        "'schedule' = cron-based; 'event' = fires on a framework bus event.",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "Slug file name [a-z0-9-]. Defaults to a slug of displayName. Required for update if displayName is omitted.",
      ),
    displayName: z
      .string()
      .optional()
      .describe(
        "Human-readable name (may contain spaces / non-ASCII). Used to derive the slug name when name is omitted.",
      ),
    schedule: z
      .string()
      .optional()
      .describe(
        "5-field cron expression, e.g. '30 8 * * *'. Required for kind='schedule'; ignored for kind='event'.",
      ),
    event: z
      .string()
      .optional()
      .describe(
        "Bus event name to subscribe to, e.g. 'plan.created'. Required for kind='event'. Use list-trigger-events to discover available events.",
      ),
    sourceApp: z
      .string()
      .optional()
      .describe(
        "Emitting app id for a CROSS-APP event routine (e.g. 'plan', 'mail'), taken from the chosen event's `sourceApp` in list-trigger-events. Leave unset for a same-process event (this app's own bus). Ignored for kind='schedule'.",
      ),
    condition: z
      .string()
      .optional()
      .describe(
        "Optional natural-language condition (event routines only). When set, the event payload is evaluated against it before the routine runs.",
      ),
    instructions: z
      .string()
      .default("")
      .describe(
        "Natural-language instructions the routine runs when it fires (agentic mode). Ignored for mode='deterministic' — pass stepDeclaration instead.",
      ),
    enabled: z
      .boolean()
      .default(true)
      .describe("Whether the routine is active and eligible to run."),
    domain: z
      .string()
      .optional()
      .describe("Optional grouping tag for the routine."),
    executionMode: z
      .enum(["agentic", "deterministic"])
      .default("agentic")
      .describe(
        "Execution mode. 'agentic' (default) runs the full agent loop over `instructions`. 'deterministic' runs a single fixed action with no LLM — requires `stepDeclaration`.",
      ),
    stepDeclaration: z
      .string()
      .optional()
      .describe(
        'JSON declaration of the single deterministic step (mode=\'deterministic\' only). One object: {"kind":"web-request","method":"POST","url":"…${keys.X}…","headers"?:{…},"body"?:"…"} OR {"kind":"action","action":"<registered-action>","params":{…}}. Validated before any write; an invalid declaration is rejected and no file is produced.',
      ),
  }),
  run: async (args) => {
    const owner = requireOwnerEmail();
    const orgId = getRequestOrgId();

    // Resolve the slug file name, decoupled from the display name.
    const slugSource = args.name ?? args.displayName ?? "";
    const name = slugifyRoutineName(slugSource);
    if (!name) {
      throw new Error(
        "Could not derive a valid routine name. Provide --name or --displayName with at least one [a-z0-9] character.",
      );
    }

    // Validate kind-specific inputs BEFORE any write — a bad routine must never
    // produce a file.
    let schedule = "";
    let event: string | undefined;
    let condition: string | undefined;
    // Cross-app source app id. Only meaningful for event routines; a schedule
    // routine clears it so a kind switch (event → schedule) drops it.
    let sourceApp: string | undefined;

    if (args.kind === "schedule") {
      schedule = (args.schedule ?? "").trim();
      if (!schedule) {
        throw new Error(
          "kind='schedule' requires a --schedule cron expression, e.g. '30 8 * * *'.",
        );
      }
      if (!isValidCron(schedule)) {
        throw new Error(
          `Invalid cron expression: "${args.schedule}". Use a 5-field cron like "30 8 * * *".`,
        );
      }
    } else {
      // event kind — schedule stays "" so the cron scheduler skips it (§1.5.8).
      event = (args.event ?? "").trim();
      if (!event) {
        throw new Error(
          "kind='event' requires an --event name to subscribe to, e.g. 'plan.created'. Use list-trigger-events to discover available events.",
        );
      }
      condition = args.condition?.trim() || undefined;
      // Cross-app event: the emitting app id. Empty/unset = same-process event
      // delivered by this process's own dispatcher (no bridge poll).
      sourceApp = args.sourceApp?.trim() || undefined;
    }

    // Resolve the routine body BEFORE any write.
    //  - agentic: the natural-language instructions, used as the agent prompt.
    //  - deterministic: a fenced ```json block holding the single validated
    //    step declaration. The declaration is validated here with the SAME Zod
    //    schema the core executor parses with, so an illegal declaration is
    //    rejected and never produces a `jobs/*.md` file (§1.5.10).
    let routineBody: string;
    if (args.executionMode === "deterministic") {
      const raw = (args.stepDeclaration ?? "").trim();
      if (!raw) {
        throw new Error(
          "mode='deterministic' requires a --stepDeclaration JSON object describing the single step.",
        );
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `stepDeclaration is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const result = deterministicStepSchema.safeParse(parsedJson);
      if (!result.success) {
        // Surface field-level reasons (§1.5.10 「返回字段级原因」).
        const reasons = result.error.issues
          .map((issue) => {
            const path = issue.path.join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join("; ");
        throw new Error(`Invalid deterministic step declaration: ${reasons}`);
      }
      // Re-serialize the parsed-and-validated declaration into a fenced json
      // block (normalized, defaults applied) as the routine body.
      routineBody = `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;
    } else {
      routineBody = args.instructions;
    }

    const existing = await getOwnerRoutineResource(owner, name);
    if (args.mode === "create" && existing) {
      throw new Error(
        `A routine named "${name}" already exists. Use mode 'update' to modify it.`,
      );
    }
    if (args.mode === "update" && !existing) {
      throw new Error(
        `No routine named "${name}" to update. Use mode 'create' to create it.`,
      );
    }

    // On update, preserve engine-written run fields; on create, start fresh.
    const prior: Partial<TriggerFrontmatter> = existing
      ? parseTriggerFrontmatter(existing.content).meta
      : {};

    const meta: TriggerFrontmatter = {
      // schedule kind: the validated cron. event kind: "" (skips cron scheduler).
      schedule,
      enabled: args.enabled,
      triggerType: args.kind,
      // event kind: subscribed event + optional NL condition + optional
      // cross-app sourceApp. schedule kind: all undefined (cleared on a switch
      // from event → schedule).
      event,
      sourceApp,
      condition,
      // A4: mode is selectable. 'deterministic' runs a single fixed step with
      // no agent loop; 'agentic' runs the full loop over `instructions`.
      mode: args.executionMode,
      domain: args.domain ?? prior.domain,
      createdBy: prior.createdBy ?? owner,
      orgId: orgId ?? prior.orgId,
      runAs: prior.runAs,
      lastRun: prior.lastRun,
      lastStatus: prior.lastStatus,
      lastError: prior.lastError,
      // Drop the prior nextRun so the scheduler recomputes from the new cron
      // (schedule kind) or leaves it unset (event kind).
    };

    const content = buildTriggerContent(meta, routineBody);
    const saved = await resourcePut(owner, routinePath(name), content);

    // Subscribe/unsubscribe event routines immediately. The dispatcher rescans
    // jobs/ and reconciles bus subscriptions; safe to call for schedule writes
    // too (a no-op when no event routine changed). Never let a refresh failure
    // mask a successful save.
    try {
      await refreshEventSubscriptions();
    } catch (err) {
      console.error(
        "[save-routine] refreshEventSubscriptions failed (routine saved, subscriptions may lag until next restart):",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      created: args.mode === "create",
      routine: toRoutineSummary(
        name,
        meta,
        new Date(saved.updatedAt).toISOString(),
      ),
    };
  },
});
