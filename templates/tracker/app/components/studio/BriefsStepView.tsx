import { parseBriefsIndex } from "@shared/briefs-index-parse";
import type { SprintArtifact, TrackerWorkItem } from "@shared/types";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconRefresh,
  IconScissors,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useExtractBriefs } from "@/hooks/use-tracker";
import { cn } from "@/lib/utils";

function scaleEstimateOf(item: TrackerWorkItem | undefined) {
  if (!item?.scaleEstimate) return null;
  try {
    return JSON.parse(item.scaleEstimate) as {
      files: number;
      verdict: "ok" | "split-required";
    };
  } catch {
    return null;
  }
}

/**
 * Step ⑦ Briefs — extract-briefs is a deterministic action, not an interview
 * skill (s2b-studio-briefs.html). Reads the persisted `briefs-index` +
 * `brief:{itemKey}` artifacts (via list-sprint-artifacts, already fetched by
 * the page) for the default view; "重新提取"/"强制提取" call extract-briefs
 * directly — idempotent, so this is safe to click freely.
 */
export function BriefsStepView({
  sprintId,
  briefsIndexArtifact,
  briefArtifacts,
  workItemsByKey,
}: {
  sprintId: string;
  briefsIndexArtifact: SprintArtifact | undefined;
  briefArtifacts: SprintArtifact[];
  workItemsByKey: Map<string, TrackerWorkItem>;
}) {
  const [forceNotice, setForceNotice] = useState<string | null>(null);
  const extractBriefs = useExtractBriefs();
  const parsed = useMemo(
    () =>
      briefsIndexArtifact
        ? parseBriefsIndex(briefsIndexArtifact.content)
        : null,
    [briefsIndexArtifact],
  );

  function runExtract(force: boolean) {
    setForceNotice(null);
    extractBriefs.mutate(
      { sprintId, force },
      {
        onError: (err: any) => {
          const message = String(err?.message ?? "");
          if (
            err?.code === "design-signoff-required" ||
            /design-signoff/.test(message)
          ) {
            setForceNotice(message || "design-signoff 未批准");
            return;
          }
          // Any other failure (missing tech-design, dependency cycle,
          // unparseable §4, ...) has no dedicated inline UI — without this it
          // fails completely silently, indistinguishable from "still idle".
          toast.error(
            message.replace(/^Action extract-briefs failed:\s*/, "") ||
              "briefs 提取失败，请重试",
          );
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3.5">
        <div className="text-sm">
          <span className="font-semibold">Briefs · 提取结果</span>
          {briefsIndexArtifact ? (
            <span className="ml-2 text-xs text-muted-foreground">
              docKey <span className="font-mono">briefs-index</span> · v
              {briefsIndexArtifact.version}
            </span>
          ) : (
            <span className="ml-2 text-xs text-muted-foreground">尚未提取</span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={extractBriefs.isPending}
          onClick={() => runExtract(false)}
        >
          <IconRefresh className="size-3.5" />
          重新提取
        </Button>
      </div>

      {forceNotice ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <IconAlertTriangle className="size-4 shrink-0 text-warning" />
          <span className="flex-1">{forceNotice}</span>
          <Button size="sm" variant="outline" onClick={() => runExtract(true)}>
            仍然强制提取
          </Button>
        </div>
      ) : null}

      {parsed ? (
        <>
          <div className="grid grid-cols-5 gap-2.5">
            <Stat
              label="briefs 已生成"
              value={parsed.briefCount ?? briefArtifacts.length}
            />
            <Stat
              label="缺失项"
              value={parsed.missingItems.length}
              tone={parsed.missingItems.length > 0 ? "warn" : undefined}
            />
            <Stat label="依赖边" value={parsed.dependencies.length} />
            <Stat label="Wave 层" value={parsed.waves.length} />
            <Stat
              label="规模超标"
              value={parsed.scaleWarnings.length}
              tone={parsed.scaleWarnings.length > 0 ? "warn" : undefined}
            />
          </div>

          {parsed.missingItems.length > 0 ? (
            <div className="rounded-lg border border-destructive/30 bg-card p-3.5 text-sm">
              <div className="mb-1.5 flex items-center gap-2 font-semibold">
                <IconAlertTriangle className="size-4 text-destructive" />
                缺失项
              </div>
              {parsed.missingItems.map((m, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {m}
                </p>
              ))}
            </div>
          ) : null}

          {parsed.waves.length > 0 ? (
            <div className="rounded-lg border border-border bg-card p-3.5">
              <div className="mb-2 text-sm font-semibold">Wave 实施顺序</div>
              {parsed.waves.map((wave, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-1.5 py-1"
                >
                  <span className="w-16 shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    Wave {i + 1}
                  </span>
                  {wave.map((key) => (
                    <span
                      key={key}
                      className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"
                    >
                      {key}
                    </span>
                  ))}
                  {i < parsed.waves.length - 1 ? (
                    <IconArrowDown className="ml-2 size-3.5 text-muted-foreground" />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {briefArtifacts.map((brief) => {
          const itemKey = brief.docKey.replace(/^brief:/, "");
          const scale = scaleEstimateOf(workItemsByKey.get(itemKey));
          const flagged = scale?.verdict === "split-required";
          return (
            <div
              key={brief.id}
              className={cn(
                "rounded-lg border bg-card p-3.5",
                flagged ? "border-warning/50" : "border-border",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold">
                  brief:{itemKey}
                </span>
                <Badge
                  variant={flagged ? "destructive" : "secondary"}
                  className="text-[10px]"
                >
                  {scale
                    ? `${scale.files} 文件 · ${flagged ? "split-required" : "规模 OK"}`
                    : "规模未知"}
                </Badge>
              </div>
              {flagged ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" className="gap-1.5">
                    <IconScissors className="size-3.5" />
                    拆分为子任务
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    &gt;6 文件或跨生命周期协同 — 未处置不得入队派发
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2">
      <span
        className={cn(
          "font-mono text-lg font-semibold leading-none",
          tone === "warn" && value > 0 && "text-warning",
        )}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
    </div>
  );
}
