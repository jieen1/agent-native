import { Link } from "react-router";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface WorkItemBreadcrumbProps {
  projectId: string;
  projectName: string;
  sprint?: { id: string; name: string } | null;
  itemKeyDisplay: string;
}

/**
 * "项目 › Sprint › ITEM-KEY" — matches the prototype's crumbs row
 * (docs/sdlc-product-design/prototypes/s4-work-item.html ~380-384: "支付中心
 * › Sprint 3 › PAY-203"), built from shadcn's Breadcrumb primitives instead
 * of the prototype's bare `.crumbs` CSS.
 *
 * The Sprint crumb only renders when the item is actually assigned to one —
 * an unassigned item goes straight from project to item key rather than
 * showing a fake/placeholder middle crumb.
 */
export function WorkItemBreadcrumb({
  projectId,
  projectName,
  sprint,
  itemKeyDisplay,
}: WorkItemBreadcrumbProps) {
  return (
    <Breadcrumb className="mb-2">
      <BreadcrumbList className="flex-nowrap text-xs">
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={`/board?project=${encodeURIComponent(projectId)}`}>
              {projectName}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {sprint ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={`/sprints/${encodeURIComponent(sprint.id)}`}>
                  {sprint.name}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </>
        ) : null}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="font-mono">
            {itemKeyDisplay}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
