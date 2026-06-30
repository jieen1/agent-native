// V3 Workspace Adapter Unit Tests
//
// Tests workspace lifecycle: createWorkspace, destroyWorkspace, getWorkspace.
// Mocks MicrosandboxRuntime, git-wrapper, vm-creds, networking, and DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Mock dependencies ───────────────────────────────────────────────────────

// Mock MicrosandboxRuntime
vi.mock("../runtime/microsandbox-runtime.js", () => {
  class MicrosandboxRuntime {
    provision() {}
    teardown() {}
    mount() {}
    init() {}
    exec() {}
  }
  return {
    MicrosandboxRuntime,
    toWslPath: vi.fn((p: string) => p),
  };
});

// Mock git-wrapper
vi.mock("../runtime/git-wrapper.js", () => ({
  cloneRepo: vi.fn(),
  checkoutRunBranch: vi.fn(),
  runBranchName: vi.fn((runId: string) => `an/run-${runId}`),
}));

// Mock vm-creds
vi.mock("../runtime/vm-creds.js", () => ({
  mountVmCredentials: vi.fn(),
  VM_HOME: "/home/sandbox",
}));

// Mock networking
vi.mock("../runtime/networking.js", () => ({
  resolveEgress: vi.fn().mockReturnValue("direct"),
}));

// Mock v3.js DB module
const hoisted = vi.hoisted(() => ({
  getV3Db: vi.fn(),
  v3Schema: {
    v3Workspaces: {},
  },
}));

