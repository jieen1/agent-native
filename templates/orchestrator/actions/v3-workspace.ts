import { defineAction } from "@agent-native/core";
import { resolveSecret } from "@agent-native/core/server";
import { eq, and, desc, or, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import { MicrosandboxRuntime } from "../server/runtime/microsandbox-runtime.js";
import {
  addAll,
  commit,
  pushBranch,
  type GitContext,
} from "../server/runtime/git-wrapper.js";
import { VM_HOME, scrubSecretsFromLog } from "../server/runtime/vm-creds.js";
import {
  createLocalWorkspace,
  localWorkspaceDiff,
  localWorkspaceFiles,
  localWorkspaceRead,
  commitAndPush as commitAndPushLocal,
} from "../server/v3-workspace-local.js";

/** Build a minimal VmHandle for msb exec calls against a named running sandbox. */
function vmHandleFor(vmName: string) {
  return {
    name: vmName,
    spec: { kind: "microvm" as const, onFailure: "recreate" as const },
    meta: {},
  };
}

/** Shared MicrosandboxRuntime for workspace git operations. */
let _wsRuntime: MicrosandboxRuntime | null = null;
function getWsRuntime(): MicrosandboxRuntime {
  if (!_wsRuntime) _wsRuntime = new MicrosandboxRuntime();
  return _wsRuntime;
}

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

/**
 * SECURITY — fail-closed owner-scope predicate for v3_workspaces, shared by
 * every workspace action below.
 *
 * Workspaces don't use the simple direct `ownerEmail` model most V3 tables
 * use: `v3_workspaces` records ownership as `ownerKind` ("user" | "run") +
 * `ownerId` (the real user's email for "user", or the owning `v3_runs.id` for
 * "run"), and historically left the `ownerEmail` column (added by the
 * framework's `ownableColumns()`) at its unpopulated default
 * ("local@localhost") — createLocalWorkspace now populates it (see
 * server/v3-workspace-local.ts), but pre-existing rows may not have it set.
 *
 * A caller may access a workspace when ANY of the following hold:
 *  - `ownerEmail` matches directly (the value every NEW workspace gets); or
 *  - it's a "user"-kind workspace whose `ownerId` (the real email, per the
 *    create-time convention) matches — covers rows written before this fix
 *    populated `ownerEmail`; or
 *  - it's a "run"-kind workspace (`ownerId` = the owning run's id) whose run
 *    is owned by the caller — the run-linked owner model workspaces
 *    fundamentally use.
 *
 * A caller who satisfies none of these must get "not found" — never a row
 * belonging to someone else (fail-closed, never fail-open).
 */
function workspaceOwnerScope(
  db: ReturnType<typeof getV3Db>,
  callerEmail: string,
): SQL {
  return or(
    eq(v3Schema.v3Workspaces.ownerEmail, callerEmail),
    and(
      eq(v3Schema.v3Workspaces.ownerKind, "user"),
      eq(v3Schema.v3Workspaces.ownerId, callerEmail),
    ),
    and(
      eq(v3Schema.v3Workspaces.ownerKind, "run"),
      inArray(
        v3Schema.v3Workspaces.ownerId,
        db
          .select({ id: v3Schema.v3Runs.id })
          .from(v3Schema.v3Runs)
          .where(eq(v3Schema.v3Runs.ownerEmail, callerEmail)),
      ),
    ),
  )!;
}

/** List V3 workspaces with optional owner_kind, ownerId, state, and tagMatch filters. */
export const workspaceList = defineAction({
  description:
    "List V3 workspaces with optional owner_kind, ownerId, state, and tagMatch (JSONB containment partial match) filters.",
  schema: z.object({
    ownerKind: z.string().optional(),
    ownerId: z.string().optional(),
    state: z.string().optional(),
    /**
     * Partial JSONB match: only return workspaces whose tags contain ALL
     * the supplied key/value pairs (Postgres @> containment). E.g.
     * { source: "tracker", item_id: "PAY-14" }.
     */
    tagMatch: z.record(z.string(), z.string()).optional(),
    limit: z.number().int().positive().default(100),
    offset: z.number().int().min(0).default(0),
  }),
  readOnly: true,
  // Advertise on the A2A agent card so peer apps (e.g. tracker) can discover
  // this read-back surface for tag-match activity reassembly (v3-DESIGN §16).
  publicAgent: { expose: true, readOnly: true, requiresAuth: false },
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    const conditions: Array<import("drizzle-orm").SQL> = [];

    // Fail-closed owner scope — ALWAYS applied regardless of the ownerKind /
    // ownerId filters below (SECURITY — this action is also reachable
    // unauthenticated via publicAgent, so it must never fall through to
    // "every owner's workspaces"). An absent identity resolves to the local
    // single-user owner, never "all owners".
    conditions.push(workspaceOwnerScope(db, resolveOwnerEmail()));

    if (args.ownerKind) {
      conditions.push(eq(v3Schema.v3Workspaces.ownerKind, args.ownerKind));
    }
    if (args.ownerId) {
      conditions.push(eq(v3Schema.v3Workspaces.ownerId, args.ownerId));
    }
    if (args.state) {
      conditions.push(eq(v3Schema.v3Workspaces.state, args.state as any));
    }
    // JSONB containment: tags @> '{"key":"value",...}'
    if (args.tagMatch && Object.keys(args.tagMatch).length > 0) {
      conditions.push(
        sql`${v3Schema.v3Workspaces.tags} @> ${JSON.stringify(args.tagMatch)}::jsonb`,
      );
    }

    const rows = await db
      .select({
        id: v3Schema.v3Workspaces.id,
        ownerKind: v3Schema.v3Workspaces.ownerKind,
        ownerId: v3Schema.v3Workspaces.ownerId,
        tags: v3Schema.v3Workspaces.tags,
        vmName: v3Schema.v3Workspaces.vmName,
        repoUrl: v3Schema.v3Workspaces.repoUrl,
        branch: v3Schema.v3Workspaces.branch,
        state: v3Schema.v3Workspaces.state,
        createdAt: v3Schema.v3Workspaces.createdAt,
        destroyedAt: v3Schema.v3Workspaces.destroyedAt,
        createdBy: v3Schema.v3Workspaces.createdBy,
      })
      .from(v3Schema.v3Workspaces)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(v3Schema.v3Workspaces.createdAt))
      .limit(args.limit)
      .offset(args.offset);

    return rows.map((r) => ({
      id: r.id,
      ownerKind: r.ownerKind,
      ownerId: r.ownerId,
      tags: r.tags,
      vmName: r.vmName,
      repoUrl: r.repoUrl,
      branch: r.branch,
      state: r.state,
      createdAt: r.createdAt?.toISOString() ?? null,
      destroyedAt: r.destroyedAt?.toISOString() ?? null,
      createdBy: r.createdBy,
    })) as V3WorkspaceRow[];
  },
});

