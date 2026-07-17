import {
  gateOverrideReviewKey,
  machineTrackAllPass,
  mergeQualityGate,
  parseSelfAssessment,
} from "@shared/quality-gate-parse";
import { parseInScopeOutcomes } from "@shared/sprint-doc-parse";
import {
  deriveStudioSteps,
  STUDIO_STEPS,
  type StudioStepState,
} from "@shared/studio-step-derive";
import type { GateKey, SprintArtifact, SprintDetail } from "@shared/types";
import { SPRINT_PHASE_LABELS } from "@shared/types";
import {
  IconArrowLeft,
  IconDashboard,
  IconInfoCircle,
  IconRun,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ArtifactToolRow } from "@/components/studio/ArtifactToolRow";
import { BriefsStepView } from "@/components/studio/BriefsStepView";
import { GenericArtifactContent } from "@/components/studio/GenericArtifactContent";
import { ProblemPoolDrawer } from "@/components/studio/ProblemPoolDrawer";
import { QualityGateBar } from "@/components/studio/QualityGateBar";
import { SignoffDialog } from "@/components/studio/SignoffDialog";
import { StepRail } from "@/components/studio/StepRail";
import { StudioChatPanel } from "@/components/studio/StudioChatPanel";
import { TestPlanScenarios } from "@/components/studio/TestPlanScenarios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useApprovals,
  useArtifactReviews,
  useCheckArtifactGates,
  useCreateSprintArtifact,
  useSetArtifactReview,
  useSprint,
  useSprintArtifacts,
  useUpdateWorkItem,
  useWorkItems,
} from "@/hooks/use-tracker";
import { AdvancePhaseButton } from "@/pages/SprintDetailPage";

const SKILL_COMMAND: Partial<
  Record<(typeof STUDIO_STEPS)[number]["key"], string>
> = {
  brainstorm: "/brainstorm",
  "sprint-plan": "/sprint-plan",
  "test-plan": "/sprint-test-plan",
  "ui-spec": "/ui-spec",
  "tech-design": "/sprint-design",
  review: "/sprint-review",
};

const SIGNOFF_ANCHOR_DOCKEY: Record<GateKey, string> = {
  "plan-signoff": "sprint-doc",
  "ui-signoff": "ui-spec",
  "design-signoff": "tech-design",
  escalation: "sprint-doc",
  "audit-deferral": "sprint-doc",
};

function latestOf(
  versions: SprintArtifact[] | undefined,
): SprintArtifact | undefined {
  return versions && versions.length > 0
    ? versions[versions.length - 1]
    : undefined;
}

