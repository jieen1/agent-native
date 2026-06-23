import { defineAction } from "@agent-native/core";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

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

/** List V3 workspaces with optional owner_kind and state filters. */
export const workspaceList = defineAction({
  description:
    "List V3 workspaces with optional owner_kind and state filters.",
  schema: z.object({
    ownerKind: z.string().optional(),
    state: z.string().optional(),
    limit: z.number().int().positive().default(100),
    offset: z.number().int().min(0).default(0),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();
    const conditions: Array<import("drizzle-orm").SQL> = [];

    if (args.ownerKind) {
      conditions.push(
        eq(v3Schema.v3Workspaces.ownerKind, args.ownerKind),
      );
    }
    if (args.state) {
      conditions.push(
        eq(v3Schema.v3Workspaces.state, args.state as any),
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
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select()
      .from(v3Schema.v3Workspaces)
      .where(eq(v3Schema.v3Workspaces.id, args.workspaceId))
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

    const rows = await db
      .select({
        id: v3Schema.v3Workspaces.id,
        state: v3Schema.v3Workspaces.state,
      })
      .from(v3Schema.v3Workspaces)
      .where(eq(v3Schema.v3Workspaces.id, args.workspaceId))
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
      .where(eq(v3Schema.v3Workspaces.id, args.workspaceId));

    return {
      workspaceId: args.workspaceId,
      previousState: current.state,
      state: "destroying",
      ok: true,
    };
  },
});

/** Create a V3 workspace (provisions a VM, clones repo). */
export const workspaceCreate = defineAction({
  description:
    "Create a V3 workspace. Provisions a VM, clones the repo, and checks out the branch.",
  schema: z.object({
    repo: z.string().url(),
    branch: z.string().optional(),
    ownerKind: z.enum(["cc", "run"]).default("cc"),
    ownerId: z.string().optional(),
    keepAfterRun: z.boolean().optional(),
    tags: z.unknown().optional(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const uuid = crypto.randomUUID();
    const vmName = `v3-ws-${uuid.slice(0, 8)}`;

    await db.execute(sql.raw(`
      INSERT INTO v3_workspaces (id, owner_kind, owner_id, vm_name, repo_url, branch, state, tags, created_by, created_at)
      VALUES (${uuid}, ${args.ownerKind}, ${args.ownerId ?? null}, ${vmName}, ${args.repo}, ${args.branch ?? null}, 'provisioning', ${JSON.stringify(args.tags ?? {}) }::jsonb, ${args.ownerId ?? null}, NOW())
    `));

    // TODO: actual msb exec to provision VM, git clone, checkout
    // For now, transition to ready after recording in DB.
    await db
      .update(v3Schema.v3Workspaces)
      .set({ state: "ready" as any })
      .where(eq(v3Schema.v3Workspaces.id, uuid));

    return {
      workspaceId: uuid,
      vmName,
      state: "ready",
      repoUrl: args.repo,
      branch: args.branch,
    };
  },
});

/** Get git diff for a workspace. */
export const workspaceDiff = defineAction({
  description: "Get git diff for a V3 workspace.",
  schema: z.object({
    workspaceId: z.string(),
    against: z.string().optional(),
  }),
  readOnly: true,
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(`Workspace ${args.workspaceId} is ${ws.state}, cannot diff`);
    }

    // TODO: msb exec `git diff ${args.against || ""}` inside VM
    return {
      workspaceId: args.workspaceId,
      vmName: ws.vmName,
      diff: "", // placeholder until msb integration
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
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(`Workspace ${args.workspaceId} is ${ws.state}, cannot list files`);
    }

    // TODO: msb exec `find <path> -maxdepth 1` inside VM
    return {
      workspaceId: args.workspaceId,
      path: args.path ?? "/",
      files: [] as string[], // placeholder until msb integration
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
  run: async (args) => {
    const ws = await assertWorkspaceExists(args.workspaceId);
    if (ws.state !== "ready" && ws.state !== "busy") {
      throw new Error(`Workspace ${args.workspaceId} is ${ws.state}, cannot read`);
    }

    // TODO: msb exec `cat <path>` inside VM
    return {
      workspaceId: args.workspaceId,
      path: args.path,
      content: "", // placeholder until msb integration
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

    // TODO: msb exec `git add . && git commit -m <msg> && git push origin <branch>`
    // with GITHUB_TOKEN injected from resolveSecret("GITHUB_TOKEN")
    return {
      workspaceId: args.workspaceId,
      sha: "pending-msb",
      branch: ws.branch ?? "main",
      pushed: false, // placeholder until msb integration
    };
  },
});

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

async function assertWorkspaceExists(
  workspaceId: string,
): Promise<V3WorkspaceRow> {
  const db = getV3Db();
  const rows = await db
    .select()
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, workspaceId))
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
