/**
 * Frontmatter round-trip — the §1.5.8 correctness basis.
 *
 * Phase A1 writes every routine through `buildTriggerContent` with an explicit
 * `triggerType: "schedule"` (never `buildJobContent`). Two properties must hold:
 *
 *  1. `parseTriggerFrontmatter(buildTriggerContent(meta, body))` recovers the
 *     same fields the routine actions care about (round-trip equivalence).
 *  2. The engine's own `parseJobFrontmatter` — which the scheduler uses on tick
 *     and which has NO `triggerType` case — still recovers `schedule`/`enabled`
 *     from a `buildTriggerContent` file while silently ignoring the
 *     `triggerType`/`mode` lines. This is why a schedule-kind file written by
 *     `buildTriggerContent` is picked up and run by the scheduler unchanged.
 *
 * These use the real core functions (no mocks): the test is the contract.
 */

import { describe, expect, it } from "vitest";
import {
  buildTriggerContent,
  parseTriggerFrontmatter,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";
import { parseJobFrontmatter } from "@agent-native/core/jobs";

const scheduleMeta: TriggerFrontmatter = {
  schedule: "30 8 * * *",
  enabled: true,
  triggerType: "schedule",
  mode: "agentic",
};

describe("frontmatter round-trip (buildTriggerContent <-> parseTriggerFrontmatter)", () => {
  it("recovers schedule/enabled/triggerType/mode and the body verbatim", () => {
    const body = "Compile my morning briefing and email it to me.";
    const { meta, body: parsedBody } = parseTriggerFrontmatter(
      buildTriggerContent(scheduleMeta, body),
    );

    expect(meta.schedule).toBe("30 8 * * *");
    expect(meta.enabled).toBe(true);
    expect(meta.triggerType).toBe("schedule");
    expect(meta.mode).toBe("agentic");
    expect(parsedBody).toBe(body);
  });

  it("round-trips enabled:false and optional fields (domain/createdBy)", () => {
    const meta: TriggerFrontmatter = {
      ...scheduleMeta,
      enabled: false,
      domain: "ops",
      createdBy: "alice@example.com",
    };
    const { meta: out } = parseTriggerFrontmatter(
      buildTriggerContent(meta, "body"),
    );

    expect(out.enabled).toBe(false);
    expect(out.domain).toBe("ops");
    expect(out.createdBy).toBe("alice@example.com");
    // triggerType is preserved across the round trip even with extras present.
    expect(out.triggerType).toBe("schedule");
  });

  it("preserves engine-written run fields (lastRun/lastStatus/nextRun)", () => {
    const meta: TriggerFrontmatter = {
      ...scheduleMeta,
      lastRun: "2026-06-20T08:30:00.000Z",
      lastStatus: "error",
      lastError: "plain failure message",
      nextRun: "2026-06-21T08:30:00.000Z",
    };
    const { meta: out } = parseTriggerFrontmatter(
      buildTriggerContent(meta, "body"),
    );

    expect(out.lastRun).toBe("2026-06-20T08:30:00.000Z");
    expect(out.lastStatus).toBe("error");
    expect(out.lastError).toBe("plain failure message");
    expect(out.nextRun).toBe("2026-06-21T08:30:00.000Z");
  });

  it("documents the triggers-parser quirk: inner quotes in lastError are NOT un-escaped", () => {
    // buildTriggerContent escapes `"` -> `\"`; parseTriggerFrontmatter only
    // strips the SURROUNDING quotes and does not reverse the inner escaping
    // (unlike the scheduler's parseJobFrontmatter, which does). A1 never writes
    // lastError itself (the engine does), so this is a documented edge, not a
    // routine-action concern — pinned here so a future parser change is noticed.
    const meta: TriggerFrontmatter = {
      ...scheduleMeta,
      lastStatus: "error",
      lastError: 'boom "quoted" failure',
    };
    const { meta: out } = parseTriggerFrontmatter(
      buildTriggerContent(meta, "body"),
    );
    expect(out.lastError).toBe('boom \\"quoted\\" failure');
  });

  it("is idempotent: build -> parse -> build -> parse yields the same meta", () => {
    const first = parseTriggerFrontmatter(
      buildTriggerContent(scheduleMeta, "body"),
    );
    const second = parseTriggerFrontmatter(
      buildTriggerContent(first.meta, first.body),
    );
    expect(second.meta).toEqual(first.meta);
    expect(second.body).toBe(first.body);
  });
});

describe("scheduler reads buildTriggerContent files (§1.5.8 — no double execution)", () => {
  it("parseJobFrontmatter recovers schedule/enabled and ignores triggerType/mode", () => {
    const content = buildTriggerContent(scheduleMeta, "Do the thing.");

    // The scheduler's parser sees no `triggerType`/`mode` case, so those lines
    // are skipped — but schedule/enabled (all it needs to tick) are intact.
    const { meta } = parseJobFrontmatter(content);

    expect(meta.schedule).toBe("30 8 * * *");
    expect(meta.enabled).toBe(true);
    // JobFrontmatter has no triggerType field at all.
    expect((meta as Record<string, unknown>).triggerType).toBeUndefined();
  });

  it("a disabled schedule-kind file parses as enabled:false for the scheduler", () => {
    const content = buildTriggerContent(
      { ...scheduleMeta, enabled: false },
      "Do the thing.",
    );
    const { meta } = parseJobFrontmatter(content);
    expect(meta.enabled).toBe(false);
  });
});
