import { useState } from "react";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  IconFile,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — V3 Templates` }];
}

export default function V3TemplatesRoute() {
  const { data: templates = [], isLoading, error } = useActionQuery(
    "workflowList" as any,
    {},
    undefined,
  ) as { data?: any[]; isLoading: boolean; error?: unknown };

  const deleteAction = useActionMutation("workflowDelete" as any, {});
  const saveAction = useActionMutation("workflowSave" as any, {});

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    inputSchema: "",
    dagJson: `{"nodes": []}`,
  });

  const handleCreate = () => {
    if (!form.name.trim()) return;
    saveAction.mutate(
      {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        inputSchema: form.inputSchema.trim()
          ? JSON.parse(form.inputSchema)
          : {},
        dag: JSON.parse(form.dagJson),
      },
      {
        onSuccess: () => {
          setCreateOpen(false);
          setForm({ name: "", description: "", inputSchema: "", dagJson: `{"nodes": []}` });
        },
      },
    );
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            V3 Templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workflow template definitions.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <IconPlus className="mr-1 size-4" />
          New Template
        </Button>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load templates.
        </div>
      ) : (
        <DataTable
          isLoading={isLoading}
          rows={templates}
          rowKey={(r) => (r as any).id ?? (r as any).name}
          columns={[
            {
              id: "name",
              header: "Name",
              cell: (r) => (
                <span className="font-medium text-sm">
                  {(r as any).name ?? (r as any).id}
                </span>
              ),
            },
            {
              id: "version",
              header: "Version",
              cell: (r) => (
                <Badge variant="secondary" className="font-mono text-xs">
                  v{(r as any).version ?? 1}
                </Badge>
              ),
            },
            {
              id: "description",
              header: "Description",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="max-w-xs truncate text-xs text-muted-foreground">
                  {(r as any).description ?? "—"}
                </span>
              ),
            },
            {
              id: "actions",
              header: "",
              cell: (r) => (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    const id = (r as any).id ?? (r as any).name;
                    deleteAction.mutate({ id });
                  }}
                  disabled={saveAction.isPending}
                >
                  <IconTrash className="size-3" />
                </Button>
              ),
            },
          ]}
          empty={
            <EmptyState
              icon={IconFile}
              title="No templates yet"
              description="Create a workflow template to define DAGs."
              className="border-0"
              action={
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <IconPlus className="mr-1 size-4" />
                  New Template
                </Button>
              }
            />
          }
        />
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Template</DialogTitle>
            <DialogDescription>
              Define a new workflow template with name, schema, and DAG.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Template name"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
            />
            <Textarea
              placeholder="Description (optional)"
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              rows={2}
            />
            <Textarea
              placeholder="Input JSON Schema (optional)"
              value={form.inputSchema}
              onChange={(e) =>
                setForm((f) => ({ ...f, inputSchema: e.target.value }))
              }
              rows={3}
              className="font-mono text-xs"
            />
            <Textarea
              placeholder="DAG JSON"
              value={form.dagJson}
              onChange={(e) =>
                setForm((f) => ({ ...f, dagJson: e.target.value }))
              }
              rows={5}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name.trim() || saveAction.isPending}
            >
              {saveAction.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
