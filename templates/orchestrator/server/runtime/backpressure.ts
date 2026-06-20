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
 * A real counting semaphore bounding concurrent microVM provisions to
 * `maxConcurrentVMs` (DESIGN §4.1). `acquire()` either takes a free slot
 * immediately or WAITS (FIFO) for one to be released; if the optional
 * `acquireTimeoutMs` elapses first it rejects with a {@link
 * VMCapacityExhaustedError} so the caller surfaces backpressure as a distinct
 * type rather than blocking forever or mislabeling it. `release()` hands the
 * slot to the next waiter.
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
   * `acquireTimeoutMs` (default: wait indefinitely) for a release. On timeout it
   * rejects with {@link VMCapacityExhaustedError} — the DISTINCT backpressure
   * type, never folded into the token budget.
   */
  async acquire(acquireTimeoutMs?: number): Promise<void> {
    if (this.inUseCount < this.max) {
      this.inUseCount += 1;
      return;
    }
    // No free slot — either wait (no timeout) or fail fast with the distinct
    // capacity error when a finite timeout is given and we cannot proceed.
    if (acquireTimeoutMs != null && acquireTimeoutMs <= 0) {
      throw new VMCapacityExhaustedError(this.max, this.inUseCount);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      if (acquireTimeoutMs != null) {
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new VMCapacityExhaustedError(this.max, this.inUseCount));
        }, acquireTimeoutMs);
        if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      }
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
   */
  async withSlot<T>(fn: () => Promise<T>, acquireTimeoutMs?: number): Promise<T> {
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