/** Get a single V3 workspace by id. */
export const workspaceGet = defineAction({
  description: "Get a single V3 workspace by id.",
  schema: z.object({
    workspaceId: z.string(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Fail-closed owner scope — a workspace the caller cannot resolve to their
    // own identity reads as not-found, never as another owner's row.
    const rows = await db
      .select()
      .from(v3Schema.v3Workspaces)
      .where(
        and(
          eq(v3Schema.v3Workspaces.id, args.workspaceId),
          workspaceOwnerScope(db, resolveOwnerEmail()),
        ),
      )
      .limit(1);

    if (!rows.length) {
      throw new Error(`Workspace '${args.workspaceId}' not found`);
    }

    const r = rows[0];
    return {
      id: r.id,
      ownerKind: r.ownerKind,
      ownerId: r.ownerId,
      tags: r.tags,
      vmName: r.vmName,
      repoUrl: r.repoUrl,
      branch: r.branch,
      state: r.state,
      createdAt: r.createdAt?.toISOString() ?? null,
      destroyedAt: r.destroyedAt?.toISOString() ?? null,
      createdBy: r.createdBy,
    } as V3WorkspaceRow;
  },
});

/** Destroy a V3 workspace (transitions state to destroying). */
export const workspaceDestroy = defineAction({
  description:
    "Destroy a V3 workspace. Transitions the workspace state to 'destroying'.",
  schema: z.object({
    workspaceId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();

    // Fail-closed owner scope, reused for the read + the write below — the
    // highest-risk of the 7 actions (destructive), so the same filter gates
    // both the existence check and the mutation itself.
    const wsFilter = and(
      eq(v3Schema.v3Workspaces.id, args.workspaceId),
      workspaceOwnerScope(db, resolveOwnerEmail()),
    );

    const rows = await db
      .select({
        id: v3Schema.v3Workspaces.id,
        state: v3Schema.v3Workspaces.state,
      })
      .from(v3Schema.v3Workspaces)
      .where(wsFilter)
      .limit(1);

    if (!rows.length) {
      throw new Error(`Workspace '${args.workspaceId}' not found`);
    }

    const current = rows[0];
    if (current.state === "destroying" || current.state === "destroyed") {
      throw new Error(
        `Workspace is already ${current.state}; cannot destroy again.`,
      );
    }

    await db
      .update(v3Schema.v3Workspaces)
      .set({
        state: "destroying" as any,
        destroyedAt: new Date(),
      })
      .where(wsFilter);

    return {
      workspaceId: args.workspaceId,
      previousState: current.state,
      state: "destroying",
      ok: true,
    };
  },
});

/** Create a V3 workspace (host-native: real git clone into a volume dir). */
export const workspaceCreate = defineAction({
  description:
    "Create a V3 workspace. Host-native: git-clones the repo into a directory on " +
    "the workspace volume and checks out the run branch (no microVM). Agent " +
    "workers cwd into the returned directory.",
  schema: z.object({
    // Accept https:// and file:// (a local path clone). z.string().url() admits
    // both; not constrained to .url() so a bare path is still rejected cleanly
    // by git rather than the schema.
    repo: z.string().min(1),
    branch: z.string().optional(),
    // "user" (default): a person created this workspace — the owner is that
    // real requesting user. "run": a workflow run owns it (ownerId is the run
    // id). "cc" is the legacy agent-on-behalf-of-user value, treated as "user".
    ownerKind: z.enum(["user", "run", "cc"]).default("user"),
    ownerId: z.string().optional(),
    keepAfterRun: z.boolean().optional(),
    tags: z.unknown().optional(),
  }),
  run: async (args) => {
    // Resolve the real requesting user via the same fail-closed resolver every
    // other V3 action uses (never undefined — an absent identity resolves to
    // the local single-user owner). This becomes the owner of a user-created
    // workspace, the audit `created_by` in all cases, AND — SECURITY — the
    // `ownerEmail` column every workspace action's owner-scope filter checks
    // directly, so future reads/writes never rely solely on the ownerKind
    // === "run" join through v3_runs.
    const requesterEmail = resolveOwnerEmail();

    // A run-owned workspace keeps the run id as its owner (passed as ownerId); a
    // person-owned one is owned by the real requesting user (legacy "cc" maps to
    // the real user too). Never the meaningless "cc" placeholder.
    const ownerKind = args.ownerKind === "run" ? "run" : "user";
    const ownerId = args.ownerId ?? requesterEmail;

    // Host-native workspace (DESIGN §10.6): real git clone into the volume,
    // checkout the run branch, persist host_path. No MicrosandboxRuntime — works
    // in Docker where msb/libkrun is unavailable.
    const ws = await createLocalWorkspace({
      repoUrl: args.repo,
      branch: args.branch,
      ownerKind,
      ownerId,
      createdBy: requesterEmail,
      ownerEmail: requesterEmail,
    });

    return {
      workspaceId: ws.id,
      // vmName stays null for host-native workspaces; hostPath is the new dir.
      vmName: null as string | null,
      hostPath: ws.dir,
      state: "ready",
      repoUrl: args.repo,
      branch: ws.branch,
    };
  },
});

/**
 * Get the git diff for a V3 workspace. Returns the full patch plus a per-file
 * breakdown (path + add/del counts + that file's hunk) so the UI can render
 * grouped, color-coded diffs.
 *
 * Two execution paths:
 *  • Host-native (host_path set, no VM): diffs against the divergence point from
 *    the default branch (merge-base origin/main…HEAD) so BOTH committed branch
 *    work and uncommitted edits render — `git diff HEAD` would be empty because
 *    the run branch's change is already committed.
 *  • VM (vm_name set): `git diff HEAD` over the microsandbox (legacy path).
 */
export const workspaceDiff = defineAction({
  description:
    "Get the git diff for a V3 workspace as a full patch plus a per-file " +
    "breakdown (path, additions, deletions, status, per-file patch). Host-native " +
    "workspaces diff against the branch divergence point so committed work shows.",
  schema: z.object({
    workspaceId: z.string(),
    against: z.string().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(
        `Workspace ${args.workspaceId} is ${ws.state}, cannot diff`,
      );
    }

    // Host-native path: diff over the checkout dir (vm_name NULL, host_path set).
    if (!ws.vmName) {
      const local = await localWorkspaceDiff(args.workspaceId, args.against);
      if (!local) {
        throw new Error(
          `Workspace ${args.workspaceId} has neither a VM nor a host path`,
        );
      }
      return {
        workspaceId: args.workspaceId,
        vmName: null as string | null,
        base: local.base,
        diff: scrubSecretsFromLog(local.diff),
        files: local.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          status: f.status,
          patch: scrubSecretsFromLog(f.patch),
        })),
      };
    }

    // VM path (legacy microsandbox).
    const runtime = getWsRuntime();
    const vm = vmHandleFor(ws.vmName);
    const workdir = "/work";
    const diffArgs = args.against ? `diff ${args.against}` : "diff HEAD";
    const res = await runtime.exec(vm, `git --no-pager ${diffArgs}`, {
      cwd: workdir,
      env: { HOME: VM_HOME },
    });

    return {
      workspaceId: args.workspaceId,
      vmName: ws.vmName,
      base: args.against ?? "HEAD",
      diff: scrubSecretsFromLog(
        res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : ""),
      ),
      files: [] as Array<{
        path: string;
        additions: number;
        deletions: number;
        status: string;
        patch: string;
      }>,
    };
  },
});

