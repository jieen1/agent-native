import { IconGitCompare, IconInfoCircle, IconRobot } from "@tabler/icons-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  fmtShortDate,
  isSystemOwner,
  ownerInitial,
  type WorkflowVersionRow,
} from "./workflow-library-types";

export interface WorkflowVersionChainProps {
  name: string;
  versions: WorkflowVersionRow[];
  isLoading: boolean;
  onOpenDiff: () => void;
}

/**
 * The workflow library's detail strip — version chain + per-version stats +
 * the current version's change note (04 §4 "版本链：每版 DAG 预览 diff + 保存者
 * + 时间 + 该版 run 统计"). The visual DAG-diff-per-version thumbnail from the
 * design doc is out of scope here (see WorkflowDiffDialog for the structural
 * add/remove/change diff between any two picked versions); this chain shows
 * WHICH versions exist, who saved them, and when.
 */
export function WorkflowVersionChain({
  name,
  versions,
  isLoading,
  onOpenDiff,
}: WorkflowVersionChainProps) {
  const current = versions[0];

  return (
    <div className="min-w-0 flex-[2]">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          版本链
        </span>
        <span className="truncate font-mono text-[13px] font-semibold">
          {name}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1.5 text-xs"
          disabled={versions.length < 2}
          onClick={onOpenDiff}
        >
          <IconGitCompare className="size-3.5" />
          对比任意两版
        </Button>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">加载版本历史…</div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {versions.map((v, i) => {
              const isCurrent = i === 0;
              const system = isSystemOwner(v.ownerEmail);
              return (
                <div
                  key={v.id}
                  className={cn(
                    "flex min-w-[148px] flex-col gap-1 rounded-md border bg-background p-2",
                    isCurrent && "border-primary ring-1 ring-primary",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                    <Badge
                      variant={isCurrent ? "outline" : "secondary"}
                      className={cn(
                        "font-mono text-[10.5px]",
                        isCurrent &&
                          "border-primary/40 bg-primary/5 text-primary",
                      )}
                    >
                      v{v.version}
                    </Badge>
                    {isCurrent ? <span>当前</span> : null}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Avatar className="size-4">
                      <AvatarFallback
                        className={cn(
                          "text-[8px]",
                          system
                            ? "rounded-[5px] bg-agent/15 text-agent"
                            : "bg-brand text-brand-foreground",
                        )}
                      >
                        {system ? (
                          <IconRobot className="size-2.5" />
                        ) : (
                          ownerInitial(v.ownerEmail)
                        )}
                      </AvatarFallback>
                    </Avatar>
                    <span>
                      {system ? "系统/Brain" : v.ownerEmail.split("@")[0]}
                    </span>
                    <span>·</span>
                    <span>{fmtShortDate(v.createdAt)}</span>
                  </div>
                  <div className="font-mono text-[10.5px] text-muted-foreground">
                    run {v.stats.runCount} · 成功率{" "}
                    {v.stats.successRate === null
                      ? "—"
                      : `${v.stats.successRate}%`}
                  </div>
                </div>
              );
            })}
          </div>

          {current?.meta.changeNote ? (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <IconInfoCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                v{current.version} 变更：{current.meta.changeNote}
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
