import { AgentPanel } from "@agent-native/core/client";
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { TAB_ID } from "@/lib/tab-id";
import { cn } from "@/lib/utils";

/**
 * Right 400px session panel (s2-sprint-studio.html `.chat-rail`). Per the
 * design doc's correction, this embeds the framework's real
 * `AgentPanel` (which itself lazy-loads `MultiTabAssistantChat` and the full
 * composer stack) directly, rather than hand-assembling
 * AgentComposerFrame+PromptComposer+TiptapComposer — tracker has no prior
 * in-app usage of either to copy, so this follows the pattern from
 * templates/clips's recording page (`<AgentPanel browserTabId scope .../>`),
 * the closest real precedent in the monorepo. Scoped to the sprint+step so
 * the thread follows which step is active, matching s2's per-step "/skill"
 * header. AgentPanel manages its own real-time chat state internally — no
 * polling added here (real-time-sync skill).
 */
export function StudioChatPanel({
  sprintId,
  activeStep,
  stepLabel,
  skillCommand,
}: {
  sprintId: string;
  activeStep: number;
  stepLabel: string;
  skillCommand: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l border-border bg-muted/40 pt-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="展开会话区"
          onClick={() => setCollapsed(false)}
        >
          <IconLayoutSidebarRightExpand className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <aside
      className={cn(
        "flex w-[400px] shrink-0 flex-col overflow-hidden border-l border-border bg-muted/40",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-[10px] font-semibold text-primary">
          {activeStep}
        </span>
        <span className="truncate text-[12.5px] font-semibold">
          {skillCommand ?? stepLabel}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-6"
          title="收起会话区"
          onClick={() => setCollapsed(true)}
        >
          <IconLayoutSidebarRightCollapse className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <AgentPanel
          browserTabId={TAB_ID}
          scope={{
            type: "sprint-studio-step",
            id: `${sprintId}:${activeStep}`,
            label: `${stepLabel} · Sprint Studio`,
          }}
          showScopeBadge={false}
          emptyStateText={`向智能体询问「${stepLabel}」，或直接使用 ${skillCommand ?? "对应技能"}`}
          suggestions={
            skillCommand
              ? [skillCommand, "直接定稿", "手工导入现成文档"]
              : ["帮我推进这一步"]
          }
          allowSettingsMode={false}
          showTabBar={false}
        />
      </div>
    </aside>
  );
}
