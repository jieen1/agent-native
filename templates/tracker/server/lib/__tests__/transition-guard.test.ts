import { describe, expect, it } from "vitest";

import {
  ALL_GUARD_STATES,
  actorFromCaller,
  allowedTransitions,
  assertTransition,
  currentGuardState,
  guardStateToStageName,
  isValidCommitRef,
  TransitionGuardError,
  type Actor,
  type ActorKind,
  type GuardState,
  type GuardWorkItem,
  type TransitionEvidence,
} from "../transition-guard.js";

// ============================================================================
// T-F3-01: transition-guard 全矩阵 (test.each 枚举 actor × 源态(7) × 目标态(7) ×
// 证据{全/缺commit/缺verdict/空}, 对照 docs/sdlc-impl-f1-f4.md §6.3 的守卫矩阵
// 逐格断言)
//
// The "expected" oracle below is written FRESH from the §6.3 matrix text (not
// copy-pasted from server/lib/transition-guard.ts) so this is a real
// regression lock, not a tautology that always agrees with the implementation
// it's testing.
//
// 守卫矩阵 (docs/sdlc-impl-f1-f4.md §6.3, 修订版 —— done 行源态约束以 02 §8
// 设计权威为准: done 的唯一合法源态是「待人工评审」):
//   done                    | 仅 human, 仅源态==待人工评审 | verdict==PASSED 且 commit(7-40 hex) | agent→actor-denied; 其他源态→invalid-source-state; 缺证据→evidence-missing
//   closed                  | 仅 human | reason(schema)且未派发(execState∈{null,queued}) | 已派发→拒; agent→拒
//   交付(人工完成逃生口)      | 仅 human | commit 或 links 至少一项            | 全缺→evidence-missing
//   正向回写类(实施→测试等)   | 不走本 action(F9)                          | 任何写入方→拒, 指向 F9
//   回退类(高→低,人工纠错)   | 仅 human | reason(schema)                     | 无 reason→schema 拒(不在 guard 范围)
//   target==当前态           | 任意                                       | {noop:true}
//
// 判定优先级(与实现一致, 矩阵按此排序断言): actor 检查先于源态检查 —— agent
// 从任何源态发 done 得 actor-denied, human 从非待人工评审源态发 done 得
// invalid-source-state。
// ============================================================================

const LADDER: GuardState[] = ["待办", "实施", "测试", "待人工评审", "交付"];

type EvidenceVariant = "full" | "missing-commit" | "missing-verdict" | "empty";

function makeEvidence(variant: EvidenceVariant): TransitionEvidence {
  switch (variant) {
    case "full":
      return {
        verdict: "PASSED",
        commit: "abcdef1",
        links: ["https://example.com/pr/1"],
        deliveryItems: ["d1"],
      };
    // missing-commit: `commit` absent but `links` populated — exercises
    // done's "commit is required, no substitute" (denied) AND 交付's
    // "commit OR links, links alone suffices" (ok) in the SAME fixture.
    case "missing-commit":
      return { verdict: "PASSED", links: ["https://example.com/pr/1"], deliveryItems: [] };
    // missing-verdict: `verdict` absent but `commit` present — exercises
    // done's "verdict is required, no substitute" (denied) AND 交付's
    // "commit alone suffices, links optional" (ok).
    case "missing-verdict":
      return { commit: "abcdef1", links: [] };
    case "empty":
      return {};
  }
}

/** execState coupling used ONLY by this matrix fixture: 待办 = never
 *  dispatched (execState=null); every other source state implies the item
 *  has been dispatched at some point (execState='dispatched'). T-F3-09 tests
 *  the execState axis explicitly and independently of source state. */
function execStateFor(source: GuardState): string | null {
  return source === "待办" ? null : "dispatched";
}

function makeItem(source: GuardState): GuardWorkItem {
  if (source === "done") return { currentStageName: "交付", status: "done", execState: "dispatched" };
  if (source === "closed") return { currentStageName: "待办", status: "closed", execState: execStateFor(source) };
  // Map guard state back to a currentStageName the way the real DB would store it.
  const stageName = source === "待人工评审" ? "验收" : source;
  return { currentStageName: stageName, status: "open", execState: execStateFor(source) };
}

type Expectation =
  | { kind: "noop" }
  | { kind: "ok" }
  | { kind: "denied"; code: string; need?: string[] };

/** Independent oracle — actor+source eligibility ONLY (evidence-agnostic).
 *  Mirrors the §6.3 matrix's "合法写入方" column, not transition-guard.ts. */
