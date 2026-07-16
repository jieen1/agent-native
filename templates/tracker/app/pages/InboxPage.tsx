import type { GateKey, InboxGroupKey, InboxRow } from "@shared/types";
import { GATE_KEY_LABELS } from "@shared/types";
import {
  IconCheck,
  IconExternalLink,
  IconInboxOff,
  IconLoader2,
  IconRepeat,
  IconRocket,
  IconArrowBackUp,
  IconArrowUp,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { statusPresentation } from "@/components/tracker-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInboxItems,
  useApproveGate,
  useRejectGate,
  useDispatch,
  useRollbackStage,
  useRequestApproval,
} from "@/hooks/use-tracker";
import {
  INBOX_GROUP_LABELS,
  INBOX_GROUP_ORDER,
  canEscalate,
  findInboxRow,
  formatRelativeTime,
  isInboxEmpty,
  pickDefaultSelection,
  previousStage,
} from "@/lib/inbox";
import { cn } from "@/lib/utils";

function rowTitle(row: InboxRow): string {
  if (row.group === "signoff" || row.group === "escalation") {
    return GATE_KEY_LABELS[row.gateKey as GateKey] ?? row.gateKey ?? row.kind;
  }
  return row.title;
}

// ── Reject dialog (signoff/escalation approvals — reason is required) ───────

