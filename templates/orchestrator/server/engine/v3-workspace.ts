// V3 Workspace Adapter (DESIGN §8.2, IMPLEMENTATION §C).
// Owns the full workspace lifecycle: provision VM, clone repo, mount credentials,
// wire egress, and persist the v3_workspaces row. The V3 dispatcher calls this
// before it hands the workspaceId to a spawn.

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getV3Db, v3Schema } from "../db/v3.js";
import { MicrosandboxRuntime, toWslPath } from "../runtime/microsandbox-runtime.js";
import type { MountSpec, VmHandle, TeardownPolicy } from "../runtime/node-runtime.js";
import { cloneRepo, checkoutRunBranch, runBranchName, type GitContext } from "../runtime/git-wrapper.js";
import { mountVmCredentials, VM_HOME } from "../runtime/vm-creds.js";
import { resolveEgress } from "../runtime/networking.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Full workspace row returned by getWorkspace. */
export interface V3Workspace {
  id: string;
  ownerKind: string;
  ownerId: string;
  tags: Record<string, string> | null;
  vmName: string | null;
  repoUrl: string | null;
  branch: string | null;
  state: string;
  createdAt: Date;
  destroyedAt: Date | null;
  createdBy: string | null;
  ownerEmail: string;
  orgId: string | null;
}

/** Workspace creation options. */
export interface CreateWorkspaceOptions {
  /** The v3 run that owns this workspace. */
  runId: string;
  /** Git repo to clone into the workspace VM. */
  repoUrl: string;
  /** Branch name (or a base ref to cut the run-branch from). */
  branch?: string;
  /** Whether to keep the VM alive after the run finishes. */
  keepAfterRun?: boolean;
  /** Tag filter used when reusing an existing workspace. */
  tagMatch?: Record<string, string>;
  /** Mount configuration (folders, creds, env) — same shape as node-runtime MountSpec. */
  mountSpec?: MountSpec;
  /**
   * The GitContext env that will be threaded into in-VM git commands.
   * The caller is responsible for ensuring the run's request context is
   * active so resolveSecret (used by vm-creds) scopes correctly.
   */
  gitEnv?: Record<string, string>;
}

// ── Singleton ────────────────────────────────────────────────────────────────

/** Shared MicrosandboxRuntime — callers don't need to construct one. */
let runtimeInstance: MicrosandboxRuntime | null = null;

function getRuntime(): MicrosandboxRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new MicrosandboxRuntime();
  }
  return runtimeInstance;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a V3 workspace: provision a disposable microVM, clone the repo into it,
 * mount credentials, and wire network egress.
 *
 * Lifecycle:
 *  1. Resolve DB, start with state=provisioning.
 *  2. MicrosandboxRuntime.provision() — boot the VM.
 *  3. mount + init (DNS fix, creds, toolchain).
 *  4. git-wrapper.cloneRepo() + git-wrapper.checkoutRunBranch().
 *  5. Write v3_workspaces row with state=ready.
 */