function oracleEligible(
  actorKind: ActorKind,
  source: GuardState,
  target: GuardState,
): { eligible: boolean; code?: string } {
  if (target === source) return { eligible: true }; // noop — handled separately, "任意" actor ok
  if (target === "done") {
    // 02 §8: done 仅人 + 仅自「待人工评审」。actor check first (see header).
    if (actorKind !== "human") return { eligible: false, code: "actor-denied" };
    if (source !== "待人工评审") return { eligible: false, code: "invalid-source-state" };
    return { eligible: true };
  }
  if (target === "closed") {
    if (actorKind !== "human") return { eligible: false, code: "actor-denied" };
    const notDispatched = execStateFor(source) === null;
    return notDispatched ? { eligible: true } : { eligible: false, code: "already-dispatched" };
  }
  if (target === "交付") {
    if (actorKind !== "human") return { eligible: false, code: "actor-denied" };
    if (source === "done" || source === "closed") return { eligible: false, code: "terminal-state" };
    return { eligible: true };
  }
  // Ladder targets: 待办 / 实施 / 测试 / 待人工评审.
  if (source === "done" || source === "closed") return { eligible: false, code: "terminal-state" };
  const sourceRank = LADDER.indexOf(source);
  const targetRank = LADDER.indexOf(target);
  if (targetRank > sourceRank) return { eligible: false, code: "forward-not-allowed" };
  // backward — manual override, human only
  return actorKind === "human" ? { eligible: true } : { eligible: false, code: "actor-denied" };
}

/** Full oracle including the evidence dimension — only meaningful when
 *  actor+source eligibility already holds. */
function oracleOutcome(
  actorKind: ActorKind,
  source: GuardState,
  target: GuardState,
  variant: EvidenceVariant,
): Expectation {
  if (target === source) return { kind: "noop" };
  const el = oracleEligible(actorKind, source, target);
  if (!el.eligible) return { kind: "denied", code: el.code! };

  if (target === "done") {
    return needForDone(variant);
  }
  if (target === "交付") {
    return needForDelivery(variant);
  }
  // closed and ladder-backward targets need nothing beyond `reason`, which is
  // outside the guard's evidence dimension (schema-enforced) — always ok once
  // eligible, regardless of evidence variant.
  return { kind: "ok" };
}

function needForDone(variant: EvidenceVariant): Expectation {
  switch (variant) {
    case "full":
      return { kind: "ok" };
    case "missing-commit":
      return { kind: "denied", code: "evidence-missing", need: ["commit"] };
    case "missing-verdict":
      return { kind: "denied", code: "evidence-missing", need: ["verdict"] };
    case "empty":
      return { kind: "denied", code: "evidence-missing", need: ["verdict", "commit"] };
  }
}

function needForDelivery(variant: EvidenceVariant): Expectation {
  switch (variant) {
    case "full":
      return { kind: "ok" }; // commit + links both present
    case "missing-commit":
      return { kind: "ok" }; // links present, satisfies "commit 或 links"
    case "missing-verdict":
      return { kind: "ok" }; // commit present (verdict irrelevant to 交付)
    case "empty":
      return { kind: "denied", code: "evidence-missing", need: ["commit", "links"] };
  }
}

const ACTORS: ActorKind[] = ["human", "agent"];
const VARIANTS: EvidenceVariant[] = ["full", "missing-commit", "missing-verdict", "empty"];

// Build the full 2 × 7 × 7 × 4 = 392-cell matrix.
const MATRIX_CASES: Array<{
  actorKind: ActorKind;
  source: GuardState;
  target: GuardState;
  variant: EvidenceVariant;
}> = [];
for (const actorKind of ACTORS) {
  for (const source of ALL_GUARD_STATES) {
    for (const target of ALL_GUARD_STATES) {
      for (const variant of VARIANTS) {
        MATRIX_CASES.push({ actorKind, source, target, variant });
      }
    }
  }
}

