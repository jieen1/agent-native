import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  useCreateWorkItem,
  useEnqueueWorkItem,
  useSprints,
  useProjects,
} from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  IconArrowLeft,
  IconArrowRight,
  IconGitBranch,
  IconLoader2,
  IconMailPlus,
  IconListCheck,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { Sprint, ItemType, ItemRisk } from "@shared/types";

// ── Segment toggle group ────────────────────────────────────────────────────

function Segmented({
  options,
  value,
  onChange,
  variant = "primary",
}: {
  options: string[];
  value: string | string[];
  onChange: (v: string | string[]) => void;
  variant?: "primary" | "secondary" | "outline";
}) {
  const isMulti = Array.isArray(value);

  function handleClick(opt: string) {
    if (isMulti) {
      const current = new Set(value as string[]);
      if (current.has(opt)) current.delete(opt);
      else current.add(opt);
      onChange(Array.from(current));
    } else {
      onChange(opt);
    }
  }

  const base = "relative h-9 px-3 text-xs font-medium transition-colors";
  const variants: Record<string, string> = {
    primary:
      "text-muted-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground",
    secondary:
      "text-muted-foreground data-[active=true]:bg-secondary data-[active=true]:text-secondary-foreground",
    outline:
      "border border-input bg-background text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
  };

  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted/40 p-0.5">
      {options.map((opt) => {
        const active = isMulti
          ? (value as string[]).includes(opt)
          : value === opt;
        return (
          <button
            key={opt}
            type="button"
            data-active={active}
            onClick={() => handleClick(opt)}
            className={cn(
              base,
              "first:rounded-[5px] last:rounded-[5px]",
              !isMulti ? "rounded-[5px]" : "",
              variants[variant],
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

// ── Field wrappers ──────────────────────────────────────────────────────────

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-sm font-medium">
        {label}
        {required && (
          <span className="text-destructive">*</span>
        )}
      </Label>
      {children}
      {hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

// ── Tag chips for multi-select nature labels ────────────────────────────────

const NATURE_OPTIONS = ["前端", "后端", "API", "数据"] as const;

function NatureTags({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {NATURE_OPTIONS.map((tag) => {
        const active = value.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => {
              const next = active
                ? value.filter((t) => t !== tag)
                : [...value, tag];
              onChange(next);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent",
            )}
          >
            {active ? (
              <IconMailPlus className="size-3" />
            ) : null}
            {tag}
          </button>
        );
      })}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function NewWorkItemPage() {
  const navigate = useNavigate();

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Type (single)
  const [type, setType] = useState<ItemType | string>("需求");
  const TYPE_OPTIONS: ItemType[] = ["需求", "任务", "缺陷", "测试", "生产问题", "集合"];

  // Priority (single)
  const [priorityLabel, setPriorityLabel] = useState("中");

  // Risk (single)
  const [risk, setRisk] = useState<ItemRisk>("medium");

  // Nature tags (multi)
  const [natureTags, setNatureTags] = useState<string[]>([]);

  // Project
  const [projectId, setProjectId] = useState("");

  // Sprint
  const [sprintId, setSprintId] = useState("");

  // Execution mode
  const [executionMode, setExecutionMode] = useState("auto");

  // Hook states
  const { data: projectsData } = useProjects();
  const projects = useMemo(() => (Array.isArray(projectsData) ? projectsData : []), [projectsData]);
  const { data: sprintsData, isLoading: sprintsLoading } = useSprints();
  const sprints: Sprint[] = useMemo(
    () => (Array.isArray(sprintsData) ? sprintsData : []),
    [sprintsData],
  );
  const createWorkItem = useCreateWorkItem();
  const enqueueWorkItem = useEnqueueWorkItem();

  const autoMode = executionMode === "auto";

  const selectedSprint = sprints.find((s) => s.id === sprintId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("请输入标题");
      return;
    }

    if (!projectId) {
      toast.error("请先选择项目");
      return;
    }

    const payload = {
      projectId,
      title: title.trim(),
      description: description.trim(),
      type: type as "需求" | "任务" | "缺陷" | "测试" | "生产问题" | "集合",
      priority: priorityMap(priorityLabel),
      risk,
      tags: natureTags,
      sprintId: sprintId || undefined,
      executionMode: (autoMode ? "auto" : "manual") as "auto" | "manual",
    };

    try {
      await createWorkItem.mutateAsync(payload);
      toast.success("工作项已创建");
      if (autoMode && sprintId) {
        await enqueueWorkItem.mutateAsync({
          workItemId: createWorkItem.data?.id || "",
        });
      }
      navigate("/board");
    } catch {
      toast.error("创建工作项失败");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* ── Header ── */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to="/board"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <IconArrowLeft className="size-3.5" />
              看板
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">
              新建工作项
            </h1>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
          {/* ── Card 1: 基本信息 ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">
                基本信息
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="项目" required>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p: { id: string; name: string }) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="标题" required>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="简要描述这个工作项"
                  autoFocus
                />
              </Field>
              <Field label="描述 / 原始需求">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="补充详细描述或粘贴原始需求..."
                  className="flex min-h-[100px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </Field>
            </CardContent>
          </Card>

          {/* ── Card 2: 分类 ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">分类</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="类型" required>
                <Segmented
                  options={TYPE_OPTIONS}
                  value={type}
                  onChange={(v) => setType(v as ItemType)}
                />
              </Field>

              <Field label="优先级">
                <Select value={priorityLabel} onValueChange={setPriorityLabel}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="紧急">紧急</SelectItem>
                    <SelectItem value="高">高</SelectItem>
                    <SelectItem value="中">中</SelectItem>
                    <SelectItem value="低">低</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="风险">
                <Segmented
                  options={["低", "中", "高"]}
                  value={risk === "low" ? "低" : risk === "high" ? "高" : "中"}
                  onChange={(v) =>
                    setRisk(
                      v === "低"
                        ? "low"
                        : v === "高"
                          ? "high"
                          : "medium",
                    )
                  }
                />
              </Field>

              <Field label="性质标签">
                <NatureTags
                  value={natureTags}
                  onChange={setNatureTags}
                />
              </Field>
            </CardContent>
          </Card>

          {/* ── Card 3: 归属与模式 ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">
                归属与模式
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="所属 Sprint">
                {sprintsLoading ? (
                  <div className="flex h-10 w-48 animate-pulse items-center rounded-md border border-input bg-muted/40 text-xs text-muted-foreground">
                    加载中…
                  </div>
                ) : (
                  <Select
                    value={sprintId}
                    onValueChange={setSprintId}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue placeholder="选择 Sprint" />
                    </SelectTrigger>
                    <SelectContent>
                      {sprints.length === 0 ? (
                        <SelectItem value="__none" disabled>
                          暂无 Sprint
                        </SelectItem>
                      ) : (
                        sprints.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              ({s.status})
                            </span>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              {selectedSprint?.branch && (
                <div className="flex items-center gap-2">
                  <IconGitBranch className="size-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs text-muted-foreground flex items-center gap-1">
                    {selectedSprint.branch}
                    <IconArrowRight className="size-3" />
                    {selectedSprint.name}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 p-3">
                <div>
                  <p className="text-sm font-medium">执行模式</p>
                  <p className="text-xs text-muted-foreground">
                    {autoMode
                      ? "自动创建后直接并入队列"
                      : "创建后手动入队"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs font-medium",
                      !autoMode && "text-muted-foreground",
                    )}
                  >
                    手动
                  </span>
                  <Switch
                    checked={autoMode}
                    onCheckedChange={(c) =>
                      setExecutionMode(c ? "auto" : "manual")
                    }
                  />
                  <span
                    className={cn(
                      "text-xs font-medium",
                      autoMode && "text-muted-foreground",
                    )}
                  >
                    自动
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Action row ── */}
          <div className="flex items-center justify-end gap-2 rounded-lg border border-border bg-card p-4 shadow-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              asChild
            >
              <Link to="/board">
                <IconX className="size-4" />
                取消
              </Link>
            </Button>
            {autoMode ? (
              <Button
                type="submit"
                size="sm"
                className="gap-1.5"
                disabled={createWorkItem.isPending}
              >
                {createWorkItem.isPending ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconListCheck className="size-4" />
                )}
                创建并入队列
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={createWorkItem.isPending}
            >
              {createWorkItem.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconMailPlus className="size-4" />
              )}
              创建工作项
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function priorityMap(label: string): number {
  switch (label) {
    case "紧急": return 1;
    case "高": return 2;
    case "中": return 3;
    case "低": return 4;
    default: return 3;
  }
}
