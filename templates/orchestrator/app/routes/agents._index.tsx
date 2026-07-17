import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconCheck,
  IconDeviceFloppy,
  IconFileText,
  IconLock,
  IconPlus,
  IconRobot,
  IconSearch,
  IconTerminal2,
  IconTrash,
  IconUser,
  IconWorld,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { MarkdownPreview } from "@/components/skills/MarkdownPreview";
import { MarkdownSourceEditor } from "@/components/skills/MarkdownSourceEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

// ── Real engine/model/runtime mapping ────────────────────────────────────────
//
// The previous version of this page assumed engine/model were driven by a
// `list-runtime-configs` runtime→model cascade (Settings). That concept does
// not exist for DAG agent defs: `runtime_configs` is a separate, singleton
// "active chat engine" setting unrelated to per-agent-def engine selection.
//
// The REAL mechanism (confirmed by tracing v3-dispatcher.ts / agent-loader.ts
// / server/vllm-engine.ts):
//   - `engine` selects the execution path: "vllm" (the singleton, env-configured
//     local vLLM engine — server/vllm-engine.ts) | "claude-code" (routes through
//     the ACP Claude Code harness) | "ai-sdk:anthropic" (a real built-in AI SDK
//     engine, packages/core/src/agent/engine/builtin.ts, requires
//     ANTHROPIC_API_KEY).
//   - `runtime` is the field v3-dispatcher.ts's `isClaudeCodeRuntime(...)`
//     actually checks to route a node through the Claude Code harness — NOT
//     `engine` alone. In practice only two values are ever produced:
//     "none" (default engine executor) and "acp:claude-code" (Claude Code
//     harness) — see server/plugins/agent-defs-seed.ts's builtin seed rows and
//     actions/save-agent-def.ts's engine→runtime derivation. So it is shown
//     here as a derived, read-only field rather than a fabricated free-choice
//     select.
//   - `model`: vLLM is a fixed local engine, so its models come from the real
//     VLLM_MODELS list in server/vllm-engine.ts (kept in sync manually here —
//     there is no shared-package export of that template-local constant).
//     Claude Code / ai-sdk:anthropic model ids are free-form strings, so they
//     are a plain text field.

/** Mirrors VLLM_MODELS in templates/orchestrator/server/vllm-engine.ts. */
const VLLM_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "qwen3.6",
  "ornith-1.0-35b",
] as const;

const CLAUDE_CODE_RUNTIME = "acp:claude-code";

/**
 * `ai-sdk:anthropic` is included because it IS a real, built-in registered
 * engine (packages/core/src/agent/engine/builtin.ts registers
 * `ai-sdk:${provider}` for every entry in its `aiSdkProviders` list, which
 * includes "anthropic" — requiredEnvVars: ["ANTHROPIC_API_KEY"]). Its exact
 * supported-model list is computed from an internal, env-dependent constant
 * in packages/core (not exported for template use), so its model field is
 * free text rather than a hardcoded — and potentially stale — select list.
 */
const ENGINE_OPTIONS = [
  { value: "vllm", label: "本地 vLLM" },
  { value: "claude-code", label: "Claude Code" },
  { value: "ai-sdk:anthropic", label: "Claude (AI SDK)" },
] as const;

const TOOL_GROUPS: Array<{
  label: string;
  icon: typeof IconFileText;
  tools: string[];
}> = [
  {
    label: "文件操作",
    icon: IconFileText,
    tools: ["Read", "Write", "Edit", "NotebookEdit"],
  },
  { label: "搜索", icon: IconSearch, tools: ["Glob", "Grep"] },
  { label: "执行", icon: IconTerminal2, tools: ["Bash", "Task"] },
  { label: "网络", icon: IconWorld, tools: ["WebFetch", "WebSearch"] },
];

/** Derive the real `runtime` value for a given `engine` (see mapping note above). */
function runtimeForEngine(engine: string): string {
  return engine === "claude-code" ? CLAUDE_CODE_RUNTIME : "none";
}

function defaultModelForEngine(engine: string): string {
  if (engine === "vllm") return VLLM_MODELS[0];
  if (engine === "claude-code") return "claude-sonnet-4-6";
  return "";
}

/** Matches list-agent-defs.ts's actual return shape 1:1 (id, name, engine,
 * model, tools (parsed array), description, runtime, builtin, version,
 * systemPrompt, createdAt, updatedAt, ownerEmail, canEdit). `canEdit` is
 * server-computed (mirrors save-agent-def/delete-agent-def's write check) —
 * never re-derive it client-side from `ownerEmail`. */
