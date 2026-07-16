// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusRing, type StatusRingStatus } from "@/components/StatusRing";

afterEach(() => {
  cleanup();
});

const ALL_STATUSES: StatusRingStatus[] = [
  "pending",
  "queued",
  "running",
  "review",
  "gate",
  "skipped",
  "rejected",
];

describe("<StatusRing>", () => {
  it.each(ALL_STATUSES)(
    "renders the %s variant with its status class",
    (status) => {
      const { container } = render(<StatusRing status={status} />);
      const ring = container.querySelector("span");
      expect(ring).toBeTruthy();
      expect(ring?.className).toContain("tk-ring");
      expect(ring?.className).toContain(`tk-ring--${status}`);
    },
  );

  it("gives each status an accessible Chinese label by default", () => {
    render(<StatusRing status="running" />);
    expect(screen.getByRole("img", { name: "进行中" })).toBeTruthy();
  });

  it("lets a caller override the accessible label", () => {
    render(<StatusRing status="running" aria-label="develop 运行中" />);
    expect(screen.getByRole("img", { name: "develop 运行中" })).toBeTruthy();
  });

  it("applies a custom size as inline width/height", () => {
    const { container } = render(<StatusRing status="running" size={11} />);
    const ring = container.querySelector("span");
    expect(ring?.style.width).toBe("11px");
    expect(ring?.style.height).toBe("11px");
  });

  it("has no inline size by default (falls back to the CSS class's 14px)", () => {
    const { container } = render(<StatusRing status="pending" />);
    const ring = container.querySelector("span");
    expect(ring?.style.width).toBe("");
  });

  it("merges an extra className alongside the status classes", () => {
    const { container } = render(
      <StatusRing status="gate" className="ml-auto" />,
    );
    const ring = container.querySelector("span");
    expect(ring?.className).toContain("ml-auto");
    expect(ring?.className).toContain("tk-ring--gate");
  });
});
