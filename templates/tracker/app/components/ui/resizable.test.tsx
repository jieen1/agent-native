// @vitest-environment happy-dom
//
// Regression test for a real production bug on /tracker/inbox: the left
// group list and the right detail panel both rendered as blank white space
// while the header/sidebar badges correctly showed a non-zero count (e.g.
// "6 项待处理"). Verified live against 192.168.1.101 with a real signed-in
// browser session — the `list-inbox` action returned correct, non-empty
// data, but both <ResizablePanel>s in InboxPage's <ResizablePanelGroup
// orientation="horizontal"> measured 0px wide.
//
// Root cause: react-resizable-panels sets `aria-orientation` on the
// rendered <Separator> to describe the divider LINE's own orientation,
// which is the *perpendicular* of the parent Group's `orientation` prop —
// a horizontal Group (panels side by side) renders a *vertical* divider
// line, i.e. `aria-orientation="vertical"`. This component's Tailwind
// classes had that backwards: the `aria-[orientation=vertical]:w-full`
// override fired for exactly the common horizontal-Group case, forcing the
// separator to claim 100% of the flex row's main axis and leaving both
// Panels 0px wide.
//
// jsdom/happy-dom never run a real layout/CSS engine, so this test can't
// measure actual pixel widths (a real browser was required to see the bug
// in the first place — see the task's verification notes). What it CAN do,
// and what a plain unit test on `cn(...)` output would not have caught, is
// render the REAL react-resizable-panels library and assert our CSS variant
// selectors are keyed to the aria-orientation value the library *actually*
// assigns for each Group orientation — the exact mismatch that broke us.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

afterEach(() => {
  cleanup();
});

describe("<ResizableHandle> — aria-orientation ↔ Tailwind variant alignment", () => {
  it("a horizontal Group's real separator gets aria-orientation=vertical, and our CSS does NOT force it to 100% width", () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="26%">left</ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="74%">right</ResizablePanel>
      </ResizablePanelGroup>,
    );

    const separator = container.querySelector('[role="separator"]');
    expect(separator).toBeTruthy();

    // Pin down react-resizable-panels' actual (perpendicular) convention —
    // if a future library upgrade changes this, this assertion fails loudly
    // instead of silently reintroducing the bug.
    expect(separator!.getAttribute("aria-orientation")).toBe("vertical");

    const className = separator!.className;
    // The bug: keying the "claim full width" override to the SAME value the
    // library assigns for a horizontal Group.
    expect(className).not.toContain("aria-[orientation=vertical]:w-full");
    expect(className).not.toContain("aria-[orientation=vertical]:h-px");
    // The fix: the override must key off the opposite (perpendicular) value.
    expect(className).toContain("aria-[orientation=horizontal]:w-full");
    expect(className).toContain("aria-[orientation=horizontal]:h-px");
    // Base (unconditional) styling must still describe a narrow vertical
    // divider line, which is what a real browser renders when no
    // aria-orientation variant matches.
    expect(className).toContain("w-px");
  });

  it("a vertical (stacked) Group's real separator gets aria-orientation=horizontal, and gets the full-width horizontal-bar override", () => {
    const { container } = render(
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="50%">top</ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="50%">bottom</ResizablePanel>
      </ResizablePanelGroup>,
    );

    const separator = container.querySelector('[role="separator"]');
    expect(separator).toBeTruthy();
    expect(separator!.getAttribute("aria-orientation")).toBe("horizontal");

    const className = separator!.className;
    expect(className).toContain("aria-[orientation=horizontal]:w-full");
    expect(className).toContain("aria-[orientation=horizontal]:h-px");
  });
});
