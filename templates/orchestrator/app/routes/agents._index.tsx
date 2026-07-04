import { useCallback, useMemo, useState } from "react";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { APP_TITLE } from "@/lib/app-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import {
  IconDeviceFloppy,
  IconLock,
  IconPlus,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";

const ENGINE_OPTIONS = [
  { value: "vllm", label: "vLLM" },
  { value: "ai-sdk:anthropic", label: "AI SDK: Anthropic" },
  { value: "acp:claude-code", label: "ACP: Claude Code" },
];

const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "qwen3.6", label: "Qwen 3.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const TOOL_OPTIONS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "Edit",
  "Write",
];

const EMPTY_FORM = {
  name: "",
  engine: "vllm",
  model: "qwen3.6",
  description: "",
  tools: [] as string[],
  systemPrompt: "",
};

export function meta() {
  return [{ title: `${APP_TITLE} — 智能体` }];
}

export default function AgentsRoute() {
  const {
    data: agents = [],
    isLoading,
    error,
    refetch,
  } = useActionQuery(
    "list-agent-defs" as any,
    {},
    undefined,
  ) as {
    data?: Array<Record<string, unknown>>;
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };

  const saveMutation = useActionMutation("save-agent-def" as any, {});
  const deleteMutation = useActionMutation("delete-agent-def" as any, {});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const isNewMode = selectedId === null;
  const isBuiltin = selectedAgent?.builtin === true;

  // Sync form when a new agent is selected
  const handleSelect = useCallback(
    (agent: Record<string, unknown>) => {
      setSelectedId(agent.id as string);
      setForm({
        name: (agent.name as string) ?? "",
        engine: (agent.engine as string) ?? "vllm",
        model: (agent.model as string) ?? "qwen3.6",
        description: (agent.description as string) ?? "",
        tools: Array.isArray(agent.tools) ? (agent.tools as string[]) : [],
        systemPrompt: (agent.systemPrompt as string) ?? "",
      });
    },
    [],
  );

  const handleNew = useCallback(() => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
  }, []);

  const handleSave = useCallback(() => {
    if (!form.name.trim() || !form.engine.trim() || !form.model.trim()) {
      toast.error("请填写必要字段");
      return;
    }
    saveMutation.mutate(
      {
        name: form.name.trim(),
        engine: form.engine,
        model: form.model,
        tools: form.tools,
        systemPrompt: form.systemPrompt,
        description: form.description || undefined,
      },
      {
        onSuccess: () => {
          toast.success(isNewMode ? "智能体已创建" : "智能体已保存");
          refetch();
          if (isNewMode) {
            setSelectedId(null);
          }
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "保存失败");
        },
      },
    );
  }, [form, isNewMode, saveMutation, refetch]);

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    deleteMutation.mutate(
      { id: selectedId },
      {
        onSuccess: () => {
          toast.success("智能体已删除");
          setSelectedId(null);
          setForm(EMPTY_FORM);
          refetch();
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "删除失败");
        },
      },
    );
  }, [selectedId, deleteMutation, refetch]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            智能体
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理工作智能体定义 — 引擎、模型、工具与系统提示。
          </p>
        </div>
        <Button size="sm" onClick={handleNew}>
          <IconPlus className="mr-1 size-4" />
          新建智能体
        </Button>
      </header>

      <div className="flex gap-6">
        {/* ── Left column: agent list ────────────────────────────────────── */}
        <div className="w-72 shrink-0">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              加载失败。
            </div>
          ) : isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {agents.map((a) => {
                const isActive = a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handleSelect(a)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? "bg-accent font-medium text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    <IconRobot className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1">
                      {(a as any).name ?? a.id}
                    </span>
                    {(a as any).builtin ? (
                      <IconLock className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    {(a as any).builtin ? (
                      <Badge variant="secondary" className="ml-1 text-[10px]">
                        内置
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                  暂无智能体。点击「新建智能体」创建。
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right column: edit form ─────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {!selectedAgent && !isNewMode ? (
            <div className="flex h-40 items-center justify-center rounded-lg border text-sm text-muted-foreground">
              选择左侧一个智能体，或新建一个。
            </div>
          ) : (
            <div className="space-y-5 rounded-lg border bg-card p-6">
              {/* Builtin banner */}
              {isBuiltin && (
                <div className="flex items-center gap-2 rounded-md border border-yellow-200/60 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-800/40 dark:bg-yellow-950/30 dark:text-yellow-300">
                  <IconLock className="size-3.5" />
                  内置智能体，只读
                </div>
              )}

              {/* Name */}
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">名称</Label>
                <Input
                  id="agent-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  disabled={!!selectedId || isBuiltin}
                  placeholder="智能体名称（创建后不可修改）"
                />
              </div>

              {/* Engine + Model row */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>引擎</Label>
                  <Select
                    value={form.engine}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, engine: v }))
                    }
                    disabled={isBuiltin}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择引擎" />
                    </SelectTrigger>
                    <SelectContent>
                      {ENGINE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>模型</Label>
                  <Select
                    value={form.model}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, model: v }))
                    }
                    disabled={isBuiltin}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <Label htmlFor="agent-desc">描述</Label>
                <Input
                  id="agent-desc"
                  value={form.description}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                  disabled={isBuiltin}
                  placeholder="智能体描述"
                />
              </div>

              {/* Tools */}
              <div className="space-y-1.5">
                <Label>工具</Label>
                <ToggleGroup
                  type="multiple"
                  value={form.tools}
                  onValueChange={(v: string[]) =>
                    setForm((f) => ({ ...f, tools: v }))
                  }
                  disabled={isBuiltin}
                >
                  {TOOL_OPTIONS.map((t) => (
                    <ToggleGroupItem key={t} value={t}>
                      {t}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              {/* System Prompt */}
              <div className="space-y-1.5">
                <Label htmlFor="agent-prompt">系统提示</Label>
                <Textarea
                  id="agent-prompt"
                  value={form.systemPrompt}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, systemPrompt: e.target.value }))
                  }
                  disabled={isBuiltin}
                  rows={10}
                  className="font-mono text-xs"
                  placeholder="输入系统提示（System Prompt）..."
                />
              </div>

              {/* Actions */}
              {!isBuiltin && (
                <div className="flex gap-3 pt-2">
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saveMutation.isPending}
                  >
                    <IconDeviceFloppy className="mr-1 size-4" />
                    {saveMutation.isPending ? "保存中..." : "保存"}
                  </Button>
                  {!isNewMode && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleteMutation.isPending}
                    >
                      <IconTrash className="mr-1 size-4" />
                      {deleteMutation.isPending ? "删除中..." : "删除"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}