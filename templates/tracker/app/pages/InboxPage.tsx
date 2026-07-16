import type {
  ActivityResponse,
  Approval,
  GateKey,
  InboxGroupKey,
  InboxRow,
  ReviewChecklistResult,
  SprintArtifact,
} from "@shared/types";
import { GATE_KEY_LABELS } from "@shared/types";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowUp,
  IconBell,
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconFileText,
  IconGavel,
  IconGitPullRequest,
  IconInboxOff,
  IconInfoCircle,
  IconLoader2,
  IconRepeat,
  IconRobot,
  IconRocket,
  IconRubberStamp,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ArtifactBadge, ArtifactViewDialog } from "@/components/ArtifactBadge";
import { FailedRunEvidence } from "@/components/FailedRunEvidence";
import {
  inboxKindChip,
  orchestratorRunHref,
  statusPresentation,
} from "@/components/tracker-format";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useInboxItems,
  useApproveGate,
  useRejectGate,
  useDispatch,
  useRollbackStage,
  useRequestApproval,
  useActivity,
  useApprovals,
  useReviewChecklist,
  useSetArtifactReview,
  useSprintArtifacts,
  useArtifacts,
} from "@/hooks/use-tracker";
import {
  INBOX_GROUP_LABELS,
  INBOX_GROUP_ORDER,
  canEscalate,
  combineRelatedArtifacts,
  findInboxRow,
  formatRelativeTime,
  isApproveGateDisabled,
  isInboxEmpty,
  latestSprintArtifactCards,
  pickDefaultSelection,
  previousStage,
  processedApprovals,
  resolveEscalationRunId,
  workItemArtifactCards,
  type InboxTab,
  type RelatedArtifactCard,
} from "@/lib/inbox";
import { cn } from "@/lib/utils";

function rowTitle(row: InboxRow): string {
  if (row.group === "signoff" || row.group === "escalation") {
    return GATE_KEY_LABELS[row.gateKey as GateKey] ?? row.gateKey ?? row.kind;
  }
  return row.title;
}

// ── Group icons + avatars (S5 视觉语汇 — icons only, no upload UX) ───────────

const GROUP_ICON: Record<InboxGroupKey, typeof IconBell> = {
  signoff: IconRubberStamp,
  reviewRequest: IconGitPullRequest,
  escalation: IconGavel,
  failedRouting: IconAlertTriangle,
  notifications: IconBell,
};

/** Brain vs. agent avatar, derived from the row's group only (not from real
 *  identity data — this app has no such field on approvals/work items). A
 *  signoff is requested by a human sprint lead through the brain-facing
 *  planning surface; every other group's row is agent/orchestrator-driven. */
