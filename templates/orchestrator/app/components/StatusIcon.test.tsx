// @vitest-environment happy-dom
import { IconHandStop } from "@tabler/icons-react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusIcon, type StatusIconTone } from "@/components/StatusIcon";

afterEach(() => {
  cleanup();
});

const ALL_TONES: StatusIconTone[] = ["ok", "err", "warn", "inf", "mut"];

describe("<StatusIcon>", () => {
  it.each(ALL_TONES)(
    "renders the %s tone with its tone class and a glyph",
    (tone) => {
      const { container } = render(<StatusIcon tone={tone} />);
      const icon = container.querySelector("span");
      expect(icon?.className).toContain("orc-status-icon");
      expect(icon?.className).toContain(`orc-status-icon--${tone}`);
      expect(container.querySelector("svg")).toBeTruthy();
    },
  );

  it("defaults to md size (no extra size class)", () => {
    const { container } = render(<StatusIcon tone="ok" />);
    const icon = container.querySelector("span");
    expect(icon?.className).not.toContain("orc-status-icon--sm");
    expect(icon?.className).not.toContain("orc-status-icon--lg");
  });

  it("applies sm/lg size classes when requested", () => {
    const { container: sm } = render(<StatusIcon tone="ok" size="sm" />);
    expect(sm.querySelector("span")?.className).toContain(
      "orc-status-icon--sm",
    );

    const { container: lg } = render(<StatusIcon tone="ok" size="lg" />);
    expect(lg.querySelector("span")?.className).toContain(
      "orc-status-icon--lg",
    );
  });

  it("gives each tone an accessible Chinese label by default", () => {
    render(<StatusIcon tone="err" />);
    expect(screen.getByRole("img", { name: "失败" })).toBeTruthy();
  });

  it("lets a caller override both the glyph and the accessible label", () => {
    render(<StatusIcon tone="warn" icon={IconHandStop} aria-label="人工门" />);
    expect(screen.getByRole("img", { name: "人工门" })).toBeTruthy();
  });

  it("only adds the one-time completion animation class when explicitly requested", () => {
    const { container: plain } = render(<StatusIcon tone="ok" />);
    expect(plain.querySelector("span")?.className).not.toContain(
      "orc-status-icon--complete",
    );

    const { container: animated } = render(
      <StatusIcon tone="ok" animateComplete />,
    );
    expect(animated.querySelector("span")?.className).toContain(
      "orc-status-icon--complete",
    );
  });
});
