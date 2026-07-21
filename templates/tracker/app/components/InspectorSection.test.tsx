// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InspectorSection } from "@/components/InspectorSection";

afterEach(() => {
  cleanup();
});

describe("<InspectorSection> — 属性/执行/时间分组 (原型 s4-work-item.html ~540-564)", () => {
  it("renders the group label and its children", () => {
    render(
      <InspectorSection label="属性">
        <div>状态行</div>
      </InspectorSection>,
    );
    expect(screen.getByText("属性")).toBeTruthy();
    expect(screen.getByText("状态行")).toBeTruthy();
  });

  it("omits the top border on the first group but keeps it on later groups", () => {
    const { container: firstContainer } = render(
      <InspectorSection label="属性" first>
        <div>x</div>
      </InspectorSection>,
    );
    expect(firstContainer.querySelector(".border-t")).toBeNull();

    const { container } = render(
      <InspectorSection label="执行">
        <div>x</div>
      </InspectorSection>,
    );
    expect(container.querySelector(".border-t")).toBeTruthy();
  });
});
