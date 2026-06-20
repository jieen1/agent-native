import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Condition } from "../../../shared/types";

// A small, safe condition editor (DESIGN §3.5 — never eval). Edits the Condition
// union used on branch out-edges and as a loop stop predicate. Returns a new
// Condition object on every change (immutable) — the caller writes it into the
// in-memory graph.

const CONDITION_KINDS: Condition["kind"][] = ["agent", "jsonpath", "status"];

export interface ConditionBuilderProps {
  value: Condition | undefined;
  onChange: (next: Condition | undefined) => void;
  /** node ids the `status` kind can reference. */
  nodeIds?: string[];
  allowClear?: boolean;
}

function defaultFor(kind: Condition["kind"]): Condition {
  switch (kind) {
    case "agent":
      return { kind: "agent", prompt: "" };
    case "jsonpath":
      return { kind: "jsonpath", path: "$", op: "==", value: "" };
    case "status":
      return { kind: "status", node: "", equals: "done" };
  }
}

export function ConditionBuilder({
  value,
  onChange,
  nodeIds = [],
  allowClear,
}: ConditionBuilderProps) {
  const { t } = useTranslation();
  const kind = value?.kind ?? "agent";

  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-2.5">
      <div className="grid gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("flow.conditionKind")}
        </span>
        <Select
          value={value ? kind : "__none__"}
          onValueChange={(v) =>
            onChange(
              v === "__none__" ? undefined : defaultFor(v as Condition["kind"]),
            )
          }
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowClear ? (
              <SelectItem value="__none__">{t("common.none")}</SelectItem>
            ) : null}
            {CONDITION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`flow.conditionKindOpt.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {value?.kind === "agent" ? (
        <Textarea
          value={value.prompt}
          onChange={(e) => onChange({ kind: "agent", prompt: e.target.value })}
          placeholder={t("flow.conditionAgentPlaceholder")}
          rows={2}
          className="text-xs"
        />
      ) : null}

      {value?.kind === "jsonpath" ? (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input
            value={value.path}
            onChange={(e) =>
              onChange({ ...value, kind: "jsonpath", path: e.target.value })
            }
            placeholder="$.result.score"
            className="h-8 font-mono text-xs"
          />
          <Input
            value={value.op}
            onChange={(e) =>
              onChange({ ...value, kind: "jsonpath", op: e.target.value })
            }
            placeholder="=="
            className="h-8 w-16 font-mono text-xs"
          />
          <Input
            value={String(value.value ?? "")}
            onChange={(e) =>
              onChange({ ...value, kind: "jsonpath", value: e.target.value })
            }
            placeholder={t("flow.conditionValue")}
            className="col-span-2 h-8 font-mono text-xs"
          />
        </div>
      ) : null}

      {value?.kind === "status" ? (
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={value.node || undefined}
            onValueChange={(v) =>
              onChange({ ...value, kind: "status", node: v })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder={t("flow.conditionNode")} />
            </SelectTrigger>
            <SelectContent>
              {nodeIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={value.equals}
            onChange={(e) =>
              onChange({ ...value, kind: "status", equals: e.target.value })
            }
            placeholder="done"
            className="h-8 text-xs"
          />
        </div>
      ) : null}
    </div>
  );
}
