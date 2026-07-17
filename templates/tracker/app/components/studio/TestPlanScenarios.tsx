import { useReconciledState } from "@agent-native/core/client";
import {
  buildCoverageMatrix,
  hasInternalSymbolLeak,
  parseNoIntegrationDeclaration,
  parseScenarios,
  type TestPlanScenario,
} from "@shared/test-plan-parse";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useMemo } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { useSetArtifactReview } from "@/hooks/use-tracker";
import { cn } from "@/lib/utils";

const REVIEW_QUESTIONS: Array<{ key: string; label: string }> = [
  { key: "falsifiable", label: "信号可证伪" },
  { key: "real-precondition", label: "前置真实非种子" },
  { key: "tool-executable", label: "工具真能执行" },
];

/**
 * Test-plan step (③) interactive view — scenario cards + the Goal×scenario
 * coverage matrix (s2-sprint-studio.html `.scenario-card`/`table.fd`), both
 * derived client-side from the raw markdown (via `@shared/test-plan-parse`,
 * the same parser `check-artifact-gates` gates on) — no separate parsing
 * action needed, the artifact's full content already arrives via
 * `get-sprint-artifact`/`list-sprint-artifacts`.
 */
export function TestPlanScenarios({
  artifactId,
  version,
  content,
  reviewsByKey,
}: {
  artifactId: string;
  version: number;
  content: string;
  /** reviewKey -> checked, from `list-artifact-reviews` (already-persisted ticks). */
  reviewsByKey: Record<string, boolean>;
}) {
  const scenarios = useMemo(() => parseScenarios(content), [content]);
  const noIntegration = useMemo(
    () => parseNoIntegrationDeclaration(content),
    [content],
  );
  const matrix = useMemo(() => buildCoverageMatrix(scenarios), [scenarios]);

  if (scenarios.length === 0 && noIntegration) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm">
        <div className="mb-1.5 flex items-center gap-2 font-medium">
          无集成场景声明
        </div>
        <p className="text-muted-foreground">{noIntegration}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {matrix.length > 0 ? (
        <div className="rounded-lg border border-primary/30 bg-card p-3.5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            覆盖矩阵 · Goal 指标 vs 场景
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border-b border-border px-2 py-1.5 text-left font-semibold uppercase text-[10.5px] text-muted-foreground">
                  Goal 指标
                </th>
                {scenarios.map((s) => (
                  <th
                    key={s.id}
                    className="border-b border-border px-2 py-1.5 text-left font-semibold uppercase text-[10.5px] text-muted-foreground"
                  >
                    {s.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.metricId}>
                  <td className="border-b border-border px-2 py-1.5">
                    <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      {row.metricId}
                    </span>
                  </td>
                  {scenarios.map((s) => (
                    <td
                      key={s.id}
                      className={cn(
                        "border-b border-border px-2 py-1.5",
                        row.scenarioIds.includes(s.id) &&
                          "bg-success/10 text-success",
                      )}
                    >
                      {row.scenarioIds.includes(s.id) ? "覆盖" : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {scenarios.map((scenario) => (
        <ScenarioCard
          key={scenario.id}
          scenario={scenario}
          matrix={matrix}
          artifactId={artifactId}
          version={version}
          reviewsByKey={reviewsByKey}
        />
      ))}
    </div>
  );
}

function ScenarioCard({
  scenario,
  matrix,
  artifactId,
  version,
  reviewsByKey,
}: {
  scenario: TestPlanScenario;
  matrix: { metricId: string; scenarioIds: string[] }[];
  artifactId: string;
  version: number;
  reviewsByKey: Record<string, boolean>;
}) {
  const leaksSymbols = hasInternalSymbolLeak(scenario);
  const relatedMetrics = matrix
    .filter((m) => m.scenarioIds.includes(scenario.id))
    .map((m) => m.metricId);

  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold">{scenario.title}</span>
        {relatedMetrics.length > 0 ? (
          <span
            className="rounded-full border border-border px-2 py-0.5 font-mono text-[10.5px]"
            title="关联 Goal 指标（覆盖矩阵行）"
          >
            {relatedMetrics.join("·")}
          </span>
        ) : null}
        {scenario.fields["执行工具"] ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11.5px]">
            {scenario.fields["执行工具"]}
          </span>
        ) : null}
        {leaksSymbols ? (
          <span
            className="flex items-center gap-1 text-[11px] text-warning"
            title="疑似泄漏内部符号（黑盒检测，启发式，可能漏报）"
          >
            <IconAlertTriangle className="size-3.5" />
            疑似非黑盒
          </span>
        ) : null}
      </div>
      {(["Why", "Steps", "Expected"] as const).map((label) =>
        scenario.fields[label] ? (
          <div key={label} className="mt-1.5 flex gap-2 text-[12.5px]">
            <span className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase text-muted-foreground">
              {label}
            </span>
            <span className="text-foreground">{scenario.fields[label]}</span>
          </div>
        ) : null,
      )}
      {scenario.fields["Pass-fail 信号"] ? (
        <div className="mt-2.5 border-t border-border pt-2.5 text-[11.5px]">
          <span className="rounded-full bg-[color:var(--evidence,theme(colors.blue.500))]/10 px-2 py-1 font-medium text-foreground">
            Pass/fail 信号：{scenario.fields["Pass-fail 信号"]}
          </span>
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-4 border-t border-dashed border-border pt-2.5">
        {REVIEW_QUESTIONS.map((q) => (
          <ReviewCheckbox
            key={q.key}
            artifactId={artifactId}
            version={version}
            reviewKey={`scenario:${scenario.id}:${q.key}`}
            label={q.label}
            initialChecked={
              reviewsByKey[`scenario:${scenario.id}:${q.key}`] ?? false
            }
          />
        ))}
      </div>
    </div>
  );
}

function ReviewCheckbox({
  artifactId,
  version,
  reviewKey,
  label,
  initialChecked,
}: {
  artifactId: string;
  version: number;
  reviewKey: string;
  label: string;
  initialChecked: boolean;
}) {
  const setReview = useSetArtifactReview();
  // Re-adopts the server's persisted value (via list-artifact-reviews, kept
  // fresh by the framework's automatic action-sourced query invalidation —
  // see real-time-sync skill) except while this exact checkbox's own toggle
  // is in flight, so a concurrent reviewer's tick doesn't get clobbered but
  // this click also doesn't flicker back before its own mutation lands.
  const [checked, setChecked] = useReconciledState(initialChecked, {
    active: setReview.isPending,
  });

  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px]">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => {
          const value = next === true;
          const prev = checked;
          setChecked(value); // optimistic
          setReview.mutate(
            { artifactId, version, reviewKey, checked: value },
            { onError: () => setChecked(prev) },
          );
        }}
      />
      {label}
    </label>
  );
}
