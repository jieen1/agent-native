import {
  IconChevronRight,
  IconExternalLink,
  IconFileText,
  IconGitPullRequest,
  IconInbox,
  IconPackage,
} from "@tabler/icons-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useV3RunSummary, type V3RunState } from "@/hooks/use-v3-run";

// ── Run inputs (generic KV render — inputs is free-form JSONB) ──────────────

const INPUT_KEY_LABEL: Record<string, string> = {
  repo: "repo",
  baseBranch: "baseBranch",
  targetBranch: "targetBranch",
  brief: "brief",
  tags: "tags",
};

function fmtInputValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function RunInputsSection({ inputs }: { inputs: unknown }) {
  const entries = useMemo(() => {
    if (!inputs || typeof inputs !== "object") return [];
    return Object.entries(inputs as Record<string, unknown>);
  }, [inputs]);

  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Run inputs
      </h4>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-4 text-center text-xs text-muted-foreground">
          该运行没有记录输入参数。
        </div>
      ) : (
        <div className="space-y-1.5 rounded-lg border border-border bg-card/40 p-3">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2 text-xs">
              <span className="w-28 shrink-0 font-mono text-muted-foreground">
                {INPUT_KEY_LABEL[key] ?? key}
              </span>
              <span className="min-w-0 flex-1 break-words font-mono text-foreground/85">
                {fmtInputValue(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Final artifacts (PR link + diff stats + terminal node outputs) ──────────

function tagString(tags: unknown, ...keys: string[]): string | null {
  if (!tags || typeof tags !== "object") return null;
  const rec = tags as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function TerminalOutputCard({
  nodeId,
  status,
  output,
}: {
  nodeId: string;
  status: string;
  output: string | null;
}) {
  return (
    <Collapsible>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/40">
          <IconChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="font-mono font-medium">{nodeId}</span>
          <Badge
            variant="outline"
            className={
              status === "failed"
                ? "h-4.5 border-red-500/40 px-1.5 text-[10px] text-red-600 dark:text-red-400"
                : status === "skipped"
                  ? "h-4.5 px-1.5 text-[10px] text-muted-foreground"
                  : "h-4.5 border-emerald-500/40 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
            }
          >
            {status}
          </Badge>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {output ? "有产出" : "无文本产出"}
          </span>
        </CollapsibleTrigger>
        {output ? (
          <CollapsibleContent>
            <pre className="max-h-60 overflow-auto border-t border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
              {output}
            </pre>
          </CollapsibleContent>
        ) : null}
      </div>
    </Collapsible>
  );
}

export interface RunInputsArtifactsProps {
  runId: string;
  runState: V3RunState;
}

/**
 * The "输入与产物" inspector tab (04-orchestrator.md §3): run inputs
 * (repo/baseBranch/targetBranch/brief/tags) + final artifacts once the run
 * reaches a terminal state (PR link, diff stats, terminal node outputs).
 * Deliberately does NOT fabricate a "merge sha" or "test passed" verdict that
 * isn't backed by real data — it surfaces the PR link tag, real diff stats,
 * and every terminal node's real output text so the user can find whatever
 * evidence that specific workflow actually produced.
 */
export function RunInputsArtifacts({
  runId,
  runState,
}: RunInputsArtifactsProps) {
  const { data: rollup, isLoading } = useV3RunSummary(runId);

  const prUrl = tagString(runState.tags, "pr_url", "prUrl");
  const isTerminal = ["done", "failed", "cancelled"].includes(runState.status);

  const terminalOutputs = rollup?.nodeOutputs ?? [];
  const diff = rollup?.diff;
  const diffStats = diff && !("error" in diff) ? diff : null;
  const diffError = diff && "error" in diff ? diff : null;

  return (
    <div className="space-y-5 p-4">
      <RunInputsSection inputs={runState.inputs} />

      <section>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          最终产物
        </h4>

        {!isTerminal ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 px-4 py-6 text-center">
            <IconInbox className="size-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              运行终态后汇总：PR 链接 · 变更统计 · 终态节点产出
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs hover:border-foreground/30"
              >
                <IconGitPullRequest className="size-4 text-muted-foreground" />
                <span className="truncate font-mono">{prUrl}</span>
                <IconExternalLink className="ml-auto size-3.5 shrink-0 opacity-60" />
              </a>
            ) : null}

            {diffStats ? (
              <div className="flex items-center gap-4 rounded-lg border border-border bg-card/40 px-3 py-2 text-xs">
                <IconPackage className="size-4 text-muted-foreground" />
                <span className="font-mono text-foreground/85">
                  {diffStats.filesChanged} 文件
                </span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400">
                  +{diffStats.additions}
                </span>
                <span className="font-mono text-red-600 dark:text-red-400">
                  -{diffStats.deletions}
                </span>
                <span className="ml-auto text-[10.5px] text-muted-foreground">
                  base: {diffStats.base} ({diffStats.baseSource})
                </span>
              </div>
            ) : diffError ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                变更统计不可用：{diffError.detail}
              </div>
            ) : null}

            {!prUrl &&
            !diffStats &&
            !diffError &&
            terminalOutputs.length === 0 &&
            !isLoading ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 px-4 py-6 text-center">
                <IconPackage className="size-5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  该运行没有产生可展示的产物。
                </span>
              </div>
            ) : null}

            {terminalOutputs.length > 0 ? (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <IconFileText className="size-3" />
                  终态节点产出（{terminalOutputs.length}）
                </div>
                <div className="space-y-1.5">
                  {terminalOutputs.map((n) => (
                    <TerminalOutputCard
                      key={n.nodeId}
                      nodeId={n.nodeIdInDag}
                      status={n.status}
                      output={n.output}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
