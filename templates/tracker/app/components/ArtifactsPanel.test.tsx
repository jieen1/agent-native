// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactsSection,
  artifactKindIcon,
  type WorkItemArtifact,
} from "@/components/ArtifactsPanel";

afterEach(() => {
  cleanup();
});

function artifact(overrides: Partial<WorkItemArtifact> = {}): WorkItemArtifact {
  return {
    id: "art_1",
    workItemId: "wi_1",
    stageId: "stage_1",
    stageName: "实施",
    kind: "复现测试证据",
    name: "复现测试证据",
    version: 1,
    contentRef: "test/calc-round.red.txt · 失败输出已捕获",
    producedByKind: "agent",
    supersedes: null,
    createdAt: "2026-07-09T09:12:00.000Z",
    updatedAt: "2026-07-09T09:12:00.000Z",
    ...overrides,
  };
}

describe("<ArtifactsSection> — 产物 (docs/sdlc-product-design/prototypes/s4-work-item.html ~464-485)", () => {
  it("shows the empty state when the work item has no artifacts yet", () => {
    render(<ArtifactsSection artifacts={[]} isLoading={false} />);
    expect(screen.getByText(/暂无产物/)).toBeTruthy();
  });

  it("shows a skeleton while loading", () => {
    render(<ArtifactsSection artifacts={[]} isLoading={true} />);
    expect(screen.getByTestId("artifacts-skeleton")).toBeTruthy();
  });

  it("renders name, agent/human badge, version chip, and the content reference inline", () => {
    render(
      <ArtifactsSection
        artifacts={[artifact()]}
        isLoading={false}
      />,
    );
    expect(screen.getByText("复现测试证据")).toBeTruthy();
    expect(screen.getByText("智能体")).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(
      screen.getByText("test/calc-round.red.txt · 失败输出已捕获"),
    ).toBeTruthy();
  });

  it("renders a 人工 badge for human-produced artifacts (not 智能体)", () => {
    render(
      <ArtifactsSection
        artifacts={[artifact({ producedByKind: "human", id: "art_2" })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText("人工")).toBeTruthy();
    expect(screen.queryByText("智能体")).toBeNull();
  });

  it("shows a superseded marker for v2+ artifacts that carry `supersedes`", () => {
    render(
      <ArtifactsSection
        artifacts={[
          artifact({
            id: "art_3",
            name: "brief:PAY-203",
            version: 2,
            supersedes: "art_1",
            contentRef: null,
          }),
        ]}
        isLoading={false}
      />,
    );
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("取代旧版本")).toBeTruthy();
  });

  it("opens a detail dialog with kind/stage/time when the eye button is clicked", () => {
    render(
      <ArtifactsSection artifacts={[artifact()]} isLoading={false} />,
    );
    fireEvent.click(screen.getByTitle("查看详情"));
    // Dialog content duplicates the name in its title — assert the
    // dialog-only fields instead of the (already-asserted) shared name.
    expect(screen.getByText("类型")).toBeTruthy();
    expect(screen.getByText("阶段")).toBeTruthy();
  });

  it("counts artifacts in the section heading", () => {
    render(
      <ArtifactsSection
        artifacts={[artifact(), artifact({ id: "art_2", name: "brief:PAY-203" })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText("产物 (2)")).toBeTruthy();
  });
});

describe("artifactKindIcon", () => {
  it("does not throw for evidence-flavored or generic kinds", () => {
    expect(artifactKindIcon("复现测试证据")).toBeTruthy();
    expect(artifactKindIcon("brief")).toBeTruthy();
  });
});