/** List files in a workspace. */
export const workspaceFiles = defineAction({
  description: "List files in a V3 workspace.",
  schema: z.object({
    workspaceId: z.string(),
    path: z.string().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(
        `Workspace ${args.workspaceId} is ${ws.state}, cannot list files`,
      );
    }

    // Host-native path: list directory entries over the checkout dir.
    if (!ws.vmName) {
      const local = await localWorkspaceFiles(args.workspaceId, args.path);
      if (!local) {
        throw new Error(
          `Workspace ${args.workspaceId} has neither a VM nor a host path`,
        );
      }
      return {
        workspaceId: args.workspaceId,
        path: local.path,
        files: local.files,
      };
    }

    // VM path (legacy microsandbox).
    const runtime = getWsRuntime();
    const vm = vmHandleFor(ws.vmName);
    const targetPath = args.path ?? "/work";
    const res = await runtime.exec(
      vm,
      `find '${targetPath.replace(/'/g, `'\\''`)}' -maxdepth 1 -not -path '${targetPath.replace(/'/g, `'\\''`)}' 2>/dev/null | sort`,
      { env: { HOME: VM_HOME } },
    );

    const files = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      workspaceId: args.workspaceId,
      path: targetPath,
      files,
    };
  },
});

/** Read a file from a workspace. */
export const workspaceRead = defineAction({
  description: "Read a file from a V3 workspace.",
  schema: z.object({
    workspaceId: z.string(),
    path: z.string(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(
        `Workspace ${args.workspaceId} is ${ws.state}, cannot read`,
      );
    }

    // Host-native path: read the file over the checkout dir (path-traversal safe).
    if (!ws.vmName) {
      const local = await localWorkspaceRead(args.workspaceId, args.path);
      if (!local) {
        throw new Error(
          `Workspace ${args.workspaceId} has neither a VM nor a host path`,
        );
      }
      return {
        workspaceId: args.workspaceId,
        path: local.path,
        content: scrubSecretsFromLog(local.content),
      };
    }

    // VM path (legacy microsandbox).
    const runtime = getWsRuntime();
    const vm = vmHandleFor(ws.vmName);
    const content = await runtime.fs(vm).read(args.path);

    return {
      workspaceId: args.workspaceId,
      path: args.path,
      content,
    };
  },
});

/** Commit and push changes in a workspace. */
export const workspaceCommitPush = defineAction({
  description:
    "Commit and push changes in a V3 workspace. Requires GITHUB_TOKEN secret.",
  schema: z.object({
    workspaceId: z.string(),
    message: z.string(),
    pushBranch: z.string().optional(),
  }),
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(
        `Workspace ${args.workspaceId} is ${ws.state}, cannot commit`,
      );
    }
    // Host-native (non-microVM) workspace: commit + push + open a PR directly in
    // the local git checkout via commitAndPush (DESIGN §10.6, §13). The VM path
    // below requires a running microVM, which host-native workspaces (vm_name
    // NULL, host_path set) never have — without this branch the brain cannot
    // ship a host-native run's work (it throws "has no VM"). commitAndPush
    // resolves GITHUB_TOKEN within THIS action's request context (so app_secrets
    // / Vault scoping works), excludes .mcp.json, retargets off the base branch,
    // and opens a real PR.
    if (!ws.vmName) {
      const baseBranch = ws.branch && ws.branch.trim() !== "" ? ws.branch : "main";
      const result = await commitAndPushLocal({
        id: args.workspaceId,
        message: args.message,
        createMr: true,
        baseBranch,
        prTitle: args.message.split("\n")[0] || args.message,
        prBody: args.message,
      });
      return {
        workspaceId: args.workspaceId,
        sha: result.sha,
        branch: result.branch,
        pushed: result.pushed,
        pushReason: result.pushed ? "pushed" : "not-pushed",
        pushDetail: result.prUrl ?? null,
        committed: result.committed,
        prUrl: result.prUrl ?? null,
      };
    }

    // Resolve GITHUB_TOKEN ephemerally from the Vault (DESIGN §13) — never
    // written to the repo config or persisted beyond this call.
    const githubToken = (await resolveSecret("GITHUB_TOKEN").catch(
      () => null,
    )) as string | null;

    const runtime = getWsRuntime();
    const vm = vmHandleFor(ws.vmName);
    const workdir = "/work";
    const env: Record<string, string> = {
      HOME: VM_HOME,
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    };
    const gitCtx: GitContext = { runtime, vm, workdir, env };

    // Stage all changes.
    await addAll(gitCtx);

    // Commit (idempotent if nothing to commit).
    const commitResult = await commit(gitCtx, args.message);

    const branch = args.pushBranch ?? ws.branch ?? "main";

    // Push to remote using ephemeral token URL (DESIGN §13 — token never in config).
    const pushResult = await pushBranch(gitCtx, {
      branch,
      remoteUrl: ws.repoUrl ?? undefined,
    });

    return {
      workspaceId: args.workspaceId,
      sha: commitResult.sha ?? null,
      branch,
      pushed: pushResult.pushed,
      pushReason: pushResult.reason,
      pushDetail: pushResult.detail,
      committed: commitResult.committed,
    };
  },
});

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Resolve a workspace by id, fail-closed owner-scoped (SECURITY — shared by
 * workspaceDiff/Files/Read/CommitPush above, and by the separate
 * `workspaceCommit` action, which performs the same class of write and must
 * be gated identically). A workspace the caller cannot resolve to their own
 * identity (directly, or via the owning run) throws "not found" — it is never
 * returned to a caller who doesn't own it.
 */
export async function assertWorkspaceExists(
  workspaceId: string,
): Promise<V3WorkspaceRow> {
  const db = getV3Db();
  const rows = await db
    .select()
    .from(v3Schema.v3Workspaces)
    .where(
      and(
        eq(v3Schema.v3Workspaces.id, workspaceId),
        workspaceOwnerScope(db, resolveOwnerEmail()),
      ),
    )
    .limit(1);

  if (!rows.length) {
    throw new Error(`Workspace '${workspaceId}' not found`);
  }

  const r = rows[0];
  return {
    id: r.id,
    ownerKind: r.ownerKind,
    ownerId: r.ownerId,
    tags: r.tags,
    vmName: r.vmName,
    repoUrl: r.repoUrl,
    branch: r.branch,
    state: r.state,
    createdAt: r.createdAt?.toISOString() ?? null,
    destroyedAt: r.destroyedAt?.toISOString() ?? null,
    createdBy: r.createdBy,
  };
}
