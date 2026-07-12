import { describe, expect, it } from "vitest";

import { TRACKER_NAVIGATION_VIEWS, trackerRoutePath } from "../navigation.js";

// ============================================================================
// B3: navigation view enumeration must include sprints/sprint/queue/new-item
// so the agent can navigate to (and view-screen can recognize) those pages.
// ============================================================================

describe("TRACKER_NAVIGATION_VIEWS", () => {
  it("still contains all pre-existing views (no regression)", () => {
    for (const v of [
      "home",
      "board",
      "projects",
      "item",
      "extensions",
      "team",
    ]) {
      expect(TRACKER_NAVIGATION_VIEWS).toContain(v);
    }
  });

  it("adds the sprints list view", () => {
    expect(TRACKER_NAVIGATION_VIEWS).toContain("sprints");
  });

  it("adds the sprint detail view", () => {
    expect(TRACKER_NAVIGATION_VIEWS).toContain("sprint");
  });

  it("adds the queue view", () => {
    expect(TRACKER_NAVIGATION_VIEWS).toContain("queue");
  });

  it("adds the new-item view", () => {
    expect(TRACKER_NAVIGATION_VIEWS).toContain("new-item");
  });

  it("has no duplicate view names", () => {
    expect(new Set(TRACKER_NAVIGATION_VIEWS).size).toBe(
      TRACKER_NAVIGATION_VIEWS.length,
    );
  });
});

describe("trackerRoutePath — pre-existing views (no regression)", () => {
  it("resolves home/board to /board", () => {
    expect(trackerRoutePath({ view: "home" })).toBe("/board");
    expect(trackerRoutePath({ view: "board" })).toBe("/board");
  });

  it("resolves board with projectId to a scoped query", () => {
    expect(trackerRoutePath({ view: "board", projectId: "p1" })).toBe(
      "/board?project=p1",
    );
  });

  it("resolves projects to /projects", () => {
    expect(trackerRoutePath({ view: "projects" })).toBe("/projects");
  });

  it("resolves item with itemId to /items/:id", () => {
    expect(trackerRoutePath({ view: "item", itemId: "wi1" })).toBe(
      "/items/wi1",
    );
  });

  it("resolves item without itemId to null", () => {
    expect(trackerRoutePath({ view: "item" })).toBe(null);
  });

  it("resolves a bare itemId (no view) to /items/:id", () => {
    expect(trackerRoutePath({ itemId: "wi1" })).toBe("/items/wi1");
  });

  it("resolves extensions to /extensions", () => {
    expect(trackerRoutePath({ view: "extensions" })).toBe("/extensions");
  });

  it("resolves team to /team", () => {
    expect(trackerRoutePath({ view: "team" })).toBe("/team");
  });

  it("returns null for an unknown view", () => {
    expect(trackerRoutePath({ view: "not-a-real-view" })).toBe(null);
  });
});

describe("trackerRoutePath — sprints (list)", () => {
  it("resolves sprints to /sprints", () => {
    expect(trackerRoutePath({ view: "sprints" })).toBe("/sprints");
  });

  it("ignores itemId/projectId for the sprints list view", () => {
    expect(trackerRoutePath({ view: "sprints", projectId: "p1" })).toBe(
      "/sprints",
    );
  });
});

describe("trackerRoutePath — sprint (detail)", () => {
  it("resolves sprint with sprintId to /sprints/:sprintId", () => {
    expect(trackerRoutePath({ view: "sprint", sprintId: "s1" })).toBe(
      "/sprints/s1",
    );
  });

  it("URL-encodes the sprintId", () => {
    expect(trackerRoutePath({ view: "sprint", sprintId: "s 1/x" })).toBe(
      `/sprints/${encodeURIComponent("s 1/x")}`,
    );
  });

  it("returns null for sprint view without a sprintId", () => {
    expect(trackerRoutePath({ view: "sprint" })).toBe(null);
  });
});

describe("trackerRoutePath — queue", () => {
  it("resolves queue to /queue", () => {
    expect(trackerRoutePath({ view: "queue" })).toBe("/queue");
  });
});

describe("trackerRoutePath — new-item", () => {
  it("resolves new-item to /items/new", () => {
    expect(trackerRoutePath({ view: "new-item" })).toBe("/items/new");
  });

  it("does not require an itemId for the new-item view", () => {
    expect(trackerRoutePath({ view: "new-item", itemId: undefined })).toBe(
      "/items/new",
    );
  });
});
