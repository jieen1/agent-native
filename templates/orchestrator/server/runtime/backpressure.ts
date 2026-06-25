// VM-capacity backpressure (DESIGN §4.1 / §6.4 — the SECOND concurrency ceiling).
//
// There are two orthogonal ceilings a run can hit, and DESIGN §4.1 is explicit
// that they MUST be reported + limited SEPARATELY (a VM-bound run that hits the
// KVM-host VM cap must never be mislabeled a token-budget overrun):
//
//   • maxConcurrentVMs — each running microVM node is one libkrun/KVM microVM,
//     bounded by the host's CPU/mem (§7.4.7). When all VM slots are in use a new
//     provision WAITS for a slot; if it cannot get one within the bound it
//     surfaces a distinct `VMCapacityExhaustedError`.
//   • tokenBudget    — the run's spend ceiling (§1.8). When spend ≥ budget the
//     scheduler refuses to schedule NEW dynamic nodes, surfaced as
//     `TokenBudgetExceededError`.
//
// This module owns the FIRST one: a real counting semaphore that bounds live VM
// provisions, plus the two distinct error TYPES so callers (and tests) can tell
// a VM-cap hit from a budget overrun by `instanceof`, never by string-matching.
//
// The semaphore is process-local (single-isolate self-host, §14). A multi-host
// durable VM cap is the deferred remote-runtime work (DESIGN §14 phase 6) — NOT
// built here.

import { DEFAULT_CAPS } from "../engine/types.js";

/**
 * Raised when a microVM provision cannot get a VM slot under the
 * `maxConcurrentVMs` ceiling within the wait bound (DESIGN §4.1 / §6.4). This is
 * a CAPACITY/backpressure signal — the node is runnable, the host is just full —
 * and is DISTINCT from a token-budget overrun so the scheduler can queue/retry
 * it rather than misreport it as a budget breach.
 */
export class VMCapacityExhaustedError extends Error {
  /** Stable discriminator so callers can branch without importing the class. */
  readonly code = "VM_CAPACITY_EXHAUSTED" as const;
  /** The ceiling that was hit (for the message + observability). */
  readonly maxConcurrentVMs: number;
  /** VMs in use when the provision gave up. */
  readonly inUse: number;

  constructor(maxConcurrentVMs: number, inUse: number) {
    super(
      `VM capacity exhausted: ${inUse}/${maxConcurrentVMs} microVMs in use ` +
        `(maxConcurrentVMs=${maxConcurrentVMs}). The node is queued for a free VM slot, not over budget.`,
    );
    this.name = "VMCapacityExhaustedError";
    this.maxConcurrentVMs = maxConcurrentVMs;
    this.inUse = inUse;
  }
}

/**
 * Raised when a run's token spend has reached its `tokenBudget` ceiling and a
 * NEW dynamic node would push past it (DESIGN §1.8). DISTINCT from
 * {@link VMCapacityExhaustedError}: this is an economic stop, not a capacity
 * one. The scheduler stops scheduling new dynamic nodes rather than queueing.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = "TOKEN_BUDGET_EXCEEDED" as const;
  readonly tokenBudget: number;
  readonly tokensSpent: number;

  constructor(tokenBudget: number, tokensSpent: number) {
    super(
      `Token budget exceeded: spent ${tokensSpent}/${tokenBudget}. ` +
        `New dynamic nodes are refused (this is a budget stop, not a VM-capacity backpressure).`,
    );
    this.name = "TokenBudgetExceededError";
    this.tokenBudget = tokenBudget;
    this.tokensSpent = tokensSpent;
  }
}

/** True for a VM-capacity backpressure error (type-safe, not string-matched). */
export function isVMCapacityExhausted(
  err: unknown,
): err is VMCapacityExhaustedError {
  return (
    err instanceof VMCapacityExhaustedError ||
    (err instanceof Error &&
      (err as { code?: string }).code === "VM_CAPACITY_EXHAUSTED")
  );
}

