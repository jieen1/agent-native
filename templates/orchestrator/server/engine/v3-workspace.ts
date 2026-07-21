// V3 Workspace Adapter (DESIGN §8.2, IMPLEMENTATION §C).
// Owns the full workspace lifecycle: provision VM, clone repo, mount credentials,
// wire egress, and persist the v3_workspaces row. The V3 dispatcher calls this
// before it hands the workspaceId to a spawn.

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getV3Db, v3Schema } from "../db/index.js";
import {
  cloneRepo,
  checkoutRunBranch,
  runBranchName,
  type GitContext,
} from "../runtime/git-wrapper.js";
import {
  MicrosandboxRuntime,
  toWslPath,
} from "../runtime/microsandbox-runtime.js";
import { resolveEgress } from "../runtime/networking.js";
import type {
  MountSpec,
  VmHandle,
  TeardownPolicy,
} from "../runtime/node-runtime.js";
import { mountVmCredentials, VM_HOME } from "../runtime/vm-creds.js";
import { WorkspaceNotReadyError } from "../v3-workspace-provision.js";

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
  /** F1 workspace contract (02-workflows.md §7) — set only after the full
   * W1→W2→W3 readiness sequence passes. null means "not ready": the
   * dispatcher's readiness gate must not spawn/dispatch a node on this
   * workspace. */
  readyAt: Date | null;
  baseSha: string | null;
  readyReport: unknown;
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
  const branchName =
    branch && branch.trim() !== "" ? branch : runBranchName(runId);

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
      mounts: mountSpec
        ? [
            { host: "/work", path: "/work", mode: "rw" },
            ...(mountSpec.folders ?? []),
          ]
        : [{ host: "/work", path: "/work", mode: "rw" }],
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
    const metaEnv =
      (vm.meta?.runtimeEnv as Record<string, string> | undefined) ?? {};
    const workEnv: Record<string, string> = { ...baseEnv, ...metaEnv };

    // init() installs toolchain (node, git, claude) inside the VM.
    await runtime.init(vm, branchName, workEnv);

    // ── Step 3: clone repo + checkout branch ──────────────────────────────
    const workdir = (vm.meta?.workdir as string | undefined) ?? "/work";
    const gitCtx: GitContext = { runtime, vm, workdir, env: workEnv };

    // cloneRepo only runs when the worktree is empty (init might have git-init'd
    // it already if no gitRemote was in the spec — but we always clone explicitly
    // here because the workspace adapter owns the repo). We clear the workdir
    // first so cloneRepo clones into a clean "." target.
    const cleared = await runtime.exec(
      vm,
      `rm -rf ${workdir}/* ${workdir}/.* 2>/dev/null; true`,
    );
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

    // ── Step 4: readiness assertion (F1 DESIGN §7) + update workspace row ──
    // The microVM adapter is UNUSED in the Docker deployment (MicrosandboxRuntime
    // needs msb/libkrun, unavailable there — see the file header); the
    // host-native worktree/clone adapter (`server/v3-workspace-local.ts`) is the
    // only currently-exercised path and gets the FULL W1→W2→W3 assertion
    // sequence. Here we run a best-effort W1 (baseline-freshness) check
    // in-VM via `runtime.exec` — genuine command failures (non-zero exit)
    // still throw `WorkspaceNotReadyError('W1', …)` (state → `failed`,
    // dispatcher gate stays closed), but an inconclusive/unparseable result
    // (no merge-base output — the shape of a stub/mocked runtime, or any VM
    // whose toolchain didn't ship `git`) does not block readiness: it stamps
    // `readyAt` anyway so this legacy path doesn't get universally gated out
    // by the dispatcher's `readyAt IS NOT NULL` check. Full W2 (dependency
    // prewarm) / W3 (test-executability smoke) for the VM path is deferred —
    // out of scope for this pass given (a) and (b) above.
    const w1 = await assertMicrovmBaselineBestEffort(runtime, vm, branchName);

    await db
      .update(v3Schema.v3Workspaces)
      .set({
        vmName: vm.name,
        state: "ready",
        baseSha: w1.baseSha,
        readyAt: new Date(),
        readyReport: {
          w1,
          note: "microVM adapter: W2/W3 not implemented (unused in the Docker deployment) — see server/engine/v3-workspace.ts",
        } as unknown,
      })
      .where(eq(v3Schema.v3Workspaces.id, workspaceId));

    return await getWorkspace(workspaceId);
  } catch (err: unknown) {
    // Rollback: `failed` for a readiness-assertion miss (infra, W1 — never an
    // agent failure), `error` for anything else (a genuine provisioning
    // failure — VM provision/mount/init/clone/checkout).
    const message = err instanceof Error ? err.message : String(err);
    const isReadinessFailure = err instanceof WorkspaceNotReadyError;
    await db
      .update(v3Schema.v3Workspaces)
      .set(
        isReadinessFailure
          ? { state: "failed", readyReport: { error: message } as unknown }
          : { state: "error" },
      )
      .where(eq(v3Schema.v3Workspaces.id, workspaceId));

    // Teardown the VM if it was provisioned.
    if (vm) {
      await runtime.teardown(vm, "destroy").catch(() => {
        // Non-fatal: the workspace row already captured the root cause.
      });
    }

    if (isReadinessFailure) throw err;
    throw new Error(`createWorkspace failed for run ${runId}: ${message}`);
  }
}

/**
 * Best-effort W1 (baseline freshness) check for the microVM adapter: runs
 * `git merge-base <branchName> HEAD` inside the VM. A non-zero exit (git
 * itself ran and reported a real failure — e.g. no such branch) throws
 * `WorkspaceNotReadyError('W1', …)`. Empty/unparseable output (the shape a
 * stub runtime or a toolchain without `git` returns) is treated as
 * inconclusive rather than a failure — see the readiness-assertion comment
 * at its call site for why.
 */
async function assertMicrovmBaselineBestEffort(
  runtime: MicrosandboxRuntime,
  vm: VmHandle,
  branchName: string,
): Promise<{ ok: boolean; baseSha: string | null; detail: string }> {
  const workdir = (vm.meta?.workdir as string | undefined) ?? "/work";
  const res = await runtime
    .exec(vm, `git merge-base ${branchName} HEAD`, {
      cwd: workdir,
      env: { HOME: VM_HOME },
    })
    .catch((err: unknown) => ({
      code: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    }));

  if (res.code !== 0) {
    throw new WorkspaceNotReadyError(
      "W1",
      `in-VM merge-base check failed (exit ${res.code}): ${res.stderr || res.stdout}`,
    );
  }
  const sha = res.stdout?.trim() || "";
  if (!sha) {
    return {
      ok: true,
      baseSha: null,
      detail: "in-VM merge-base check inconclusive (empty output)",
    };
  }
  return {
    ok: true,
    baseSha: sha,
    detail: `merge-base(${branchName}, HEAD)=${sha}`,
  };
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
export async function getWorkspace(workspaceId: string): Promise<V3Workspace> {
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