function InboxAvatar({ group }: { group: InboxGroupKey }) {
  if (group === "signoff") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
        <IconBrain className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-blue-500/30 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
      <IconRobot className="size-3" />
    </span>
  );
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
        "flex gap-2.5 border-b border-border/60 px-3.5 py-2.5 last:border-b-0 hover:bg-accent/50",
        active && "bg-accent hover:bg-accent",
      )}
    >
      <InboxAvatar group={row.group} />
      <div className="min-w-0 flex-1">
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
              className={cn(
                "h-4.5 shrink-0 px-1.5 text-[10px]",
                inboxKindChip("pending-approval"),
              )}
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
  const Icon = GROUP_ICON[groupKey];
  return (
    <div>
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3" />
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

// ── 门判据 (S5 gate-criteria checklist, F6) ──────────────────────────────────

function ChecklistRow({
  item,
  onToggle,
}: {
  item: ReviewChecklistResult["items"][number];
  onToggle?: () => void;
}) {
  const clickable = item.source === "human" && !!onToggle;
  const content = (
    <>
      {item.checked ? (
        <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
      ) : (
        <IconCircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{item.label}</div>
        {item.checked ? (
          item.detail ? (
            <div className="text-xs text-muted-foreground">{item.detail}</div>
          ) : null
        ) : (
          <div className="text-xs text-destructive">
            {item.detail ??
              (item.state === "needs-human"
                ? clickable
                  ? "待人工确认 — 点击本行确认已核"
                  : "待人工确认"
                : "缺失")}
          </div>
        )}
      </div>
      <Badge variant="outline" className="h-4.5 shrink-0 text-[10px]">
        {item.source === "machine" ? "机器" : "人工"}
      </Badge>
    </>
  );
  const className = cn(
    "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left",
    item.checked
      ? "border-border bg-card"
      : "border-destructive/35 bg-destructive/5",
  );
  if (clickable) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={cn(className, "cursor-pointer hover:bg-accent/40")}
      >
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

export function GateChecklistSection({
  loading,
  result,
  onToggleItem,
}: {
  loading: boolean;
  result: ReviewChecklistResult | undefined;
  onToggleItem?: (item: ReviewChecklistResult["items"][number]) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (!result || result.items.length === 0) return null;

  const passed = result.items.filter((i) => i.checked).length;
  const total = result.items.length;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        门判据 · {passed}/{total} 通过
      </h3>
      <div className="space-y-1.5">
        {result.items.map((item) => (
          <ChecklistRow
            key={item.key}
            item={item}
            onToggle={onToggleItem ? () => onToggleItem(item) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ── 关联产物 (S5 related-artifacts card) ─────────────────────────────────────

export function RelatedArtifactsCard({
  card,
  onOpen,
}: {
  card: RelatedArtifactCard;
  onOpen: () => void;
}) {
  const disabled = card.source === "work-item" && !card.contentRef;
  return (
    <div className="flex gap-3 rounded-md border border-border bg-card p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <IconFileText className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
          <span>
            {card.docKey ? `${card.docKey} · ${card.name}` : card.name}
          </span>
          <Badge
            variant="secondary"
            className="h-4.5 px-1.5 font-mono text-[10px]"
          >
            v{card.version}
          </Badge>
          <ArtifactBadge kind={card.producedByKind} />
        </div>
        {card.excerpt ? (
          <p className="mt-1.5 line-clamp-3 border-l-2 border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
            {card.excerpt}
          </p>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 self-center gap-1 text-xs"
        disabled={disabled}
        onClick={onOpen}
      >
        <IconExternalLink className="size-3.5" />
        打开产物
      </Button>
    </div>
  );
}

function RelatedArtifactsSection({
  sprintId,
  workItemId,
}: {
  sprintId?: string | null;
  workItemId?: string;
}) {
  const { data: sprintData, isLoading: sprintLoading } = useSprintArtifacts(
    sprintId ?? "",
  );
  const { data: workItemData, isLoading: workItemLoading } = useArtifacts(
    workItemId ?? "",
  );
  const [viewing, setViewing] = useState<SprintArtifact | null>(null);

  if (!sprintId && !workItemId) return null;

  const loading =
    (!!sprintId && sprintLoading) || (!!workItemId && workItemLoading);

  if (loading) {
    return (
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          关联产物
        </h3>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const sprintCards = latestSprintArtifactCards(sprintData?.byDocKey);
  const workItemCards = workItemArtifactCards(workItemData?.byStage);
  const cards = combineRelatedArtifacts(sprintCards, workItemCards);
  if (cards.length === 0) return null;

  function openCard(card: RelatedArtifactCard) {
    if (card.source === "sprint") {
      const flat = Object.values(sprintData?.byDocKey ?? {}).flat();
      setViewing(flat.find((a) => a.id === card.id) ?? null);
      return;
    }
    if (card.contentRef) {
      window.open(card.contentRef, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        关联产物
      </h3>
      <div className="space-y-2">
        {cards.map((card) => (
          <RelatedArtifactsCard
            key={`${card.source}-${card.id}`}
            card={card}
            onOpen={() => openCard(card)}
          />
        ))}
      </div>
      <ArtifactViewDialog
        artifact={viewing}
        open={!!viewing}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}

// ── Right detail: signoff (ApprovalDetail) ───────────────────────────────────

function ApprovalDetail({ row }: { row: InboxRow }) {
  const approveGate = useApproveGate();
  const [rejectOpen, setRejectOpen] = useState(false);
  const label =
    GATE_KEY_LABELS[row.gateKey as GateKey] ?? row.gateKey ?? row.kind;

  const { data: checklist, isLoading: checklistLoading } = useReviewChecklist(
    row.workItemId,
  );
  const setReview = useSetArtifactReview();

  const hasWorkItem = !!row.workItemId;
  const approveDisabled =
    approveGate.isPending ||
    isApproveGateDisabled({
      hasWorkItem,
      checklistLoading: hasWorkItem && checklistLoading,
      checklistComplete: checklist ? checklist.complete : null,
    });
  const missingLabels = checklist
    ? checklist.items.filter((i) => !i.checked).map((i) => i.label)
    : [];

  function toggleChecklistItem(item: ReviewChecklistResult["items"][number]) {
    if (item.source !== "human") return;
    if (!checklist?.artifactId || checklist.version == null) return;
    setReview.mutate({
      artifactId: checklist.artifactId,
      version: checklist.version,
      reviewKey: `checklist:${item.key}`,
      checked: !item.checked,
    });
  }

  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="secondary">签核</Badge>
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

      {hasWorkItem ? (
        <GateChecklistSection
          loading={checklistLoading}
          result={checklist}
          onToggleItem={toggleChecklistItem}
        />
      ) : null}

      <RelatedArtifactsSection
        sprintId={row.sprintId}
        workItemId={row.workItemId}
      />

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Button
            className="gap-1.5"
            disabled={approveDisabled}
            title={
              missingLabels.length > 0
                ? `缺少判据：${missingLabels.join("、")}`
                : undefined
            }
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
        {hasWorkItem ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <IconInfoCircle className="size-3.5" />
            判据齐备后批准按钮自动启用；驳回需填写理由
          </p>
        ) : null}
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

// ── Right detail: escalation (EscalationDetail) — its own view, not shared
// with ApprovalDetail (裁决 has no 门判据 section in the prototype; it has
// review evidence + a run badge + escalation-specific button copy instead). ─

export function EscalationBody({
  row,
  activity,
  activityLoading,
  approving,
  onApprove,
  onReject,
}: {
  row: InboxRow;
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
  approving: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const label =
    GATE_KEY_LABELS[row.gateKey as GateKey] ?? row.gateKey ?? row.kind;
  const runId = resolveEscalationRunId(row.gateRef, activity?.runs);

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">
          <InboxAvatar group="escalation" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {label}
            <Badge variant="secondary">待裁决</Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {row.itemKeyDisplay ? (
              <span className="font-mono">{row.itemKeyDisplay}</span>
            ) : null}
            {row.summary ? <span>{row.summary}</span> : null}
            {runId ? (
              <a
                href={orchestratorRunHref(runId)}
                className="inline-flex items-center gap-1 font-mono hover:underline"
              >
                {runId.slice(0, 12)}…
                <IconExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        </div>
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

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          评审证据
        </h3>
        <FailedRunEvidence
          activity={activity}
          activityLoading={activityLoading}
        />
        {!activityLoading ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground/70">
            评审轮次历史（逐轮 FAILED 明细、严重度）当前无可读数据源 ——
            orchestrator 只回传节点当前状态，不回传历史轮次（同 RunEvidenceList
            已记录的已知缺口）。
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button className="gap-1.5" disabled={approving} onClick={onApprove}>
          {approving ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconCheck className="size-4" />
          )}
          批准继续
        </Button>
        <Button variant="outline" className="gap-1.5" onClick={onReject}>
          <IconX className="size-4" />
          驳回终止
        </Button>
        {runId ? (
          <Button asChild variant="outline" className="gap-1.5">
            <a href={orchestratorRunHref(runId)}>
              <IconExternalLink className="size-4" />
              打开运行详情
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EscalationDetail({ row }: { row: InboxRow }) {
  const approveGate = useApproveGate();
  const [rejectOpen, setRejectOpen] = useState(false);
  const workItemId = row.workItemId ?? row.id;
  const { data: activity, isLoading: activityLoading } = useActivity(
    workItemId,
    true,
  );

  return (
    <>
      <EscalationBody
        row={row}
        activity={activity}
        activityLoading={activityLoading}
        approving={approveGate.isPending}
        onApprove={() =>
          row.approvalId && approveGate.mutate({ id: row.approvalId })
        }
        onReject={() => setRejectOpen(true)}
      />
      {row.approvalId ? (
        <RejectApprovalDialog
          approvalId={row.approvalId}
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
        />
      ) : null}
    </>
  );
}

function ReviewRequestDetail({ row }: { row: InboxRow }) {
  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="secondary" className={inboxKindChip("review-request")}>
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
        完整的评审门禁
        UI（测试证据/审查三问/Diff/核对清单/批准合并驳回返工）复用来源 尚未就绪
        —— 这不是遗漏：并行的工作项详情页对齐工作（s4 原型）尚未产出可复用的
        评审门禁组件，暂不在收件箱内手搓一套简化版顶替。完整的评审操作在工作项详情页
        处理，避免在收件箱内重复一份评审门禁逻辑。
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
  // On-demand only — this hook runs once per mount of THIS detail panel (the
  // one currently open row), never once per list row. Same fetch path
  // WorkItemDetailPage's RunEvidenceList already polls (get-activity, 4s).
  const { data: activity, isLoading: activityLoading } = useActivity(
    workItemId,
    true,
  );

  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant="destructive">失败路由</Badge>
        <h2 className="mt-2 text-lg font-semibold">{row.title}</h2>
        {row.summary ? (
          <p className="mt-1 text-sm text-muted-foreground">{row.summary}</p>
        ) : null}
      </div>

      <FailedRunEvidence
        activity={activity}
        activityLoading={activityLoading}
      />

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
      return <ApprovalDetail row={row} />;
    case "escalation":
      return <EscalationDetail row={row} />;
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
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center animate-in fade-in duration-300">
      <IconInboxOff className="size-9 text-muted-foreground/50" />
      <p className="text-sm font-medium text-foreground">收件箱已清空</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        没有待批的签核、裁决、评审请求或失败路由项。新的项出现时会自动显示在这里。
      </p>
    </div>
  );
}

// ── 已处理 (processed) tab — decided approvals only ─────────────────────────

function ProcessedApprovalRow({
  approval,
  active,
  onSelect,
}: {
  approval: Approval;
  active: boolean;
  onSelect: () => void;
}) {
  const label =
    GATE_KEY_LABELS[approval.gateKey as GateKey] ?? approval.gateKey;
  const approved = approval.status === "approved";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "block w-full border-b border-border/60 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-accent/50",
        active && "bg-accent hover:bg-accent",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTime(approval.decidedAt ?? approval.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge
          variant={approved ? "secondary" : "destructive"}
          className="h-4.5 shrink-0 px-1.5 text-[10px]"
        >
          {approved ? "已批准" : "已驳回"}
        </Badge>
        {approval.workItemId ? (
          <span className="shrink-0 font-mono text-[10px]">
            {approval.workItemId}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function ProcessedList({
  approvals,
  selectedId,
  onSelect,
}: {
  approvals: Approval[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (approvals.length === 0) {
    return (
      <p className="px-3.5 py-8 text-center text-xs text-muted-foreground">
        暂无已处理记录
      </p>
    );
  }
  return (
    <div>
      {approvals.map((a) => (
        <ProcessedApprovalRow
          key={a.id}
          approval={a}
          active={a.id === selectedId}
          onSelect={() => onSelect(a.id)}
        />
      ))}
    </div>
  );
}

export function ProcessedApprovalDetail({
  approval,
}: {
  approval: Approval | null;
}) {
  if (!approval) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        选择左侧一项查看详情
      </div>
    );
  }
  const label =
    GATE_KEY_LABELS[approval.gateKey as GateKey] ?? approval.gateKey;
  const approved = approval.status === "approved";
  return (
    <div className="space-y-5 p-6">
      <div>
        <Badge variant={approved ? "secondary" : "destructive"}>
          {approved ? "已批准" : "已驳回"}
        </Badge>
        <h2 className="mt-2 text-lg font-semibold">{label}</h2>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Sprint</dt>
        <dd className="font-mono text-xs">{approval.sprintId}</dd>
        {approval.workItemId ? (
          <>
            <dt className="text-muted-foreground">工作项</dt>
            <dd>
              <Link
                to={`/items/${encodeURIComponent(approval.workItemId)}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {approval.workItemId}
                <IconExternalLink className="size-3" />
              </Link>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">发起人</dt>
        <dd>{approval.requestedBy}</dd>
        <dt className="text-muted-foreground">裁定人</dt>
        <dd>{approval.decidedBy ?? "—"}</dd>
        <dt className="text-muted-foreground">裁定时间</dt>
        <dd>{approval.decidedAt?.slice(0, 16).replace("T", " ") ?? "—"}</dd>
        {approval.reason ? (
          <>
            <dt className="text-muted-foreground">理由</dt>
            <dd>{approval.reason}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function InboxTabSwitcher({
  tab,
  onChange,
}: {
  tab: InboxTab;
  onChange: (tab: InboxTab) => void;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onChange(v as InboxTab)}>
      <TabsList className="h-7 gap-0.5 bg-muted p-0.5">
        <TabsTrigger value="pending" className="h-6 px-2 text-[11px]">
          待处理
        </TabsTrigger>
        <TabsTrigger value="processed" className="h-6 px-2 text-[11px]">
          已处理
        </TabsTrigger>
      </TabsList>
    </Tabs>
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

  const [tab, setTab] = useState<InboxTab>("pending");
  const { data: approvals, isLoading: approvalsLoading } = useApprovals({});
  const processed = processedApprovals(approvals);
  const [selectedProcessedId, setSelectedProcessedId] = useState<string | null>(
    null,
  );
  const selectedProcessed =
    processed.find((a) => a.id === selectedProcessedId) ?? null;

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

  useEffect(() => {
    if (approvalsLoading) return;
    if (
      selectedProcessedId &&
      processed.some((a) => a.id === selectedProcessedId)
    ) {
      return;
    }
    setSelectedProcessedId(processed[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalsLoading, processed.map((a) => a.id).join(",")]);

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
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize="26%" minSize="18%" maxSize="42%">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2">
                <span className="text-[11px] text-muted-foreground">
                  {tab === "pending"
                    ? counts
                      ? `${counts.total} 待处理 · ${counts.notifications} 通知`
                      : ""
                    : `${processed.length} 条历史记录`}
                </span>
                <InboxTabSwitcher tab={tab} onChange={setTab} />
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {tab === "pending" ? (
                  isLoading ? (
                    <div className="space-y-2 p-3.5">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 rounded-lg" />
                      ))}
                    </div>
                  ) : empty ? (
                    <InboxZeroState />
                  ) : (
                    INBOX_GROUP_ORDER.map((key) => (
                      <InboxGroupSection
                        key={key}
                        groupKey={key}
                        rows={groups?.[key] ?? []}
                        selectedId={selected?.id ?? null}
                      />
                    ))
                  )
                ) : approvalsLoading ? (
                  <div className="space-y-2 p-3.5">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-14 rounded-lg" />
                    ))}
                  </div>
                ) : (
                  <ProcessedList
                    approvals={processed}
                    selectedId={selectedProcessedId}
                    onSelect={setSelectedProcessedId}
                  />
                )}
              </ScrollArea>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="74%">
            <ScrollArea className="h-full">
              {tab === "pending" ? (
                <InboxDetail row={selected} />
              ) : (
                <ProcessedApprovalDetail approval={selectedProcessed} />
              )}
            </ScrollArea>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