/** True for a token-budget overrun error (type-safe, not string-matched). */
export function isTokenBudgetExceeded(
  err: unknown,
): err is TokenBudgetExceededError {
  return (
    err instanceof TokenBudgetExceededError ||
    (err instanceof Error &&
      (err as { code?: string }).code === "TOKEN_BUDGET_EXCEEDED")
  );
}

/**
 * Default acquire timeout (DESIGN §10.2): "spawn waits pool_acquire_timeout_seconds
 * (default 120), then transient error." Applied to both VmSemaphore and WarmVmPool.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;

/**
 * A real counting semaphore bounding concurrent microVM provisions to
 * `maxConcurrentVMs` (DESIGN §4.1). `acquire()` either takes a free slot
 * immediately or WAITS (FIFO) for one to be released; if `acquireTimeoutMs`
 * elapses first it rejects with {@link VMCapacityExhaustedError} so the caller
 * surfaces backpressure as a distinct type rather than blocking forever or
 * mislabeling it. Defaults to {@link DEFAULT_ACQUIRE_TIMEOUT_MS} (120 s).
 * `release()` hands the slot to the next waiter.
 *
 * It is INTERNALLY concurrency-safe under the single-threaded event loop: all
 * mutations happen synchronously between awaits, so two acquirers can never both
 * see the same free slot.
 */
export class VmSemaphore {
  private readonly max: number;
  private inUseCount = 0;
  /** FIFO queue of resolvers waiting for a slot, each with its timeout timer. */
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  constructor(maxConcurrentVMs: number) {
    if (!Number.isInteger(maxConcurrentVMs) || maxConcurrentVMs < 1) {
      throw new Error(
        `VmSemaphore: maxConcurrentVMs must be a positive integer, got ${maxConcurrentVMs}`,
      );
    }
    this.max = maxConcurrentVMs;
  }

  /** The configured ceiling. */
  get maxConcurrentVMs(): number {
    return this.max;
  }

  /** How many slots are currently held (VMs live). */
  get inUse(): number {
    return this.inUseCount;
  }

