import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  useActionMutation,
  useActionQuery,
  callAction,
} from "@agent-native/core/client";
import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  IconEdit,
  IconCopy,
  IconTrash,
  IconPlus,
  IconSitemap,
  IconInfoCircle,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — 工作流` }];
}

interface WorkflowRow {
  id: string;
  name: string;
  version: number;
  description: string | null;
  nodeCount: number;
  createdAt: string | null;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo} 个月前`;
    return `${Math.floor(mo / 12)} 年前`;
  } catch {
    return iso;
  }
}

const EMPTY_NEW_FORM = {
  name: "",
  startFrom: "blank" as "blank" | "duplicate",
  duplicateSourceId: "",
};

export default function V3TemplatesRoute() {
  const navigate = useNavigate();

  const {
    data: templates = [],
    isLoading,
    error,
  } = useActionQuery("workflowList" as any, {}, undefined) as {
    data?: WorkflowRow[];
    isLoading: boolean;
    error?: unknown;
  };

  const saveAction = useActionMutation("workflowSave" as any, {});
  const deleteAction = useActionMutation("workflowDelete" as any, {});

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_NEW_FORM);
  const [duplicating, setDuplicating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<WorkflowRow | null>(null);
  const [duplicatingRowId, setDuplicatingRowId] = useState<string | null>(null);

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

  const handleDuplicateRow = async (row: WorkflowRow) => {
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
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            工作流
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            派发运行所依据的 DAG
            模板。打开模板即可在可视化编辑器中构建和校验其图结构。
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <IconPlus className="mr-1 size-4" />
          新建模板
        </Button>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          加载模板失败。
        </div>
      ) : (
        <>
          <DataTable<WorkflowRow>
            isLoading={isLoading}
            rows={templates}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/workflows/${r.id}`)}
            columns={[
              {
                id: "name",
                header: "名称",
                cell: (r) => (
                  <span className="font-medium text-sm">{r.name}</span>
                ),
              },
              {
                id: "version",
                header: "版本",
                cell: (r) => (
                  <Badge variant="secondary" className="font-mono text-xs">
                    v{r.version}
                  </Badge>
                ),
              },
              {
                id: "nodes",
                header: "节点数",
                className: "hidden sm:table-cell",
                headClassName: "hidden sm:table-cell",
                cell: (r) => (
                  <span className="text-xs text-muted-foreground">
                    {r.nodeCount}
                  </span>
                ),
              },
              {
                id: "stages",
                header: "使用中的阶段",
                className: "hidden md:table-cell",
                headClassName: "hidden md:table-cell",
                cell: () => (
                  <span className="text-xs text-muted-foreground">—</span>
                ),
              },
              {
                id: "modified",
                header: "最后修改",
                className: "hidden lg:table-cell",
                headClassName: "hidden lg:table-cell",
                cell: (r) => (
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmtRelative(r.createdAt)}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "",
                cell: (r) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0"
                      aria-label="编辑"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/workflows/${r.id}`);
                      }}
                    >
                      <IconEdit className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0"
                      aria-label="复制"
                      disabled={duplicatingRowId === r.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDuplicateRow(r);
                      }}
                    >
                      <IconCopy className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0 text-destructive hover:text-destructive"
                      aria-label="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(r);
                      }}
                    >
                      <IconTrash className="size-3.5" />
                    </Button>
                  </div>
                ),
              },
            ]}
            empty={
              <EmptyState
                icon={IconSitemap}
                title="暂无模板"
                description="创建一个工作流模板来定义 DAG。"
                className="border-0"
                action={
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <IconPlus className="mr-1 size-4" />
                    新建模板
                  </Button>
                }
              />
            }
          />
          {templates.length > 0 ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <IconInfoCircle className="size-3.5 shrink-0" />
              「使用中的阶段」列出引用该工作流的阶段派发配置。
            </div>
          ) : null}
        </>
      )}

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
    </div>
  );
}