describe("T-F3-01: transition-guard 全矩阵 (392 cells)", () => {
  it(`enumerates exactly ${ACTORS.length * ALL_GUARD_STATES.length * ALL_GUARD_STATES.length * VARIANTS.length} cases`, () => {
    expect(MATRIX_CASES).toHaveLength(392);
  });

  it.each(MATRIX_CASES)(
    "actor=$actorKind source=$source target=$target evidence=$variant",
    ({ actorKind, source, target, variant }) => {
      const item = makeItem(source);
      const actor: Actor = { kind: actorKind, email: actorKind === "human" ? "u@x.com" : null };
      const evidence = makeEvidence(variant);
      const expected = oracleOutcome(actorKind, source, target, variant);

      // --- assertTransition ---
      if (expected.kind === "noop") {
        expect(assertTransition(item, target, actor, evidence)).toEqual({ noop: true });
      } else if (expected.kind === "ok") {
        expect(assertTransition(item, target, actor, evidence)).toEqual({ noop: false });
      } else {
        let caught: unknown;
        try {
          assertTransition(item, target, actor, evidence);
          caught = undefined;
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(TransitionGuardError);
        expect((caught as TransitionGuardError).code).toBe(expected.code);
        if (expected.need) {
          expect(new Set((caught as TransitionGuardError).need)).toEqual(new Set(expected.need));
        }
      }

      // --- allowedTransitions (evidence-agnostic cross-check) ---
      // Only assert once per (actor, source, target) — evidence doesn't
      // change eligibility, so this is invariant across the 4 variants; we
      // still run it every time to catch any accidental evidence-leak bug.
      const el = oracleEligible(actorKind, source, target);
      const listed = allowedTransitions(item, actor).some((d) => d.target === target);
      if (target === source) {
        expect(listed).toBe(false); // noop excluded from the Select's menu
      } else {
        expect(listed).toBe(el.eligible);
      }
    },
  );
});

// ============================================================================
// T-F3-02: evidence-missing 结构化错误 (precise shape)
// ============================================================================

describe("T-F3-02: evidence-missing 结构化错误", () => {
  it("assertTransition(item,'done',human,{verdict:'PASSED'}) throws exactly {code:'evidence-missing', need:['commit']}", () => {
    const item: GuardWorkItem = { currentStageName: "验收", status: "open", execState: "dispatched" };
    const human: Actor = { kind: "human", email: "u@x.com" };
    let caught: unknown;
    try {
      assertTransition(item, "done", human, { verdict: "PASSED" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionGuardError);
    const err = caught as TransitionGuardError;
    expect(err.code).toBe("evidence-missing");
    expect(err.need).toEqual(["commit"]);
  });

  it("missing both verdict and commit → need=['verdict','commit']", () => {
    const item: GuardWorkItem = { currentStageName: "验收", status: "open", execState: "dispatched" };
    const human: Actor = { kind: "human", email: "u@x.com" };
    try {
      assertTransition(item, "done", human, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as TransitionGuardError).need).toEqual(["verdict", "commit"]);
    }
  });

  it("交付 missing both commit and links → need=['commit','links']", () => {
    const item: GuardWorkItem = { currentStageName: "实施", status: "open", execState: "dispatched" };
    const human: Actor = { kind: "human", email: "u@x.com" };
    try {
      assertTransition(item, "交付", human, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as TransitionGuardError).code).toBe("evidence-missing");
      expect((e as TransitionGuardError).need).toEqual(["commit", "links"]);
    }
  });
});

// ============================================================================
// done 源态约束 (02 §8 设计权威): done 仅可自「待人工评审」进入 —— 即使
// human + 全证据, 其他源态一律 invalid-source-state。矩阵 (T-F3-01) 已全
// 枚举; 这里是边界的显式命名锁 + allowedTransitions 同步验证。
// ============================================================================

describe("done 源态约束: 仅待人工评审可达 done", () => {
  const human: Actor = { kind: "human", email: "u@x.com" };
  const FULL = { verdict: "PASSED" as const, commit: "abcdef1" };

  it("human + 全证据 自「待人工评审」→ done 通过", () => {
    const item: GuardWorkItem = { currentStageName: "验收", status: "open", execState: "dispatched" };
    expect(assertTransition(item, "done", human, FULL)).toEqual({ noop: false });
  });

  it.each(["待办", "分析", "设计", "实施", "测试", "交付"])(
    "human + 全证据 自「%s」→ done 被拒 invalid-source-state",
    (stageName) => {
      const item: GuardWorkItem = { currentStageName: stageName, status: "open", execState: "dispatched" };
      let caught: unknown;
      try {
        assertTransition(item, "done", human, FULL);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TransitionGuardError);
      expect((caught as TransitionGuardError).code).toBe("invalid-source-state");
    },
  );

  it("allowedTransitions 只在源态==待人工评审 时把 done 列为选项", () => {
    for (const stageName of ["待办", "分析", "设计", "实施", "测试", "验收", "交付"]) {
      const item: GuardWorkItem = { currentStageName: stageName, status: "open", execState: "dispatched" };
      const listed = allowedTransitions(item, human).some((d) => d.target === "done");
      expect(listed).toBe(stageName === "验收");
    }
  });

  it("agent 自待人工评审发 done 仍是 actor-denied(actor 检查先于源态)", () => {
    const item: GuardWorkItem = { currentStageName: "验收", status: "open", execState: "dispatched" };
    let caught: unknown;
    try {
      assertTransition(item, "done", { kind: "agent", email: null }, FULL);
    } catch (e) {
      caught = e;
    }
    expect((caught as TransitionGuardError).code).toBe("actor-denied");
  });
});

// ============================================================================
// T-F3-16 (guard-side helper): isValidCommitRef / guardStateToStageName /
// currentGuardState / actorFromCaller — the small pure helpers the action
// layer depends on.
// ============================================================================

describe("isValidCommitRef", () => {
  it.each([
    ["abcdef1", true], // 7 hex chars
    ["a".repeat(40), true], // 40 hex chars
    ["a".repeat(41), false], // too long
    ["abcde", false], // too short (5 chars)
    ["ABCDEF1", true], // case-insensitive
    ["not-hex!", false],
    [undefined, false],
    ["", false],
  ])("isValidCommitRef(%p) === %p", (input, expected) => {
    expect(isValidCommitRef(input as string | undefined)).toBe(expected);
  });
});

describe("currentGuardState / guardStateToStageName round-trip", () => {
  it.each([
    [{ currentStageName: "待办", status: "open" }, "待办"],
    [{ currentStageName: "分析", status: "open" }, "待办"],
    [{ currentStageName: "设计", status: "open" }, "待办"],
    [{ currentStageName: "实施", status: "open" }, "实施"],
    [{ currentStageName: "测试", status: "open" }, "测试"],
    [{ currentStageName: "验收", status: "open" }, "待人工评审"],
    [{ currentStageName: "交付", status: "open" }, "交付"],
    [{ currentStageName: "交付", status: "done" }, "done"],
    [{ currentStageName: "待办", status: "closed" }, "closed"],
  ] as Array<[GuardWorkItem, GuardState]>)(
    "currentGuardState(%o) === %p",
    (item, expected) => {
      expect(currentGuardState(item)).toBe(expected);
    },
  );

  it("guardStateToStageName('待人工评审') === '验收' (the one non-identity mapping)", () => {
    expect(guardStateToStageName("待人工评审")).toBe("验收");
  });

  it.each(["待办", "实施", "测试", "交付"] as GuardState[])(
    "guardStateToStageName(%p) is identity",
    (s) => {
      expect(guardStateToStageName(s)).toBe(s);
    },
  );
});

describe("actorFromCaller", () => {
  it("caller='tool' → agent, regardless of email", () => {
    expect(actorFromCaller("tool", "u@x.com")).toEqual({ kind: "agent", email: "u@x.com" });
    expect(actorFromCaller("tool", undefined)).toEqual({ kind: "agent", email: null });
  });

  it("caller='frontend'/'http'/'cli'/'mcp' with a resolved email → human", () => {
    for (const caller of ["frontend", "http", "cli", "mcp"]) {
      expect(actorFromCaller(caller, "u@x.com")).toEqual({ kind: "human", email: "u@x.com" });
    }
  });

  it("no resolved email at all → system", () => {
    expect(actorFromCaller("http", undefined)).toEqual({ kind: "system", email: null });
    expect(actorFromCaller(undefined, null)).toEqual({ kind: "system", email: null });
  });

  // F9 (T-F9-04): the reconciler's writeback channel calls the tracker over
  // the cross-app MCP surface (caller==='mcp'), which — WITHOUT this special
  // case — falls into the "caller!=='tool' + resolved email → human" branch
  // above. That would let the writeback identity sail through every
  // human-only guard branch (done/closed/交付/回退) if it (or a JWT crafted to
  // impersonate it) ever called transition-work-item. Recognizing the
  // reserved sentinel here forces it to `agent` — zero standing beyond any
  // other agent caller on THIS guard, on top of (never instead of) the
  // writeback-only actions' own `assertWritebackCaller` check.
  it("F9: the reserved writeback sentinel email → agent, even over the 'mcp' caller surface", async () => {
    const { writebackActorEmail } = await import("../writeback-actor.js");
    expect(actorFromCaller("mcp", writebackActorEmail())).toEqual({
      kind: "agent",
      email: writebackActorEmail(),
    });
  });

  it("F9: a normal human email over 'mcp' is UNAFFECTED — still classified human", async () => {
    const { writebackActorEmail } = await import("../writeback-actor.js");
    expect(writebackActorEmail()).not.toBe("u@x.com");
    expect(actorFromCaller("mcp", "u@x.com")).toEqual({ kind: "human", email: "u@x.com" });
  });
});
