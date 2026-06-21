/**
 * navigate — Phase A5 production gate §1.5.20 item 3: "navigate writes the
 * navigation command into application_state".
 *
 * Asserts the *structure* of what navigate writes (path/view/routineName/
 * _writeId), not any prose, and that the write targets the `navigate`
 * application-state key:
 *   - a high-level `view` maps to the canonical URL path and is recorded.
 *   - `routineName` is slugged before it is written.
 *   - a raw `path` overrides the view-derived path.
 *   - every command carries a de-dupe `_writeId`.
 *   - with neither `view` nor `path`, it throws and writes nothing.
 *
 * Only `@agent-native/core/application-state` is mocked, so the assertion is
 * about the exact app-state mutation the UI consumes. The real `_routines-lib`
 * slugifier runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  writeAppState: vi.fn(),
}));

vi.mock("@agent-native/core/application-state", () => ({
  writeAppState: appState.writeAppState,
}));

const { default: navigate } = await import("./navigate.js");

/** The (key, value) the action wrote into application state. */
function lastWrite(): [string, Record<string, unknown>] {
  const calls = appState.writeAppState.mock.calls;
  return calls[calls.length - 1] as [string, Record<string, unknown>];
}

describe("navigate writes a navigation command into application_state", () => {
  beforeEach(() => {
    appState.writeAppState.mockReset();
    appState.writeAppState.mockResolvedValue(undefined);
  });

  it("writes the `navigate` key with the view-derived path, view, and a _writeId", async () => {
    const result = await navigate.run({ view: "routines" });

    expect(appState.writeAppState).toHaveBeenCalledTimes(1);
    const [key, nav] = lastWrite();
    expect(key).toBe("navigate");
    expect(nav.path).toBe("/routines");
    expect(nav.view).toBe("routines");
    expect(typeof nav._writeId).toBe("string");
    expect((nav._writeId as string).length).toBeGreaterThan(0);

    expect(result).toMatchObject({
      navigating: true,
      path: "/routines",
      view: "routines",
    });
  });

  it("maps routine-edit + routineName to /routines/{slug} and records the slug", async () => {
    await navigate.run({ view: "routine-edit", routineName: "Morning Brief!" });

    const [key, nav] = lastWrite();
    expect(key).toBe("navigate");
    // routineName is slugged before being written into app-state.
    expect(nav.routineName).toBe("morning-brief");
    expect(nav.path).toBe("/routines/morning-brief");
    expect(nav.view).toBe("routine-edit");
  });

  it("maps the runs view to /routines/{slug}/runs", async () => {
    await navigate.run({ view: "runs", routineName: "daily-briefing" });
    const [, nav] = lastWrite();
    expect(nav.path).toBe("/routines/daily-briefing/runs");
  });

  it("a raw path overrides the view-derived path", async () => {
    await navigate.run({ path: "/routines/keys" });
    const [, nav] = lastWrite();
    expect(nav.path).toBe("/routines/keys");
    // No view supplied -> no view key in the command.
    expect(nav.view).toBeUndefined();
  });

  it("writes a unique _writeId per call (UI de-dupe)", async () => {
    await navigate.run({ view: "routines" });
    await navigate.run({ view: "routines" });
    const ids = appState.writeAppState.mock.calls.map(
      ([, nav]: [string, Record<string, unknown>]) => nav._writeId,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("throws and writes nothing when neither view nor path is given", async () => {
    await expect(navigate.run({})).rejects.toThrow(/view or .*path/i);
    expect(appState.writeAppState).not.toHaveBeenCalled();
  });
});
