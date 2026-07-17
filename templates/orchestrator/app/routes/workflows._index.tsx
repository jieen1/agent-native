import {
  useActionMutation,
  useActionQuery,
  callAction,
} from "@agent-native/core/client";
import {
  IconCode,
  IconPlus,
  IconSitemap,
  IconTopologyStar3,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  WorkflowListRow,
  WorkflowVersionRow,
} from "@/components/v3/workflow-library-types";
import { WorkflowDiffDialog } from "@/components/v3/WorkflowDiffDialog";
import { WorkflowImportDialog } from "@/components/v3/WorkflowImportDialog";
import { WorkflowLibraryCard } from "@/components/v3/WorkflowLibraryCard";
import { WorkflowRunDialog } from "@/components/v3/WorkflowRunDialog";
import { WorkflowVersionChain } from "@/components/v3/WorkflowVersionChain";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 工作流` }];
}

const EMPTY_NEW_FORM = {
  name: "",
  startFrom: "blank" as "blank" | "duplicate",
  duplicateSourceId: "",
};

interface WorkflowGroup {
  label: string;
  rows: WorkflowListRow[];
}

function groupByFamily(rows: WorkflowListRow[]): WorkflowGroup[] {
  const core = rows.filter((r) => r.meta.family === "core");
  const sdlc = rows.filter((r) => r.meta.family === "sdlc");
  const light = rows.filter((r) => r.meta.family === "light");
  const other = rows.filter(
    (r) =>
      r.meta.family !== "core" &&
      r.meta.family !== "sdlc" &&
      r.meta.family !== "light",
  );
  const groups: WorkflowGroup[] = [];
  if (core.length > 0)
    groups.push({ label: "Core 族 · brain 组合微工作流", rows: core });
  if (sdlc.length > 0) groups.push({ label: "SDLC 族 · 内置", rows: sdlc });
  if (light.length > 0) groups.push({ label: "轻量族 · 短流程", rows: light });
  if (other.length > 0) groups.push({ label: "自定义", rows: other });
  return groups;
}

// Static reference table (04 §4 "适用规则（项目级可改）"). Not yet backed by a
// per-project routing-rule data model — no such table exists elsewhere in the
// schema today, and inventing one is out of this task's scope (see the task
// report for the explicit scope call). This mirrors the s8 prototype's content
// verbatim as a read-only reference, editable only by a future project-level
// settings feature.
const APPLICABILITY_RULES: Array<[string, string]> = [
  ["需求 / 任务（sprint 内）", "sdlc-issue-pipeline"],
  ["缺陷 / 生产问题", "hotfix"],
  ["from-audit 单", "hotfix（实施 · 测试）"],
  ["文档", "docs-task"],
  ["调研", "spike-research"],
  ["无 sprint · auto", "quick-task"],
];

export default function V3TemplatesRoute() {
  const navigate = useNavigate();

  const {
    data: templates = [],
    isLoading,
    error,
  } = useActionQuery("workflowList" as any, {}, undefined) as {
    data?: WorkflowListRow[];
    isLoading: boolean;
    error?: unknown;
  };

  const groups = useMemo(() => groupByFamily(templates), [templates]);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  useEffect(() => {
    if (selectedName || templates.length === 0) return;
    setSelectedName(templates[0].name);
  }, [templates, selectedName]);

  const { data: versions = [], isLoading: versionsLoading } = useActionQuery(
    "workflowVersions" as any,
    { name: selectedName ?? "" },
    { enabled: !!selectedName },
  ) as { data?: WorkflowVersionRow[]; isLoading: boolean };

  const saveAction = useActionMutation("workflowSave" as any, {});
  const deleteAction = useActionMutation("workflowDelete" as any, {});

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_NEW_FORM);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicatingRowId, setDuplicatingRowId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowListRow | null>(
    null,
  );
  const [runTemplate, setRunTemplate] = useState<WorkflowListRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setForm(EMPTY_NEW_FORM);
  };

  const handleCreate = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("请输入模板名称");
      return;
    }
    if (form.startFrom === "duplicate" && !form.duplicateSourceId) {
      toast.error("请选择要复制的模板");
      return;
    }

    const finishCreate = (payload: {
      dag: unknown;
      inputSchema?: unknown;
      description?: string;
    }) => {
      saveAction.mutate(
        { name, ...payload },
        {
          onSuccess: (result: any) => {
            toast.success("模板已创建");
            closeCreateDialog();
            navigate(`/workflows/${result.id}`);
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "创建失败");
          },
        },
      );
    };

    if (form.startFrom === "blank") {
      finishCreate({ dag: { nodes: [] } });
      return;
    }

    setDuplicating(true);
    try {
      const source = (await callAction("workflowGet" as any, {
        idOrName: form.duplicateSourceId,
      })) as {
        dag: unknown;
        inputSchema?: unknown;
        description?: string | null;
      };
      finishCreate({
        dag: source.dag,
        inputSchema: source.inputSchema,
        description: source.description ?? undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "读取源模板失败");
    } finally {
      setDuplicating(false);
    }
  };

  const handleDuplicateRow = async (row: WorkflowListRow) => {
    setDuplicatingRowId(row.id);
    try {
      const source = (await callAction("workflowGet" as any, {
        idOrName: row.id,
      })) as {
        dag: unknown;
        inputSchema?: unknown;
        description?: string | null;
      };
      saveAction.mutate(
        {
          name: `${row.name} (副本)`,
          dag: source.dag,
          inputSchema: source.inputSchema,
          description: source.description ?? undefined,
        },
        {
          onSuccess: (result: any) => {
            toast.success("模板已复制");
            navigate(`/workflows/${result.id}`);
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "复制失败");
          },
        },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "复制失败");
    } finally {
      setDuplicatingRowId(null);
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteAction.mutate(
      { idOrName: deleteTarget.id },
      {
        onSuccess: () => {
          toast.success("模板已删除");
          if (selectedName === deleteTarget.name) setSelectedName(null);
          setDeleteTarget(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "删除失败");
          setDeleteTarget(null);
        },
      },
    );
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      <div className="flex items-center gap-2.5 px-6 pb-2.5 pt-3.5">
        <span className="flex size-[30px] items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <IconTopologyStar3 className="size-[17px]" />
        </span>
        <h1 className="text-base font-semibold">工作流</h1>
        <span className="font-mono text-xs text-muted-foreground">
          {templates.length}
        </span>
        <span className="text-xs text-muted-foreground">
          版本化 DAG 模板 · 改流程不改代码
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
            <IconCode className="mr-1 size-3.5" />
            导入 JSON
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <IconPlus className="mr-1 size-3.5" />
            新建工作流
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            加载工作流失败。
          </div>
        ) : isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : templates.length === 0 ? (
          <EmptyState
            icon={IconSitemap}
            title="暂无工作流"
            description="创建一个工作流模板来定义 DAG。"
            className="border-0"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <IconPlus className="mr-1 size-4" />
                新建工作流
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                <div
                  className="grid gap-3"
                  style={{
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(236px, 1fr))",
                  }}
                >
                  {group.rows.map((row) => (
                    <WorkflowLibraryCard
                      key={row.id}
                      row={row}
                      selected={row.name === selectedName}
                      duplicating={duplicatingRowId === row.id}
                      onSelect={() => setSelectedName(row.name)}
                      onView={() => navigate(`/workflows/${row.id}`)}
                      onRun={() => setRunTemplate(row)}
                      onDuplicate={() => handleDuplicateRow(row)}
                      onDelete={() => setDeleteTarget(row)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedName ? (
        <div className="flex gap-5 border-t border-border bg-card px-6 py-3.5">
          <WorkflowVersionChain
            name={selectedName}
            versions={versions}
            isLoading={versionsLoading}
            onOpenDiff={() => setDiffOpen(true)}
          />
          <div className="min-w-[280px] flex-1">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              适用规则（项目级可改）
            </div>
            <table className="w-full text-xs">
              <tbody>
                {APPLICABILITY_RULES.map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-1.5 pr-2 text-muted-foreground">
                      {label}
                    </td>
                    <td className="py-1.5 font-mono text-[11.5px]">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* New workflow dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) =>
          open ? setCreateOpen(true) : closeCreateDialog()
        }
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建工作流模板</DialogTitle>
            <DialogDescription>
              先命名，然后在可视化编辑器中构建 DAG。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-wf-name">模板名称</Label>
              <Input
                id="new-wf-name"
                placeholder="例如 热修复发布流水线"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label>起始方式</Label>
              <RadioGroup
                value={form.startFrom}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    startFrom: v as "blank" | "duplicate",
                  }))
                }
              >
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 hover:bg-accent/50">
                  <RadioGroupItem value="blank" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">空白 DAG</span>
                    <span className="block text-xs text-muted-foreground">
                      从空模板开始，逐步搭建。
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 hover:bg-accent/50">
                  <RadioGroupItem value="duplicate" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">
                      复制现有模板
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      复制下方模板的节点与设置，再进行调整。
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {form.startFrom === "duplicate" ? (
              <div className="space-y-1.5">
                <Label>来源模板</Label>
                <Select
                  value={form.duplicateSourceId}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, duplicateSourceId: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择一个模板" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} (v{t.version})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeCreateDialog}>
              取消
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !form.name.trim() || saveAction.isPending || duplicating
              }
            >
              <IconPlus className="mr-1 size-4" />
              {saveAction.isPending || duplicating ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除模板「{deleteTarget?.name}」?</DialogTitle>
            <DialogDescription>此操作无法撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteAction.isPending}
            >
              {deleteAction.isPending ? "删除中…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkflowRunDialog
        template={runTemplate}
        onOpenChange={(open) => !open && setRunTemplate(null)}
        onRunStarted={(runId) => navigate(`/runs/${runId}`)}
      />

      <WorkflowImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(id) => navigate(`/workflows/${id}`)}
      />

      {selectedName ? (
        <WorkflowDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          name={selectedName}
          versions={versions}
        />
      ) : null}
    </div>
  );
}
