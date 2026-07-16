import { IconGripVertical } from "@tabler/icons-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>) => (
  <ResizablePrimitive.Group
    className={cn(
      // react-resizable-panels sets `aria-orientation` on the rendered
      // Separator to describe the divider LINE's own orientation, which is
      // the perpendicular of the Group's `orientation` prop (a horizontal
      // Group — panels side by side — gets a *vertical* divider line, and
      // vice versa). This Group element itself never carries
      // `aria-orientation`, so this variant is inert today, but it's kept in
      // sync with that same perpendicular convention below.
      "flex h-full w-full aria-[orientation=horizontal]:flex-col",
      className,
    )}
    {...props}
  />
);

const ResizablePanel = ResizablePrimitive.Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) => (
  <ResizablePrimitive.Separator
    className={cn(
      // `aria-orientation` on the rendered Separator describes the divider
      // LINE's own orientation, which is the perpendicular of the parent
      // Group's `orientation` prop: a horizontal Group (panels side by side)
      // renders a *vertical* divider line (aria-orientation="vertical"), and
      // a vertical Group (panels stacked) renders a *horizontal* divider
      // line (aria-orientation="horizontal"). The base classes below already
      // describe the vertical-line look (narrow width, full height) for the
      // common horizontal-Group case, so the override must trigger on
      // aria-orientation="horizontal", not "vertical" — using "vertical"
      // here (the previous bug) forces every horizontal Group's divider to
      // claim 100% width, leaving both panels 0px wide.
      "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0 [&[aria-orientation=horizontal]>div]:rotate-90",
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <IconGripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </ResizablePrimitive.Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
