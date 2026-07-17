import { describe, expect, it } from "vitest";

import { classifyDocKey } from "../sprint-artifacts.js";

describe("classifyDocKey — S6 产物库三段式分组 (03-tracker.md §5.2 ③ / §11)", () => {
  it("classifies planning docs", () => {
    expect(classifyDocKey("sprint-doc")).toBe("规划");
    expect(classifyDocKey("test-plan")).toBe("规划");
    expect(classifyDocKey("brainstorm-notes")).toBe("规划");
  });

  it("classifies design docs, including the brief: prefix family", () => {
    expect(classifyDocKey("ui-spec")).toBe("设计");
    expect(classifyDocKey("ui-prototype")).toBe("设计");
    expect(classifyDocKey("tech-design")).toBe("设计");
    expect(classifyDocKey("shared-brief")).toBe("设计");
    expect(classifyDocKey("briefs-index")).toBe("设计");
    expect(classifyDocKey("brief:PAY-201")).toBe("设计");
  });

  it("classifies verification docs, including the audit-report: prefix family", () => {
    expect(classifyDocKey("verify-report")).toBe("验证");
    expect(classifyDocKey("story")).toBe("验证");
    expect(classifyDocKey("spike-report")).toBe("验证");
    expect(classifyDocKey("audit-report:2")).toBe("验证");
  });

  it("falls back to 其他 for an unrecognized docKey instead of dropping it", () => {
    expect(classifyDocKey("some-future-doc-type")).toBe("其他");
  });
});
