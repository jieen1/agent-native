import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/board/EmptyState";
import { IconInbox } from "@tabler/icons-react";
import { useQueueControls } from "@/hooks/use-queue";
import type { WorkItem } from "@/hooks/use-work-items";
import type { TemplateListItem } from "@/hooks/use-templates";

// D2 — Bulk enqueue to orchestrator (FRONTEND §10). multiselect idle items +
// workflow ▾ + concurrencyDegree. Submits enqueue-work-item ×N + set-concurrency.
// Sets execState→queued; business status is untouched.
export interface EnqueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Candidate items (the dialog filters to idle/failed/done — enqueueable). */
  items: WorkItem[];
  workflows?: TemplateListItem[];
  /** Current worker-pool width, for the slider default. */
  currentConcurrency?: number;
  projectKeyOf?: (item: WorkItem) => string | undefined;
}

export function EnqueueDialog({
  open,
  onOpenChange,
  items,
  workflows = [],
  currentConcurrency = 1,
  projectKeyOf,
}: EnqueueDialogProps) {
  const { t } = useTranslation();
  const { enqueue, setConcurrency } = useQueueControls();

  const enqueueable = useMemo(
    () =>
      items.filter(
        (i) =>
          i.execState === "idle" ||
          i.execState === "failed" ||
          i.execState === "done",
      ),
    [items],
  );

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [workflowId, setWorkflowId] = useState("auto");
  const [degree, setDegree] = useState(currentConcurrency);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected({});
    setWorkflowId("auto");
    setDegree(currentConcurrency);
    setPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedIds = useMemo(
    () => enqueueable.filter((i) => selected[i.id]).map((i) => i.id),
    [enqueueable, selected],
  );

  async function submit() {
    if (selectedIds.length === 0) return;
    setPending(true);
    try {
      await setConcurrency.mutateAsync({ degree });
      for (const id of selectedIds) {
        await enqueue.mutateAsync({
          id,
          workflowId: workflowId === "auto" ? undefined : workflowId,
        });
      }
      toast.success(t("board.enqueued"));
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialog.enqueueTitle")}</DialogTitle>
          <DialogDescription>{t("dialog.enqueueSubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>{t("dialog.enqueueItems")}</Label>
            {enqueueable.length === 0 ? (
              <EmptyState
                icon={IconInbox}
                title={t("dialog.enqueueEmpty")}
                className="p-6"
              />
            ) : (
              <ScrollArea className="h-48 rounded-md border border-border">
                <ul className="divide-y divide-border">
                  {enqueueable.map((item) => {
                    const key = projectKeyOf?.(item);
                    return (
                      <li key={item.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40">
                          <Checkbox
                            checked={!!selected[item.id]}
                            onCheckedChange={(v) =>
                              setSelected((s) => ({
                                ...s,
                                [item.id]: v === true,
                              }))
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="truncate text-sm font-medium">
                              {item.title}
                            </span>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                              {key ?? item.type}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldWorkflow")}</Label>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("dialog.workflowAuto")}</SelectItem>
                {workflows.map((wf) => (
                  <SelectItem key={wf.id} value={wf.id}>
                    {wf.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>
              {t("dialog.enqueueConcurrency")}: {degree}
            </Label>
            <Slider
              min={1}
              max={10}
              step={1}
              value={[degree]}
              onValueChange={(v) => setDegree(v[0] ?? 1)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={pending || selectedIds.length === 0}
          >
            {pending ? <Spinner className="size-4" /> : null}
            {t("dialog.enqueueSubmit", { count: selectedIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
