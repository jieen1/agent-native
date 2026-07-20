import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowLeft,
  IconArrowUp,
  IconBrandGithub,
  IconCategory,
  IconCheck,
  IconClock,
  IconEdit,
  IconCircleCheck,
  IconDotsVertical,
  IconExternalLink,
  IconFileText,
  IconFlag,
  IconPaperclip,
  IconPalette,
  IconPhoto,
  IconRuler,
  IconGitBranch,
  IconHash,
  IconLayoutKanban,
  IconLink,
  IconListCheck,
  IconLoader2,
  IconMessageCircle,
  IconPlus,
  IconRocket,
  IconScissors,
  IconSettings,
  IconShieldLock,
  IconSitemap,
  IconStack2,
  IconTag,
  IconTimeline,
  IconTrash,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { toast } from "sonner";

import type {
  ScaleEstimate,
  TransitionOption,
  WorkItemRunSummary,
} from "@shared/types";

import { ActivityFeed } from "@/components/ActivityFeed";
import { ArtifactsPanel } from "@/components/ArtifactsPanel";
import { InspectorSection } from "@/components/InspectorSection";
import { RunBadgeCompact, RunEvidenceList } from "@/components/RunEvidenceList";
import {
  fmtDateTime,
  orchestratorBrainHref,
  orchestratorRunHref,
  repoHref,
  repoLabel,
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkItemBreadcrumb } from "@/components/WorkItemBreadcrumb";
import {
  useActivity,
  useComments,
  useAddComment,
  useLinks,
  useAddLink,
  useTrackerActivities,
  useUpdateWorkItem,
  useDeleteWorkItem,
  useDispatch,
  useEstimateBriefScale,
  useRequestApproval,
  useSplitWorkItem,
  useStages,
  useWorkItem,
  useSprints,
  useOrgMembers,
  useTriggerStage,
  useRollbackStage,
  useAdvanceStage,
  useTransitionWorkItem,
  useEpicChildren,
  useDocuments,
  useAddDocument,
  useDeleteDocument,
} from "@/hooks/use-tracker";
import { buildDraftChildren, canSubmitSplit } from "@/lib/split-draft";
import { cn } from "@/lib/utils";
import { canEscalateWorkItem, stageNeighbors } from "@/lib/work-item-header";

// ── Stage stepper ────────────────────────────────────────────────────────────

const STAGE_NODES = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
] as const;

function StageNode({ status, name }: { status: string; name: string }) {
  if (status === "已完成") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-emerald-500 flex items-center justify-center">
          <IconCheck className="size-3 text-white" strokeWidth={3} />
        </div>
        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          {name}
        </span>
      </div>
    );
  }
  if (status === "执行中") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-blue-500 flex items-center justify-center ring-4 ring-blue-500/20">
          <span className="size-2 rounded-full bg-white animate-pulse" />
        </div>
        <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400">
          {name}
        </span>
      </div>
    );
  }
  if (status === "已驳回") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-red-400 flex items-center justify-center">
          <IconX className="size-3 text-white" strokeWidth={3} />
        </div>
        <span className="text-[10px] font-medium text-red-500">{name}</span>
      </div>
    );
  }
  if (status === "跳过") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full border-2 border-dashed border-slate-400 flex items-center justify-center">
          <span className="text-[10px] text-slate-400">—</span>
        </div>
        <span className="text-[10px] font-medium text-slate-400 line-through">
          {name}
        </span>
      </div>
    );
  }
  // 待执行 / unknown
  return (
    <div className="flex flex-col items-center gap-1.5 relative z-10">
      <div className="size-5 rounded-full border-2 border-slate-300 dark:border-slate-600" />
      <span className="text-[10px] font-medium text-muted-foreground">
        {name}
      </span>
    </div>
  );
}

function StageLine({ prevDone }: { prevDone: boolean }) {
  return prevDone ? (
    <div className="flex-1 h-px bg-emerald-500 my-2.5" />
  ) : (
    <div className="flex-1 h-px border border-dashed border-slate-300 dark:border-slate-600 my-2.5" />
  );
}

function StageProgressCard({
  workItemId,
  currentStageName,
  plannedStages,
}: {
  workItemId: string;
  currentStageName: string;
  plannedStages?: string[];
}) {
  const { data, isLoading } = useStages(workItemId);
  const stages: any[] = Array.isArray(data) ? data : [];
  const stageMap: Record<string, string> = {};
  for (const s of stages) stageMap[s.stageName] = s.stageStatus;

  // Use the item's plannedStages subset when present; fall back to the full order.
  const stageOrder: string[] =
    plannedStages && plannedStages.length > 0
      ? plannedStages
      : [...STAGE_NODES];
  const lastStage = stageOrder[stageOrder.length - 1];
  const currentIdx = stageOrder.indexOf(currentStageName);

  const nodeStatuses: Record<string, string> = {};
  stageOrder.forEach((stageName, i) => {
    const row = stageMap[stageName];
    if (row) {
      nodeStatuses[stageName] = row;
    } else if (stageName === currentStageName) {
      nodeStatuses[stageName] = "执行中";
    } else if (currentIdx >= 0 && i < currentIdx) {
      nodeStatuses[stageName] = "已完成";
    } else {
      nodeStatuses[stageName] = "待执行";
    }
  });

  const currentLabel =
    nodeStatuses[currentStageName] === "执行中"
      ? `${currentStageName} · 执行中`
      : currentStageName === lastStage && nodeStatuses[lastStage] === "已完成"
        ? `${lastStage} · 已完成`
        : `${currentStageName}`;

  const currentBadgeClass =
    nodeStatuses[currentStageName] === "已完成" ||
    currentStageName === lastStage
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30"
      : "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30";

  const currentDot =
    nodeStatuses[currentStageName] === "已完成"
      ? "bg-emerald-500"
      : "bg-blue-500 animate-pulse";

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card shadow-sm p-5 animate-pulse h-24" />
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm p-5">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold">阶段进度</h3>
        <span className="text-xs text-muted-foreground">仅展示状态</span>
      </div>

      {/* Horizontal stepper */}
      <div className="flex items-start">
        {stageOrder.map((name, i) => {
          const st = nodeStatuses[name];
          const prevDone =
            i === 0 ? false : nodeStatuses[stageOrder[i - 1]] === "已完成";
          return (
            <>
              {i > 0 && <StageLine key={`line-${i}`} prevDone={prevDone} />}
              <StageNode key={name} name={name} status={st} />
            </>
          );
        })}
      </div>

      {/* Current stage badge */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">当前:</span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
            currentBadgeClass,
          )}
        >
          <span className={cn("size-1.5 rounded-full", currentDot)} />
          {currentLabel}
        </span>
      </div>
    </div>
  );
}

// ── Small status chip (header) ───────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const pres = statusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        pres.chip,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          pres.dot,
          pres.live && "animate-pulse",
        )}
      />
      {pres.label}
    </span>
  );
}

// ── Comments panel ────────────────────────────────────────────────────────────

function CommentsPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useComments(workItemId);
  const addComment = useAddComment();
  const [text, setText] = useState("");

  const comments: any[] = Array.isArray(data) ? data : [];

  function submit() {
    const body = text.trim();
    if (!body) return;
    addComment.mutate(
      { workItemId, body },
      {
        onSuccess: () => {
          setText("");
          toast.success("评论已添加");
        },
      },
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <IconMessageCircle className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          评论{comments.length > 0 ? ` (${comments.length})` : ""}
        </h2>
      </div>
      <div className="space-y-3">
        {isLoading ? (
          <div className="h-12 animate-pulse rounded-lg bg-muted/40" />
        ) : comments.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 py-2">暂无评论。</p>
        ) : (
          comments.map((c: any) => (
            <div
              key={c.id}
              className="rounded-lg border border-border bg-card/40 p-3"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <IconUser className="size-3 shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium">{c.authorName}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {fmtDateTime(c.createdAt)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {c.body}
              </p>
            </div>
          ))
        )}
        <div className="flex flex-col gap-2">
          <Textarea
            placeholder="写下评论… (Ctrl+Enter 发送)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
            }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={submit}
              disabled={!text.trim() || addComment.isPending}
              className="gap-1.5"
            >
              {addComment.isPending ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconPlus className="size-3.5" />
              )}
              发表评论
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Links panel ───────────────────────────────────────────────────────────────

const LINK_TYPE_LABELS: Record<string, string> = {
  "bug-of": "缺陷归属",
  "test-of": "测试归属",
  blocks: "阻塞",
  "blocked-by": "被阻塞",
  "duplicate-of": "重复",
  "relates-to": "关联",
  "depends-on": "依赖",
};

const LINK_TYPE_COLORS: Record<string, string> = {
  "bug-of": "bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/30",
  "test-of": "bg-teal-500/15 text-teal-600 dark:text-teal-400 ring-teal-500/30",
  blocks:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30",
  "blocked-by":
    "bg-orange-500/15 text-orange-600 dark:text-orange-400 ring-orange-500/30",
  "duplicate-of":
    "bg-slate-500/15 text-slate-600 dark:text-slate-400 ring-slate-500/30",
  "relates-to": "bg-secondary text-secondary-foreground ring-border",
  "depends-on":
    "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-violet-500/30",
};

// ── Document types ────────────────────────────────────────────────────────────

const DOC_TYPE_ORDER = [
  "design",
  "prototype",
  "acceptance",
  "spec",
  "other",
] as const;
const DOC_TYPE_LABELS: Record<string, string> = {
  design: "设计",
  prototype: "原型",
  acceptance: "验收",
  spec: "规格",
  other: "其他",
};
const DOC_TYPE_COLORS: Record<string, string> = {
  design: "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-blue-500/30",
  prototype:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 ring-purple-500/30",
  acceptance:
    "bg-green-500/15 text-green-600 dark:text-green-400 ring-green-500/30",
  spec: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30",
  other: "bg-secondary text-secondary-foreground ring-border",
};
const DOC_TYPE_ICONS: Record<string, any> = {
  design: IconPalette,
  prototype: IconPhoto,
  acceptance: IconCircleCheck,
  spec: IconRuler,
  other: IconFileText,
};

function LinksPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useLinks(workItemId);
  const addLink = useAddLink();
  const [toItemId, setToItemId] = useState("");
  const [linkType, setLinkType] = useState("relates-to");

  const links: any[] = Array.isArray(data) ? data : [];

  function submit() {
    const target = toItemId.trim();
    if (!target) return;
    addLink.mutate(
      { fromItemId: workItemId, toItemId: target, linkType },
      {
        onSuccess: () => {
          setToItemId("");
          toast.success("关联已添加");
        },
      },
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <IconLink className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          关联{links.length > 0 ? ` (${links.length})` : ""}
        </h2>
      </div>
      <div className="space-y-2">
        {isLoading ? (
          <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
        ) : links.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 py-1">
            暂无关联工作项。
          </p>
        ) : (
          links.map((l: any) => (
            <div
              key={l.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2"
            >
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                  LINK_TYPE_COLORS[l.linkType] ??
                    "bg-secondary text-secondary-foreground ring-border",
                )}
              >
                {LINK_TYPE_LABELS[l.linkType] ?? l.linkType}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {l.direction === "from" ? "→" : "←"}
              </span>
              <span className="text-xs font-medium truncate">
                {l.otherItemTitle || l.otherItemId}
              </span>
            </div>
          ))
        )}
        <div className="flex gap-2">
          <Input
            placeholder="目标工作项 ID"
            value={toItemId}
            onChange={(e) => setToItemId(e.target.value)}
            className="h-8 text-xs flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <Select value={linkType} onValueChange={setLinkType}>
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(LINK_TYPE_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v} className="text-xs">
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={submit}
            disabled={!toItemId.trim() || addLink.isPending}
            className="h-8 px-2"
          >
            {addLink.isPending ? (
              <IconLoader2 className="size-3.5 animate-spin" />
            ) : (
              <IconPlus className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Documents panel ───────────────────────────────────────────────────────────

function DocumentsPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useDocuments(workItemId);
  const addDoc = useAddDocument();
  const deleteDoc = useDeleteDocument();
  const [open, setOpen] = useState(false);
  const [formDocType, setFormDocType] = useState<string>("design");
  const [formTitle, setFormTitle] = useState("");
  const [formUrl, setFormUrl] = useState("");

  const byDocType: Record<string, any[]> = data?.byDocType ?? {};
  const totalDocs = DOC_TYPE_ORDER.reduce(
    (n, dt) => n + (byDocType[dt]?.length ?? 0),
    0,
  );

  function submitDoc() {
    const title = formTitle.trim();
    const url = formUrl.trim();
    if (!title) {
      toast.error("标题不能为空");
      return;
    }
    if (!url) {
      toast.error("URL 不能为空");
      return;
    }
    addDoc.mutate(
      {
        workItemId,
        docType: formDocType as (typeof DOC_TYPE_ORDER)[number],
        title,
        url,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setFormTitle("");
          setFormUrl("");
          setFormDocType("design");
          toast.success("文档已添加");
        },
      },
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IconPaperclip className="size-3.5 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            关联文档{totalDocs > 0 ? ` (${totalDocs})` : ""}
          </h2>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 gap-1 text-xs">
              <IconPlus className="size-3" /> 添加文档
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>添加文档</DialogTitle>
              <DialogDescription>
                关联设计/原型/验收/规格等文档到当前工作项。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>文档类型</Label>
                <Select value={formDocType} onValueChange={setFormDocType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOC_TYPE_ORDER.map((dt) => (
                      <SelectItem key={dt} value={dt}>
                        {DOC_TYPE_LABELS[dt]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="doc-title">标题</Label>
                <Input
                  id="doc-title"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder="文档标题"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="doc-url">URL</Label>
                <Input
                  id="doc-url"
                  type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={addDoc.isPending}
              >
                取消
              </Button>
              <Button onClick={submitDoc} disabled={addDoc.isPending}>
                {addDoc.isPending ? "添加中..." : "确认添加"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="space-y-3">
        {isLoading ? (
          <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
        ) : (
          DOC_TYPE_ORDER.map((dt) => {
            const docs = byDocType[dt] ?? [];
            const label = DOC_TYPE_LABELS[dt];
            const color = DOC_TYPE_COLORS[dt];
            const DocTypeIcon = DOC_TYPE_ICONS[dt];
            return (
              <div key={dt}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                      color,
                    )}
                  >
                    <DocTypeIcon className="size-3" />
                    {label}
                  </span>
                </div>
                {docs.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 py-1">
                    暂无{label}文档。
                  </p>
                ) : (
                  <div className="space-y-1">
                    {docs.map((doc: any) => (
                      <div
                        key={doc.id}
                        className="group flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2 transition-colors hover:bg-muted/40"
                      >
                        <span
                          className={cn(
                            "shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                            color,
                          )}
                        >
                          <DocTypeIcon className="size-3" />
                          {label}
                        </span>
                        <IconFileText className="size-3.5 text-muted-foreground shrink-0" />
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 truncate text-xs font-medium hover:underline"
                        >
                          {doc.title}
                          <IconExternalLink className="inline size-3 ml-1 opacity-60" />
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={() =>
                            deleteDoc.mutate(
                              { id: doc.id },
                              { onSuccess: () => toast.success("文档已删除") },
                            )
                          }
                          disabled={deleteDoc.isPending}
                        >
                          <IconTrash className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ── Epic children panel ─────────────────────────────────────────────────────

function EpicChildrenPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useEpicChildren(workItemId);
  const children = data?.children ?? [];
  const dependencies = data?.dependencies ?? [];

  const depsByChild = new Map<string, typeof dependencies>();
  for (const dep of dependencies) {
    const list = depsByChild.get(dep.fromId) ?? [];
    list.push(dep);
    depsByChild.set(dep.fromId, list);
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <IconSitemap className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          子项{children.length > 0 ? ` (${children.length})` : ""}
        </h2>
      </div>
      <div className="space-y-2">
        {isLoading ? (
          <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
        ) : children.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 py-1">
            暂无子项，使用「拆解集合」将其拆分为子工作项。
          </p>
        ) : (
          children.map((child) => {
            const deps = depsByChild.get(child.id) ?? [];
            const status = statusPresentation(child.status);
            return (
              <div
                key={child.id}
                className="rounded-lg border border-border bg-card/40 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", status.dot)}
                  />
                  <Link
                    to={`/items/${child.id}`}
                    className="shrink-0 text-xs font-medium hover:underline"
                    title={
                      child.itemKeyDisplay && child.itemKeyDisplay !== child.itemKey
                        ? "历史重号，已消歧显示"
                        : undefined
                    }
                  >
                    {child.itemKeyDisplay || child.itemKey || child.id}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {child.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {child.currentStageName || "待办"}
                  </span>
                </div>
                {deps.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 pl-3.5">
                    {deps.map((dep, i) => (
                      <div
                        key={i}
                        className="text-[10px] text-orange-600 dark:text-orange-400"
                      >
                        {dep.fromLabel} ← blocked-by ← {dep.toLabel}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ── Tracker activities panel ──────────────────────────────────────────────────

function ActivitiesPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useTrackerActivities(workItemId, true);
  const activities: any[] = Array.isArray(data) ? data : [];

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <IconTimeline className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          操作历史
        </h2>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted/40" />
          ))}
        </div>
      ) : activities.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 py-2">暂无操作记录。</p>
      ) : (
        <div className="relative border-l border-border pl-4">
          {activities.map((a: any) => (
            <div key={a.id} className="relative pb-3">
              <span className="absolute -left-[1.1rem] top-1.5 size-2 rounded-full border-2 border-border bg-muted" />
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-medium">{a.eventType}</span>
                  <span className="mx-1 text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">
                    {a.actorName}
                  </span>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {fmtDateTime(a.createdAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Metadata row (definition list) ───────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconBrandGithub;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="w-20 shrink-0 pt-px text-xs text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

// ── Editable priority ──────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  1: "P0",
  2: "P1",
  3: "P2",
  4: "P3",
};

function EditablePriority({ id, priority }: { id: string; priority: number }) {
  const update = useUpdateWorkItem();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="group flex items-center gap-1.5 text-sm"
        onClick={() => setEditing(true)}
        title="点击编辑"
      >
        {PRIORITY_LABELS[priority] ?? `P${priority}`}
        <IconEdit className="size-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </button>
    );
  }

  return (
    <Select
      value={String(priority)}
      onValueChange={(v) => {
        update.mutate(
          { id, priority: Number(v) },
          {
            onSuccess: () => {
              setEditing(false);
              toast.success("优先级已更新");
            },
          },
        );
      }}
      open
      onOpenChange={(o) => {
        if (!o) setEditing(false);
      }}
    >
      <SelectTrigger className="h-7 w-[80px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[1, 2, 3, 4].map((p) => (
          <SelectItem key={p} value={String(p)} className="text-xs">
            {PRIORITY_LABELS[p]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Editable risk ──────────────────────────────────────────────────────────────

const RISK_MAP: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};
const RISK_COLORS: Record<string, string> = {
  high: "border-red-300 bg-red-50 text-red-600 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400",
  medium:
    "border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400",
  low: "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400",
};

function EditableRisk({ id, risk }: { id: string; risk: string }) {
  const update = useUpdateWorkItem();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="group flex items-center gap-1.5"
        onClick={() => setEditing(true)}
        title="点击编辑"
      >
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
            RISK_COLORS[risk] ?? RISK_COLORS.low,
          )}
        >
          {RISK_MAP[risk] ?? risk}
        </span>
        <IconEdit className="size-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </button>
    );
  }

  return (
    <Select
      value={risk}
      onValueChange={(v) => {
        update.mutate(
          { id, risk: v },
          {
            onSuccess: () => {
              setEditing(false);
              toast.success("风险已更新");
            },
          },
        );
      }}
      open
      onOpenChange={(o) => {
        if (!o) setEditing(false);
      }}
    >
      <SelectTrigger className="h-7 w-[80px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(RISK_MAP).map(([v, l]) => (
          <SelectItem key={v} value={v} className="text-xs">
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Editable tags ──────────────────────────────────────────────────────────────

function EditableTags({ id, tags }: { id: string; tags: string[] }) {
  const update = useUpdateWorkItem();
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");

  function removeTag(tag: string) {
    update.mutate(
      { id, tags: tags.filter((t) => t !== tag) },
      { onSuccess: () => toast.success("标签已更新") },
    );
  }

  function addTag() {
    const t = newTag.trim();
    setNewTag("");
    setAddingTag(false);
    if (!t || tags.includes(t)) return;
    update.mutate(
      { id, tags: [...tags, t] },
      { onSuccess: () => toast.success("标签已添加") },
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="group inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="opacity-0 group-hover:opacity-70 transition-opacity hover:text-destructive"
          >
            <IconX className="size-2.5" />
          </button>
        </span>
      ))}
      {addingTag ? (
        <Input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTag();
            if (e.key === "Escape") {
              setAddingTag(false);
              setNewTag("");
            }
          }}
          onBlur={addTag}
          autoFocus
          className="h-5 w-20 rounded px-1 text-[10px]"
          placeholder="新标签"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAddingTag(true)}
          className="inline-flex items-center rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <IconPlus className="size-2.5" />
        </button>
      )}
    </div>
  );
}

// ── Editable sprint ────────────────────────────────────────────────────────────

function EditableSprint({
  id,
  sprint,
}: {
  id: string;
  sprint: { id: string; name: string; status: string } | null;
}) {
  const update = useUpdateWorkItem();
  const { data: sprintsRaw } = useSprints();
  const sprints: any[] = Array.isArray(sprintsRaw) ? sprintsRaw : [];
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="group flex items-center gap-1.5 text-sm"
        onClick={() => setEditing(true)}
        title="点击编辑"
      >
        {sprint ? (
          <>
            <span className="font-medium">{sprint.name}</span>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {sprint.status}
            </Badge>
          </>
        ) : (
          <span className="text-muted-foreground text-xs">未分配</span>
        )}
        <IconEdit className="size-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </button>
    );
  }

  return (
    <Select
      value={sprint?.id ?? "none"}
      onValueChange={(v) => {
        update.mutate(
          { id, sprintId: v === "none" ? null : v },
          {
            onSuccess: () => {
              setEditing(false);
              toast.success("Sprint 已更新");
            },
          },
        );
      }}
      open
      onOpenChange={(o) => {
        if (!o) setEditing(false);
      }}
    >
      <SelectTrigger className="h-7 w-[160px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none" className="text-xs">
          未分配
        </SelectItem>
        {sprints.map((s: any) => (
          <SelectItem key={s.id} value={s.id} className="text-xs">
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Editable nature (性质 tags) ────────────────────────────────────────────────

const NATURE_OPTIONS = ["前端", "后端", "API", "数据"] as const;

function EditableNature({ id, nature }: { id: string; nature: string[] }) {
  const update = useUpdateWorkItem();

  function toggle(tag: string) {
    const next = nature.includes(tag)
      ? nature.filter((t) => t !== tag)
      : [...nature, tag];
    update.mutate(
      { id, nature: next },
      {
        onSuccess: () => toast.success("性质已更新"),
      },
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {NATURE_OPTIONS.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => toggle(tag)}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset transition-colors",
            nature.includes(tag)
              ? "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-violet-500/30"
              : "bg-secondary text-secondary-foreground ring-border hover:bg-muted",
          )}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}

// ── Editable owner (负责人) ────────────────────────────────────────────────────

function EditableOwner({ id, owner }: { id: string; owner: string | null }) {
  const update = useUpdateWorkItem();
  const { data: membersData } = useOrgMembers();
  const members = membersData?.members ?? [];
  const [editing, setEditing] = useState(false);

  const displayLabel =
    owner === "agent" || owner === "智能体"
      ? "智能体"
      : owner
        ? owner.length > 20
          ? owner.slice(0, 20) + "…"
          : owner
        : "未分配";

  if (!editing) {
    return (
      <button
        type="button"
        className="group flex items-center gap-1 text-xs text-foreground hover:underline"
        onClick={() => setEditing(true)}
      >
        <IconUser className="size-3 text-muted-foreground" />
        {owner ? (
          <span>{displayLabel}</span>
        ) : (
          <span className="text-muted-foreground">未分配</span>
        )}
        <IconEdit className="size-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </button>
    );
  }

  return (
    <Select
      value={owner ?? "none"}
      onValueChange={(v) => {
        update.mutate(
          { id, owner: v === "none" ? null : v },
          {
            onSuccess: () => {
              setEditing(false);
              toast.success("负责人已更新");
            },
          },
        );
      }}
      open
      onOpenChange={(o) => {
        if (!o) setEditing(false);
      }}
    >
      <SelectTrigger className="h-7 w-[140px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none" className="text-xs">
          未分配
        </SelectItem>
        <SelectItem value="agent" className="text-xs">
          智能体
        </SelectItem>
        {members
          .filter((m) => m.email !== "agent")
          .map((m) => (
            <SelectItem key={m.email} value={m.email} className="text-xs">
              {m.email}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

// ── F3: 受守卫流转对话框 (GuardedTransitionDialog) ────────────────────────────
//
// Entry point: the "状态" MetaRow (整行可点击). Options come EXCLUSIVELY from
// get-work-item's `allowedTransitions` — this component never re-implements
// the guard table (02 §8 / server/lib/transition-guard.ts is the only source
// of truth; T-F3-08 requires front/back parity).

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

function GuardedStatusRow({
  item,
}: {
  item: {
    itemKey?: string;
    status: string;
    currentStageName?: string;
    execState?: string | null;
    allowedTransitions?: TransitionOption[];
  };
}) {
  const [open, setOpen] = useState(false);
  const statusLabel = item.status === "done" || item.status === "closed"
    ? item.status
    : (item.currentStageName ?? "待办");

  return (
    <>
      <button
        type="button"
        className="group flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted"
        onClick={() => setOpen(true)}
      >
        <IconListCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="w-20 shrink-0 pt-px text-xs text-muted-foreground">
          状态
        </span>
        <span className="min-w-0 flex-1 text-sm">{statusLabel}</span>
        <IconShieldLock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
      </button>
      {open ? (
        <GuardedTransitionDialog item={item} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

function GuardedTransitionDialog({
  item,
  open,
  onOpenChange,
}: {
  item: {
    itemKey?: string;
    status: string;
    currentStageName?: string;
    execState?: string | null;
    allowedTransitions?: TransitionOption[];
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { id = "" } = useParams();
  const transition = useTransitionWorkItem();
  const options = item.allowedTransitions ?? [];

  const [target, setTarget] = useState<string>(options[0]?.target ?? "");
  const [reason, setReason] = useState("");
  const [verdict, setVerdict] = useState<"PASSED" | "CHANGES_REQUESTED">("PASSED");
  const [commit, setCommit] = useState("");
  const [runId, setRunId] = useState("");
  const [links, setLinks] = useState<string[]>([]);
  const [linkInput, setLinkInput] = useState("");
  const [deliveryItems, setDeliveryItems] = useState<string[]>([]);
  const [deliveryInput, setDeliveryInput] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  const selected = options.find((o) => o.target === target);
  const isDone = target === "done";
  const isClosed = target === "closed";
  const isDelivery = target === "交付";
  // CHANGES_REQUESTED is a review-rejection, not a done-write — the server
  // redirects it to a manual-override rollback to 实施 (S4: 驳回并要求返工),
  // so it only needs `reason`, never a commit.
  const isChangesRequested = isDone && verdict === "CHANGES_REQUESTED";
  const needsEvidence = !!selected && selected.need.length > 0 && !isClosed;
  const needsCommit = !!selected?.need.includes("commit") && !isChangesRequested;
  const needsLinks = !!selected?.need.includes("links");

  const currentStatusBadge = item.status === "done" || item.status === "closed"
    ? item.status
    : (item.currentStageName ?? "待办");

  const reasonValid = reason.trim().length >= 4;
  const doneEvidenceOk =
    !isDone || isChangesRequested || (verdict === "PASSED" && COMMIT_RE.test(commit.trim()));
  const deliveryEvidenceOk = !isDelivery || commit.trim().length > 0 || links.length > 0;
  const canSubmit =
    !!target &&
    reasonValid &&
    doneEvidenceOk &&
    deliveryEvidenceOk &&
    !transition.isPending;

  function addLink() {
    const v = linkInput.trim();
    if (!v) return;
    setLinks((prev) => [...prev, v]);
    setLinkInput("");
  }
  function addDeliveryItem() {
    const v = deliveryInput.trim();
    if (!v) return;
    setDeliveryItems((prev) => [...prev, v]);
    setDeliveryInput("");
  }

  // Submit semantics: PESSIMISTIC refetch, deliberately NOT the optimistic
  // update the S4 design sketched. Nothing is written to the local cache
  // before the server confirms: the dialog closes and queries invalidate
  // (refetch) only in onSuccess; on error the dialog stays open with all
  // fields intact and no local state ever changed. For a guarded transition
  // (where the server can reject on actor/evidence/CAS-conflict grounds) an
  // optimistic status flip would routinely show a state the guard then
  // refuses — safer to wait for the authoritative answer.
  function submit() {
    if (!target) return;
    setServerError(null);
    setMissing([]);
    transition.mutate(
      {
        id,
        target: target as any,
        reason: reason.trim(),
        ...(isDone ? { verdict } : {}),
        ...(commit.trim() || links.length > 0 || deliveryItems.length > 0 || runId.trim()
          ? {
              evidence: {
                ...(commit.trim() ? { commit: commit.trim() } : {}),
                ...(links.length > 0 ? { links } : {}),
                ...(deliveryItems.length > 0 ? { deliveryItems } : {}),
                ...(runId.trim() ? { runId: runId.trim() } : {}),
              },
            }
          : {}),
      },
      {
        onSuccess: (res: unknown) => {
          const r = res as { noop?: boolean } | undefined;
          onOpenChange(false);
          toast.success(
            r?.noop
              ? "无变化(状态未改变)"
              : isChangesRequested
                ? "已驳回并要求返工"
                : "状态已更新",
          );
        },
        onError: (err: unknown) => {
          const e = err as { code?: string; need?: string[]; message?: string };
          if (e?.code === "evidence-missing" && Array.isArray(e.need)) {
            setMissing(e.need);
          }
          setServerError(
            e?.message?.replace(/^Action transition-work-item failed:\s*/, "") ??
              "状态迁移失败",
          );
          // Dialog stays open (per S4 契约) with all fields intact.
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[440px]">
        <DialogHeader>
          <DialogTitle>变更状态 · {item.itemKey ?? id.slice(0, 8)}</DialogTitle>
          <DialogDescription>当前状态与你可执行的迁移(仅列出通过守卫的目标)。</DialogDescription>
        </DialogHeader>
        <div className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          当前状态
          <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
            {currentStatusBadge}
          </Badge>
        </div>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label>目标状态</Label>
            <Select
              value={target}
              onValueChange={(v) => {
                setTarget(v);
                setMissing([]);
                setServerError(null);
              }}
              disabled={options.length === 0}
            >
              <SelectTrigger className={cn(missing.length > 0 && "border-destructive")}>
                <SelectValue placeholder="选择目标状态" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.target} value={o.target}>
                    <span className="flex items-center gap-2">
                      <span>{o.target}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.summary}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                当前状态没有你可执行的人工迁移
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transition-reason">原因</Label>
            <Textarea
              id="transition-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="为什么人工变更?写入审计与活动流"
              rows={3}
              className={cn(!reasonValid && reason.length > 0 && "border-destructive")}
            />
          </div>

          {isDone ? (
            <div className="space-y-1.5">
              <Label>评审结论</Label>
              <RadioGroup
                value={verdict}
                onValueChange={(v) => setVerdict(v as "PASSED" | "CHANGES_REQUESTED")}
                className="grid-flow-col justify-start gap-4"
              >
                <label className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="PASSED" />
                  PASSED
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="CHANGES_REQUESTED" />
                  CHANGES_REQUESTED
                </label>
              </RadioGroup>
            </div>
          ) : null}

          {isClosed ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              关闭后可在已关闭过滤中找回。
            </p>
          ) : null}

          {needsEvidence ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              {needsCommit || target === "交付" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="transition-commit">合并 commit</Label>
                  <Input
                    id="transition-commit"
                    value={commit}
                    onChange={(e) => setCommit(e.target.value)}
                    placeholder="7-40 位 hex(如 a1b2c3d)"
                    className={cn(
                      "font-mono text-xs",
                      missing.includes("commit") && "border-destructive",
                    )}
                  />
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="transition-run">关联 run(可选)</Label>
                <Input
                  id="transition-run"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  placeholder="orchestrator run id"
                  className="font-mono text-xs"
                />
              </div>

              {needsLinks || target === "交付" ? (
                <div className="space-y-1.5">
                  <Label>链接{needsLinks ? "" : "(可选)"}</Label>
                  <div className="flex gap-1.5">
                    <Input
                      value={linkInput}
                      onChange={(e) => setLinkInput(e.target.value)}
                      placeholder="PR / commit 链接"
                      className={cn(
                        "text-xs",
                        missing.includes("links") && "border-destructive",
                      )}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addLink();
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addLink}>
                      <IconPlus className="size-3.5" />
                    </Button>
                  </div>
                  {links.length > 0 ? (
                    <ul className="space-y-1">
                      {links.map((l, i) => (
                        <li
                          key={`${l}-${i}`}
                          className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs"
                        >
                          <span className="truncate">{l}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setLinks((prev) => prev.filter((_, idx) => idx !== i))
                            }
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            <IconX className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label>交付物(可选)</Label>
                <div className="flex gap-1.5">
                  <Input
                    value={deliveryInput}
                    onChange={(e) => setDeliveryInput(e.target.value)}
                    placeholder="交付物名称"
                    className="text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDeliveryItem();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addDeliveryItem}>
                    <IconPlus className="size-3.5" />
                  </Button>
                </div>
                {deliveryItems.length > 0 ? (
                  <ul className="space-y-1">
                    {deliveryItems.map((d, i) => (
                      <li
                        key={`${d}-${i}`}
                        className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs"
                      >
                        <span className="truncate">{d}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setDeliveryItems((prev) => prev.filter((_, idx) => idx !== i))
                          }
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          <IconX className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          {missing.length > 0 || serverError ? (
            <div className="rounded-md bg-destructive/15 px-3 py-2 text-xs text-destructive">
              {missing.length > 0
                ? `缺少证据: ${missing.join(", ")}`
                : serverError}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={transition.isPending}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {transition.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : null}
            {isDone && verdict === "CHANGES_REQUESTED" ? "驳回并要求返工" : "确认变更"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── F5: 任务拆分阈值(规划前置契约,02 §3.10) ────────────────────────────────

/** 规模徽标 — ok=灰点、split-required=warning badge「规模 N 文件」、无估算=浅字. */
function ScaleBadge({ estimate }: { estimate: ScaleEstimate | null | undefined }) {
  if (!estimate) {
    return <span className="text-[11px] text-muted-foreground/70">未估算</span>;
  }
  if (estimate.verdict === "split-required") {
    return (
      <Badge className="h-5 gap-1 bg-amber-100 px-1.5 text-[11px] text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400">
        <IconAlertTriangle className="size-3" />
        规模 {estimate.files} 文件
      </Badge>
    );
  }
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40"
      title="规模估算: ok"
    />
  );
}

/** 告警条(brief 详情/派发面板顶部)— verdict==='split-required' 时出现. */
function ScaleWarningBar({
  workItemId,
  estimate,
  onOpenSplit,
  overrideDispatchPending,
  onOverrideDispatch,
}: {
  workItemId: string;
  estimate: ScaleEstimate;
  onOpenSplit: () => void;
  overrideDispatchPending: boolean;
  onOverrideDispatch: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-500/10 px-3.5 py-2.5 dark:border-amber-700/40">
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium text-foreground">
          预估涉及 {estimate.files} 个文件
          {estimate.crossLifecycle ? " / 跨生命周期协同" : ""}
          ——超过单节点阈值(&gt;6),建议拆分
        </p>
        <p className="mt-0.5 text-muted-foreground">
          M3-D 三次预算耗尽实证:超规模对 vLLM 是确定性失败
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" onClick={onOpenSplit} className="gap-1.5">
          <IconScissors className="size-3.5" />
          一键拆分
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                disabled={overrideDispatchPending}
              >
                仍然派发
              </Button>
            </TooltipTrigger>
            <TooltipContent>人工覆盖将记录审计</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认覆盖规模阈值派发？</AlertDialogTitle>
            <AlertDialogDescription>
              超阈值派发失败率高——M3-D 三次预算耗尽实证。此操作会记录为
              scale.overridden 活动(含估算快照),供后续审计。确认覆盖？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onOverrideDispatch();
              }}
            >
              确认覆盖并派发
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 拆分对话框(shadcn Dialog,560px)— docs/sdlc-impl-f5-f10.md §1B. */
function SplitWorkItemDialog({
  workItemId,
  itemKey,
  estimate,
  open,
  onOpenChange,
}: {
  workItemId: string;
  itemKey?: string;
  estimate: ScaleEstimate | null | undefined;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const splitWorkItem = useSplitWorkItem();
  const [rows, setRows] = useState<{ title: string; description: string }[]>([]);
  const [chainBlockedBy, setChainBlockedBy] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);

  // Re-seed the draft every time the dialog opens (initial pre-fill by file
  // cluster — §1B: "按 signals 里的文件簇分组建议(每组 ≤6 文件)生成 2–3
  // 行草稿").
  function handleOpenChange(v: boolean) {
    if (v) {
      setRows(buildDraftChildren(estimate?.signals ?? []));
      setChainBlockedBy(true);
      setServerError(null);
    }
    onOpenChange(v);
  }

  function updateRow(i: number, patch: Partial<{ title: string; description: string }>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function submit() {
    setServerError(null);
    splitWorkItem.mutate(
      {
        workItemId,
        children: rows.map((r) => ({
          title: r.title.trim(),
          description: r.description.trim() || undefined,
        })),
        chainBlockedBy,
      },
      {
        onSuccess: (res: { children?: { id: string; itemKey: string }[] }) => {
          toast.success(`已拆分为 ${res.children?.length ?? rows.length} 个子单`);
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          const e = err as { code?: string; message?: string };
          setServerError(
            e?.message?.replace(/^Action split-work-item failed:\s*/, "") ??
              "拆分失败",
          );
          // Dialog stays open (S2 契约: 失败红条提示不关框).
        },
      },
    );
  }

  const canSubmit = canSubmitSplit(rows) && !splitWorkItem.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[560px] max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>拆分 {itemKey ?? workItemId.slice(0, 8)}</DialogTitle>
          <DialogDescription>
            按 signals 文件簇预填 · 每子单 ≤6 文件 · itemKey 由项目序列器分配
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {rows.map((row, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 space-y-1.5">
                <Input
                  placeholder="子单标题(必填)"
                  value={row.title}
                  onChange={(e) => updateRow(i, { title: e.target.value })}
                />
                <Textarea
                  placeholder="简述(可选)"
                  rows={2}
                  value={row.description}
                  onChange={(e) => updateRow(i, { description: e.target.value })}
                  className="text-xs"
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                title="删除"
              >
                <IconTrash className="size-4" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setRows((prev) => [...prev, { title: "", description: "" }])}
          >
            <IconPlus className="size-4" />
            添加子单
          </Button>

          <div className="flex items-center gap-2 border-t pt-3">
            <Switch checked={chainBlockedBy} onCheckedChange={setChainBlockedBy} id="chain-blocked-by" />
            <Label htmlFor="chain-blocked-by" className="cursor-pointer text-xs font-normal">
              子单按顺序 blocked-by 链接
            </Label>
          </div>

          {serverError ? (
            <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              {serverError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            {splitWorkItem.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconScissors className="size-4" />
            )}
            确认拆分({rows.length} 子单)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function WorkItemDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: item, isLoading } = useWorkItem(id);
  const dispatch = useDispatch();
  const deleteItem = useDeleteWorkItem();
  const dispatched = !!item?.orchestratorThreadId;
  const activity = useActivity(id, dispatched);
  const triggerStage = useTriggerStage();
  const rollbackStage = useRollbackStage();
  const advanceStage = useAdvanceStage();
  const estimateBriefScale = useEstimateBriefScale();
  const requestApproval = useRequestApproval();

  const [monitorInterval, setMonitorInterval] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activityTab, setActivityTab] = useState<"activity" | "comments">(
    "activity",
  );
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);

  function dispatchArgs(overrideScale?: boolean) {
    const trimmed = monitorInterval.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    const monitorIntervalSec =
      parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : undefined;
    return {
      workItemId: id,
      ...(monitorIntervalSec !== undefined ? { monitorIntervalSec } : {}),
      ...(overrideScale ? { overrideScale: true } : {}),
    };
  }

  function onDispatch() {
    dispatch.mutate(dispatchArgs(), {
      onSuccess: (res: { threadId?: string; blockedBy?: string[] }) => {
        if (res.threadId) {
          toast.success(`已派发 — 大脑线程 ${res.threadId.slice(0, 12)}…`);
        } else if (res.blockedBy?.length) {
          toast.info(`等待依赖完成: ${res.blockedBy.join(", ")}`);
        }
      },
    });
  }

  // F5: "仍然派发" — 人工覆盖 scale-exceeded 拒绝(02 §3.10 决策序①),经
  // AlertDialog 二次确认后带 overrideScale:true 重新派发(scale.overridden
  // 活动落库,见 dispatch-to-orchestrator.ts)。
  function onOverrideDispatch() {
    dispatch.mutate(dispatchArgs(true), {
      onSuccess: (res: { threadId?: string; blockedBy?: string[] }) => {
        if (res.threadId) {
          toast.success(`已覆盖规模阈值派发 — 大脑线程 ${res.threadId.slice(0, 12)}…`);
        } else if (res.blockedBy?.length) {
          toast.info(`等待依赖完成: ${res.blockedBy.join(", ")}`);
        }
      },
    });
  }

  if (isLoading && !item) {
    // 三栏骨架:左 rail(属性,--panel L1 面板)+ 中栏(主内容)+ 右栏
    // (执行/时间/关联/活动,--panel L1 面板),形状与加载完成后的布局一致。
    return (
      <div className="mx-auto max-w-[1400px] space-y-5 p-5 sm:p-6">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
          <Skeleton className="h-96 w-full rounded-xl bg-panel" />
          <div className="min-w-0 space-y-5">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
          <Skeleton className="h-[28rem] w-full rounded-xl bg-panel" />
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">未找到该工作项。</p>
        <Button asChild variant="ghost" className="mt-3 gap-1.5">
          <Link to="/board">
            <IconArrowLeft className="size-4" /> 返回看板
          </Link>
        </Button>
      </div>
    );
  }

  const slot = activity.data?.slot;
  const queue = activity.data?.queue;
  const status = activity.data?.itemStatus ?? item.status;
  const remote = item.project?.gitRemote;
  // F8 (S4 执行组): show the latest NON-EMPTY branch across the item's run
  // history (newest-first; runId may still be null pre-F9-backfill, branch
  // likewise) rather than always the project's default branch — falls back
  // to the item's own `branch` column, then the project default.
  const runs = (item as { runs?: WorkItemRunSummary[] }).runs ?? [];
  const latestRunBranch = runs.find((r) => r.branch)?.branch ?? null;
  const branch = latestRunBranch || item.branch || item.project?.defaultBranch || "main";
  const ghHref = repoHref(remote);
  const ghLabel = repoLabel(remote);

  const riskVal = (item as { risk?: string }).risk ?? "medium";
  const tags = (item as { tags?: string[] }).tags ?? [];
  const sprint =
    (item as { sprint?: { id: string; name: string; status: string } | null })
      .sprint ?? null;
  const itemKey = (item as { itemKey?: string }).itemKey;
  // F8: itemKey 消歧(读路径) — prefer this for anything shown to a human;
  // `itemKey` (raw) stays available for identity/logic uses.
  const itemKeyDisplay =
    (item as { itemKeyDisplay?: string }).itemKeyDisplay ?? itemKey;
  const currentStageName =
    (item as { currentStageName?: string }).currentStageName ?? "待办";
  const plannedStagesList: string[] = (() => {
    try {
      const raw = (item as { plannedStages?: unknown }).plannedStages;
      const parsed = Array.isArray(raw)
        ? raw
        : JSON.parse((raw as string) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const owner = (item as { owner?: string | null }).owner ?? null;
  const nature: string[] = (() => {
    try {
      const raw = (item as { nature?: string }).nature ?? "[]";
      return Array.isArray(raw) ? raw : JSON.parse(raw);
    } catch {
      return [];
    }
  })();

  // Header controls: 触发下一阶段 / 回退阶段 share this stage-neighbor lookup
  // (also used to feed the removed sidebar "Actions card" — both buttons now
  // live in the page header, prototype-style).
  const stageOrder =
    plannedStagesList.length > 0 ? plannedStagesList : [...STAGE_NODES];
  const { nextStage, prevStage } = stageNeighbors(stageOrder, currentStageName);

  function onAdvanceStage() {
    if (!nextStage) return;
    advanceStage.mutate(
      { scope: "item", id, fromStage: currentStageName },
      {
        onSuccess: (res: any) => {
          if (res?.noop) {
            toast.info("无变化(状态已更新)");
          } else if (res?.blocked) {
            toast.error(`阶段推进被阻塞: ${(res.missing || []).join("、")}`);
          } else {
            toast.success(`已推进至「${res?.stageName}」`);
          }
        },
      },
    );
  }

  function onRollbackStage() {
    if (!prevStage) return;
    rollbackStage.mutate(
      { workItemId: id, targetStage: prevStage },
      { onSuccess: () => toast.success(`已回退至「${prevStage}」`) },
    );
  }

  // "升级至裁决" — real request-approval(gateKey:'escalation') gate, the same
  // mechanism the Inbox's failed-routing cards already use (app/lib/inbox.ts
  // canEscalate). Only rendered when the item has a sprint (request-approval
  // requires sprintId) — no fake button when there's nothing to escalate.
  function onEscalate() {
    if (!sprint?.id) return;
    requestApproval.mutate(
      { sprintId: sprint.id, gateKey: "escalation", workItemId: id },
      { onSuccess: () => toast.success("已升级至裁决") },
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* Breadcrumb — 项目 › Sprint › itemKey (原型 s4-work-item.html ~380-384),
          replaces the old bare "← 看板" back-link: the first crumb already
          covers that navigation. */}
      <WorkItemBreadcrumb
        projectId={item.projectId}
        projectName={item.project?.name ?? item.projectId}
        sprint={sprint}
        itemKeyDisplay={itemKeyDisplay ?? item.projectId}
      />

      {/* ── Header — single prototype-style row: badges + title on the left,
          all primary actions (派发/回退阶段/升级至裁决/更多) on the right. ── */}
      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              {itemKeyDisplay ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {itemKeyDisplay}
                </span>
              ) : null}
              <Badge
                variant="outline"
                className={cn(
                  "h-5 px-1.5 text-[11px] capitalize",
                  typeChip(item.type),
                )}
              >
                {item.type}
              </Badge>
              <StatusChip status={status} />
              {slot?.status === "queued" && queue ? (
                <span className="text-xs text-muted-foreground">
                  排队中 · {queue.running}/{queue.brainConcurrency} 个槽位忙碌
                </span>
              ) : null}
              {slot?.status === "running" ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
                  <IconLoader2 className="size-3.5 animate-spin" />
                  运行中
                </span>
              ) : null}
            </div>
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">
              {item.title}
            </h1>
          </div>

          {/* Action cluster — mirrors 重派/回退阶段/升级/更多 (原型 388-395行);
              F5's 估算规模/规模徽标 and the real 监控间隔 setting keep a
              reasonable spot alongside rather than being dropped. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <ScaleBadge estimate={item.scaleEstimate} />
            {!item.scaleEstimate ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-1.5 text-[11px] text-muted-foreground"
                disabled={estimateBriefScale.isPending}
                onClick={() => estimateBriefScale.mutate({ workItemId: id })}
              >
                {estimateBriefScale.isPending ? (
                  <IconLoader2 className="size-3 animate-spin" />
                ) : null}
                估算规模
              </Button>
            ) : null}

            <Button
              onClick={onDispatch}
              disabled={dispatch.isPending}
              className="gap-1.5"
              variant={dispatched ? "outline" : "default"}
            >
              {dispatch.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconRocket className="size-4" />
              )}
              {dispatch.isPending
                ? "派发中…"
                : dispatched
                  ? "重新派发"
                  : "派发给编排器"}
            </Button>

            <Button
              variant="outline"
              className="gap-1.5"
              disabled={rollbackStage.isPending || !prevStage}
              onClick={onRollbackStage}
            >
              {rollbackStage.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconArrowBackUp className="size-4" />
              )}
              回退至{prevStage ? `「${prevStage}」` : "上一阶段"}
            </Button>

            {canEscalateWorkItem(sprint) ? (
              <Button
                variant="outline"
                className="gap-1.5"
                disabled={requestApproval.isPending}
                onClick={onEscalate}
              >
                <IconArrowUp className="size-4" />
                升级至裁决
              </Button>
            ) : null}

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground"
                  title="监控设置"
                >
                  <IconSettings className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-2">
                <Label
                  htmlFor="monitor-interval"
                  className="text-xs text-muted-foreground"
                >
                  监控间隔
                </Label>
                <div className="relative">
                  <Input
                    id="monitor-interval"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    placeholder="120"
                    value={monitorInterval}
                    onChange={(e) => setMonitorInterval(e.target.value)}
                    className="h-8 pr-9 text-sm"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
                    秒
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  周期性漂移检查的节奏。留空 = 默认 120 秒。0 = 仅事件触发(无定时唤醒)。
                </p>
              </PopoverContent>
            </Popover>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground"
                  title="更多"
                >
                  <IconDotsVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  className="gap-2"
                  disabled={!nextStage || advanceStage.isPending}
                  onClick={onAdvanceStage}
                >
                  <IconRocket className="size-4" />
                  触发{nextStage ? `「${nextStage}」` : "下一"}阶段
                </DropdownMenuItem>
                {dispatched && item.orchestratorThreadId ? (
                  <DropdownMenuItem asChild className="gap-2">
                    <a href={orchestratorBrainHref(item.orchestratorThreadId)}>
                      <IconMessageCircle className="size-4" />
                      打开大脑线程
                      <IconExternalLink className="ml-auto size-3 opacity-60" />
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 text-destructive focus:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <IconTrash className="size-4" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {item.scaleEstimate?.verdict === "split-required" ? (
          <ScaleWarningBar
            workItemId={id}
            estimate={item.scaleEstimate}
            onOpenSplit={() => setSplitDialogOpen(true)}
            overrideDispatchPending={dispatch.isPending}
            onOverrideDispatch={onOverrideDispatch}
          />
        ) : null}

        <SplitWorkItemDialog
          workItemId={id}
          itemKey={itemKey}
          estimate={item.scaleEstimate}
          open={splitDialogOpen}
          onOpenChange={setSplitDialogOpen}
        />

        {/* Delete confirmation — triggered from the "更多" menu above. */}
        {confirmDelete ? (
          <div className="mt-3 flex items-center justify-end gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="text-xs text-destructive">
              确认删除该工作项？此操作不可恢复。
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 gap-1"
              disabled={deleteItem.isPending}
              onClick={() => {
                deleteItem.mutate(
                  { id },
                  {
                    onSuccess: () => {
                      toast.success("工作项已删除");
                      navigate(
                        `/board?project=${encodeURIComponent(item.projectId)}`,
                      );
                    },
                  },
                );
              }}
            >
              {deleteItem.isPending ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconTrash className="size-3.5" />
              )}
              确认删除
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </Button>
          </div>
        ) : null}
      </header>

      {/* ── Body —— 三栏：左栏(属性 rail) · 中栏(主内容) · 右栏(执行/时间/关联/活动面板) ── */}
      <div className="grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
        {/* 左栏：导航/元信息 rail —— --panel 表面，sticky（原 Inspector「属性」分组整体迁入） */}
        <aside className="order-1">
          <div className="space-y-3 lg:sticky lg:top-4 rounded-xl border border-border bg-panel px-1">
            <InspectorSection label="属性" first>
              <GuardedStatusRow
                item={{
                  itemKey: itemKeyDisplay,
                  status: item.status,
                  currentStageName,
                  execState: (item as { execState?: string | null }).execState ?? null,
                  allowedTransitions:
                    (item as { allowedTransitions?: TransitionOption[] })
                      .allowedTransitions ?? [],
                }}
              />

              <MetaRow icon={IconFlag} label="优先级">
                <EditablePriority id={id} priority={item.priority} />
              </MetaRow>

              <MetaRow icon={IconAlertTriangle} label="风险">
                <EditableRisk id={id} risk={riskVal} />
              </MetaRow>

              <MetaRow icon={IconCategory} label="类型">
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 px-1.5 text-[11px] capitalize",
                    typeChip(item.type),
                  )}
                >
                  {item.type}
                </Badge>
              </MetaRow>

              <MetaRow icon={IconTag} label="性质">
                <EditableNature id={id} nature={nature} />
              </MetaRow>

              <MetaRow icon={IconStack2} label="Sprint">
                <EditableSprint id={id} sprint={sprint} />
              </MetaRow>

              <MetaRow icon={IconUser} label="负责人">
                <EditableOwner id={id} owner={owner} />
              </MetaRow>

              {itemKey ? (
                <MetaRow icon={IconHash} label="编号">
                  <span
                    className="font-mono text-xs"
                    title={
                      itemKeyDisplay !== itemKey
                        ? "历史重号，已消歧显示"
                        : undefined
                    }
                  >
                    {itemKeyDisplay}
                  </span>
                </MetaRow>
              ) : null}

              <MetaRow icon={IconLayoutKanban} label="项目">
                <Link
                  to={`/board?project=${encodeURIComponent(item.projectId)}`}
                  className="truncate font-medium text-foreground hover:underline"
                >
                  {item.project?.name ?? item.projectId}
                </Link>
              </MetaRow>

              <MetaRow icon={IconTag} label="标签">
                <EditableTags id={id} tags={tags} />
              </MetaRow>
            </InspectorSection>
          </div>
        </aside>

        {/* 中栏：主内容 —— 页面视觉核心 */}
        <div className="order-2 min-w-0 space-y-6">
          <StageProgressCard
            workItemId={id}
            currentStageName={currentStageName}
            plannedStages={plannedStagesList}
          />

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              需求
            </h2>
            <div className="rounded-xl border border-border bg-card/40 p-4">
              {item.description ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                  {item.description}
                </p>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  暂无需求描述。
                </p>
              )}
            </div>
          </section>

          {runs.length > 0 ? (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <IconTimeline className="size-3.5" />
                执行记录
              </h2>
              <div className="rounded-xl border border-border bg-card/40 p-4">
                <RunEvidenceList
                  runs={runs}
                  activity={activity.data}
                  activityLoading={activity.isLoading}
                />
              </div>
            </section>
          ) : null}

          <ArtifactsPanel workItemId={id} />

          {(item.type === "epic" || item.type === "集合") && (
            <EpicChildrenPanel workItemId={id} />
          )}
        </div>

        {/* 右栏：活动/评论/关联信息面板 —— --panel 表面，sticky（原 Inspector「执行」「时间」分组 + 关联/文档/活动/评论/编排器动态迁入） */}
        <aside className="order-3">
          <div className="space-y-3 lg:sticky lg:top-4 rounded-xl border border-border bg-panel px-1">
            <InspectorSection label="执行" first>
              <MetaRow icon={IconBrandGithub} label="仓库">
                {ghHref ? (
                  <a
                    href={ghHref}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 break-all font-mono text-xs hover:text-foreground hover:underline"
                    title={remote ?? undefined}
                  >
                    {ghLabel}
                    <IconExternalLink className="size-3 shrink-0 opacity-60" />
                  </a>
                ) : (
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {ghLabel ?? "未配置仓库"}
                  </span>
                )}
              </MetaRow>

              <MetaRow icon={IconGitBranch} label="分支">
                <span className="font-mono text-xs text-foreground/80">
                  {branch}
                </span>
              </MetaRow>

              {runs.length > 0 ? (
                <MetaRow icon={IconTimeline} label="关联运行">
                  <RunBadgeCompact
                    run={runs.find((r) => !r.superseded) ?? runs[0]!}
                    activity={activity.data}
                  />
                </MetaRow>
              ) : null}

              {item.orchestratorThreadId ? (
                <MetaRow icon={IconMessageCircle} label="大脑">
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <a
                          href={orchestratorBrainHref(
                            item.orchestratorThreadId,
                          )}
                          className="flex items-center gap-1 font-mono text-xs text-foreground/80 hover:text-foreground hover:underline"
                        >
                          {item.orchestratorThreadId.slice(0, 16)}…
                          <IconExternalLink className="size-3 shrink-0 opacity-60" />
                        </a>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        <span className="font-mono text-xs">
                          {item.orchestratorThreadId}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </MetaRow>
              ) : null}
            </InspectorSection>

            <InspectorSection label="时间">
              <MetaRow icon={IconClock} label="创建">
                <span className="text-xs text-muted-foreground">
                  {fmtDateTime(item.createdAt)}
                </span>
              </MetaRow>

              <MetaRow icon={IconClock} label="更新">
                <span className="text-xs text-muted-foreground">
                  {fmtDateTime(item.updatedAt)}
                </span>
              </MetaRow>
            </InspectorSection>
          </div>

          <div className="mt-6 space-y-6">
            <LinksPanel workItemId={id} />

            <DocumentsPanel workItemId={id} />

            <section className="rounded-xl border border-border bg-card/40">
              <div className="flex items-center gap-1 border-b border-border px-4 pt-3 pb-0">
                <button
                  type="button"
                  onClick={() => setActivityTab("activity")}
                  className={cn(
                    "pb-2 px-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                    activityTab === "activity"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  活动
                </button>
                <button
                  type="button"
                  onClick={() => setActivityTab("comments")}
                  className={cn(
                    "pb-2 px-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                    activityTab === "comments"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  评论
                </button>
              </div>
              <div className="p-4">
                {activityTab === "activity" ? (
                  <ActivitiesPanel workItemId={id} />
                ) : (
                  <CommentsPanel workItemId={id} />
                )}
              </div>
            </section>

            {dispatched ? (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    编排器动态
                  </h2>
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        activity.isLoading
                          ? "bg-amber-500 animate-pulse"
                          : "bg-emerald-500",
                      )}
                    />
                    {activity.data?.thread?.status
                      ? `大脑 ${activity.data.thread.status}`
                      : "实时"}
                  </span>
                </div>
                <ActivityFeed
                  dispatched={dispatched}
                  activity={activity.data}
                  isLoading={activity.isLoading}
                />
              </section>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