vi.mock("../db/v3.js", () => ({
  getV3Db: hoisted.getV3Db,
  v3Schema: hoisted.v3Schema,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { MicrosandboxRuntime } from "../runtime/microsandbox-runtime.js";
import { cloneRepo, checkoutRunBranch, runBranchName } from "../runtime/git-wrapper.js";
import { mountVmCredentials, VM_HOME } from "../runtime/vm-creds.js";
import { resolveEgress } from "../runtime/networking.js";

// ── Mock DB Builder ──────────────────────────────────────────────────────────

interface WorkspaceRow {
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

function createMockDb() {
  const workspaces = new Map<string, WorkspaceRow>();

  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          return Array.from(workspaces.values());
        },
      }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          for (const [, ws] of workspaces) {
            Object.assign(ws, data);
          }
          return {};
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        workspaces.set(row.id as string, row as unknown as WorkspaceRow);
        return {};
      },
    }),
  } as unknown as PostgresJsDatabase;

  return { db, workspaces };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("V3 Workspace Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MicrosandboxRuntime", () => {
    it("is mockable via vi.mock", () => {
      expect(MicrosandboxRuntime).toBeDefined();
      expect(typeof MicrosandboxRuntime).toBe("function");
    });

    it("mock instance has expected methods", () => {
      const runtime = new MicrosandboxRuntime();
      expect(typeof runtime.provision).toBe("function");
      expect(typeof runtime.teardown).toBe("function");
      expect(typeof runtime.mount).toBe("function");
      expect(typeof runtime.init).toBe("function");
      expect(typeof runtime.exec).toBe("function");
    });
  });

  describe("git-wrapper", () => {
    it("cloneRepo is mockable", () => {
      expect(cloneRepo).toBeDefined();
    });

    it("checkoutRunBranch is mockable", () => {
      expect(checkoutRunBranch).toBeDefined();
    });

    it("runBranchName produces an-branch from runId", () => {
      const branch = runBranchName("run-abc");
      expect(branch).toBe("an/run-run-abc");
    });
  });

  describe("vm-creds", () => {
    it("VM_HOME is set", () => {
      expect(VM_HOME).toBe("/home/sandbox");
    });

    it("mountVmCredentials is mockable", () => {
      expect(mountVmCredentials).toBeDefined();
    });
  });

  describe("networking", () => {
    it("resolveEgress is mockable", () => {
      expect(resolveEgress).toBeDefined();
    });

    it("resolveEgress returns direct by default", () => {
      expect(resolveEgress(null as any, null as any, {})).toBe("direct");
    });
  });

  describe("createWorkspace", () => {
    it("createWorkspace calls all steps in order", async () => {
      vi.resetModules();
      const { workspaces, db } = createMockDb();
      hoisted.getV3Db.mockReturnValue(db);

      // Mock MicrosandboxRuntime singleton methods
      const mockVm = {
        name: "test-vm-001",
        spec: { kind: "microvm" },
        meta: { workdir: "/work", runtimeEnv: {} },
      };

      const mockRuntime = {
        provision: vi.fn().mockResolvedValue(mockVm),
        mount: vi.fn().mockResolvedValue(undefined),
        init: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
        teardown: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(MicrosandboxRuntime.prototype, "provision").mockImplementation(async () => mockVm as any);
      vi.spyOn(MicrosandboxRuntime.prototype, "mount").mockImplementation(async () => {});
      vi.spyOn(MicrosandboxRuntime.prototype, "init").mockImplementation(async () => {});
      vi.spyOn(MicrosandboxRuntime.prototype, "exec").mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));
      vi.spyOn(MicrosandboxRuntime.prototype, "teardown").mockImplementation(async () => {});

      // Mock git operations
      vi.mocked(cloneRepo).mockResolvedValue({
        cloned: true,
        branchPickedUp: true,
        reason: "",
        detail: "",
      } as any);
      vi.mocked(checkoutRunBranch).mockResolvedValue({
        checkedOut: true,
        reason: "",
      } as any);

      // Now import the workspace module (it will use the mocked deps)
      const { createWorkspace } = await import("./v3-workspace.js");

      const workspace = await createWorkspace({
        runId: "run-1",
        repoUrl: "https://github.com/test/repo.git",
        branch: "main",
      });

      // Verify all steps were called in order
      expect(MicrosandboxRuntime.prototype.provision).toHaveBeenCalledTimes(1);
      expect(MicrosandboxRuntime.prototype.mount).toHaveBeenCalledTimes(1);
      expect(MicrosandboxRuntime.prototype.init).toHaveBeenCalledTimes(1);
      expect(cloneRepo).toHaveBeenCalledTimes(1);
      expect(checkoutRunBranch).not.toHaveBeenCalled(); // branchPickedUp=true

      // Verify workspace row was created and updated
      expect(workspace.id).toBeDefined();
      expect(workspace.ownerKind).toBe("run");
      expect(workspace.ownerId).toBe("run-1");
      expect(workspace.repoUrl).toBe("https://github.com/test/repo.git");
      expect(workspace.vmName).toBe("test-vm-001");

      // Verify workspace was persisted
      const persisted = workspaces.get(workspace.id);
      expect(persisted).toBeDefined();
    });
  });

  describe("destroyWorkspace", () => {
    it("destroyWorkspace updates state", async () => {
      const { workspaces, db } = createMockDb();

      // Seed a workspace
      const wsId = "ws-123";
      workspaces.set(wsId, {
        id: wsId,
        ownerKind: "run",
        ownerId: "run-1",
        tags: null,
        vmName: "test-vm-001",
        repoUrl: "https://github.com/test/repo.git",
        branch: "main",
        state: "ready",
        createdAt: new Date(),
        destroyedAt: null,
        createdBy: "run:run-1",
        ownerEmail: "local@localhost",
        orgId: null,
      });

      hoisted.getV3Db.mockReturnValue(db);

      vi.spyOn(MicrosandboxRuntime.prototype, "teardown").mockImplementation(async () => {});

      vi.resetModules();
      const { destroyWorkspace } = await import("./v3-workspace.js");

      const result = await destroyWorkspace(wsId);
      expect(result.state).toBe("destroyed");
      expect(result.destroyedAt).toBeDefined();

      // Verify teardown was called
      expect(MicrosandboxRuntime.prototype.teardown).toHaveBeenCalledTimes(1);
    });

    it("destroyWorkspace is idempotent on already-destroyed workspace", async () => {
      const { workspaces, db } = createMockDb();

      const wsId = "ws-456";
      workspaces.set(wsId, {
        id: wsId,
        ownerKind: "run",
        ownerId: "run-1",
        tags: null,
        vmName: "test-vm-002",
        repoUrl: "https://github.com/test/repo.git",
        branch: "main",
        state: "destroyed",
        createdAt: new Date(),
        destroyedAt: new Date(),
        createdBy: "run:run-1",
        ownerEmail: "local@localhost",
        orgId: null,
      });

      hoisted.getV3Db.mockReturnValue(db);

      vi.spyOn(MicrosandboxRuntime.prototype, "teardown").mockImplementation(async () => {});

      vi.resetModules();
      const { destroyWorkspace } = await import("./v3-workspace.js");

      const result = await destroyWorkspace(wsId);

      expect(result.state).toBe("destroyed");
      // Teardown should NOT be called because already destroyed
      expect(MicrosandboxRuntime.prototype.teardown).not.toHaveBeenCalled();
    });
  });

  describe("getWorkspace", () => {
    it("getWorkspace returns workspace", async () => {
      const { workspaces, db } = createMockDb();

      const wsId = "ws-789";
      workspaces.set(wsId, {
        id: wsId,
        ownerKind: "run",
        ownerId: "run-1",
        tags: { keep_after_run: "false" },
        vmName: "test-vm-003",
        repoUrl: "https://github.com/test/repo.git",
        branch: "main",
        state: "ready",
        createdAt: new Date(),
        destroyedAt: null,
        createdBy: "run:run-1",
        ownerEmail: "local@localhost",
        orgId: null,
      });

      hoisted.getV3Db.mockReturnValue(db);

      vi.resetModules();
      const { getWorkspace } = await import("./v3-workspace.js");

      const result = await getWorkspace(wsId);

      expect(result.id).toBe(wsId);
      expect(result.state).toBe("ready");
      expect(result.vmName).toBe("test-vm-003");
      expect(result.tags).toEqual({ keep_after_run: "false" });
    });

    it("getWorkspace throws when workspace not found", async () => {
      const { db } = createMockDb();
      // No workspaces seeded

      hoisted.getV3Db.mockReturnValue(db);

      vi.resetModules();
      const { getWorkspace } = await import("./v3-workspace.js");

      await expect(getWorkspace("nonexistent")).rejects.toThrow(
        "workspace nonexistent not found",
      );
    });
  });
});
