import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import { toast } from "sonner";
import {
  IconLock,
  IconPackages,
  IconPlus,
  IconRobot,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import {
  useDeleteNodeDef,
  useNodeDefs,
  useSeedLibrary,
  type NodeDef,
} from "@/hooks/use-library";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconDots } from "@tabler/icons-react";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { ConfirmDialog } from "@/components/board/ConfirmDialog";
import { NodeDefDialog } from "@/components/dialogs/NodeDefDialog";

export function meta() {
  return [{ title: `${APP_TITLE} — Library` }];
}

// Node library (FRONTEND §7). list-node-defs in a DataTable: key, kind
// (tool/agent), version, lock glyph, config preview. + New / Edit (D7) / Delete
// (D8, blocked when referenced) / Seed starter library.
export default function LibraryRoute() {
  const { t } = useTranslation();
  const { data: nodeDefs = [], isLoading } = useNodeDefs();
  const deleteNodeDef = useDeleteNodeDef();
  const seedLibrary = useSeedLibrary();
  const navigate = useActionMutation("navigate", {});

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<NodeDef | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NodeDef | null>(null);

  useEffect(() => {
    navigate.mutate({ view: "library" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }
  function openEdit(nd: NodeDef) {
    setEditTarget(nd);
    setDialogOpen(true);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteNodeDef.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          toast.success(t("common.deleted"));
        },
        onError: (e: unknown) => {
          setDeleteTarget(null);
          toast.error(
            e instanceof Error ? e.message : t("library.deleteBlocked"),
          );
        },
      },
    );
  }

  function seed() {
    seedLibrary.mutate(
      {},
      {
        onSuccess: () => toast.success(t("library.seeded")),
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("common.actionFailed")),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {t("library.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("library.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={seed}
            disabled={seedLibrary.isPending}
          >
            <IconSparkles className="size-4" />
            {t("library.seed")}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <IconPlus className="size-4" />
            {t("library.newNode")}
          </Button>
        </div>
      </header>

      <DataTable<NodeDef>
        isLoading={isLoading}
        rows={nodeDefs}
        rowKey={(n) => n.id}
        onRowClick={openEdit}
        columns={[
          {
            id: "key",
            header: t("library.columnKey"),
            cell: (n) => (
              <span className="flex items-center gap-1.5 font-mono text-xs">
                <IconLock
                  className="size-3.5 text-muted-foreground"
                  aria-label={t("library.locked")}
                />
                {n.key}
              </span>
            ),
          },
          {
            id: "kind",
            header: t("library.columnKind"),
            cell: (n) => (
              <span className="inline-flex items-center gap-1 text-xs">
                {n.kind === "agent" ? (
                  <IconRobot className="size-3.5" />
                ) : (
                  <IconTool className="size-3.5" />
                )}
                {n.kind === "agent"
                  ? t("library.kindAgent")
                  : t("library.kindTool")}
              </span>
            ),
          },
          {
            id: "title",
            header: t("library.columnTitle"),
            cell: (n) => (
              <span className="text-sm">
                {n.title || <span className="text-muted-foreground">—</span>}
              </span>
            ),
          },
          {
            id: "version",
            header: t("library.columnVersion"),
            cell: (n) => (
              <span className="font-mono text-xs text-muted-foreground">
                v{n.version}
              </span>
            ),
          },
          {
            id: "config",
            header: t("library.columnConfig"),
            className: "hidden md:table-cell",
            headClassName: "hidden md:table-cell",
            cell: (n) => (
              <span className="line-clamp-1 max-w-[220px] font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(n.config)}
              </span>
            ),
          },
          {
            id: "actions",
            header: "",
            className: "w-10 text-right",
            cell: (n) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("common.edit")}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconDots className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenuItem onSelect={() => openEdit(n)}>
                    {t("common.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                    onSelect={() => setDeleteTarget(n)}
                  >
                    {t("common.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]}
        empty={
          <EmptyState
            icon={IconPackages}
            title={t("library.emptyTitle")}
            description={t("library.emptyDescription")}
            className="border-0"
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={seed}
                  disabled={seedLibrary.isPending}
                >
                  <IconSparkles className="size-4" />
                  {t("library.seed")}
                </Button>
                <Button size="sm" onClick={openCreate}>
                  <IconPlus className="size-4" />
                  {t("library.newNode")}
                </Button>
              </div>
            }
          />
        }
      />

      <NodeDefDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        nodeDef={editTarget}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("dialog.deleteNodeTitle")}
        description={t("dialog.deleteNodeBody")}
        pending={deleteNodeDef.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
