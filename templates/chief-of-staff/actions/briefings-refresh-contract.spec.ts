/**
 * Phase B1 — auto-refresh contract for the briefing actions.
 *
 * docs/IMPLEMENTATION_PLAN.md §1.5.18 redefines "auto-refresh" as: a mutating
 * action's completion drives a refetch within <= 2x the poll interval, with no
 * explicit reload. The mechanism (real-time-sync skill + use-db-sync.ts) is:
 *
 *   1. The action dispatcher emits a `source:"action"` change event on success
 *      for every NON-readOnly action (read-only / GET actions are skipped).
 *   2. useDbSync (mounted once in app/root.tsx) polls /_agent-native/poll and,
 *      on an `action` event, calls queryClient.invalidateQueries() — so every
 *      useActionQuery (list-briefings / get-briefing) refetches.
 *
 * We cannot spin up the poll loop in a template unit test, so we assert the
 * *contract that drives it*: the read actions are resolved read-only (no
 * refresh event), and update-briefing is resolved mutating (event fires). The
 * actual UI refetch is owned by useDbSync, which B1 does not re-wire — it is
 * already mounted in app/root.tsx. The list/get/update round-trip that proves
 * the refetched value is correct lives in briefings-actions.spec.ts.
 */
import { describe, expect, it } from "vitest";

// These modules pull in ../server/db/index.js, which registers the shareable
// resource and constructs a getDb. Importing for the resolved-flags check does
// not open the DB (getDb is lazy), so no DB mock is needed here.
const { default: listBriefings } = await import("./list-briefings.js");
const { default: getBriefing } = await import("./get-briefing.js");
const { default: updateBriefing } = await import("./update-briefing.js");

describe("Phase B1 — auto-refresh contract", () => {
  it("list-briefings is read-only (GET) so it does NOT trigger a refresh event", () => {
    expect(listBriefings.readOnly).toBe(true);
    expect(listBriefings.http).toMatchObject({ method: "GET" });
  });

  it("get-briefing is read-only (GET) so it does NOT trigger a refresh event", () => {
    expect(getBriefing.readOnly).toBe(true);
    expect(getBriefing.http).toMatchObject({ method: "GET" });
  });

  it("update-briefing is mutating (not read-only) so it DOES trigger a refresh event", () => {
    // defineAction resolves readOnly to `undefined` for an action with no GET
    // http and no explicit readOnly — i.e. the dispatcher treats it as mutating
    // and emits the `source:"action"` change event that useDbSync turns into a
    // refetch within one poll interval.
    expect(updateBriefing.readOnly).not.toBe(true);
    expect(updateBriefing.http).toBeUndefined();
  });

  it("the three actions expose a callable run()", () => {
    expect(typeof listBriefings.run).toBe("function");
    expect(typeof getBriefing.run).toBe("function");
    expect(typeof updateBriefing.run).toBe("function");
  });
});