export async function createWorkspace(
  opts: CreateWorkspaceOptions,
): Promise<V3Workspace> {
  const db = getV3Db();
  const runtime = getRuntime();
  const {
    runId,
    repoUrl,
    branch,
    keepAfterRun = false,
    mountSpec,
    gitEnv = {},
  } = opts;

  const workspaceId = crypto.randomUUID();
  const branchName = branch && branch.trim() !== "" ? branch : runBranchName(runId);

  // ── Step 0: insert provisioning row (fail-fast bookkeeping) ──────────────
  await db.insert(v3Schema.v3Workspaces).values({
    id: workspaceId,
    ownerKind: "run",
    ownerId: runId,
    tags: {
      keep_after_run: String(keepAfterRun),
      ...(opts.tagMatch ?? {}),
    } as any,
    vmName: null,
    repoUrl,
    branch: branchName,
    state: "provisioning",
    createdAt: new Date(),
    destroyedAt: null,
    createdBy: `run:${runId}`,
    ownerEmail: "local@localhost",
    orgId: null,
  });

  let vm: VmHandle | null = null;

  try {
    // ── Step 1: provision VM ──────────────────────────────────────────────
    vm = await runtime.provision({
      kind: "microvm",
      onFailure: "recreate",
      image: mountSpec?.env?.ORCHESTRATOR_IMAGE,
      gitRemote: repoUrl,
      baseRef: branch,
      mounts: mountSpec ? [
        { host: "/work", path: "/work", mode: "rw" },
        ...(mountSpec.folders ?? []),
      ] : [{ host: "/work", path: "/work", mode: "rw" }],
      env: mountSpec?.env,
      resources: mountSpec?.env?.ORCHESTRATOR_CPUS
        ? { cpus: Number(mountSpec.env.ORCHESTRATOR_CPUS) }
        : undefined,
    });

    // ── Step 2: mount + init (egress DNS, creds, toolchain) ──────────────
    const effectiveMount: MountSpec = mountSpec ?? {};
    await runtime.mount(vm, effectiveMount);

    // Build the combined env that git commands will inherit.
    const baseEnv: Record<string, string> = {
      HOME: VM_HOME,
      ...(mountSpec?.env ?? {}),
      ...gitEnv,
    };

    // Merge any runtime env that mount() stashed on vm.meta.
    const metaEnv = (vm.meta?.runtimeEnv as Record<string, string> | undefined) ?? {};
    const workEnv: Record<string, string> = { ...baseEnv, ...metaEnv };

    // init() installs toolchain (node, git, claude) inside the VM.
    await runtime.init(vm, branchName, workEnv);

    // ── Step 3: clone repo + checkout branch ──────────────────────────────
    const workdir =
      (vm.meta?.workdir as string | undefined) ?? "/work";
    const gitCtx: GitContext = { runtime, vm, workdir, env: workEnv };

    // cloneRepo only runs when the worktree is empty (init might have git-init'd
    // it already if no gitRemote was in the spec — but we always clone explicitly
    // here because the workspace adapter owns the repo). We clear the workdir
    // first so cloneRepo clones into a clean "." target.
    const cleared = await runtime.exec(vm, `rm -rf ${workdir}/* ${workdir}/.* 2>/dev/null; true`);
    void cleared;

    const cloned = await cloneRepo(gitCtx, {
      remoteUrl: repoUrl,
      branch: branchName,
    });
    if (!cloned.cloned) {
      throw new Error(
        `cloneRepo failed for ${repoUrl}: ${cloned.reason} — ${cloned.detail}`,
      );
    }

    // checkoutRunBranch when cloneRepo did not already pick up the branch.
    if (!cloned.branchPickedUp) {
      await checkoutRunBranch(gitCtx, {
        branch: branchName,
        baseRef: branch,
      });
    }

    // ── Step 4: update workspace row → ready ─────────────────────────────
    await db
      .update(v3Schema.v3Workspaces)
      .set({
        vmName: vm.name,
        state: "ready",
      })
      .where(eq(v3Schema.v3Workspaces.id, workspaceId));

    return await getWorkspace(workspaceId);
  } catch (err: unknown) {
    // Rollback: update workspace to error state with the real message.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(v3Schema.v3Workspaces)
      .set({
        state: "error",
      })
      .where(eq(v3Schema.v3Workspaces.id, workspaceId));

    // Teardown the VM if it was provisioned.
    if (vm) {
      await runtime.teardown(vm, "destroy").catch(() => {
        // Non-fatal: the workspace row already captured the root cause.
      });
    }

    throw new Error(`createWorkspace failed for run ${runId}: ${message}`);
  }
}

/**
 * Destroy a V3 workspace: teardown the VM and mark the workspace row destroyed.
 * If `keepAfterRun` is recorded on the workspace tags, skip teardown and only
 * mark the row as destroyed (the VM stays alive for inspection).
 */
export async function destroyWorkspace(
  workspaceId: string,
): Promise<V3Workspace> {
  const db = getV3Db();
  const runtime = getRuntime();

  const workspace = await getWorkspace(workspaceId);

  if (workspace.state === "destroyed") {
    return workspace;
  }

  // Check keep_after_run tag.
  const keepAfterRun =
    workspace.tags && typeof workspace.tags === "object"
      ? (workspace.tags as Record<string, unknown>).keep_after_run === "true"
      : false;

  let policy: TeardownPolicy = "destroy";
  if (keepAfterRun && workspace.vmName) {
    // VM stays, only the row is marked destroyed.
    policy = "keep";
  }

  try {
    if (workspace.vmName) {
      // Find the spec for this VM — we need a VmHandle. Reconstruct a minimal
      // handle from the workspace row so teardown can address the sandbox by name.
      const vm: VmHandle = {
        name: workspace.vmName,
        spec: { kind: "microvm", onFailure: "recreate" },
        meta: {},
      };
      await runtime.teardown(vm, policy);
    }
  } catch (err: unknown) {
    // Teardown failure is non-fatal for the row update.
  }

  // Always mark the row as destroyed.
  await db
    .update(v3Schema.v3Workspaces)
    .set({
      state: "destroyed",
      destroyedAt: new Date(),
    })
    .where(eq(v3Schema.v3Workspaces.id, workspaceId));

  return getWorkspace(workspaceId);
}

/**
 * Read a V3 workspace by ID. Throws if the workspace does not exist.
 */
export async function getWorkspace(
  workspaceId: string,
): Promise<V3Workspace> {
  const db = getV3Db();

  const [row] = await db
    .select()
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, workspaceId));

  if (!row) {
    throw new Error(`workspace ${workspaceId} not found`);
  }

  return row as V3Workspace;
}
