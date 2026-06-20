import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Spinner } from "@/components/ui/spinner";
import { useSaveNodeDef, type NodeDef } from "@/hooks/use-library";

// D7 — New / edit library node (FRONTEND §10 / §7). key / kind (tool|agent) /
// config (JSON) / version. Submits save-node-def (versioned). Inline JSON
// validation; Esc/overlay cancels; errors keep the dialog open + toast.
export interface NodeDefDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass the node def to edit; omit for create mode. */
  nodeDef?: NodeDef | null;
}

export function NodeDefDialog({
  open,
  onOpenChange,
  nodeDef,
}: NodeDefDialogProps) {
  const { t } = useTranslation();
  const saveNodeDef = useSaveNodeDef();
  const isEdit = !!nodeDef;

  const [key, setKey] = useState("");
  const [kind, setKind] = useState("tool");
  const [title, setTitle] = useState("");
  const [config, setConfig] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKey(nodeDef?.key ?? "");
    setKind(nodeDef?.kind ?? "tool");
    setTitle(nodeDef?.title ?? "");
    setConfig(
      nodeDef?.config ? JSON.stringify(nodeDef.config, null, 2) : "{}",
    );
    setJsonError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeDef?.id]);

  function submit() {
    if (!key.trim()) {
      toast.error(t("dialog.requiredField"));
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      setJsonError(null);
    } catch {
      setJsonError(t("dialog.invalidJson"));
      return;
    }
    saveNodeDef.mutate(
      {
        id: nodeDef?.id,
        key: key.trim(),
        kind: kind.trim(),
        title: title.trim() || undefined,
        config: parsed,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(t("common.saved"));
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("dialog.editNodeTitle") : t("dialog.newNodeTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? t("dialog.editNodeTitle") : t("dialog.newNodeTitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldNodeKey")}</Label>
              <Input
                autoFocus
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="run-tests"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldNodeKind")}</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tool">{t("library.kindTool")}</SelectItem>
                  <SelectItem value="agent">
                    {t("library.kindAgent")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("common.title")}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldNodeConfig")}</Label>
            <Textarea
              value={config}
              onChange={(e) => {
                setConfig(e.target.value);
                if (jsonError) setJsonError(null);
              }}
              rows={6}
              className="font-mono text-xs"
            />
            {jsonError ? (
              <p className="text-xs text-destructive">{jsonError}</p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saveNodeDef.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={saveNodeDef.isPending || !key.trim()}
          >
            {saveNodeDef.isPending ? <Spinner className="size-4" /> : null}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
