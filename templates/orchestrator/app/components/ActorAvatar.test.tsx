// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActorAvatar, ActorAvatarStack } from "@/components/ActorAvatar";

afterEach(() => {
  cleanup();
});

describe("<ActorAvatar>", () => {
  it("renders a human avatar as a circle showing initials", () => {
    const { container } = render(<ActorAvatar kind="human" initials="SJ" />);
    const el = container.querySelector("span");
    expect(el?.className).toContain("orc-avatar");
    expect(el?.className).not.toContain("orc-avatar--agent");
    expect(el?.className).not.toContain("orc-avatar--brain");
    expect(el?.textContent).toBe("SJ");
  });

  it("renders an agent avatar as a rounded square with a robot glyph", () => {
    const { container } = render(<ActorAvatar kind="agent" />);
    const el = container.querySelector("span");
    expect(el?.className).toContain("orc-avatar--agent");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders a brain avatar as a rounded square with a brain glyph", () => {
    const { container } = render(<ActorAvatar kind="brain" />);
    const el = container.querySelector("span");
    expect(el?.className).toContain("orc-avatar--brain");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("shows the breathing presence dot only when live", () => {
    const { container: idle } = render(<ActorAvatar kind="agent" />);
    expect(idle.querySelector(".orc-avatar-presence")).toBeNull();

    const { container: running } = render(<ActorAvatar kind="agent" live />);
    expect(running.querySelector(".orc-avatar-presence")).toBeTruthy();
  });

  it("gives each kind an accessible name, defaulting to initials for humans", () => {
    render(<ActorAvatar kind="human" initials="LW" />);
    expect(screen.getByRole("img", { name: "LW" })).toBeTruthy();
  });

  it("falls back to a generic human label when no initials are given", () => {
    render(<ActorAvatar kind="human" />);
    expect(screen.getByRole("img", { name: "人" })).toBeTruthy();
  });

  it("applies a custom size to both the box and the glyph", () => {
    const { container } = render(<ActorAvatar kind="agent" size={16} />);
    const el = container.querySelector("span");
    expect(el?.style.width).toBe("16px");
    expect(el?.style.height).toBe("16px");
  });
});

describe("<ActorAvatarStack>", () => {
  const avatars = [
    { key: "a", kind: "human" as const, initials: "SJ" },
    { key: "b", kind: "agent" as const },
    { key: "c", kind: "brain" as const },
    { key: "d", kind: "human" as const, initials: "LW" },
    { key: "e", kind: "human" as const, initials: "TK" },
  ];

  it("shows at most `max` avatars and collapses the rest into a +N tile", () => {
    const { container } = render(
      <ActorAvatarStack avatars={avatars} max={3} />,
    );
    const items = container.querySelectorAll(".orc-avatar");
    // 3 shown + 1 overflow tile.
    expect(items.length).toBe(4);
    expect(container.textContent).toContain("+2");
  });

  it("renders no overflow tile when everything fits", () => {
    const { container } = render(
      <ActorAvatarStack avatars={avatars.slice(0, 2)} max={3} />,
    );
    expect(container.textContent).not.toContain("+");
    expect(container.querySelectorAll(".orc-avatar").length).toBe(2);
  });
});
