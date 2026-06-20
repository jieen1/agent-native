// P6 BACKPRESSURE unit tests (DESIGN §4.1 acceptance b). Prove the two ceilings
// are DISTINCT error TYPES and limited SEPARATELY:
//   • the VM-capacity semaphore bounds live microVM provisions to maxConcurrentVMs
//     (running VM peak ≤ cap), and the overflow surfaces VMCapacityExhaustedError;
//   • a VM-cap hit is NOT a TokenBudgetExceededError (no mislabeling);
//   • the NodeRunner provision path takes a VM slot for the whole 7-stage pass,
//     so M = 2×maxConcurrentVMs nodes never exceed the cap (the load-test shape).
//
// VM-FREE: a fake NodeRuntime (no real microsandbox) makes provision a tracked
// async no-op, so the cap + error types are proven without a KVM host.

import { describe, it, expect } from "vitest";
import {
  VmSemaphore,
  VMCapacityExhaustedError,
  TokenBudgetExceededError,
  isVMCapacityExhausted,
  isTokenBudgetExceeded,
} from "./backpressure.js";
import { NodeRunner } from "./node-runner.js";
import type { NodeRuntime, VmHandle, TeardownPolicy } from "./node-runtime.js";
import type { RuntimeExecutor, RuntimeExecCtx } from "./executors/types.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";

// ── the two error types are genuinely distinct ───────────────────────────────

describe("distinct error types (DESIGN §4.1 — VM cap ≠ token budget)", () => {
  it("VMCapacityExhaustedError is not a TokenBudgetExceededError and vice-versa", () => {
    const vm = new VMCapacityExhaustedError(4, 4);
    const budget = new TokenBudgetExceededError(100, 100);

    expect(vm).toBeInstanceOf(VMCapacityExhaustedError);
    expect(vm).not.toBeInstanceOf(TokenBudgetExceededError);
    expect(budget).toBeInstanceOf(TokenBudgetExceededError);
    expect(budget).not.toBeInstanceOf(VMCapacityExhaustedError);

    // The type guards are exclusive — a VM-cap hit never reads as a budget overrun.
    expect(isVMCapacityExhausted(vm)).toBe(true);
    expect(isTokenBudgetExceeded(vm)).toBe(false);
    expect(isTokenBudgetExceeded(budget)).toBe(true);
    expect(isVMCapacityExhausted(budget)).toBe(false);

    // Distinct discriminator codes.
    expect(vm.code).toBe("VM_CAPACITY_EXHAUSTED");
    expect(budget.code).toBe("TOKEN_BUDGET_EXCEEDED");
  });
});

// ── the semaphore itself ──────────────────────────────────────────────────────

describe("VmSemaphore (DESIGN §4.1 — the second ceiling)", () => {
  it("bounds concurrent holders to the cap; release hands the slot to a waiter", async () => {
    const sem = new VmSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.inUse).toBe(2);

    // A third acquire with a finite timeout fails FAST with the distinct type.
    await expect(sem.acquire(0)).rejects.toBeInstanceOf(VMCapacityExhaustedError);

    // Releasing frees a slot for a new acquirer.
    sem.release();
    await sem.acquire();
    expect(sem.inUse).toBe(2);
  });

  it("a waiter (no timeout) is unblocked by a release, preserving the cap", async () => {
    const sem = new VmSemaphore(1);
    await sem.acquire();
    let acquired = false;
    const waiter = sem.acquire().then(() => {
      acquired = true;
    });
    // Still blocked while the slot is held.
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(sem.waiting).toBe(1);
    sem.release();
    await waiter;
    expect(acquired).toBe(true);
    expect(sem.inUse).toBe(1);
  });

  it("withSlot releases even when the body throws (no slot leak)", async () => {
    const sem = new VmSemaphore(1);
    await expect(
      sem.withSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The slot was returned — a fresh acquire succeeds immediately.
    expect(sem.inUse).toBe(0);
    await sem.acquire();
    expect(sem.inUse).toBe(1);
  });
});

// ── the NodeRunner provision path holds a slot for the whole pass ─────────────

/** A fake microVM backend: provision is a tracked async no-op (no real KVM). */
function makeFakeRuntime(opts: {
  onProvision: () => void;
  onTeardown: () => void;
  execMs: number;
}): NodeRuntime {
  return {
    kind: "fake",
    async provision(spec: NodeRuntimeSpec): Promise<VmHandle> {
      opts.onProvision();
      return { name: `vm_${Math.random().toString(36).slice(2)}`, spec };
    },
    async mount() {},
    async init() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("not used");
    },
    fs() {
      return {
        read: async () => "",
        write: async () => {},
        copyFromHost: async () => {},
        copyToHost: async () => {},
      };
    },
    async getPortUrl() {
      return "";
    },
    async snapshot() {
      return "snap";
    },
    async teardown(_vm: VmHandle, _policy: TeardownPolicy) {
      opts.onTeardown();
    },
  };
}

