import type { RunRoutineResult } from "@/hooks/use-routines";

/**
 * A presentation-agnostic description of a manual run outcome. The dry-run
 * button maps this to a toast; tests assert on the structured shape so the
 * branching (not-found / schedule success-or-error / event match-or-not) is
 * covered without rendering or mocking sonner.
 */
export interface RunOutcome {
  tone: "success" | "error" | "info";
  title: string;
  description?: string;
  /** Thread to deep-link to, when the run created one. */
  threadId?: string;
}

/** Map a `run-routine` result to a structured outcome for the UI. */
export function describeRunResult(result: RunRoutineResult): RunOutcome {
  if ("notFound" in result) {
    return {
      tone: "error",
      title: "Routine not found",
      description: "Save it first, then try again.",
    };
  }

  if (result.kind === "schedule") {
    if (result.status === "error") {
      return {
        tone: "error",
        title: "Run failed",
        description: result.error ?? "Unknown error",
        threadId: result.threadId,
      };
    }
    return {
      tone: "success",
      title: "Routine ran successfully.",
      threadId: result.threadId,
    };
  }

  // event kind
  if (!result.conditionMatched) {
    return {
      tone: "info",
      title: "Condition did not match",
      description:
        result.reason ?? "The routine would not run for this sample payload.",
    };
  }
  return {
    tone: "success",
    title: "Condition matched — routine dispatched.",
    description:
      "The run is starting; open the run history to watch it and jump to its thread.",
  };
}
