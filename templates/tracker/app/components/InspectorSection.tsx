import type { ReactNode } from "react";

/**
 * One grouped block of the right-column Inspector — "属性" / "执行" / "时间"
 * in WorkItemDetailPage. Matches the prototype's `.insp-sec` + `.group-label`
 * treatment (docs/sdlc-product-design/prototypes/s4-work-item.html
 * ~166-167, 540-564): a small uppercase muted-foreground label followed by a
 * top border separating it from the previous group (no border above the
 * first group).
 */
export function InspectorSection({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={first ? "pt-1" : "border-t border-border pt-3"}>
      <div className="px-3.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}
