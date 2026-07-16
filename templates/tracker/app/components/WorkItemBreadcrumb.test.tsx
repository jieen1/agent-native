// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { WorkItemBreadcrumb } from "@/components/WorkItemBreadcrumb";

afterEach(() => {
  cleanup();
});

function renderCrumb(props: Parameters<typeof WorkItemBreadcrumb>[0]) {
  return render(
    <MemoryRouter>
      <WorkItemBreadcrumb {...props} />
    </MemoryRouter>,
  );
}

describe("<WorkItemBreadcrumb> — 项目 › Sprint › ITEM-KEY (原型 s4-work-item.html ~380-384)", () => {
  it("renders project › sprint › item key, in order, when the item has a sprint", () => {
    renderCrumb({
      projectId: "proj_1",
      projectName: "支付中心",
      sprint: { id: "sprint_3", name: "Sprint 3" },
      itemKeyDisplay: "PAY-203",
    });
    expect(screen.getByText("支付中心")).toBeTruthy();
    expect(screen.getByText("Sprint 3")).toBeTruthy();
    expect(screen.getByText("PAY-203")).toBeTruthy();
  });

  it("links the project crumb to the board filtered by project", () => {
    renderCrumb({
      projectId: "proj_1",
      projectName: "支付中心",
      sprint: null,
      itemKeyDisplay: "PAY-203",
    });
    const link = screen.getByText("支付中心").closest("a");
    expect(link?.getAttribute("href")).toBe("/board?project=proj_1");
  });

  it("links the sprint crumb to the sprint detail page", () => {
    renderCrumb({
      projectId: "proj_1",
      projectName: "支付中心",
      sprint: { id: "sprint_3", name: "Sprint 3" },
      itemKeyDisplay: "PAY-203",
    });
    const link = screen.getByText("Sprint 3").closest("a");
    expect(link?.getAttribute("href")).toBe("/sprints/sprint_3");
  });

  it("skips the sprint crumb (no fake middle crumb) when the item has no sprint", () => {
    renderCrumb({
      projectId: "proj_1",
      projectName: "支付中心",
      sprint: null,
      itemKeyDisplay: "PAY-203",
    });
    // Only two crumbs: project and item key.
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  it("renders the item key as the current (non-link) page crumb", () => {
    renderCrumb({
      projectId: "proj_1",
      projectName: "支付中心",
      sprint: null,
      itemKeyDisplay: "PAY-203",
    });
    const page = screen.getByText("PAY-203");
    expect(page.getAttribute("aria-current")).toBe("page");
  });
});
