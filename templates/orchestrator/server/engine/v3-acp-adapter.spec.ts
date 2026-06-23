// V3 ACP Adapter Unit Tests
//
// Tests isAcpRuntime, classifyAcpError, resolveAcpHarness, and P3 stubs.

import { describe, it, expect } from "vitest";
import {
  isAcpRuntime,
  classifyAcpError,
  resolveAcpHarness,
  startAcpSession,
  cancelAcpSession,
  getAcpSession,
} from "./v3-acp-adapter.js";

describe("isAcpRuntime", () => {
  it("returns true for acp: prefixed runtimes", () => {
    expect(isAcpRuntime("acp:claude-code")).toBe(true);
    expect(isAcpRuntime("acp:gemini")).toBe(true);
    expect(isAcpRuntime("acp:cursor")).toBe(true);
    expect(isAcpRuntime("acp:")).toBe(true);
  });

  it("returns false for non-acp runtimes", () => {
    expect(isAcpRuntime("node")).toBe(false);
    expect(isAcpRuntime("anthropic")).toBe(false);
    expect(isAcpRuntime("acp")).toBe(false);
    expect(isAcpRuntime("acp:")).toBe(true);
    expect(isAcpRuntime("")).toBe(false);
  });
});

describe("classifyAcpError", () => {
  describe("Permanent errors", () => {
    it("harness not registered -> permanent", () => {
      expect(classifyAcpError(new Error("harness not registered"))).toBe(
        "permanent",
      );
    });

    it("harness not found -> permanent", () => {
      expect(classifyAcpError(new Error("harness not found: foo"))).toBe(
        "permanent",
      );
    });

    it("no such harness -> permanent", () => {
      expect(classifyAcpError(new Error("no such harness: bar"))).toBe(
        "permanent",
      );
    });

    it("binary not found + not installable -> permanent", () => {
      expect(
        classifyAcpError(
          new Error("binary not found: claude-code (not installable)"),
        ),
      ).toBe("permanent");
    });

    it("command not found + not installable -> permanent", () => {
      expect(
        classifyAcpError(
          new Error("command not found: cursor (not installable)"),
        ),
      ).toBe("permanent");
    });

    it("ENOENT + not installable -> permanent", () => {
      expect(
        classifyAcpError(new Error("ENOENT: gemini (not installable)")),
      ).toBe("permanent");
    });
  });

  describe("Transient errors", () => {
    it("binary not found + installable -> transient", () => {
      expect(
        classifyAcpError(
          new Error("binary not found: claude-code (installable via npm)"),
        ),
      ).toBe("transient");
    });

    it("network error -> transient", () => {
      expect(classifyAcpError(new Error("network timeout"))).toBe("transient");
      expect(classifyAcpError(new Error("ETIMEDOUT"))).toBe("transient");
      expect(classifyAcpError(new Error("ECONNRESET"))).toBe("transient");
      expect(classifyAcpError(new Error("ECONNREFUSED"))).toBe("transient");
      expect(classifyAcpError(new Error("ENETUNREACH"))).toBe("transient");
      expect(classifyAcpError(new Error("EAI_AGAIN"))).toBe("transient");
      expect(classifyAcpError(new Error("EAI_FAIL"))).toBe("transient");
    });

    it("HTTP 5xx -> transient", () => {
      expect(classifyAcpError(new Error("502 Bad Gateway"))).toBe("transient");
      expect(classifyAcpError(new Error("503 Service Unavailable"))).toBe(
        "transient",
      );
      expect(classifyAcpError(new Error("504 Gateway Timeout"))).toBe(
        "transient",
      );
    });

    it("session timeout -> transient", () => {
      expect(classifyAcpError(new Error("session timeout"))).toBe("transient");
      expect(classifyAcpError(new Error("timed out waiting for response"))).toBe(
        "transient",
      );
      expect(classifyAcpError(new Error("context deadline exceeded"))).toBe(
        "transient",
      );
    });
  });

  describe("Default classification", () => {
    it("unknown error defaults to transient", () => {
      expect(classifyAcpError(new Error("something weird happened"))).toBe(
        "transient",
      );
      expect(classifyAcpError(new Error("unexpected response"))).toBe(
        "transient",
      );
    });
  });

  describe("Case insensitivity", () => {
    it("handles uppercase error messages", () => {
      expect(classifyAcpError(new Error("HARNESS NOT REGISTERED"))).toBe(
        "permanent",
      );
      expect(classifyAcpError(new Error("ETIMEDOUT"))).toBe("transient");
    });

    it("handles mixed case error messages", () => {
      expect(classifyAcpError(new Error("Harness Not Found"))).toBe(
        "permanent",
      );
      expect(classifyAcpError(new Error("Session Timeout"))).toBe("transient");
    });
  });

  describe("Error name included in classification", () => {
    it("uses error name + message for matching", () => {
      const err = new Error("not installable");
      err.name = "ENoent";
      expect(classifyAcpError(err)).toBe("permanent");
    });
  });
});

describe("resolveAcpHarness", () => {
  it("returns runtime string as harness ref", () => {
    expect(resolveAcpHarness("acp:claude-code")).toBe("acp:claude-code");
    expect(resolveAcpHarness("acp:gemini")).toBe("acp:gemini");
  });

  it("throws for non-acp runtime", () => {
    expect(() => resolveAcpHarness("node")).toThrow('expected "acp:" prefix');
    expect(() => resolveAcpHarness("anthropic")).toThrow(
      'expected "acp:" prefix',
    );
    expect(() => resolveAcpHarness("")).toThrow('expected "acp:" prefix');
  });
});

describe("P3 session lifecycle stubs", () => {
  it("startAcpSession throws implement in P3", async () => {
    await expect(startAcpSession("acp:claude-code")).rejects.toThrow(
      "implement in P3",
    );
  });

  it("cancelAcpSession throws implement in P3", async () => {
    await expect(cancelAcpSession("session-123")).rejects.toThrow(
      "implement in P3",
    );
  });

  it("getAcpSession throws implement in P3", async () => {
    await expect(getAcpSession("session-123")).rejects.toThrow(
      "implement in P3",
    );
  });
});