  /** How many acquirers are blocked waiting for a free slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Take a VM slot. Resolves immediately if one is free; otherwise waits up to
   * `acquireTimeoutMs` (default: {@link DEFAULT_ACQUIRE_TIMEOUT_MS} = 120 s) for a
   * release. On timeout it rejects with {@link VMCapacityExhaustedError} — the
   * DISTINCT backpressure type, never folded into the token budget.
   */
  async acquire(
    acquireTimeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ): Promise<void> {
    if (this.inUseCount < this.max) {
      this.inUseCount += 1;
      return;
    }
    // No free slot — fail immediately for a zero timeout, otherwise queue.
    if (acquireTimeoutMs <= 0) {
      throw new VMCapacityExhaustedError(this.max, this.inUseCount);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new VMCapacityExhaustedError(this.max, this.inUseCount));
      }, acquireTimeoutMs);
      if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      this.waiters.push(waiter);
    });
    // Resolved by release() which already accounted the slot to us.
  }

  /** Release a held slot, handing it to the next FIFO waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      // The slot transfers directly to the waiter (inUseCount stays the same).
      next.resolve();
      return;
    }
    if (this.inUseCount > 0) this.inUseCount -= 1;
  }

  /**
   * Run `fn` while holding a VM slot, releasing it in a finally so a thrown fn
   * never leaks the slot (which would permanently shrink `maxConcurrentVMs`).
   * Defaults to {@link DEFAULT_ACQUIRE_TIMEOUT_MS} (120 s → transient error).
   */
  async withSlot<T>(
    fn: () => Promise<T>,
    acquireTimeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ): Promise<T> {
    await this.acquire(acquireTimeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * The process-wide VM semaphore, sized to `maxConcurrentVMs` (DESIGN §4.1 /
 * §6.4). Lazily built so a test can reset it; the NodeRunner provision path
 * acquires from it so the live VM count never exceeds the host ceiling — the
 * load-bearing backpressure for the P6 M=2×maxConcurrentVMs load test.
 */
let shared: VmSemaphore | null = null;

/** Read (or lazily create) the shared VM semaphore. */
export function getVmSemaphore(): VmSemaphore {
  if (!shared) shared = new VmSemaphore(DEFAULT_CAPS.maxConcurrentVMs);
  return shared;
}

/**
 * Replace the shared semaphore (test seam + a future `set-concurrency` wire-up
 * when maxConcurrentVMs becomes tunable). Pass an explicit cap to size it.
 */
export function setVmSemaphore(maxConcurrentVMs: number): VmSemaphore {
  shared = new VmSemaphore(maxConcurrentVMs);
  return shared;
}

// ── Warm microVM Pool (DESIGN §10.2) ─────────────────────────────────────────

/**
 * Status of a single warm VM slot in the pool.
 *   "warm_idle" — provisioned and ready for immediate acquisition.
 *   "busy"      — currently assigned to a spawn.
 */
export type WarmVmSlotStatus = "warm_idle" | "busy";

/** A single slot in the warm VM pool. */
export interface WarmVmSlot {
  /** The sandbox name (`an-node-...`) assigned at provision time. */
  vmName: string;
  status: WarmVmSlotStatus;
  /** When the VM was provisioned (for staleness checks). */
  createdAt: Date;
}

/** Aggregate pool statistics (for pool.status MCP surface, DESIGN §8.7). */
export interface PoolStatus {
  warm_idle: number;
  busy: number;
  capacity: number;
  queue_waiting: number;
}

/**
 * Async factory type for provisioning a new warm VM. Decoupled from the pool so
 * the real implementation (MicrosandboxRuntime.provision) is injected and tests
 * can use a stub.
 */
export type VmProvisionFn = () => Promise<string>; // returns vmName

/**
 * Warm microVM pool (DESIGN §10.2).
 *
 * Pre-warms N microVMs (default 4) so a spawn can acquire an idle VM instantly
 * instead of waiting 8-30s for a cold boot. After every acquire the pool
 * replenishes async (a non-blocking background provision) so the target idle
 * count is maintained.
 *
 * Pool lifecycle:
 *   1. `start(provisionFn)` — kicks off N parallel provisions (best-effort;
 *      failures are silently dropped so a misconfigured env doesn't block startup).
 *   2. `acquire()` — takes an idle VM (if available) or waits up to
 *      acquireTimeoutMs (default 120 000ms → transient error; DESIGN §10.2).
 *      Schedules an async replenish to restore the idle target.
 *   3. `release(vmName)` — returns a VM to the idle pool (called when a spawn
 *      finishes; the destroy-after-use policy means the caller destroys instead,
 *      so typically release is NOT called; the slot is just deleted).
 *   4. `status()` — returns { warm_idle, busy, capacity, queue_waiting }.
 */
export class WarmVmPool {
  private readonly targetIdle: number;
  private acquireTimeoutMs: number;
  private provisionFn: VmProvisionFn | null = null;

  /** All known slots (idle + busy). */
  private readonly slots = new Map<string, WarmVmSlot>();
  /** FIFO queue of resolve/reject pairs waiting for an idle slot. */
  private readonly waiters: Array<{
    resolve: (vmName: string) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  /** True when a background replenish is running (avoid double-spawn). */
  private replenishing = false;

  constructor(
    targetIdle: number = DEFAULT_CAPS.maxConcurrentVMs,
    acquireTimeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(targetIdle) || targetIdle < 1) {
      throw new Error(
        `WarmVmPool: targetIdle must be a positive integer, got ${targetIdle}`,
      );
    }
    this.targetIdle = targetIdle;
    this.acquireTimeoutMs = acquireTimeoutMs;
  }

  /**
   * Start the pool: register the provision function and kick off initial
   * pre-warming. Call once at server startup. Best-effort — failures are
   * swallowed so a bad image or WSL unavailability doesn't crash the process.
   */
  start(provisionFn: VmProvisionFn): void {
    this.provisionFn = provisionFn;
    // Kick off N parallel pre-warm provisions without blocking.
    for (let i = 0; i < this.targetIdle; i++) {
      this._provisionOne().catch(() => {});
    }
  }

  /**
   * Acquire an idle VM slot. Resolves immediately if one is warm_idle;
   * otherwise waits up to `acquireTimeoutMs` for a slot to become available.
   * On timeout, rejects with a `VMCapacityExhaustedError` (maps to `transient`
   * error class per DESIGN §10.2 / §12).
   */
  acquire(): Promise<string> {
    // Take first idle slot if available.
    for (const [vmName, slot] of this.slots) {
      if (slot.status === "warm_idle") {
        slot.status = "busy";
        // Async replenish to restore idle count.
        this._scheduleReplenish();
        return Promise.resolve(vmName);
      }
    }

    // No idle slot — queue with timeout.
    const timeoutMs = this.acquireTimeoutMs;
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          const busy = [...this.slots.values()].filter(
            (s) => s.status === "busy",
          ).length;
          reject(new VMCapacityExhaustedError(this.targetIdle, busy));
        }, timeoutMs);
        if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Mark a slot as destroyed (called after the caller destroys the VM).
   * Removes the slot and schedules a replenish.
   */
  markDestroyed(vmName: string): void {
    this.slots.delete(vmName);
    this._scheduleReplenish();
  }

  /** Pool statistics for the pool.status MCP tool (DESIGN §8.7). */
  status(): PoolStatus {
    let warm_idle = 0;
    let busy = 0;
    for (const slot of this.slots.values()) {
      if (slot.status === "warm_idle") warm_idle++;
      else busy++;
    }
    return {
      warm_idle,
      busy,
      capacity: this.targetIdle,
      queue_waiting: this.waiters.length,
    };
  }

  /** Number of idle slots currently available. */
  get idleCount(): number {
    return [...this.slots.values()].filter((s) => s.status === "warm_idle")
      .length;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** Provision one warm VM and add it as idle (or hand to first waiter). */
  private async _provisionOne(): Promise<void> {
    if (!this.provisionFn) return;
    let vmName: string;
    try {
      vmName = await this.provisionFn();
    } catch {
      return; // best-effort
    }
    const slot: WarmVmSlot = {
      vmName,
      status: "warm_idle",
      createdAt: new Date(),
    };
    // If a waiter is queued, hand the slot directly to them.
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      slot.status = "busy";
      this.slots.set(vmName, slot);
      waiter.resolve(vmName);
      return;
    }
    this.slots.set(vmName, slot);
  }

  /** Schedule an async replenish when the idle count is below target. */
  private _scheduleReplenish(): void {
    if (this.replenishing) return;
    const deficit = this.targetIdle - this.idleCount;
    if (deficit <= 0) return;
    this.replenishing = true;
    // Use setImmediate (or Promise.resolve) to not block the current call.
    Promise.resolve().then(async () => {
      try {
        const needed = this.targetIdle - this.idleCount;
        const provisions = Array.from({ length: Math.max(0, needed) }, () =>
          this._provisionOne().catch(() => {}),
        );
        await Promise.all(provisions);
      } finally {
        this.replenishing = false;
      }
    });
  }
}

/** The process-wide warm VM pool. Lazily created on first access. */
let sharedPool: WarmVmPool | null = null;

/** Get (or lazily create) the process-wide warm VM pool. */
export function getWarmVmPool(): WarmVmPool {
  if (!sharedPool) {
    sharedPool = new WarmVmPool(
      DEFAULT_CAPS.maxConcurrentVMs,
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    );
  }
  return sharedPool;
}

/**
 * Replace the pool (test seam). Pass a custom instance when you need a
 * non-default capacity or acquireTimeoutMs.
 */
export function setWarmVmPool(pool: WarmVmPool): void {
  sharedPool = pool;
}
