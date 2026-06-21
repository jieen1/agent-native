/**
 * list-routine-templates + the preset library (Phase A5 §1.5.15).
 *
 * Asserts the static catalog the Templates page consumes:
 *  - the action returns one summary per preset, with stable ids and the trigger
 *    metadata the UI groups on (category / triggerType / schedule / event /
 *    sourceApp);
 *  - the library covers all three trigger classes (schedule, cross-app event,
 *    deterministic) — the A5 coverage requirement;
 *  - every preset's serialized content round-trips through the engine's real
 *    `buildTriggerContent` → `parseTriggerFrontmatter`, so a fork can never
 *    produce a routine the engine misreads;
 *  - the deterministic preset's body is a valid single-step declaration under
 *    the engine's own `deterministicStepSchema`, so a deterministic fork is
 *    runnable as written.
 *
 * No store/context mocks are needed — the action is owner-agnostic and pure.
 */

import { describe, expect, it } from "vitest";
import {
  buildTriggerContent,
  parseTriggerFrontmatter,
  parseDeterministicStep,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";
import { default as listRoutineTemplates } from "./list-routine-templates.js";
import { ROUTINE_PRESETS } from "./_routine-presets.js";

describe("list-routine-templates", () => {
  it("returns one summary per preset with the UI's grouping fields", async () => {
    const { templates } = await listRoutineTemplates.run({});
    expect(templates).toHaveLength(ROUTINE_PRESETS.length);

    const byId = new Map(templates.map((t) => [t.id, t]));
    // ids are unique and stable.
    expect(byId.size).toBe(templates.length);

    const briefing = byId.get("daily-briefing");
    expect(briefing?.category).toBe("schedule");
    expect(briefing?.triggerType).toBe("schedule");
    expect(briefing?.schedule).toBe("30 8 * * 1-5");

    const recap = byId.get("pr-recap-on-plan");
    expect(recap?.category).toBe("event-cross-app");
    expect(recap?.triggerType).toBe("event");
    expect(recap?.event).toBe("plan.created");
    expect(recap?.sourceApp).toBe("plan");

    const webhook = byId.get("daily-webhook-ping");
    expect(webhook?.category).toBe("deterministic");
    expect(webhook?.mode).toBe("deterministic");
  });

  it("covers all three trigger classes (A5 coverage)", async () => {
    const { templates } = await listRoutineTemplates.run({});
    const categories = new Set(templates.map((t) => t.category));
    expect(categories.has("schedule")).toBe(true);
    expect(categories.has("event-cross-app")).toBe(true);
    expect(categories.has("deterministic")).toBe(true);
  });
});

describe("routine preset library round-trips through the engine", () => {
  it("every preset serializes and parses back to its trigger fields", () => {
    for (const preset of ROUTINE_PRESETS) {
      const meta: TriggerFrontmatter = {
        schedule: preset.frontmatter.schedule ?? "",
        enabled: true,
        triggerType: preset.triggerType,
        event: preset.frontmatter.event,
        sourceApp: preset.frontmatter.sourceApp,
        condition: preset.frontmatter.condition,
        mode: preset.mode,
        domain: preset.frontmatter.domain,
        createdBy: "owner@example.com",
      };
      const content = buildTriggerContent(meta, preset.body);
      const parsed = parseTriggerFrontmatter(content);

      expect(parsed.meta.triggerType).toBe(preset.triggerType);
      expect(parsed.meta.mode).toBe(preset.mode);
      expect(parsed.meta.schedule).toBe(preset.frontmatter.schedule ?? "");
      expect(parsed.meta.event).toBe(preset.frontmatter.event);
      expect(parsed.meta.sourceApp).toBe(preset.frontmatter.sourceApp);
      expect(parsed.meta.condition).toBe(preset.frontmatter.condition);
      // Event presets must keep an empty schedule so the cron scheduler skips them.
      if (preset.triggerType === "event") {
        expect(parsed.meta.schedule).toBe("");
      }
    }
  });

  it("the deterministic preset body is a valid single-step declaration", () => {
    const det = ROUTINE_PRESETS.find((p) => p.mode === "deterministic");
    expect(det).toBeDefined();
    if (!det) return;
    const step = parseDeterministicStep(det.body);
    expect(step.kind).toBe("web-request");
    if (step.kind === "web-request") {
      expect(step.method).toBe("POST");
      expect(step.url).toContain("${keys.STATUS_WEBHOOK}");
    }
  });
});
