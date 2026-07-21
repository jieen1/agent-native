import { afterEach, describe, expect, it } from "vitest";

import {
  assertWritebackCaller,
  isWritebackCaller,
  writebackActorEmail,
  WritebackGuardError,
} from "../writeback-actor.js";

// ============================================================================
// F9 — server/lib/writeback-actor.ts
//
// T-F9-05 的纯函数底座: 判定"这是不是回写通道本身在调用" —— 双因子
// (caller==='mcp' AND userEmail===哨兵值), 缺一不可。
// ============================================================================

const ORIGINAL_ENV = process.env.WRITEBACK_ACTOR_EMAIL;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.WRITEBACK_ACTOR_EMAIL;
  else process.env.WRITEBACK_ACTOR_EMAIL = ORIGINAL_ENV;
});

describe("writebackActorEmail", () => {
  it("defaults to the built-in sentinel when WRITEBACK_ACTOR_EMAIL is unset", () => {
    delete process.env.WRITEBACK_ACTOR_EMAIL;
    expect(writebackActorEmail()).toBe("writeback@orchestrator.internal");
  });

  it("honors an env override", () => {
    process.env.WRITEBACK_ACTOR_EMAIL = "svc-writeback@example.org";
    expect(writebackActorEmail()).toBe("svc-writeback@example.org");
  });
});

describe("isWritebackCaller", () => {
  it("true only when BOTH caller==='mcp' AND userEmail matches the sentinel", () => {
    expect(
      isWritebackCaller({ caller: "mcp", userEmail: writebackActorEmail() }),
    ).toBe(true);
  });

  it("false when caller is 'tool' (normal in-app agent loop) even with the right email", () => {
    expect(
      isWritebackCaller({ caller: "tool", userEmail: writebackActorEmail() }),
    ).toBe(false);
  });

  it("false when caller is 'frontend'/'http'/'cli' even with the right email (a human/script surface, not cross-app MCP)", () => {
    for (const caller of ["frontend", "http", "cli"]) {
      expect(
        isWritebackCaller({ caller, userEmail: writebackActorEmail() }),
      ).toBe(false);
    }
  });

  it("false when caller==='mcp' but the email is a normal human/agent identity (T-F9-05: no free ride via the mcp surface alone)", () => {
    expect(
      isWritebackCaller({ caller: "mcp", userEmail: "someone@example.com" }),
    ).toBe(false);
  });

  it("false when there is no ctx / no userEmail at all", () => {
    expect(isWritebackCaller(undefined)).toBe(false);
    expect(isWritebackCaller(null)).toBe(false);
    expect(isWritebackCaller({ caller: "mcp", userEmail: undefined })).toBe(
      false,
    );
    expect(isWritebackCaller({ caller: "mcp", userEmail: null })).toBe(false);
  });
});

describe("assertWritebackCaller", () => {
  it("does not throw for a genuine writeback caller", () => {
    expect(() =>
      assertWritebackCaller({
        caller: "mcp",
        userEmail: writebackActorEmail(),
      }),
    ).not.toThrow();
  });

  it("throws a structured WritebackGuardError (code='actor-denied') for anyone else", () => {
    try {
      assertWritebackCaller({
        caller: "tool",
        userEmail: "agent-acting-as@example.com",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WritebackGuardError);
      expect((err as WritebackGuardError).code).toBe("actor-denied");
    }
  });
});