export function SprintStudioPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: rawSprint, isLoading: sprintLoading } = useSprint(id);
  const sprint = rawSprint as SprintDetail | undefined;
  const { data: artifactsData } = useSprintArtifacts(id);
  const byDocKey = artifactsData?.byDocKey ?? {};
  const { data: approvals = [] } = useApprovals({ sprintId: id });
  const { data: allWorkItems } = useWorkItems(sprint?.projectId);
  const createArtifact = useCreateSprintArtifact();
  const updateWorkItem = useUpdateWorkItem();
  const setArtifactReview = useSetArtifactReview();

  const [signoffGate, setSignoffGate] = useState<GateKey | null>(null);

  const artifactFacts = useMemo(() => {
    const facts: Record<string, { latestVersion: number | null }> = {};
    for (const def of STUDIO_STEPS) {
      const versions = byDocKey[def.docKey] ?? [];
      facts[def.docKey] = {
        latestVersion: latestOf(versions)?.version ?? null,
      };
    }
    return facts;
  }, [byDocKey]);

  const sprintDocContent = latestOf(byDocKey["sprint-doc"])?.content;
  const inScopeOutcomes = useMemo(
    () => (sprintDocContent ? parseInScopeOutcomes(sprintDocContent) : []),
    [sprintDocContent],
  );

  const stepParam = Number(searchParams.get("step"));
  const requestedStep =
    Number.isFinite(stepParam) && stepParam > 0 ? stepParam : null;

  const steps = useMemo(
    () =>
      deriveStudioSteps({
        artifacts: artifactFacts,
        activeStep: requestedStep,
        inScopeOutcomes,
        stepOverrides: sprint?.studioState?.stepOverrides as
          | Partial<Record<number, StudioStepState>>
          | undefined,
      }),
    [artifactFacts, requestedStep, inScopeOutcomes, sprint?.studioState],
  );

  const activeStep =
    requestedStep ??
    steps.find((s) => s.state === "in-progress")?.step ??
    steps.find((s) => s.state === "pending" && !s.optional)?.step ??
    2;

  const currentDef =
    STUDIO_STEPS.find((s) => s.step === activeStep) ?? STUDIO_STEPS[1]!;
  const currentDocKey = currentDef.docKey;
  const currentVersions = byDocKey[currentDocKey] ?? [];
  const currentLatest = latestOf(currentVersions);

  const { data: gateData } = useCheckArtifactGates(id, currentDocKey);
  const { data: reviewsData } = useArtifactReviews(
    currentLatest
      ? { artifactId: currentLatest.id, version: currentLatest.version }
      : { sprintId: id, docKey: currentDocKey },
    !!id,
  );

  const reviewsByKey = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const r of reviewsData?.reviews ?? [])
      map[r.reviewKey] = r.checked === 1;
    return map;
  }, [reviewsData]);

  const selfItems = useMemo(
    () => (currentLatest ? parseSelfAssessment(currentLatest.content) : []),
    [currentLatest],
  );
  const overrideSignals = useMemo(
    () =>
      (reviewsData?.reviews ?? [])
        .filter((r) => r.reviewKey.startsWith("gate-override:"))
        .map((r) => ({
          key: r.reviewKey.replace("gate-override:", ""),
          checked: r.checked === 1,
        })),
    [reviewsData],
  );
  const mergedGate = useMemo(
    () => mergeQualityGate(gateData?.items ?? [], selfItems, overrideSignals),
    [gateData, selfItems, overrideSignals],
  );
  const canAdopt = machineTrackAllPass(mergedGate) && mergedGate.length > 0;

  const backlogItems = (allWorkItems ?? []).filter((w) => !w.sprintId);

  function selectStep(step: number) {
    const next = new URLSearchParams(searchParams);
    next.set("step", String(step));
    setSearchParams(next, { replace: true });
  }

  function handleOverride(key: string, checked: boolean) {
    if (!currentLatest) return;
    setArtifactReview.mutate({
      artifactId: currentLatest.id,
      version: currentLatest.version,
      reviewKey: gateOverrideReviewKey(key),
      checked,
    });
  }

  function handleAdopt() {
    const nextIncomplete = steps.find(
      (s) =>
        s.step > activeStep &&
        s.state !== "final" &&
        s.state !== "skipped" &&
        s.state !== "not-applicable",
    );
    if (nextIncomplete) selectStep(nextIncomplete.step);
    toast.success(
      currentLatest
        ? `已采纳 ${currentDocKey} v${currentLatest.version}`
        : `${currentDocKey} 质量门已通过`,
    );
  }

  function handleDropOnArtifactArea(e: React.DragEvent) {
    const workItemId = e.dataTransfer.getData("text/tracker-work-item-id");
    if (!workItemId) return;
    e.preventDefault();
    updateWorkItem.mutate({ id: workItemId, sprintId: id });
  }

  if (sprintLoading && !sprint) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (!sprint) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">未找到该 Sprint。</p>
        <Button asChild variant="ghost" className="mt-3 gap-1.5">
          <Link to="/sprints">
            <IconArrowLeft className="size-4" /> 返回 Sprint 列表
          </Link>
        </Button>
      </div>
    );
  }

  const phase = sprint.phase ?? "planning";
  const missingForPlanSignoff = [
    latestOf(byDocKey["sprint-doc"]) ? null : "sprint-doc",
    latestOf(byDocKey["test-plan"]) ? null : "test-plan",
  ].filter(Boolean) as string[];
  const planSignoffApproval = approvals.find(
    (a) =>
      a.gateKey === "plan-signoff" && a.status === "approved" && !a.staleAt,
  );

  const activeGateApproval = signoffGate
    ? approvals
        .filter((a) => a.gateKey === signoffGate)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    : undefined;
  const activeGateAnchor = signoffGate
    ? latestOf(byDocKey[SIGNOFF_ANCHOR_DOCKEY[signoffGate]])
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2.5 px-5 pb-2.5 pt-3.5">
        <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <IconRun className="size-4" />
        </span>
        <h1 className="text-base font-semibold">{sprint.name}</h1>
        <Badge variant="secondary">
          {SPRINT_PHASE_LABELS[phase as keyof typeof SPRINT_PHASE_LABELS] ??
            phase}
        </Badge>
        <div className="ml-2 flex items-center gap-1 overflow-x-auto text-xs text-muted-foreground">
          {Object.values(SPRINT_PHASE_LABELS).map((label, i, arr) => (
            <span key={label} className="flex items-center gap-1">
              <span
                className={
                  label ===
                  (SPRINT_PHASE_LABELS[
                    phase as keyof typeof SPRINT_PHASE_LABELS
                  ] ?? phase)
                    ? "font-semibold text-info"
                    : ""
                }
              >
                {label}
              </span>
              {i < arr.length - 1 ? (
                <span className="mx-0.5 h-px w-2.5 bg-border" />
              ) : null}
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to={`/sprints/${id}`}>
              <IconDashboard className="size-3.5" />
              驾驶舱
            </Link>
          </Button>
          {missingForPlanSignoff.length > 0 ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <IconInfoCircle className="size-3.5" />缺{" "}
              {missingForPlanSignoff.join("/")} 产物
            </span>
          ) : null}
          <Button
            size="sm"
            disabled={missingForPlanSignoff.length > 0 || !!planSignoffApproval}
            title={
              missingForPlanSignoff.length > 0
                ? `缺 ${missingForPlanSignoff.join("/")} 产物`
                : undefined
            }
            onClick={() => setSignoffGate("plan-signoff")}
          >
            {planSignoffApproval ? "plan-signoff 已批" : "发起 plan-signoff"}
          </Button>
          <AdvancePhaseButton sprintId={id} phase={phase} />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden border-t border-border">
        <StepRail
          steps={steps}
          activeStep={activeStep}
          onSelectStep={selectStep}
          approvals={approvals}
          onSignoffClick={setSignoffGate}
        />

        <section
          className="flex min-w-0 flex-1 flex-col overflow-y-auto"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropOnArtifactArea}
        >
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background px-5 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {currentDef.label}
            </span>
            <span className="text-xs text-muted-foreground">
              docKey <span className="font-mono">{currentDocKey}</span>
              {currentLatest ? ` · v${currentLatest.version}` : " · 尚未定稿"}
            </span>
            <ArtifactToolRow
              sprintId={id}
              docKey={currentDocKey}
              kind={currentDef.label}
              versions={currentVersions}
              latest={currentLatest}
            />
          </div>

          <div className="flex flex-1 flex-col gap-3 p-5">
            {currentDef.key === "briefs" ? (
              <BriefsStepView
                sprintId={id}
                briefsIndexArtifact={currentLatest}
                briefArtifacts={Object.entries(byDocKey)
                  .filter(([k]) => k.startsWith("brief:"))
                  .map(([, versions]) => latestOf(versions))
                  .filter((a): a is SprintArtifact => !!a)}
                workItemsByKey={
                  new Map((sprint.items ?? []).map((it) => [it.itemKey, it]))
                }
              />
            ) : currentDef.key === "test-plan" && currentLatest ? (
              <TestPlanScenarios
                artifactId={currentLatest.id}
                version={currentLatest.version}
                content={currentLatest.content}
                reviewsByKey={reviewsByKey}
              />
            ) : currentLatest ? (
              <GenericArtifactContent content={currentLatest.content} />
            ) : (
              <p className="text-sm text-muted-foreground">
                此步骤尚无产物版本 —
                使用右侧会话区的技能开始，或用上方「手工导入」直接定稿。
              </p>
            )}
          </div>

          {currentDef.key !== "briefs" ? (
            <QualityGateBar
              items={mergedGate}
              docKey={currentDocKey}
              nextVersion={(currentLatest?.version ?? 0) + 1}
              canAdopt={canAdopt}
              onAdopt={handleAdopt}
              onOverride={handleOverride}
              adopting={createArtifact.isPending}
            />
          ) : null}

          <ProblemPoolDrawer
            sprintId={id}
            backlogItems={backlogItems}
            defaultOpen={!(sprint.studioState?.problemPoolCollapsed ?? true)}
          />
        </section>

        <StudioChatPanel
          sprintId={id}
          activeStep={activeStep}
          stepLabel={currentDef.label}
          skillCommand={SKILL_COMMAND[currentDef.key] ?? null}
        />
      </div>

      {signoffGate ? (
        <SignoffDialog
          open={!!signoffGate}
          onOpenChange={(open) => !open && setSignoffGate(null)}
          sprintId={id}
          gateKey={signoffGate}
          approval={activeGateApproval}
          anchorArtifact={activeGateAnchor}
        />
      ) : null}
    </div>
  );
}
