import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { V3StatusBadge } from "./V3StatusBadge";
import type { V3Node } from "@/hooks/use-v3-run";

// ── NodeInspector ────────────────────────────────────────────────────────────

export interface NodeInspectorProps {
  node: V3Node | null | undefined;
  loading: boolean;
  hasSelection: boolean;
  onRetry?: () => void;
  onSkip?: () => void;
}

export function NodeInspector({
  node,
  loading,
  hasSelection,
  onRetry,
  onSkip,
}: NodeInspectorProps) {
  if (!hasSelection) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Node Inspector
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Click a node in the DAG to view details
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="h-full">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-28" />
        </CardContent>
      </Card>
    );
  }

  if (!node) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Node Inspector
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Node not found
        </CardContent>
      </Card>
    );
  }

  const isTerminal =
    node.status === "done" || node.status === "failed" || node.status === "skipped";
  const canRetry = node.status === "failed";
  const canSkip = node.status === "pending" || node.status === "running";

  const duration = (() => {
    if (!node.startedAt) return null;
    const end = node.completedAt ? new Date(node.completedAt) : new Date();
    const ms = end.getTime() - new Date(node.startedAt).getTime();
    if (ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  })();

  return (
    <Card className="h-full overflow-auto">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="line-clamp-1 font-mono text-sm font-medium">
            {node.nodeIdInDag}
          </CardTitle>
          <V3StatusBadge status={node.status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Type badge */}
        <div>
          <span className="text-xs font-medium text-muted-foreground">
            Type
          </span>
          <div className="mt-1">
            <Badge variant="secondary" className="font-mono text-xs">
              {node.type}
            </Badge>
          </div>
        </div>

        <Separator />

        {/* Metadata grid */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Iteration</dt>
          <dd className="font-mono">{node.iteration}</dd>

          <dt className="text-muted-foreground">Fanout Index</dt>
          <dd className="font-mono">{node.fanoutIndex}</dd>

          <dt className="text-muted-foreground">Spawn ID</dt>
          <dd className="truncate font-mono" title={node.currentSpawnId ?? ""}>
            {node.currentSpawnId ?? "—"}
          </dd>

          <dt className="text-muted-foreground">Artifact</dt>
          <dd className="truncate font-mono" title={node.outputArtifactId ?? ""}>
            {node.outputArtifactId ?? "—"}
          </dd>

          <dt className="text-muted-foreground">Started</dt>
          <dd>
            {node.startedAt
              ? new Date(node.startedAt).toLocaleTimeString()
              : "—"}
          </dd>

          <dt className="text-muted-foreground">Completed</dt>
          <dd>
            {node.completedAt
              ? new Date(node.completedAt).toLocaleTimeString()
              : "—"}
          </dd>

          {duration && (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="font-mono">{duration}</dd>
            </>
          )}
        </dl>

        {/* Error message */}
        {node.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {node.error}
          </div>
        ) : null}

        <Separator />

        {/* Action buttons */}
        <div className="flex gap-2">
          {canRetry && onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <IconPlayerPlay className="size-3.5" />
              Retry
            </Button>
          ) : null}
          {canSkip && onSkip ? (
            <Button size="sm" variant="outline" onClick={onSkip}>
              <IconX className="size-3.5" />
              Skip
            </Button>
          ) : null}
          {isTerminal && !canRetry && !canSkip ? (
            <span className="text-xs text-muted-foreground">
              Node completed
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
