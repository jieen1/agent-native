// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PriorityBars } from "@/components/PriorityBars";

afterEach(() => {
  cleanup();
});

describe("<PriorityBars>", () => {
  it.each([
    [1, "tk-pbars--p0", "P0 紧急"],
    [2, "tk-pbars--p1", "P1 高"],
    [3, "tk-pbars--p2", "P2 中"],
    [4, "tk-pbars--p3", "P3 低"],
  ] as const)(
    "priority=%i renders %s with the %s label",
    (priority, cls, label) => {
      const { container } = render(<PriorityBars priority={priority} />);
      const el = container.querySelector("span");
      expect(el?.className).toContain("tk-pbars");
      expect(el?.className).toContain(cls);
      expect(screen.getByRole("img", { name: label })).toBeTruthy();
    },
  );

  it("always renders exactly 4 bar segments", () => {
    const { container } = render(<PriorityBars priority={1} />);
    expect(container.querySelectorAll("span span").length).toBe(4);
  });

  it("falls back to P3 for an out-of-range priority instead of throwing", () => {
    const { container } = render(<PriorityBars priority={99} />);
    const el = container.querySelector("span");
    expect(el?.className).toContain("tk-pbars--p3");
  });

  it("lets a caller override the accessible label", () => {
    render(<PriorityBars priority={1} aria-label="紧急，尽快处理" />);
    expect(screen.getByRole("img", { name: "紧急，尽快处理" })).toBeTruthy();
  });
});
