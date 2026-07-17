import {
  IconCircleCheck,
  IconAlertCircle,
  IconX,
  IconPlus,
  IconChevronRight,
  IconGripVertical,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  nextPropertyName,
  parseOutputSchemaProperties,
  reorderArray,
  serializeOutputSchemaProperties,
  type SchemaPropertyDraft,
  type SchemaPropertyType,
} from "./output-schema-editor";
import type {
  WorkflowAgentNode,
  WorkflowHumanGateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
} from "./workflow-dag-types";

export interface AgentOption {
  name: string;
}

export interface WorkflowNodeDetailProps {
  node: WorkflowNode | null;
  /** Every other node id in the DAG (never includes the selected node itself). */
  otherNodeIds: string[];
  agents: AgentOption[];
  errors: string[];
  onChange: (next: WorkflowNode) => void;
  onRenameId: (newId: string) => void;
}

// ── Small shared bits ────────────────────────────────────────────────────────

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {help ? (
        <p className="text-[11.5px] text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/** Chip-list editor for an ordered string[] of node ids (deps / loop body). */
function NodeIdListEditor({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const addable = options.filter((o) => !value.includes(o));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium"
        >
          {id}
          <button
            type="button"
            aria-label={`移除 ${id}`}
            onClick={() => onChange(value.filter((v) => v !== id))}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-border hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      {addable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-6 rounded-full"
              aria-label="添加依赖"
            >
              <IconPlus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map((id) => (
              <DropdownMenuItem
                key={id}
                onSelect={() => onChange([...value, id])}
              >
                {id}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {value.length === 0 && addable.length === 0 ? (
        <span className="text-xs text-muted-foreground">无可用节点</span>
      ) : null}
    </div>
  );
}

/** Free-text ordered string[] editor (human_gate `options[]`, enum values) —
 *  drag-to-reorder mirrors WorkflowNodeList's node-reorder interaction
 *  (native HTML5 DnD + grip handle) since neither list's values come from a
 *  fixed set, so NodeIdListEditor's dropdown-based "add" doesn't apply. */
function StringArrayEditor({
  value,
  onChange,
  addPlaceholder = "输入后回车添加",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  addPlaceholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const commitAdd = () => {
    const next = draft.trim();
    if (!next || value.includes(next)) {
      setDraft("");
      return;
    }
    onChange([...value, next]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      {value.length > 0 ? (
        <div className="flex flex-col gap-1">
          {value.map((item, index) => (
            <div
              key={`${item}-${index}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== index) {
                  onChange(reorderArray(value, dragIndex, index));
                }
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1"
            >
              <IconGripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item}
              </span>
              <button
                type="button"
                aria-label={`移除 ${item}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground"
              >
                <IconX className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitAdd();
            }
          }}
          placeholder={addPlaceholder}
          className="h-7 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7 shrink-0"
          aria-label="添加"
          onClick={commitAdd}
        >
          <IconPlus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function GuardField({
  value,
  onChange,
  errors,
}: {
  value: string;
  onChange: (v: string) => void;
  errors: string[];
}) {
  const guardError = errors.find((e) => e.toLowerCase().includes("guard"));
  const hasValue = value.trim().length > 0;
  return (
    <Field label="Guard 条件" help="表达式求值为 false 时跳过该节点。">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例如 input.diff_size < 5000"
          className={cn(
            "pr-8 font-mono text-xs",
            guardError && "border-destructive",
          )}
        />
        {hasValue ? (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            {guardError ? (
              <IconAlertCircle className="size-4 text-destructive" />
            ) : (
              <IconCircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
            )}
          </span>
        ) : null}
      </div>
      {guardError ? (
        <p className="text-[11.5px] text-destructive">{guardError}</p>
      ) : null}
    </Field>
  );
}

/** JSON-editing textarea that only commits the parsed value when valid —
 *  the raw escape hatch behind OutputSchemaField's "原始 JSON" mode. No
 *  Field/Label wrapper of its own so the caller can place its own label and
 *  mode toggle above it. */
function JsonTextarea({
  value,
  onCommit,
  rows = 6,
}: {
  value: unknown;
  onCommit: (next: unknown) => void;
  rows?: number;
}) {
  // Initialized once per mount; the caller remounts this field (via a
  // `key={node.id}` on its parent) whenever the selected node changes, so a
  // fresh draft is seeded from `value` without fighting the user's typing.
  const [draft, setDraft] = useState(() =>
    value == null ? "" : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Textarea
        value={draft}
        rows={rows}
        className="font-mono text-xs"
        placeholder="{}"
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() === "") {
            setError(null);
            onCommit(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(text);
            setError(null);
            onCommit(parsed);
          } catch {
            setError("无效 JSON");
          }
        }}
      />
      {error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}
    </>
  );
}

const PROPERTY_TYPE_LABEL: Record<SchemaPropertyType, string> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔",
  array: "数组",
  object: "对象",
};

/** One property row in the structured output_schema editor: name + type +
 *  required, with an inline enum-values list editor when type is "string" —
 *  enum fields are the first-class case this editor exists for (r4 doc
 *  §4.5), since a judgment node's verdict field is exactly this shape. */
function SchemaPropertyRow({
  property,
  onChange,
  onRemove,
}: {
  property: SchemaPropertyDraft;
  onChange: (next: SchemaPropertyDraft) => void;
  onRemove: () => void;
}) {
  const isEnum =
    property.type === "string" && property.enumValues !== undefined;
  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={property.name}
          onChange={(e) => onChange({ ...property, name: e.target.value })}
          placeholder="字段名"
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Select
          value={property.type}
          onValueChange={(v) =>
            onChange({
              ...property,
              type: v as SchemaPropertyType,
              enumValues: v === "string" ? property.enumValues : undefined,
            })
          }
        >
          <SelectTrigger className="h-7 w-[88px] shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PROPERTY_TYPE_LABEL) as SchemaPropertyType[]).map(
              (t) => (
                <SelectItem key={t} value={t}>
                  {PROPERTY_TYPE_LABEL[t]}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label="移除字段"
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <IconX className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center justify-between gap-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Checkbox
            checked={property.required}
            onCheckedChange={(checked) =>
              onChange({ ...property, required: checked === true })
            }
          />
          必需 (required)
        </label>
        {property.type === "string" ? (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            onClick={() =>
              onChange({
                ...property,
                enumValues: isEnum ? undefined : [],
              })
            }
          >
            {isEnum ? "取消枚举" : "设为枚举 (enum)"}
          </button>
        ) : null}
      </div>
      {isEnum ? (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            枚举值
          </div>
          <StringArrayEditor
            value={property.enumValues ?? []}
            onChange={(enumValues) => onChange({ ...property, enumValues })}
            addPlaceholder="输入取值后回车添加"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Structured `output_schema` editor (r4 doc §4.5 gap #2 — "判断节点的
 * output_schema 以结构化编辑器呈现（enum 字段一等呈现）"). Any agent node can
 * have an `output_schema`; the ones referenced by a downstream guard/until
 * expression are the "judgment nodes" §4.2's lint rule 2 requires to declare
 * an enum verdict field — this editor makes that enum the primary thing you
 * edit (add/remove/reorder values as list items) instead of hand-typing
 * JSON Schema. Schemas the structured model can't fully represent (a nested
 * object/array property, `$ref`, a non-string enum, …) keep the "原始 JSON"
 * tab as the only option rather than risk losing that structure on commit.
 */
function OutputSchemaField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  // Re-parsed from `value` on every render (cheap, pure) rather than cached
  // in local state — `value` is the single source of truth (owned by the
  // parent node), so a raw-JSON edit is immediately reflected if the user
  // flips back to "结构化", and a schema that becomes exotic via raw editing
  // correctly re-disables the structured tab instead of silently discarding
  // it on the next structured commit.
  const parsed = parseOutputSchemaProperties(value);
  const [mode, setMode] = useState<"structured" | "raw">(() =>
    parsed.structurable ? "structured" : "raw",
  );
  const effectiveMode = parsed.structurable ? mode : "raw";

  const commit = (next: SchemaPropertyDraft[]) => {
    onCommit(serializeOutputSchemaProperties(next));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-[11px]">
          <button
            type="button"
            disabled={!parsed.structurable}
            onClick={() => setMode("structured")}
            title={
              parsed.structurable
                ? undefined
                : "当前 JSON 结构超出可视化编辑器支持范围（如嵌套对象/$ref），仅可用原始 JSON 编辑"
            }
            className={cn(
              "rounded px-1.5 py-0.5",
              effectiveMode === "structured"
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground",
              !parsed.structurable && "cursor-not-allowed opacity-40",
            )}
          >
            结构化
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={cn(
              "rounded px-1.5 py-0.5",
              effectiveMode === "raw"
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            原始 JSON
          </button>
        </div>
      </div>

      {effectiveMode === "structured" ? (
        <div className="space-y-2">
          {parsed.properties.map((p, index) => (
            <SchemaPropertyRow
              key={index}
              property={p}
              onChange={(next) =>
                commit(
                  parsed.properties.map((p2, i) => (i === index ? next : p2)),
                )
              }
              onRemove={() =>
                commit(parsed.properties.filter((_, i) => i !== index))
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-full gap-1.5 text-xs"
            onClick={() =>
              commit([
                ...parsed.properties,
                {
                  name: nextPropertyName(parsed.properties.map((p) => p.name)),
                  type: "string",
                  required: false,
                },
              ])
            }
          >
            <IconPlus className="size-3.5" />
            添加字段
          </Button>
        </div>
      ) : (
        <JsonTextarea value={value} onCommit={onCommit} />
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function WorkflowNodeDetail({
  node,
  otherNodeIds,
  agents,
  errors,
  onChange,
  onRenameId,
}: WorkflowNodeDetailProps) {
  const [idDraft, setIdDraft] = useState(node?.id ?? "");
  useEffect(() => setIdDraft(node?.id ?? ""), [node?.id]);

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        选择左侧的一个节点查看和编辑其详情。
      </div>
    );
  }

  const commitRename = () => {
    const trimmed = idDraft.trim();
    if (trimmed && trimmed !== node.id) onRenameId(trimmed);
    else setIdDraft(node.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 truncate border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        节点 · {node.id}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Field
          label="节点 ID"
          help="其他节点的 deps/body 会随重命名一起更新；guard/until 表达式中的引用不会自动更新。"
        >
          <Input
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="font-mono text-sm"
          />
        </Field>

        {node.type === "agent" ? (
          <AgentFields
            key={node.id}
            node={node}
            agents={agents}
            onChange={onChange}
          />
        ) : null}
        {node.type === "human_gate" ? (
          <HumanGateFields key={node.id} node={node} onChange={onChange} />
        ) : null}
        {node.type === "parallel_over" ? (
          <ParallelFields
            key={node.id}
            node={node}
            otherNodeIds={otherNodeIds}
            onChange={onChange}
          />
        ) : null}
        {node.type === "loop" ? (
          <LoopFields
            key={node.id}
            node={node}
            otherNodeIds={otherNodeIds}
            onChange={onChange}
          />
        ) : null}

        {node.type !== "parallel_over" && node.type !== "loop" ? (
          <Field label="依赖节点 (Depends on)">
            <NodeIdListEditor
              value={node.deps ?? []}
              options={otherNodeIds}
              onChange={(deps) => onChange({ ...node, deps } as WorkflowNode)}
            />
          </Field>
        ) : null}

        <GuardField
          value={node.guard ?? ""}
          errors={errors}
          onChange={(guard) =>
            onChange({ ...node, guard: guard || undefined } as WorkflowNode)
          }
        />
      </div>
    </div>
  );
}

// ── Per-type field groups ────────────────────────────────────────────────────

function AgentFields({
  node,
  agents,
  onChange,
}: {
  node: WorkflowAgentNode;
  agents: AgentOption[];
  onChange: (next: WorkflowNode) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const agentOptions =
    node.agent && !agents.some((a) => a.name === node.agent)
      ? [{ name: node.agent }, ...agents]
      : agents;

  return (
    <>
      <Field label="智能体 (Agent)">
        <Select
          value={node.agent || undefined}
          onValueChange={(v) => onChange({ ...node, agent: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择智能体" />
          </SelectTrigger>
          <SelectContent>
            {agentOptions.map((a) => (
              <SelectItem key={a.name} value={a.name}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="提示词 (Prompt)">
        <Textarea
          value={node.prompt}
          onChange={(e) => onChange({ ...node, prompt: e.target.value })}
          rows={6}
          className="font-mono text-xs"
          placeholder="输入该节点的提示词…"
        />
      </Field>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-sm font-medium">
          <IconChevronRight
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              advancedOpen && "rotate-90",
            )}
          />
          高级设置
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <OutputSchemaField
            label="输出 Schema (output_schema)"
            value={node.output_schema}
            onCommit={(v) => onChange({ ...node, output_schema: v })}
          />

          <div className="grid grid-cols-2 gap-3">
            <Field label="引擎覆盖 (engine_override)">
              <Input
                value={node.engine_override ?? ""}
                onChange={(e) =>
                  onChange({
                    ...node,
                    engine_override: e.target.value || undefined,
                  })
                }
                placeholder="例如 vllm"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="模型覆盖 (model_override)">
              <Input
                value={node.model_override ?? ""}
                onChange={(e) =>
                  onChange({
                    ...node,
                    model_override: e.target.value || undefined,
                  })
                }
                placeholder="例如 qwen3.6"
                className="font-mono text-xs"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="最大重试次数 (retry.max)">
              <Input
                type="number"
                min={1}
                value={node.retry?.max ?? ""}
                onChange={(e) => {
                  const n =
                    e.target.value === "" ? undefined : Number(e.target.value);
                  onChange({
                    ...node,
                    retry:
                      n == null
                        ? undefined
                        : { ...(node.retry ?? { max: 1 }), max: n },
                  });
                }}
              />
            </Field>
            <Field label="退避策略 (backoff)">
              <Select
                value={node.retry?.backoff ?? "__none"}
                onValueChange={(v) =>
                  onChange({
                    ...node,
                    retry:
                      v === "__none"
                        ? node.retry
                          ? { ...node.retry, backoff: undefined }
                          : undefined
                        : {
                            ...(node.retry ?? { max: 1 }),
                            backoff: v as "exponential" | "linear" | "fixed",
                          },
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="默认" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">默认</SelectItem>
                  <SelectItem value="exponential">指数退避</SelectItem>
                  <SelectItem value="linear">线性退避</SelectItem>
                  <SelectItem value="fixed">固定间隔</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="超时时间 (timeout_seconds)">
              <Input
                type="number"
                min={0}
                value={node.timeout_seconds ?? ""}
                onChange={(e) =>
                  onChange({
                    ...node,
                    timeout_seconds:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="摘要 Token 上限 (max_summary_tokens)">
              <Input
                type="number"
                min={0}
                value={node.max_summary_tokens ?? ""}
                onChange={(e) =>
                  onChange({
                    ...node,
                    max_summary_tokens:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>

          <Field label="工作区 (workspace)">
            <Input
              value={node.workspace ?? ""}
              onChange={(e) =>
                onChange({ ...node, workspace: e.target.value || undefined })
              }
              className="font-mono text-xs"
            />
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function HumanGateFields({
  node,
  onChange,
}: {
  node: WorkflowHumanGateNode;
  onChange: (next: WorkflowNode) => void;
}) {
  return (
    <>
      <Field label="提示词 (Prompt)">
        <Textarea
          value={node.prompt}
          onChange={(e) => onChange({ ...node, prompt: e.target.value })}
          rows={4}
          placeholder="展示给审批人的说明…"
        />
      </Field>

      <Field
        label="决议选项 (options)"
        help="人工在此节点决议时可选的答案；nodeResolveGate 会按此列表校验选择。留空则接受任意非空字符串。"
      >
        <StringArrayEditor
          value={node.options ?? []}
          onChange={(options) =>
            onChange({
              ...node,
              options: options.length > 0 ? options : undefined,
            })
          }
          addPlaceholder="例如 approve / reject，回车添加"
        />
      </Field>
    </>
  );
}

function ParallelFields({
  node,
  otherNodeIds,
  onChange,
}: {
  node: WorkflowParallelNode;
  otherNodeIds: string[];
  onChange: (next: WorkflowNode) => void;
}) {
  return (
    <>
      <Field
        label="依赖节点 (Depends on)"
        help="parallel_over 至少需要一个依赖。"
      >
        <NodeIdListEditor
          value={node.deps ?? []}
          options={otherNodeIds}
          onChange={(deps) => onChange({ ...node, deps })}
        />
      </Field>

      <Field label="子任务节点 (body)" help="并行执行的目标节点。">
        <Select
          value={node.body || undefined}
          onValueChange={(v) => onChange({ ...node, body: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择一个节点" />
          </SelectTrigger>
          <SelectContent>
            {otherNodeIds.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="并发上限 (max_concurrency)">
          <Input
            type="number"
            min={1}
            value={node.max_concurrency ?? ""}
            onChange={(e) =>
              onChange({
                ...node,
                max_concurrency:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="items_from (表达式)">
          <Input
            value={node.items_from ?? ""}
            onChange={(e) =>
              onChange({ ...node, items_from: e.target.value || undefined })
            }
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </>
  );
}

function LoopFields({
  node,
  otherNodeIds,
  onChange,
}: {
  node: WorkflowLoopNode;
  otherNodeIds: string[];
  onChange: (next: WorkflowNode) => void;
}) {
  return (
    <>
      <Field label="依赖节点 (Depends on)">
        <NodeIdListEditor
          value={node.deps ?? []}
          options={otherNodeIds}
          onChange={(deps) => onChange({ ...node, deps })}
        />
      </Field>

      <Field label="循环体节点 (body)" help="按顺序在每轮迭代中执行的节点。">
        <NodeIdListEditor
          value={node.body ?? []}
          options={otherNodeIds}
          onChange={(body) => onChange({ ...node, body })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="until (表达式)">
          <Input
            value={node.until ?? ""}
            onChange={(e) =>
              onChange({ ...node, until: e.target.value || undefined })
            }
            className="font-mono text-xs"
          />
        </Field>
        <Field label="最大迭代次数 (max_iterations)">
          <Input
            type="number"
            min={1}
            value={node.max_iterations ?? node.maxIterations ?? ""}
            onChange={(e) => {
              const n =
                e.target.value === "" ? undefined : Number(e.target.value);
              onChange({ ...node, max_iterations: n, maxIterations: n });
            }}
          />
        </Field>
      </div>

      <Field label="items_from (表达式)">
        <Input
          value={node.items_from ?? ""}
          onChange={(e) =>
            onChange({ ...node, items_from: e.target.value || undefined })
          }
          className="font-mono text-xs"
        />
      </Field>
    </>
  );
}