interface AgentDef {
  id: string;
  name: string;
  engine: string;
  model: string;
  tools: string[];
  description: string;
  runtime: string;
  builtin: boolean;
  version: number;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  ownerEmail: string;
  canEdit: boolean;
}

interface SaveAgentDefInput {
  name: string;
  engine: string;
  model: string;
  tools: string[];
  systemPrompt: string;
  description?: string;
  runtime?: string;
}

interface SaveAgentDefResult {
  id: string;
  name: string;
  ok: boolean;
}

interface DeleteAgentDefResult {
  id: string;
  name: string;
  ok: boolean;
}

interface AgentForm {
  name: string;
  engine: string;
  model: string;
  runtime: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}

const EMPTY_FORM: AgentForm = {
  name: "",
  engine: "vllm",
  model: VLLM_MODELS[0],
  runtime: "none",
  description: "",
  tools: [],
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
  } = useActionQuery<AgentDef[]>("list-agent-defs" as any, {}, undefined);

  const saveMutation = useActionMutation<SaveAgentDefResult, SaveAgentDefInput>(
    "save-agent-def" as any,
    {},
  );
  const deleteMutation = useActionMutation<
    DeleteAgentDefResult,
    { id: string }
  >("delete-agent-def" as any, {});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  // Explicit "user clicked + 新建智能体" flag — distinct from "nothing
  // selected yet". Deriving new-mode from `selectedId === null` made the full
  // create-agent form (engine/model/runtime/tools/systemPrompt editor) render
  // immediately on page load, before the user asked to create anything. The
  // idle/empty state now only shows once creatingNew is explicitly set.
  const [creatingNew, setCreatingNew] = useState(false);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const isNewMode = creatingNew;
  const isBuiltin = selectedAgent?.builtin === true;
  // Non-builtin row created by someone else: server-computed `canEdit` is the
  // sole source of truth (never re-derive ownership from a raw email
  // comparison client-side).
  const isForeignReadOnly =
    !isNewMode && !!selectedAgent && !isBuiltin && !selectedAgent.canEdit;
  const isReadOnly = isBuiltin || isForeignReadOnly;

  const handleSelect = useCallback((agent: AgentDef) => {
    setSelectedId(agent.id);
    setCreatingNew(false);
    setForm({
      name: agent.name,
      engine: agent.engine,
      model: agent.model,
      runtime: agent.runtime || runtimeForEngine(agent.engine),
      description: agent.description,
      tools: [...agent.tools],
      systemPrompt: agent.systemPrompt,
    });
  }, []);

  const handleNew = useCallback(() => {
    setSelectedId(null);
    setCreatingNew(true);
    setForm({ ...EMPTY_FORM, tools: [] });
  }, []);

  const handleEngineChange = useCallback((value: string) => {
    setForm((f) => ({
      ...f,
      engine: value,
      runtime: runtimeForEngine(value),
      model: defaultModelForEngine(value),
    }));
  }, []);

  const toggleTool = useCallback((tool: string) => {
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(tool)
        ? f.tools.filter((t) => t !== tool)
        : [...f.tools, tool],
    }));
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
        runtime: form.runtime,
      },
      {
        onSuccess: () => {
          toast.success(isNewMode ? "智能体已创建" : "智能体已保存");
          refetch();
          if (isNewMode) {
            setSelectedId(null);
            setCreatingNew(false);
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
          setForm({ ...EMPTY_FORM, tools: [] });
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
            管理工作智能体定义 — 引擎、模型、运行时、工具与系统提示。
          </p>
        </div>
        <Button size="sm" onClick={handleNew}>
          <IconPlus className="mr-1 size-4" />
          新建智能体
        </Button>
      </header>

      <div className="flex items-start gap-6">
        {/* ── Left column: agent list (master) ─────────────────────────── */}
        <div className="w-64 shrink-0 space-y-1">
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
            <>
              {agents.map((a) => {
                const isActive = !isNewMode && a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handleSelect(a)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      isActive
                        ? "bg-accent font-medium text-accent-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    <IconRobot className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{a.name}</span>
                    {a.builtin ? (
                      <>
                        <IconLock className="size-3.5 shrink-0 text-muted-foreground" />
                        <Badge variant="secondary" className="ml-1 text-[10px]">
                          内置
                        </Badge>
                      </>
                    ) : (
                      <Badge
                        variant="outline"
                        title={`由 ${a.ownerEmail} 创建`}
                        className="ml-1 max-w-[110px] shrink-0 truncate border-info/30 bg-info/10 text-[10px] font-normal text-info"
                      >
                        由 {a.ownerEmail} 创建
                      </Badge>
                    )}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                  暂无智能体。点击「新建智能体」创建。
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right column: detail panel ───────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {!selectedAgent && !isNewMode ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border text-center text-sm text-muted-foreground">
              <IconRobot className="size-8 text-muted-foreground/50" />
              {agents.length === 0 ? (
                <>
                  <p>还没有智能体</p>
                  <Button size="sm" variant="secondary" onClick={handleNew}>
                    <IconPlus className="mr-1 size-4" />
                    新建智能体
                  </Button>
                </>
              ) : (
                <p>选择左侧一个智能体，或新建一个</p>
              )}
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

              {/* Foreign read-only banner — non-builtin row created by
                  another account (server-computed canEdit === false) */}
              {isForeignReadOnly && (
                <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
                  <IconLock className="size-3.5" />
                  由他人创建，只读
                </div>
              )}

              {/* Owner badge — non-builtin rows only (builtin already has its
                  own "内置" identity above) */}
              {!isNewMode && selectedAgent && !isBuiltin && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <IconUser className="size-3.5" />
                  <span>由 {selectedAgent.ownerEmail} 创建</span>
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
                    onValueChange={handleEngineChange}
                    disabled={isReadOnly}
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
                  {form.engine === "vllm" ? (
                    <Select
                      value={form.model}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, model: v }))
                      }
                      disabled={isReadOnly}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {VLLM_MODELS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={form.model}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, model: e.target.value }))
                      }
                      disabled={isReadOnly}
                      placeholder="claude-sonnet-4-6"
                      className="font-mono text-xs"
                    />
                  )}
                </div>
              </div>

              {/* Runtime — derived from engine, not independently editable:
                  only "none" and "acp:claude-code" are ever produced by this
                  app (agent-loader.ts's AgentRuntime type, agent-defs-seed.ts's
                  builtin rows, save-agent-def.ts's engine→runtime derivation).
                  Shown so the real routing field is no longer hidden from
                  the form. */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">运行时</span>
                <Badge variant="outline" className="font-mono">
                  {form.runtime}
                </Badge>
                <span>
                  {form.runtime === CLAUDE_CODE_RUNTIME
                    ? "由引擎自动决定 — 通过 ACP Claude Code 代理运行此节点。"
                    : "由引擎自动决定 — 通过标准引擎执行器运行此节点。"}
                </span>
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
                  disabled={isReadOnly}
                  placeholder="智能体描述"
                />
              </div>

              {/* Tools — grouped multi-select chips */}
              <div className="space-y-1.5">
                <Label>工具</Label>
                <div className="flex flex-col gap-3.5 rounded-md border p-3.5">
                  {TOOL_GROUPS.map((group) => (
                    <div key={group.label} className="flex flex-col gap-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        <group.icon className="size-3.5" />
                        {group.label}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {group.tools.map((tool) => {
                          const selected = form.tools.includes(tool);
                          return (
                            <button
                              key={tool}
                              type="button"
                              disabled={isReadOnly}
                              aria-pressed={selected}
                              onClick={() => toggleTool(tool)}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                                selected
                                  ? "border-accent bg-accent text-accent-foreground"
                                  : "border-border bg-background text-foreground hover:bg-muted",
                                isReadOnly && "pointer-events-none opacity-60",
                              )}
                            >
                              {tool}
                              {selected ? (
                                <IconCheck className="size-3.5" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* System Prompt — split source/preview markdown editor.
                  Reuses the SAME MarkdownSourceEditor/MarkdownPreview pair the
                  Skills / Runbook editor uses (SkillEditorPane.tsx), whose
                  gutter is generated from a single `lineCount` (derived from
                  one `value.split("\n")`) driving one `Array.from` loop, and
                  scroll-synced by mirroring the textarea's scrollTop onto the
                  gutter on every scroll event — see MarkdownSourceEditor.tsx. */}
              <div className="space-y-1.5">
                <Label>系统提示</Label>
                <div className="grid h-[420px] grid-cols-2 overflow-hidden rounded-md border">
                  <div className="flex min-w-0 flex-col overflow-hidden border-r">
                    <div className="shrink-0 border-b bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Markdown 源码
                    </div>
                    <MarkdownSourceEditor
                      value={form.systemPrompt}
                      onChange={(v) =>
                        setForm((f) => ({ ...f, systemPrompt: v }))
                      }
                      disabled={isReadOnly}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col overflow-hidden">
                    <div className="shrink-0 border-b bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      预览
                    </div>
                    <div className="flex-1 overflow-auto px-6 py-5">
                      <MarkdownPreview markdown={form.systemPrompt} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              {!isReadOnly && (
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
