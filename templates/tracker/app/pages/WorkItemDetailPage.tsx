import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBrandGithub,
  IconCheck,
  IconClock,
  IconEdit,
  IconCircleCheck,
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

import { ActivityFeed } from "@/components/ActivityFeed";
import {
  fmtDateTime,
  orchestratorBrainHref,
  repoHref,
  repoLabel,
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  useStages,
  useWorkItem,
  useSprints,
  useTriggerStage,
  useRollbackStage,
  useAdvanceStage,
  useRunAcceptance,
  useEpicChildren,
  useDocuments,
  useAddDocument,
  useDeleteDocument,
} from "@/hooks/use-tracker";
import { cn } from "@/lib/utils";

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
              <span className="text-muted-foreground">
                {l.direction === "from" ? (
                  <IconArrowRight className="size-3" />
                ) : (
                  <IconArrowLeft className="size-3" />
                )}
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
                  >
                    {child.itemKey || child.id}
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
                        className="flex items-center gap-1 text-[10px] text-orange-600 dark:text-orange-400"
                      >
                        <span className="truncate">{dep.fromLabel}</span>
                        <IconArrowLeft className="size-2.5 shrink-0" />
                        <span className="shrink-0">blocked-by</span>
                        <IconArrowLeft className="size-2.5 shrink-0" />
                        <span className="truncate">{dep.toLabel}</span>
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
      </SelectContent>
    </Select>
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
  const runAcceptance = useRunAcceptance();

  const [monitorInterval, setMonitorInterval] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activityTab, setActivityTab] = useState<"activity" | "comments">(
    "activity",
  );
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const [acceptUrl, setAcceptUrl] = useState("");

  function onDispatch() {
    const trimmed = monitorInterval.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    const monitorIntervalSec =
      parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : undefined;
    dispatch.mutate(
      monitorIntervalSec !== undefined
        ? { workItemId: id, monitorIntervalSec }
        : { workItemId: id },
      {
        onSuccess: (res: { threadId: string }) => {
          toast.success(`已派发 — 大脑线程 ${res.threadId.slice(0, 12)}…`);
        },
      },
    );
  }

  function submitAcceptance() {
    const url = acceptUrl.trim();
    if (!url) {
      toast.error("请输入待验证页面 URL");
      return;
    }
    runAcceptance.mutate(
      {
        workItemId: id,
        scenarios: [
          {
            name: "手动截图验收",
            kind: "screenshot" as const,
            url,
          },
        ],
      },
      {
        onSuccess: (res: {
          verdict: "pass" | "reject";
          passed: number;
          scenarios: unknown[];
        }) => {
          setAcceptDialogOpen(false);
          setAcceptUrl("");
          const total = res.scenarios?.length ?? 0;
          if (res.verdict === "pass") {
            toast.success(`验收通过 — ${res.passed}/${total}`);
          } else {
            toast.error(`验收驳回 — ${res.passed}/${total}`);
          }
        },
      },
    );
  }

  if (isLoading && !item) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
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
  const branch = item.project?.defaultBranch ?? "main";
  const ghHref = repoHref(remote);
  const ghLabel = repoLabel(remote);

  const riskVal = (item as { risk?: string }).risk ?? "medium";
  const tags = (item as { tags?: string[] }).tags ?? [];
  const sprint =
    (item as { sprint?: { id: string; name: string; status: string } | null })
      .sprint ?? null;
  const itemKey = (item as { itemKey?: string }).itemKey;
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

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 gap-1.5">
        <Link to={`/board?project=${encodeURIComponent(item.projectId)}`}>
          <IconArrowLeft className="size-4" /> 看板
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {item.project?.key ? (
            <span className="font-mono text-xs font-medium text-muted-foreground">
              {item.project.key}
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

        {/* Controls row */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
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

          <div className="flex items-center gap-2">
            <Label
              htmlFor="monitor-interval"
              className="whitespace-nowrap text-xs text-muted-foreground"
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
                className="h-8 w-24 pr-9 text-sm"
                title="周期性漂移检查的节奏。留空 = 默认 120 秒。0 = 仅事件触发(无定时唤醒)。"
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
                秒
              </span>
            </div>
          </div>

          {dispatched && item.orchestratorThreadId ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1.5 text-muted-foreground"
            >
              <a href={orchestratorBrainHref(item.orchestratorThreadId)}>
                <IconMessageCircle className="size-3.5" />
                打开大脑线程
                <IconExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : null}

          {/* Delete button */}
          {confirmDelete ? (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-destructive">确认删除？</span>
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
                删除
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
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-8 gap-1.5 text-muted-foreground hover:text-destructive",
                dispatched ? "" : "ml-auto",
              )}
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrash className="size-3.5" />
              删除
            </Button>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* Left column */}
        <div className="order-2 min-w-0 space-y-6 lg:order-1">
          {/* Stage progress card */}
          <StageProgressCard
            workItemId={id}
            currentStageName={currentStageName}
            plannedStages={plannedStagesList}
          />

          {/* Requirement */}
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

          {/* Epic children (only for epic/集合 work items) */}
          {(item.type === "epic" || item.type === "集合") && (
            <EpicChildrenPanel workItemId={id} />
          )}

          {/* Links */}
          <LinksPanel workItemId={id} />

          {/* Documents */}
          <DocumentsPanel workItemId={id} />

          {/* Unified activity + comments tab panel */}
          <section className="rounded-xl border border-border bg-card/40">
            {/* Tab header */}
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

          {/* Orchestrator Activity Feed */}
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

        {/* Right column: context */}
        <aside className="order-1 lg:order-2">
          <div className="space-y-3 lg:sticky lg:top-4">
            {/* Actions card */}
            {(() => {
              // Use item's plannedStages; fallback to full 7-stage order
              const FALLBACK_ORDER = [
                "待办",
                "分析",
                "设计",
                "实施",
                "测试",
                "验收",
                "交付",
              ] as const;
              let plannedStagesArr: string[];
              try {
                const raw = (item as any).plannedStages;
                plannedStagesArr = Array.isArray(raw)
                  ? raw
                  : JSON.parse(raw ?? "[]");
              } catch {
                plannedStagesArr = [];
              }
              const stageOrder =
                plannedStagesArr.length > 0 ? plannedStagesArr : FALLBACK_ORDER;
              const idx = stageOrder.indexOf(currentStageName);
              const nextStage =
                idx >= 0 && idx < stageOrder.length - 1
                  ? stageOrder[idx + 1]
                  : null;
              const prevStage = idx > 0 ? stageOrder[idx - 1] : null;
              return (
                <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                  <Button
                    className="w-full gap-1.5"
                    size="sm"
                    disabled={!nextStage || advanceStage.isPending}
                    onClick={() =>
                      nextStage &&
                      advanceStage.mutate(
                        { scope: "item", id, fromStage: currentStageName },
                        {
                          onSuccess: (res: any) => {
                            if (res?.noop) {
                              toast.info("无变化(状态已更新)");
                            } else if (res?.blocked) {
                              toast.error(
                                `阶段推进被阻塞: ${(res.missing || []).join("、")}`,
                              );
                            } else {
                              toast.success(`已推进至「${res?.stageName}」`);
                            }
                          },
                        },
                      )
                    }
                  >
                    {advanceStage.isPending ? (
                      <IconLoader2 className="size-3.5 animate-spin" />
                    ) : (
                      <IconRocket className="size-3.5" />
                    )}
                    触发{nextStage ? `「${nextStage}」` : "下一"}阶段
                  </Button>
                  <Button
                    className="w-full gap-1.5"
                    size="sm"
                    variant="outline"
                    disabled={rollbackStage.isPending || !prevStage}
                    onClick={() =>
                      prevStage &&
                      rollbackStage.mutate(
                        { workItemId: id, targetStage: prevStage },
                        {
                          onSuccess: () =>
                            toast.success(`已回退至 ${prevStage}`),
                        },
                      )
                    }
                  >
                    {rollbackStage.isPending ? (
                      <IconLoader2 className="size-3.5 animate-spin" />
                    ) : null}
                    回退至{prevStage ? `「${prevStage}」` : "上一阶段"}
                  </Button>
                  <Dialog
                    open={acceptDialogOpen}
                    onOpenChange={setAcceptDialogOpen}
                  >
                    <DialogTrigger asChild>
                      <Button
                        className="w-full gap-1.5"
                        size="sm"
                        variant="outline"
                      >
                        <IconCircleCheck className="size-3.5" />
                        运行验收
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>运行验收</DialogTitle>
                        <DialogDescription>
                          对指定页面截图验证，生成验收报告并完成「验收」阶段。
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-1.5">
                        <Label htmlFor="accept-url">待验证页面 URL</Label>
                        <Input
                          id="accept-url"
                          type="url"
                          value={acceptUrl}
                          onChange={(e) => setAcceptUrl(e.target.value)}
                          placeholder="https://..."
                          autoFocus
                        />
                      </div>
                      <DialogFooter>
                        <Button
                          variant="ghost"
                          onClick={() => setAcceptDialogOpen(false)}
                        >
                          取消
                        </Button>
                        <Button
                          disabled={runAcceptance.isPending}
                          onClick={submitAcceptance}
                        >
                          {runAcceptance.isPending ? (
                            <IconLoader2 className="size-3.5 animate-spin" />
                          ) : (
                            <IconCircleCheck className="size-3.5" />
                          )}
                          运行
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              );
            })()}

            {/* Attributes card */}
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
              {itemKey ? (
                <MetaRow icon={IconHash} label="编号">
                  <span className="font-mono text-xs">{itemKey}</span>
                </MetaRow>
              ) : null}

              <MetaRow icon={IconUser} label="负责人">
                <EditableOwner id={id} owner={owner} />
              </MetaRow>

              <MetaRow icon={IconStack2} label="Sprint">
                <EditableSprint id={id} sprint={sprint} />
              </MetaRow>

              <MetaRow icon={IconListCheck} label="当前阶段">
                <span className="text-sm">{currentStageName}</span>
              </MetaRow>

              <MetaRow icon={IconFlag} label="优先级">
                <EditablePriority id={id} priority={item.priority} />
              </MetaRow>

              <MetaRow icon={IconAlertTriangle} label="风险">
                <EditableRisk id={id} risk={riskVal} />
              </MetaRow>

              <MetaRow icon={IconTag} label="性质">
                <EditableNature id={id} nature={nature} />
              </MetaRow>

              <MetaRow icon={IconTag} label="标签">
                <EditableTags id={id} tags={tags} />
              </MetaRow>

              <MetaRow icon={IconLayoutKanban} label="项目">
                <Link
                  to={`/board?project=${encodeURIComponent(item.projectId)}`}
                  className="truncate font-medium text-foreground hover:underline"
                >
                  {item.project?.name ?? item.projectId}
                </Link>
              </MetaRow>

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

              <MetaRow icon={IconClock} label="创建时间">
                <span className="text-xs text-muted-foreground">
                  {fmtDateTime(item.createdAt)}
                </span>
              </MetaRow>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
