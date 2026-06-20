import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
import {
  modelFromRaw,
  modelToJson,
  type WorkflowGraphModel,
} from "@/lib/workflow-graph-model";

// JSON-view fallback (FRONTEND §6 / §6.3). The power-user / agent-editable raw
// JSON of the SAME in-memory model: editing here parses back into the model on a
// valid change, so the canvas and the JSON never diverge. Invalid JSON shows an
// inline error and is simply not committed until it parses.

export interface JsonViewProps {
  model: WorkflowGraphModel;
  onChange: (model: WorkflowGraphModel) => void;
}

export function JsonView({ model, onChange }: JsonViewProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => modelToJson(model));
  const [error, setError] = useState<string | null>(null);

  // Re-seed the textarea when the model changes from OUTSIDE (e.g. a canvas edit
  // while the JSON view is hidden, then re-shown). Compare serialized form so we
  // do not clobber the user's in-progress typing on every keystroke round-trip.
  useEffect(() => {
    const next = modelToJson(model);
    setText((prev) => (sameGraph(prev, next) ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  function handle(value: string) {
    setText(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setError(t("flow.jsonInvalid"));
      return;
    }
    setError(null);
    // Preserve existing positions for nodes the JSON keeps; modelFromRaw reads
    // any `__positions` the JSON carries, else falls back to the current layout.
    onChange(modelFromRaw(parsed, model.positions));
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <Textarea
        value={text}
        onChange={(e) => handle(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none font-mono text-xs"
      />
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}

/** Cheap structural-equality on the parsed graph (ignores whitespace). */
function sameGraph(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}
