// P4-D (Codex review 2026-07-23): v3-error-recovery.ts had zero test
// coverage for any of its four exports. checkPostgresHealth is now wired
// into actions/health-telemetry.ts (the S10 health page); these tests cover
// its own decision logic plus the pure classifyShimExitCode/reconnectWithRetry
// helpers, which remain intentionally unwired (see v3-error-recovery.ts's
// header) but are real, reusable logic worth locking with real assertions.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let mockDialect: "postgres" | "sqlite" = "postgres";
let mockExecuteImpl: (sql: string) => Promise<{ rows: unknown[] }> = () =>
  Promise.resolve({ rows: [{ alive: 1 }] });

vi.mock("@agent-native/core/db", () => ({
  getDialect: () => mockDialect,
  isPostgres: () => mockDialect === "postgres",
  getDbExec: () => ({
    execute: (sql: string) => mockExecuteImpl(sql),
  }),
}));

import {
  checkPostgresHealth,
  classifyShimExitCode,
  reconnectWithRetry,
} from "./v3-error-recovery.js";

describe("checkPostgresHealth", () => {
  beforeEach(() => {
    mockDialect = "postgres";
    mockExecuteImpl = () => Promise.resolve({ rows: [{ alive: 1 }] });
  });

  it("short-circuits to healthy on a non-Postgres dialect without querying", async () => {
    mockDialect = "sqlite";
    mockExecuteImpl = () => {
      throw new Error("must not query on non-Postgres dialects");
    };
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(true);
    expect(result.action).toBe("none");
  });

  it("reports healthy when SELECT 1 succeeds", async () => {
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("healthy");
  });

  it("reports unhealthy when the probe returns an unexpected result", async () => {
    mockExecuteImpl = () => Promise.resolve({ rows: [{ alive: 0 }] });
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(false);
    expect(result.action).toBe("restart_server");
  });

  it("classifies ECONNREFUSED as a connection-level failure", async () => {
    mockExecuteImpl = () => {
      const err = new Error("connection refused") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    };
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(false);
    expect(result.action).toBe("restart_postgres");
  });

  it("classifies ETIMEDOUT as a timeout failure", async () => {
    mockExecuteImpl = () => {
      const err = new Error("timed out") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      throw err;
    };
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(false);
    expect(result.action).toBe("check_network_and_restart");
  });

  it("classifies an unrecognized error as investigate_and_restart", async () => {
    mockExecuteImpl = () => {
      throw new Error("something else entirely");
    };
    const result = await checkPostgresHealth();
    expect(result.healthy).toBe(false);
    expect(result.action).toBe("investigate_and_restart");
  });
});

describe("classifyShimExitCode", () => {
  it("classifies exit 0 as success", () => {
    expect(classifyShimExitCode(0).classification).toBe("success");
  });

  it("classifies OOM/segfault/abort codes as permanent", () => {
    expect(classifyShimExitCode(137).classification).toBe("permanent");
    expect(classifyShimExitCode(137).signal).toBe("SIGKILL");
    expect(classifyShimExitCode(139).classification).toBe("permanent");
    expect(classifyShimExitCode(139).signal).toBe("SIGSEGV");
    expect(classifyShimExitCode(134).classification).toBe("permanent");
    expect(classifyShimExitCode(134).signal).toBe("SIGABRT");
  });

  it("classifies any other non-zero code as transient", () => {
    expect(classifyShimExitCode(1).classification).toBe("transient");
    expect(classifyShimExitCode(255).classification).toBe("transient");
  });
});

describe("reconnectWithRetry", () => {
  beforeEach(() => {
    mockDialect = "postgres";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the operation's result on the first try when it succeeds", async () => {
    const op = vi.fn(async () => "ok");
    const result = await reconnectWithRetry(op, 3);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("runs the operation once with no retry on a non-Postgres dialect", async () => {
    mockDialect = "sqlite";
    const err = new Error("refused") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    const op = vi.fn(async () => {
      throw err;
    });
    await expect(reconnectWithRetry(op, 3)).rejects.toThrow("refused");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on a connection-class error and eventually succeeds", async () => {
    const err = new Error("reset") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw err;
      return "recovered";
    });
    const resultPromise = reconnectWithRetry(op, 5);
    await vi.runAllTimersAsync();
    expect(await resultPromise).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting maxRetries on a persistent connection error", async () => {
    const err = new Error("still down") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    const op = vi.fn(async () => {
      throw err;
    });
    const resultPromise = reconnectWithRetry(op, 2);
    // Attach a rejection handler immediately so the eventual rejection is
    // never "unhandled" while fake timers advance past the retry delays.
    const assertion = expect(resultPromise).rejects.toThrow("still down");
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry a non-connection-class error", async () => {
    const err = new Error("bad query");
    const op = vi.fn(async () => {
      throw err;
    });
    await expect(reconnectWithRetry(op, 3)).rejects.toThrow("bad query");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