/** A fake EXECUTE-stage brain that just sleeps `execMs` then returns. */
function makeFakeExecutor(execMs: number): RuntimeExecutor {
  return {
    kind: "fake-exec",
    async run(_ctx: RuntimeExecCtx): Promise<{
      output: unknown;
      tokensSpent: number;
      toolCallCount: number;
      model: string;
    }> {
      await new Promise((r) => setTimeout(r, execMs));
      return { output: { ok: true }, tokensSpent: 0, toolCallCount: 0, model: "fake" };
    },
  };
}

function microvmNode(id: string): Node {
  return {
    id,
    type: "agent",
    title: id,
    runtime: { kind: "microvm", onSuccess: "destroy", onFailure: "recreate" },
  } as Node;
}

describe("NodeRunner provision backpressure (DESIGN §4.1 — M=2×cap load shape)", () => {
  it("running VM peak never exceeds maxConcurrentVMs; M=2×cap nodes all complete", async () => {
    const CAP = 2;
    const M = 2 * CAP; // 4 nodes, the P6 load-test shape
    const sem = new VmSemaphore(CAP);

    let live = 0;
    let peak = 0;
    const runtime = makeFakeRuntime({
      onProvision: () => {
        live += 1;
        peak = Math.max(peak, live);
      },
      onTeardown: () => {
        live -= 1;
      },
      execMs: 20,
    });

    const runner = new NodeRunner({
      executor: makeFakeExecutor(20),
      runtimeFor: () => runtime,
      vmSemaphore: sem,
      // No timeout → overflow nodes WAIT for a slot (backpressure, not failure).
    });

    const results = await Promise.allSettled(
      Array.from({ length: M }, (_u, i) =>
        runner.run(
          {
            node: microvmNode(`n${i}`),
            deps: {},
            ownerEmail: "local@localhost",
            orgId: null,
          },
          new AbortController().signal,
        ),
      ),
    );

    // All M nodes completed (queued behind the cap, none failed).
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // The VM-in-use peak NEVER exceeded the cap — the monitor assertion.
    expect(peak).toBeLessThanOrEqual(CAP);
    expect(peak).toBe(CAP); // and it DID saturate the cap
    // The semaphore returned to empty (no slot leak).
    expect(sem.inUse).toBe(0);
  });

  it("overflow with acquireTimeoutMs=0 surfaces VMCapacityExhaustedError (NOT a budget error)", async () => {
    const CAP = 1;
    const sem = new VmSemaphore(CAP);

    const runtime = makeFakeRuntime({
      onProvision: () => {},
      onTeardown: () => {},
      execMs: 50,
    });
    const runner = new NodeRunner({
      executor: makeFakeExecutor(50),
      runtimeFor: () => runtime,
      vmSemaphore: sem,
      acquireTimeoutMs: 0, // fail fast on a full cap → distinct capacity error
    });

    const sig = new AbortController().signal;
    // First node grabs the only slot and holds it through its 50ms exec.
    const first = runner.run(
      { node: microvmNode("a"), deps: {}, ownerEmail: "local@localhost", orgId: null },
      sig,
    );
    // Second node, started immediately, finds the cap full → VMCapacityExhausted.
    const second = runner
      .run(
        { node: microvmNode("b"), deps: {}, ownerEmail: "local@localhost", orgId: null },
        sig,
      )
      .catch((e) => e);

    const err = await second;
    expect(isVMCapacityExhausted(err)).toBe(true);
    // The critical non-mislabel assertion: a VM-cap hit is NOT a budget overrun.
    expect(isTokenBudgetExceeded(err)).toBe(false);
    expect(err).toBeInstanceOf(VMCapacityExhaustedError);

    await first; // let the holder finish cleanly
    expect(sem.inUse).toBe(0);
  });

  it("a `none`-runtime node takes NO VM slot (host execution, no microVM)", async () => {
    const sem = new VmSemaphore(1);
    // Saturate the single slot so any acquire would block/fail.
    await sem.acquire();

    const runtime = makeFakeRuntime({
      onProvision: () => {},
      onTeardown: () => {},
      execMs: 1,
    });
    const runner = new NodeRunner({
      executor: makeFakeExecutor(1),
      runtimeFor: () => runtime,
      vmSemaphore: sem,
      acquireTimeoutMs: 0,
    });

    // A node with a `none` runtime must run even though the VM cap is full —
    // it consumes no microVM slot.
    const noneNode = {
      id: "host",
      type: "branch",
      title: "host",
      runtime: { kind: "none", onFailure: "recreate" },
    } as Node;
    const res = await runner.run(
      { node: noneNode, deps: {}, ownerEmail: "local@localhost", orgId: null },
      new AbortController().signal,
    );
    expect((res.output as { ok: boolean }).ok).toBe(true);
    sem.release();
  });
});
