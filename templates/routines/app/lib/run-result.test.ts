import { describe, expect, it } from "vitest";
import { describeRunResult } from "./run-result";

describe("describeRunResult", () => {
  it("reports a not-found routine as an error with no thread", () => {
    const out = describeRunResult({ notFound: true, name: "ghost" });
    expect(out.tone).toBe("error");
    expect(out.title).toMatch(/not found/i);
    expect(out.threadId).toBeUndefined();
  });

  it("reports a successful schedule run with its thread for deep-linking", () => {
    const out = describeRunResult({
      kind: "schedule",
      name: "morning-briefing",
      threadId: "thread-123",
      status: "success",
    });
    expect(out.tone).toBe("success");
    expect(out.threadId).toBe("thread-123");
  });

  it("reports a failed schedule run with the error and thread", () => {
    const out = describeRunResult({
      kind: "schedule",
      name: "morning-briefing",
      threadId: "thread-9",
      status: "error",
      error: "boom",
    });
    expect(out.tone).toBe("error");
    expect(out.description).toBe("boom");
    expect(out.threadId).toBe("thread-9");
  });

  it("reports an unmatched event condition as info, surfacing the reason", () => {
    const out = describeRunResult({
      kind: "event",
      name: "on-new-plan",
      event: "plan.created",
      conditionMatched: false,
      dispatched: false,
      reason: "the plan is not a recap",
    });
    expect(out.tone).toBe("info");
    expect(out.description).toBe("the plan is not a recap");
    expect(out.threadId).toBeUndefined();
  });

  it("reports a matched-and-dispatched event as success", () => {
    const out = describeRunResult({
      kind: "event",
      name: "on-new-plan",
      event: "plan.created",
      conditionMatched: true,
      dispatched: true,
    });
    expect(out.tone).toBe("success");
    expect(out.title).toMatch(/matched/i);
  });
});
