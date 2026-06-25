import { useActionQuery } from "@agent-native/core/client";

/**
 * V3 Workspace detail types + hooks.
 *
 * A workspace is a real git checkout (host-native: a clone in a volume dir) or a
 * microVM. These hooks read its metadata, diff, file tree, a single file, and —
 * by cross-referencing spawns — the runs that used it. All read-only.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface V3WorkspaceRow {
  id: string;
  ownerKind: string;
  ownerId: string;
  tags: unknown;
  vmName: string | null;
  repoUrl: string | null;
  branch: string | null;
  state: string;
  createdAt: string | null;
  destroyedAt: string | null;
  createdBy: string | null;
}

/** One changed file in the workspace diff (path + counts + that file's patch). */
export interface V3DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  patch: string;
}

export interface V3WorkspaceDiff {
  workspaceId: string;
  vmName: string | null;
  base?: string;
  diff: string;
  files: V3DiffFile[];
}

export interface V3WorkspaceFiles {
  workspaceId: string;
  path: string;
  files: string[];
}

export interface V3WorkspaceFileContent {
  workspaceId: string;
  path: string;
  content: string;
}

/** A spawn row as returned by `spawnList` — carries workspaceId + resolved runId. */
export interface V3SpawnLite {
  id: string;
  runId: string | null;
  nodeId: string | null;
  agentName: string | null;
  status: string;
  workspaceId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const LIVE_POLL_MS = 4000;

function isLiveState(state: string | undefined): boolean {
  return state !== undefined && state !== "destroyed" && state !== "destroying";
}

export function useWorkspace(id: string | undefined) {
  return useActionQuery(
    "workspaceGet" as any,
    { workspaceId: id ?? "" },
    { enabled: !!id },
  ) as { data?: V3WorkspaceRow; isLoading: boolean; error?: unknown };
}

export function useWorkspaceDiff(id: string | undefined, state?: string) {
  return useActionQuery(
    "workspaceDiff" as any,
    { workspaceId: id ?? "" },
    {
      enabled: !!id && isLiveState(state),
      refetchInterval: () => false,
    },
  ) as {
    data?: V3WorkspaceDiff;
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };
}

export function useWorkspaceFiles(
  id: string | undefined,
  path: string | undefined,
  enabled: boolean,
) {
  return useActionQuery(
    "workspaceFiles" as any,
    { workspaceId: id ?? "", ...(path ? { path } : {}) },
    { enabled: enabled && !!id },
  ) as {
    data?: V3WorkspaceFiles;
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };
}

export function useWorkspaceFile(
  id: string | undefined,
  path: string | null | undefined,
) {
  return useActionQuery(
    "workspaceRead" as any,
    { workspaceId: id ?? "", path: path ?? "" },
    { enabled: !!id && !!path },
  ) as { data?: V3WorkspaceFileContent; isLoading: boolean; error?: unknown };
}

/**
 * Runs that used this workspace, discovered by listing spawns and filtering on
 * `workspaceId`. There is no direct workspace→run column (the relation lives on
 * the spawn), so we cross-reference here on the client.
 */
export function useWorkspaceRuns(workspaceId: string | undefined) {
  // Only `scope` is passed: over HTTP GET, numeric params (limit/offset)
  // serialize to strings and the action's `z.number()` schema rejects them
  // (400). The server default limit (100) is ample for a single run's spawns.
  const query = useActionQuery(
    "spawnList" as any,
    { scope: "run-scoped" },
    { enabled: !!workspaceId },
  ) as { data?: V3SpawnLite[]; isLoading: boolean; error?: unknown };

  return query;
}