function RejectApprovalDialog({
  approvalId,
  open,
  onClose,
}: {
  approvalId: string;
  open: boolean;
  onClose: () => void;
}) {
  const rejectGate = useRejectGate();
  const [reason, setReason] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    void rejectGate
      .mutateAsync({ id: approvalId, reason: reason.trim() })
      .then(() => {
        setReason("");
        onClose();
      });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>驳回原因</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="inbox-reject-reason">原因（必填）</Label>
            <Input
              id="inbox-reject-reason"
              placeholder="请填写驳回原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={rejectGate.isPending || !reason.trim()}
            >
              {rejectGate.isPending ? "提交中…" : "确认驳回"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Left list ─────────────────────────────────────────────────────────────

function InboxRowItem({ row, active }: { row: InboxRow; active: boolean }) {
  const isApproval = row.group === "signoff" || row.group === "escalation";
  const status = isApproval ? null : statusPresentation(row.status);
  return (
    <Link
      to={`/inbox?item=${encodeURIComponent(row.id)}`}
      replace
      className={cn(
        "block border-b border-border/60 px-3.5 py-2.5 last:border-b-0 hover:bg-accent/50",
        active && "bg-accent hover:bg-accent",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {rowTitle(row)}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTime(row.timestamp)}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {isApproval ? (
          <Badge
            variant="secondary"
            className="h-4.5 shrink-0 bg-amber-400/20 px-1.5 text-[10px] text-amber-700"
          >
            待批
          </Badge>
        ) : (
          <span
            className={cn(
              "inline-flex h-4.5 shrink-0 items-center rounded border px-1.5 text-[10px]",
              status?.chip,
            )}
          >
            {row.status}
          </span>
        )}
        {row.itemKeyDisplay ? (
          <span className="shrink-0 font-mono text-[10px]">
            {row.itemKeyDisplay}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{row.summary}</span>
      </div>
    </Link>
  );
}

function InboxGroupSection({
  groupKey,
  rows,
  selectedId,
}: {
  groupKey: InboxGroupKey;
  rows: InboxRow[];
  selectedId: string | null;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {INBOX_GROUP_LABELS[groupKey]}
        </h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3.5 pb-2 text-xs text-muted-foreground/70">
          {groupKey === "notifications"
            ? "暂无跨工作项事件源，占位（阶段推进/verify/promote 通知尚未接入真实数据）"
            : "暂无待处理"}
        </p>
      ) : (
        rows.map((row) => (
          <InboxRowItem key={row.id} row={row} active={row.id === selectedId} />
        ))
      )}
    </div>
  );
}

// ── Right detail ──────────────────────────────────────────────────────────

function ApprovalDetail({ row }: { row: InboxRow }) {
  const approveGate = useApproveGate();
  const [rejectOpen, setRejectOpen] = useState(false);
  const label =
    GATE_KEY_LABELS[row.gateKey as GateKey] ?? row.gateKey ?? row.kind;

  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="secondary">
          {row.group === "escalation" ? "裁决" : "签核"}
        </Badge>
        <h2 className="mt-2 text-lg font-semibold">{label}</h2>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Sprint</dt>
        <dd className="font-mono text-xs">{row.sprintId ?? "—"}</dd>
        {row.workItemId ? (
          <>
            <dt className="text-muted-foreground">工作项</dt>
            <dd>
              <Link
                to={`/items/${encodeURIComponent(row.workItemId)}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {row.workItemId}
                <IconExternalLink className="size-3" />
              </Link>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">发起人</dt>
        <dd>{row.requestedBy ?? "—"}</dd>
        <dt className="text-muted-foreground">发起时间</dt>
        <dd>{row.timestamp?.slice(0, 16).replace("T", " ") ?? "—"}</dd>
      </dl>

      <div className="flex items-center gap-2">
        <Button
          className="gap-1.5"
          disabled={approveGate.isPending}
          onClick={() =>
            row.approvalId && approveGate.mutate({ id: row.approvalId })
          }
        >
          {approveGate.isPending ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconCheck className="size-4" />
          )}
          批准
        </Button>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => setRejectOpen(true)}
        >
          <IconRepeat className="size-4" />
          驳回
        </Button>
      </div>

      {row.approvalId ? (
        <RejectApprovalDialog
          approvalId={row.approvalId}
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ReviewRequestDetail({ row }: { row: InboxRow }) {
  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="secondary" className="bg-violet-500/10 text-violet-600">
          评审请求
        </Badge>
        <h2 className="mt-2 text-lg font-semibold">{row.title}</h2>
        {row.summary ? (
          <p className="mt-1 text-sm text-muted-foreground">{row.summary}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">工作项</dt>
        <dd className="font-mono text-xs">
          {row.itemKeyDisplay ?? row.itemKey ?? "—"}
        </dd>
        <dt className="text-muted-foreground">阶段</dt>
        <dd>{row.currentStageName ?? "—"}</dd>
        {row.branch ? (
          <>
            <dt className="text-muted-foreground">分支</dt>
            <dd className="font-mono text-xs">{row.branch}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">更新于</dt>
        <dd>{row.timestamp?.slice(0, 16).replace("T", " ") ?? "—"}</dd>
      </dl>

      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        完整的评审操作（diff、测试证据、结构化核对清单、批准合并/驳回返工）在工作项详情页处理，
        避免在收件箱内重复一份评审门禁逻辑。
      </p>

      <Button asChild className="gap-1.5">
        <Link to={`/items/${encodeURIComponent(row.workItemId ?? row.id)}`}>
          打开工作项详情处理评审
          <IconExternalLink className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}

function FailedRoutingDetail({ row }: { row: InboxRow }) {
  const dispatch = useDispatch();
  const rollbackStage = useRollbackStage();
  const requestApproval = useRequestApproval();
  const prevStage = previousStage(row.currentStageName);
  const workItemId = row.workItemId ?? row.id;

  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="destructive">失败路由</Badge>
        <h2 className="mt-2 text-lg font-semibold">{row.title}</h2>
        {row.summary ? (
          <p className="mt-1 text-sm text-muted-foreground">{row.summary}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">工作项</dt>
        <dd className="font-mono text-xs">
          {row.itemKeyDisplay ?? row.itemKey ?? "—"}
        </dd>
        <dt className="text-muted-foreground">阶段</dt>
        <dd>{row.currentStageName ?? "—"}</dd>
        {row.branch ? (
          <>
            <dt className="text-muted-foreground">分支</dt>
            <dd className="font-mono text-xs">{row.branch}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">更新于</dt>
        <dd>{row.timestamp?.slice(0, 16).replace("T", " ") ?? "—"}</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-1.5"
          disabled={dispatch.isPending}
          onClick={() =>
            dispatch.mutate(
              { workItemId },
              { onSuccess: () => toast.success("已重新派发") },
            )
          }
        >
          {dispatch.isPending ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconRocket className="size-4" />
          )}
          重新派发
        </Button>
        <Button
          variant="outline"
          className="gap-1.5"
          disabled={rollbackStage.isPending || !prevStage}
          onClick={() =>
            prevStage &&
            rollbackStage.mutate(
              { workItemId, targetStage: prevStage },
              { onSuccess: () => toast.success(`已回退至「${prevStage}」`) },
            )
          }
        >
          <IconArrowBackUp className="size-4" />
          回退至{prevStage ? `「${prevStage}」` : "上一阶段"}
        </Button>
        {canEscalate(row) ? (
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={requestApproval.isPending}
            onClick={() =>
              row.sprintId &&
              requestApproval.mutate(
                { sprintId: row.sprintId, gateKey: "escalation", workItemId },
                { onSuccess: () => toast.success("已升级至裁决") },
              )
            }
          >
            <IconArrowUp className="size-4" />
            升级至裁决
          </Button>
        ) : null}
      </div>

      <Button asChild variant="link" className="h-auto p-0 gap-1">
        <Link to={`/items/${encodeURIComponent(workItemId)}`}>
          打开工作项详情
          <IconExternalLink className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}

function InboxDetail({ row }: { row: InboxRow | null }) {
  if (!row) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        选择左侧一项查看详情
      </div>
    );
  }
  switch (row.group) {
    case "signoff":
    case "escalation":
      return <ApprovalDetail row={row} />;
    case "reviewRequest":
      return <ReviewRequestDetail row={row} />;
    case "failedRouting":
      return <FailedRoutingDetail row={row} />;
    default:
      return null;
  }
}

// ── Empty state (whole inbox) ────────────────────────────────────────────

function InboxZeroState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center animate-in fade-in duration-300">
      <IconInboxOff className="size-10 text-muted-foreground/50" />
      <p className="text-sm font-medium text-foreground">收件箱已清空</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        没有待批的签核、裁决、评审请求或失败路由项。新的项出现时会自动显示在这里。
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export function InboxPage() {
  const { data, isLoading } = useInboxItems();
  const groups = data?.groups;
  const counts = data?.counts;
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedIdParam = searchParams.get("item");
  const selected =
    findInboxRow(groups, selectedIdParam) ?? pickDefaultSelection(groups);
  const empty = isInboxEmpty(groups);

  // Keep the ?item= param in sync with the resolved selection — this is what
  // makes a resolved row "slide out" of the list and advance the detail panel
  // to the next item once the poll refetches it away (design: 处理完成的项自动滑出).
  useEffect(() => {
    if (isLoading) return;
    const nextId = selected?.id ?? null;
    if (nextId !== selectedIdParam) {
      const next = new URLSearchParams(searchParams);
      if (nextId) next.set("item", nextId);
      else next.delete("item");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, selected?.id, selectedIdParam]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 className="text-base font-semibold tracking-tight">收件箱</h2>
        {counts && counts.total > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {counts.total} 项待处理
          </Badge>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="space-y-2 p-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : empty ? (
          <InboxZeroState />
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize="26%" minSize="18%" maxSize="42%">
              <ScrollArea className="h-full">
                {INBOX_GROUP_ORDER.map((key) => (
                  <InboxGroupSection
                    key={key}
                    groupKey={key}
                    rows={groups?.[key] ?? []}
                    selectedId={selected?.id ?? null}
                  />
                ))}
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="74%">
              <ScrollArea className="h-full">
                <InboxDetail row={selected} />
              </ScrollArea>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
}
