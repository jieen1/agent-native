import { useActionMutation, useActionQuery } from "@agent-native/core/client";

export type DeployStage =
  | "queued"
  | "backing-up"
  | "building"
  | "syncing"
  | "restarting"
  | "verifying"
  | "rolling-back"
  | "done";

export type DeployStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface DeployStageEntry {
  stage: DeployStage;
  startedAt: string;
  completedAt?: string;
  ok?: boolean;
  detail?: string;
}

export interface DeployStatusResult {
  id: string;
  target: string;
  apps: string[];
  status: DeployStatus;
  stage: DeployStage;
  stageLog: DeployStageEntry[];
  commitSha: string | null;
  backupRef: string | null;
  healthCheckResult: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  triggeredBy: string | null;
}

export interface DeployRunSummary {
  id: string;
  target: string;
  apps: string[];
  status: DeployStatus;
  stage: DeployStage;
  commitSha: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  triggeredBy: string | null;
}

function isLiveDeploy(status: DeployStatus | undefined): boolean {
  return status === "queued" || status === "running";
}

const LIVE_POLL_MS = 2000;

export function useTriggerDeploy() {
  return useActionMutation("trigger-deploy" as any, {}) as {
    mutate: (
      args: { apps?: string[]; target?: string },
      opts?: {
        onSuccess?: (result: unknown) => void;
        onError?: (err: unknown) => void;
      },
    ) => void;
    isPending: boolean;
  };
}

/** Poll one deploy run's live stage/status (`deploy-status`) while it's active. */
export function useDeployStatus(deployRunId: string | null | undefined) {
  return useActionQuery(
    "deploy-status" as any,
    { deployRunId: deployRunId ?? "" },
    {
      enabled: !!deployRunId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const data = query.state.data as DeployStatusResult | undefined;
        return isLiveDeploy(data?.status) ? LIVE_POLL_MS : false;
      },
    },
  ) as { data?: DeployStatusResult; isLoading: boolean; error?: unknown };
}

/** Deploy history for the settings page; polls while the most recent run is live. */
export function useDeployHistory(limit = 10) {
  return useActionQuery(
    "list-deploy-runs" as any,
    { limit },
    {
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const data = query.state.data as DeployRunSummary[] | undefined;
        return isLiveDeploy(data?.[0]?.status) ? LIVE_POLL_MS : false;
      },
    },
  ) as { data?: DeployRunSummary[]; isLoading: boolean; error?: unknown };
}
