import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
} from "@tabler/icons-react";
import type { GraphValidationResult } from "@/lib/workflow-graph-model";

// Live-validation banner (FRONTEND §6 / §6.3). Renders the result of the SHARED
// `validateGraph` — errors (block Save) in red, warnings (do not block) in amber,
// all-clear in green. This component does NOT validate; the canvas passes it the
// result of the one shared validator so there is a single source of truth.

export function ValidationBanner({
  result,
}: {
  result: GraphValidationResult;
}) {
  const { t } = useTranslation();

  if (result.ok && result.warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
        <IconCircleCheck className="size-4 shrink-0" />
        {t("flow.validOk")}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {result.errors.map((err, i) => (
        <div
          key={`e-${i}`}
          className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-700 dark:text-red-300"
        >
          <IconCircleX className="mt-0.5 size-3.5 shrink-0" />
          <span>{err}</span>
        </div>
      ))}
      {result.warnings.map((warn, i) => (
        <div
          key={`w-${i}`}
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{warn}</span>
        </div>
      ))}
    </div>
  );
}
