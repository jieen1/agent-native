import { useActionQuery } from "@agent-native/core/client";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

import type { WorkflowVersionRow } from "./workflow-library-types";

export interface WorkflowDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  versions: WorkflowVersionRow[];
}

interface WorkflowDiffResult {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export function WorkflowDiffDialog({
  open,
  onOpenChange,
  name,
  versions,
}: WorkflowDiffDialogProps) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const [v1, setV1] = useState<number | undefined>(sorted[1]?.version);
  const [v2, setV2] = useState<number | undefined>(sorted[0]?.version);

  useEffect(() => {
    if (!open) return;
    setV1((prev) => prev ?? sorted[1]?.version);
    setV2((prev) => prev ?? sorted[0]?.version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canDiff = v1 !== undefined && v2 !== undefined && v1 !== v2;

  const { data, isLoading, error } = useActionQuery(
    "workflowDiff" as any,
    { name, v1, v2 },
    { enabled: open && canDiff },
  ) as { data?: WorkflowDiffResult; isLoading: boolean; error?: unknown };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>对比任意两版</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{name}</span> 的两个版本之间，DAG
            节点的结构差异。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <VersionSelect
            label="版本 A"
            value={v1}
            versions={sorted}
            onChange={setV1}
          />
          <span className="text-muted-foreground">vs</span>
          <VersionSelect
            label="版本 B"
            value={v2}
            versions={sorted}
            onChange={setV2}
          />
        </div>

        {!canDiff ? (
          <p className="text-sm text-muted-foreground">
            选择两个不同的版本进行对比。
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">对比失败，请重试。</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">对比中…</p>
        ) : data ? (
          <div className="space-y-3">
            <DiffSection label="新增节点" variant="added" ids={data.added} />
            <DiffSection
              label="删除节点"
              variant="removed"
              ids={data.removed}
            />
            <DiffSection
              label="修改节点"
              variant="changed"
              ids={data.changed}
            />
            <DiffSection
              label="未变节点"
              variant="unchanged"
              ids={data.unchanged}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function VersionSelect({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: number | undefined;
  versions: WorkflowVersionRow[];
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex-1 space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Select
        value={value !== undefined ? String(value) : undefined}
        onValueChange={(v) => onChange(Number(v))}
      >
        <SelectTrigger className="h-8">
          <SelectValue placeholder="选择版本" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              v{v.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const DIFF_STYLES: Record<string, string> = {
  added:
    "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  removed:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300",
  changed:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  unchanged: "border-border bg-muted text-muted-foreground",
};

function DiffSection({
  label,
  variant,
  ids,
}: {
  label: string;
  variant: keyof typeof DIFF_STYLES;
  ids: string[];
}) {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {label} ({ids.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <Badge
            key={id}
            variant="outline"
            className={`font-mono text-[11px] ${DIFF_STYLES[variant]}`}
          >
            {id}
          </Badge>
        ))}
      </div>
    </div>
  );
}
