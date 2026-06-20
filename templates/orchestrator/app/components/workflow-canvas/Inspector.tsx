import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconTrash } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  Condition,
  Edge,
  Node,
  NodeEffort,
  NodeRuntimeSpec,
} from "../../../shared/types";
import type { TemplateListItem } from "@/hooks/use-templates";
import { ModelPicker } from "./ModelPicker";
import { ConditionBuilder } from "./ConditionBuilder";

// The editor's right pane (FRONTEND §6 "Inspector"). Every field writes the
// in-memory graph through `onPatchNode` / `onPatchEdge` (immutable). Nothing hits
// the server until Save. Fields are shown only when meaningful for the node type.

const EFFORTS: NodeEffort[] = ["low", "medium", "high"];

export interface InspectorProps {
  node: Node | null;
  /** when a branch out-edge is selected, edit its `when`. */
  selectedEdge: Edge | null;
  /** all node ids (for itemsFrom / status-condition / deps hints). */
  nodeIds: string[];
  templates: TemplateListItem[];
  onPatchNode: (patch: Partial<Node>) => void;
  onPatchEdge: (patch: Partial<Edge>) => void;
  onRemoveNode: () => void;
  onRemoveEdge: () => void;
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

export function Inspector({
  node,
  selectedEdge,
  nodeIds,
  templates,
  onPatchNode,
  onPatchEdge,
  onRemoveNode,
  onRemoveEdge,
}: InspectorProps) {
  const { t } = useTranslation();

  const depHint = useMemo(
    () => nodeIds.filter((id) => id !== node?.id),
    [nodeIds, node?.id],
  );

  // Edge inspector (a selected branch out-edge): edit its `when`.
  if (selectedEdge && !node) {
    return (
      <ScrollArea className="h-full">
        <div className="grid gap-4 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("flow.edgeTitle")}</h3>
            <Button variant="ghost" size="sm" onClick={onRemoveEdge}>
              <IconTrash className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {selectedEdge.from} → {selectedEdge.to}
          </p>
          <FieldRow label={t("flow.edgeWhen")}>
            <ConditionBuilder
              value={selectedEdge.when}
              onChange={(when: Condition | undefined) => onPatchEdge({ when })}
              nodeIds={nodeIds}
              allowClear
            />
          </FieldRow>
        </div>
      </ScrollArea>
    );
  }

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {t("flow.inspectorEmpty")}
      </div>
    );
  }

  const isTerminal = node.type === "start" || node.type === "end";
  const isAgentish =
    node.type === "agent" || node.type === "tool" || Boolean(node.nodeDefKey);
  const runtime = node.runtime;

  function patchRuntime(patch: Partial<NodeRuntimeSpec>) {
    const base: NodeRuntimeSpec = runtime ?? {
      kind: "microvm",
      onFailure: "rollback",
    };
    onPatchNode({ runtime: { ...base, ...patch } });
  }

  return (
    <ScrollArea className="h-full">
      <div className="grid gap-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">
            {t(`flow.nodeType.${node.type}`, { defaultValue: node.type })}
          </h3>
          {!isTerminal ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemoveNode}
              aria-label={t("common.delete")}
            >
              <IconTrash className="size-4" />
            </Button>
          ) : null}
        </div>

        <FieldRow label={t("flow.fieldTitle")}>
          <Input
            value={node.title}
            onChange={(e) => onPatchNode({ title: e.target.value })}
            className="h-8"
          />
        </FieldRow>

        {!isTerminal ? (
          <>
            {isAgentish ? (
              <>
                <FieldRow label={t("flow.fieldAssignee")}>
                  <Input
                    value={node.assignee ?? ""}
                    onChange={(e) =>
                      onPatchNode({ assignee: e.target.value || undefined })
                    }
                    placeholder="local"
                    className="h-8"
                  />
                </FieldRow>

                <FieldRow label={t("flow.fieldEngine")}>
                  <ModelPicker
                    engine={node.engine}
                    model={node.model}
                    onChange={(v) => onPatchNode(v)}
                  />
                </FieldRow>

                <FieldRow label={t("flow.fieldEffort")}>
                  <Select
                    value={node.effort ?? "__none__"}
                    onValueChange={(v) =>
                      onPatchNode({
                        effort:
                          v === "__none__" ? undefined : (v as NodeEffort),
                      })
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        {t("common.none")}
                      </SelectItem>
                      {EFFORTS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {t(`flow.effort.${e}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>

                {node.type === "tool" ? (
                  <FieldRow label={t("flow.fieldAction")}>
                    <Input
                      value={node.action ?? ""}
                      onChange={(e) =>
                        onPatchNode({ action: e.target.value || undefined })
                      }
                      placeholder="run-tests"
                      className="h-8 font-mono text-xs"
                    />
                  </FieldRow>
                ) : null}

                <FieldRow label={t("flow.fieldPrompt")}>
                  <Textarea
                    value={node.prompt ?? ""}
                    onChange={(e) =>
                      onPatchNode({ prompt: e.target.value || undefined })
                    }
                    rows={4}
                    className="text-xs"
                    placeholder={t("flow.promptPlaceholder")}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t("flow.promptHint")}
                    {depHint.length > 0 ? (
                      <span className="font-mono">
                        {" "}
                        {`{{deps.${depHint[0]}.output}}`}
                      </span>
                    ) : null}
                  </p>
                </FieldRow>

                <FieldRow label={t("flow.fieldOutputSchema")}>
                  <Textarea
                    value={
                      node.outputSchema
                        ? JSON.stringify(node.outputSchema, null, 2)
                        : ""
                    }
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw) {
                        onPatchNode({ outputSchema: undefined });
                        return;
                      }
                      try {
                        onPatchNode({ outputSchema: JSON.parse(raw) });
                      } catch {
                        // keep typing; invalid JSON is just not committed yet
                      }
                    }}
                    rows={3}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder='{ "type": "object" }'
                  />
                </FieldRow>
              </>
            ) : null}

            {/* branch — its conditions live on out-edges (select an edge) */}
            {node.type === "branch" ? (
              <p className="rounded-md border border-dashed border-border p-2.5 text-[11px] text-muted-foreground">
                {t("flow.branchHint")}
              </p>
            ) : null}

            {/* fanout */}
            {node.type === "fanout" ? (
              <>
                <FieldRow label={t("flow.fieldItemsFrom")}>
                  <Select
                    value={node.itemsFrom || undefined}
                    onValueChange={(v) => onPatchNode({ itemsFrom: v })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue placeholder={t("flow.pickNode")} />
                    </SelectTrigger>
                    <SelectContent>
                      {depHint.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
                <FieldRow label={t("flow.fieldMaxConcurrency")}>
                  <Input
                    type="number"
                    min={1}
                    value={node.maxConcurrency ?? ""}
                    onChange={(e) =>
                      onPatchNode({
                        maxConcurrency: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    className="h-8"
                  />
                </FieldRow>
              </>
            ) : null}

            {/* loop */}
            {node.type === "loop" ? (
              <>
                <FieldRow label={t("flow.fieldCondition")}>
                  <ConditionBuilder
                    value={node.condition}
                    onChange={(condition) => onPatchNode({ condition })}
                    nodeIds={nodeIds}
                  />
                </FieldRow>
                <div className="grid grid-cols-2 gap-2">
                  <FieldRow label={t("flow.fieldMaxIterations")}>
                    <Input
                      type="number"
                      min={1}
                      value={node.maxIterations ?? ""}
                      onChange={(e) =>
                        onPatchNode({
                          maxIterations: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      className="h-8"
                    />
                  </FieldRow>
                  <FieldRow label={t("flow.fieldDryRounds")}>
                    <Input
                      type="number"
                      min={0}
                      value={node.dryRounds ?? ""}
                      onChange={(e) =>
                        onPatchNode({
                          dryRounds: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      className="h-8"
                    />
                  </FieldRow>
                </div>
                <FieldRow label={t("flow.fieldDedupeKey")}>
                  <Input
                    value={node.dedupeKey ?? ""}
                    onChange={(e) =>
                      onPatchNode({ dedupeKey: e.target.value || undefined })
                    }
                    placeholder="$.id"
                    className="h-8 font-mono text-xs"
                  />
                </FieldRow>
              </>
            ) : null}

            {/* subworkflow */}
            {node.type === "subworkflow" ? (
              <FieldRow label={t("flow.fieldTemplateRef")}>
                <Select
                  value={node.templateRef || undefined}
                  onValueChange={(v) => onPatchNode({ templateRef: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder={t("flow.pickTemplate")} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            ) : null}

            {/* human */}
            {node.type === "human" ? (
              <FieldRow label={t("flow.fieldApprovalPrompt")}>
                <Textarea
                  value={node.prompt ?? ""}
                  onChange={(e) =>
                    onPatchNode({ prompt: e.target.value || undefined })
                  }
                  rows={3}
                  className="text-xs"
                  placeholder={t("flow.approvalPlaceholder")}
                />
              </FieldRow>
            ) : null}

            <Separator />

            {/* execution */}
            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("flow.fieldAwait")}</Label>
                <Switch
                  checked={node.await ?? true}
                  onCheckedChange={(c) => onPatchNode({ await: c })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FieldRow label={t("flow.fieldRetryMax")}>
                  <Input
                    type="number"
                    min={0}
                    value={node.retry?.max ?? ""}
                    onChange={(e) =>
                      onPatchNode({
                        retry: e.target.value
                          ? {
                              max: Number(e.target.value),
                              backoffMs: node.retry?.backoffMs ?? 0,
                            }
                          : undefined,
                      })
                    }
                    className="h-8"
                  />
                </FieldRow>
                <FieldRow label={t("flow.fieldRetryBackoff")}>
                  <Input
                    type="number"
                    min={0}
                    value={node.retry?.backoffMs ?? ""}
                    onChange={(e) =>
                      onPatchNode({
                        retry: {
                          max: node.retry?.max ?? 0,
                          backoffMs: Number(e.target.value || 0),
                        },
                      })
                    }
                    className="h-8"
                  />
                </FieldRow>
              </div>
              <FieldRow label={t("flow.fieldTimeout")}>
                <Input
                  type="number"
                  min={0}
                  value={node.timeoutMs ?? ""}
                  onChange={(e) =>
                    onPatchNode({
                      timeoutMs: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  className="h-8"
                />
              </FieldRow>
            </div>

            {/* runtime sub-panel */}
            <Accordion type="single" collapsible>
              <AccordionItem value="runtime" className="border-b-0">
                <AccordionTrigger className="py-2 text-xs font-medium">
                  {t("flow.runtimeTitle")}
                </AccordionTrigger>
                <AccordionContent className="grid gap-3 pt-1">
                  <FieldRow label={t("flow.runtimeKind")}>
                    <Select
                      value={runtime?.kind ?? "none"}
                      onValueChange={(v) =>
                        patchRuntime({ kind: v as NodeRuntimeSpec["kind"] })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="microvm">microvm</SelectItem>
                        <SelectItem value="none">none</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldRow>
                  <FieldRow label={t("flow.runtimeImage")}>
                    <Input
                      value={runtime?.image ?? ""}
                      onChange={(e) => patchRuntime({ image: e.target.value })}
                      placeholder="node:22"
                      className="h-8 font-mono text-xs"
                    />
                  </FieldRow>
                  <div className="grid grid-cols-2 gap-2">
                    <FieldRow label={t("flow.runtimeBaseRef")}>
                      <Input
                        value={runtime?.baseRef ?? ""}
                        onChange={(e) =>
                          patchRuntime({ baseRef: e.target.value })
                        }
                        className="h-8 font-mono text-xs"
                      />
                    </FieldRow>
                    <FieldRow label={t("flow.runtimeBranch")}>
                      <Input
                        value={runtime?.branch ?? ""}
                        onChange={(e) =>
                          patchRuntime({ branch: e.target.value })
                        }
                        className="h-8 font-mono text-xs"
                      />
                    </FieldRow>
                  </div>
                  <FieldRow label={t("flow.runtimeMounts")}>
                    <Input
                      value={(runtime?.mounts ?? [])
                        .map((m) => `${m.host}:${m.path}`)
                        .join(", ")}
                      onChange={(e) =>
                        patchRuntime({
                          mounts: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((pair) => {
                              const [host, path] = pair.split(":");
                              return { host: host ?? "", path: path ?? "" };
                            }),
                        })
                      }
                      placeholder="host:/path, host2:/path2"
                      className="h-8 font-mono text-xs"
                    />
                  </FieldRow>
                  <FieldRow label={t("flow.runtimeCreds")}>
                    <Input
                      value={(runtime?.creds ?? []).join(", ")}
                      onChange={(e) =>
                        patchRuntime({
                          creds: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="GITHUB_TOKEN, NPM_TOKEN"
                      className="h-8 font-mono text-xs"
                    />
                  </FieldRow>
                  <FieldRow label={t("flow.runtimeOnFailure")}>
                    <Select
                      value={runtime?.onFailure ?? "rollback"}
                      onValueChange={(v) =>
                        patchRuntime({
                          onFailure: v as NodeRuntimeSpec["onFailure"],
                        })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rollback">rollback</SelectItem>
                        <SelectItem value="recreate">recreate</SelectItem>
                        <SelectItem value="keep">keep</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldRow>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
