// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SprintPhaseStepper } from "@/components/SprintPhaseStepper";

afterEach(() => {
  cleanup();
});

describe("<SprintPhaseStepper> — 八相位驾驶舱头部 (原型 s6-sprint-cockpit.html ~356-374)", () => {
  it("renders all eight phases in order", () => {
    render(<SprintPhaseStepper phase="executing" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]!.textContent).toContain("planning");
    expect(items[4]!.textContent).toContain("目标审计");
    expect(items[7]!.textContent).toContain("done");
  });

  it("marks phases before the current one done and the current one active", () => {
    const { container } = render(<SprintPhaseStepper phase="executing" />);
    const items = screen.getAllByRole("listitem");
    // planning + designing are done (StatusIcon renders an svg glyph, not a ring)
    expect(items[0]!.querySelector("svg")).toBeTruthy();
    expect(items[1]!.querySelector("svg")).toBeTruthy();
    // executing itself is active — no checkmark glyph
    expect(items[2]!.querySelector("svg")).toBeNull();
    expect(items[2]!.textContent).toContain("executing");
    // verifying onward are pending
    expect(items[3]!.querySelector("svg")).toBeNull();
    void container;
  });

  it("falls back to all-pending for an unrecognized phase value instead of guessing a position", () => {
    render(<SprintPhaseStepper phase="some-legacy-value" />);
    const items = screen.getAllByRole("listitem");
    for (const item of items) {
      expect(item.querySelector("svg")).toBeNull();
    }
  });

  it("marks done when the sprint is already at the final phase", () => {
    render(<SprintPhaseStepper phase="done" />);
    const items = screen.getAllByRole("listitem");
    // First 7 phases are done (checkmark glyph); "done" itself is active (ring).
    for (let i = 0; i < 7; i++) {
      expect(items[i]!.querySelector("svg")).toBeTruthy();
    }
    expect(items[7]!.querySelector("svg")).toBeNull();
  });
});
