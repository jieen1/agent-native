/**
 * Dispatch-grade template lint (docs/sdlc-product-design/
 * r4-workflow-families-planning-skills.md §4.2 — task board #78/R4a.2).
 *
 * Same layer as `validateDag()` — a pure function, no LLM calls, no DB reads.
 * `validateDag` answers "is this a structurally legal DAG"; this answers "is
 * this DAG good enough to auto-dispatch without a human reading every
 * prompt" — the seven checks P-C names "dispatch-grade vs card-grade" (04
 * doc §4.2). Callers should run `validateDag` first; this function does not
 * repeat validateDag's structural/type checks and assumes a shape-valid dag.
 *
 * §4.2's second review round drew a hard line the return shape must expose:
 * rules ①②③⑥⑦ are exact structural field checks (same confidence class as
 * validateDag's own guard/output_schema checks); rules ④⑤ are Chinese
 * keyword/regex heuristics over natural-language prompt text with known
 * false positives/negatives (documented per-rule below and in this file's
 * spec) — never render them with the same "solid checkmark" confidence as
 * the structural five. That distinction is the `confidence` field.
 */

import {
  isClaudeCodeEngineRef,
  nodeTargetsClaudeCode,
} from "./dag-validator.js";

// ── Return shape ─────────────────────────────────────────────────────────────

export type LintConfidence = "structural" | "heuristic";

export interface LintRuleResult {
  /** 1-7, matching §4.2's enumeration. */
  rule: number;
  key: string;
  /** Short Chinese label for UI badges/panels, e.g. "①输入接线". */
  label: string;
  confidence: LintConfidence;
  ok: boolean;
  /** One-line human-readable evidence — what passed/failed and why. */
  detail: string;
  /** Node ids the UI can use for "click to locate" (offending or relevant). */
  nodeIds?: string[];
}

export interface DispatchGradeLintResult {
  /** True only when all 7 rules pass. */
  ok: boolean;
  level: "dispatch-grade" | "card-grade";
  passCount: number;
  totalCount: number;
  results: LintRuleResult[];
}

// ── Loosely-typed node shape (mirrors dag-validator's V3Node union, but kept
// permissive here since this function must never throw on malformed input —
// it's read by the live editor panel on every keystroke, debounced). ────────

interface RawNode {
  id?: unknown;
  type?: unknown;
  prompt?: unknown;
  workspace?: unknown;
  guard?: unknown;
  until?: unknown;
  items_from?: unknown;
  output_schema?: unknown;
  agent?: unknown;
  engine_override?: unknown;
  timeout_seconds?: unknown;
  retry?: unknown;
  deps?: unknown;
  body?: unknown;
  max_iterations?: unknown;
  maxIterations?: unknown;
}

interface EffectiveAgentNode {
  /** Own id for a real "agent" node, or the parent parallel_over's id for an inline body. */
  id: string;
  prompt: string;
  workspace?: string;
  output_schema?: unknown;
  agent?: string;
  engine_override?: string;
  timeout_seconds?: number;
  retry?: unknown;
}

function parseDagNodes(dag: unknown): RawNode[] | null {
  let parsed: unknown = dag;
  if (typeof dag === "string") {
    try {
      parsed = JSON.parse(dag);
    } catch {
      return null;
    }
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as any).nodes)
  ) {
    return null;
  }
  return (parsed as any).nodes as RawNode[];
}

/** Flattens real "agent" nodes AND parallel_over inline agent bodies into one
 *  list — both are places a prompt/workspace actually executes against a
 *  workspace, and §4.2 rules 1/4/5 need to scan both uniformly. */
function collectEffectiveAgentNodes(nodes: RawNode[]): EffectiveAgentNode[] {
  const out: EffectiveAgentNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string") continue;
    if (n.type === "agent") {
      out.push({
        id: n.id,
        prompt: typeof n.prompt === "string" ? n.prompt : "",
        workspace: typeof n.workspace === "string" ? n.workspace : undefined,
        output_schema: n.output_schema,
        agent: typeof n.agent === "string" ? n.agent : undefined,
        engine_override:
          typeof n.engine_override === "string" ? n.engine_override : undefined,
        timeout_seconds:
          typeof n.timeout_seconds === "number" ? n.timeout_seconds : undefined,
        retry: n.retry,
      });
    } else if (
      n.type === "parallel_over" &&
      n.body &&
      typeof n.body === "object"
    ) {
      const b = n.body as RawNode;
      out.push({
        id: n.id,
        prompt: typeof b.prompt === "string" ? b.prompt : "",
        workspace: typeof b.workspace === "string" ? b.workspace : undefined,
        output_schema: b.output_schema,
        agent: typeof b.agent === "string" ? b.agent : undefined,
        engine_override:
          typeof b.engine_override === "string" ? b.engine_override : undefined,
        timeout_seconds:
          typeof b.timeout_seconds === "number" ? b.timeout_seconds : undefined,
        retry: b.retry,
      });
    }
  }
  return out;
}

function hasEnumProperty(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const props = (schema as any).properties;
  if (!props || typeof props !== "object") return false;
  return Object.values(props).some((p: any) => p && Array.isArray(p.enum));
}

// ── Reference extraction ─────────────────────────────────────────────────────

/** `{{inputs.foo.bar}}` / `{{deps.node1.output.verdict}}` — the ONLY channel
 *  prompt/workspace text actually gets values injected through (no
 *  auto-injection, per v3-dispatcher.ts's contract this seed corpus already
 *  documents). */
function extractMustacheRefs(text: string): {
  inputs: string[];
  deps: string[];
} {
  const inputs: string[] = [];
  const deps: string[] = [];
  const re = /\{\{\s*(inputs|deps)\.([A-Za-z0-9_.[\]]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const first = m[2].split(/[.[]/)[0];
    if (first) (m[1] === "inputs" ? inputs : deps).push(first);
  }
  return { inputs, deps };
}

/** `inputs.foo`/`deps.bar` appearing in a raw (non-mustache) guard/until/
 *  items_from expression string. */
function extractRawRefs(text: string): { inputs: string[]; deps: string[] } {
  const inputs: string[] = [];
  const deps: string[] = [];
  const re = /\b(inputs|deps)\.([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    (m[1] === "inputs" ? inputs : deps).push(m[2]);
  }
  return { inputs, deps };
}

// ── Rule 1 — input wiring (structural) ───────────────────────────────────────

function ruleInputWiring(
  nodes: RawNode[],
  effectiveAgents: EffectiveAgentNode[],
  inputSchema: any,
): LintRuleResult {
  const schemaProps =
    inputSchema &&
    typeof inputSchema === "object" &&
    inputSchema.properties &&
    typeof inputSchema.properties === "object"
      ? inputSchema.properties
      : {};
  const requiredFields: string[] = Array.isArray(inputSchema?.required)
    ? inputSchema.required
    : [];

  const referencedInputs = new Set<string>();
  for (const a of effectiveAgents) {
    extractMustacheRefs(a.prompt).inputs.forEach((f) =>
      referencedInputs.add(f),
    );
    if (a.workspace)
      extractMustacheRefs(a.workspace).inputs.forEach((f) =>
        referencedInputs.add(f),
      );
  }
  for (const n of nodes) {
    if (typeof n?.items_from === "string") {
      extractRawRefs(n.items_from).inputs.forEach((f) =>
        referencedInputs.add(f),
      );
    }
  }

  const missingRequired = requiredFields.filter(
    (f) => !referencedInputs.has(f),
  );
  const undeclared = [...referencedInputs].filter((f) => !(f in schemaProps));
  const ok = missingRequired.length === 0 && undeclared.length === 0;

  const parts: string[] = [];
  if (missingRequired.length)
    parts.push(`required 字段未被引用: ${missingRequired.join(" / ")}`);
  if (undeclared.length)
    parts.push(`prompt 引用了未声明的 inputs 字段: ${undeclared.join(" / ")}`);
  if (ok) {
    parts.push(
      requiredFields.length
        ? `${requiredFields.join(" / ")} 均被引用;无未声明引用`
        : "无 required 字段;无未声明引用",
    );
  }
  return {
    rule: 1,
    key: "input-wiring",
    label: "①输入接线",
    confidence: "structural",
    ok,
    detail: parts.join(" · "),
  };
}

// ── Rule 2 — judgment node structure (structural) ────────────────────────────

function ruleJudgmentStructure(
  nodes: RawNode[],
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const byId = new Map(effectiveAgents.map((a) => [a.id, a]));
  const humanGateIds = new Set(
    nodes
      .filter((n) => n && n.type === "human_gate" && typeof n.id === "string")
      .map((n) => n.id as string),
  );

  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const expr of [n?.guard, n?.until]) {
      if (typeof expr === "string")
        extractRawRefs(expr).deps.forEach((id) => referenced.add(id));
    }
  }

  const okIds: string[] = [];
  const failing: string[] = [];
  for (const id of referenced) {
    if (humanGateIds.has(id)) continue; // human_gate's {choice} shape is guaranteed by the engine, not output_schema
    const node = byId.get(id);
    if (!node) continue; // dangling ref — validateDag's own dep/guard-syntax checks own this
    if (!hasEnumProperty(node.output_schema)) {
      failing.push(id);
    } else {
      okIds.push(id);
    }
  }

  const ok = failing.length === 0;
  const detail = ok
    ? okIds.length
      ? `${okIds.join(" / ")} 全带 enum verdict`
      : "无节点被 guard/until 引用"
    : `缺结构化判断输出: ${failing.join(" / ")}(guard/until 引用但无 output_schema.enum 字段)`;
  return {
    rule: 2,
    key: "judgment-structure",
    label: "②判断节点结构化",
    confidence: "structural",
    ok,
    detail,
    nodeIds: failing,
  };
}

// ── Rule 3 — bounded loops (structural) ──────────────────────────────────────
//
// Three sub-checks kept deliberately narrow to avoid false positives proven
// out against the real (already-hardened) seed corpus while writing this
// file — see this file's spec for the traced examples:
//
//  (a) `loop` nodes must declare max_iterations/maxIterations ≤ 3.
//  (b) guard-unrolled "rounds": judgment nodes (output_schema+enum) grouped
//      by node id with a trailing digit stripped (review1/review2/review3 →
//      base "review") must not exceed 3 per group. This naming convention is
//      what every real round in this corpus actually uses (dev/brain always
//      number retries this way); a graph-connectivity approach was tried
//      first and rejected because gateStack/gateTests/gateNone/diffAudit in
//      the real `sdlc-issue-pipeline` v4 dag all co-reference review1-3 in
//      OR-branches for UNRELATED reasons (branch selection / final scope
//      audit, not retry rounds), which made a naive "connected judgment
//      nodes" grouping massively over-count.
//  (c) exhausted-loop termination: nodes that directly depend on a `loop`
//      node must be guarded (or be a human_gate) — an unconditional node
//      right after a bounded loop is exactly the "loop maxes out, pipeline
//      proceeds as if it succeeded" defect §1.3 documents in the old
//      dead-code `sdlc-issue-pipeline` seed (loop → gate → diff-audit → pr,
//      all unconditional). The same "downstream must be guarded" check was
//      tried for guard-unrolled round-groups too and DROPPED: in the real
//      `sdlc-issue-pipeline` v4 dag, `review1` (unconditional, by design —
//      code review always runs regardless of the independent qa/qa2
//      verdict) directly depends on `qa2` (last node of the 2-round "qa"
//      group), which is correct multi-signal-convergence design, not a
//      silent-success bug — but reads as one under a naive "last round's
//      dependents must all be guarded" rule. Loop nodes are the one
//      construct where "bounded, and exhaustion must not silently
//      continue" is unambiguous without that false positive; see this
//      file's spec + the task report for the full trace.

function stripTrailingDigits(id: string): string {
  return id.replace(/\d+$/, "");
}

function ruleBoundedLoops(
  nodes: RawNode[],
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const offendingIds: string[] = [];

  const loopNodes = nodes.filter(
    (n) => n && n.type === "loop" && typeof n.id === "string",
  );
  for (const l of loopNodes) {
    const mi =
      (l.max_iterations as number | undefined) ??
      (l.maxIterations as number | undefined);
    if (typeof mi !== "number") {
      failures.push(`loop '${l.id}' 未声明 max_iterations`);
      offendingIds.push(l.id as string);
    } else if (mi > 3) {
      failures.push(`loop '${l.id}' max_iterations=${mi} > 3`);
      offendingIds.push(l.id as string);
    }
  }

  const judgmentNodes = effectiveAgents.filter((a) =>
    hasEnumProperty(a.output_schema),
  );
  const groups = new Map<string, string[]>();
  for (const j of judgmentNodes) {
    const base = stripTrailingDigits(j.id);
    const arr = groups.get(base) ?? [];
    arr.push(j.id);
    groups.set(base, arr);
  }
  let maxRound = 0;
  for (const [base, ids] of groups) {
    maxRound = Math.max(maxRound, ids.length);
    if (ids.length > 3) {
      failures.push(`'${base}*' 判断轮数 ${ids.length} > 3(${ids.join(", ")})`);
      offendingIds.push(...ids);
    }
  }
  if (maxRound > 0 && loopNodes.length === 0) {
    notes.push(`guard 展开 ${maxRound} 轮 ≤ 3`);
  }

  const humanGateIds = new Set(
    nodes
      .filter((n) => n && n.type === "human_gate" && typeof n.id === "string")
      .map((n) => n.id as string),
  );
  for (const l of loopNodes) {
    const dependents = nodes.filter(
      (n) => Array.isArray(n?.deps) && (n!.deps as unknown[]).includes(l.id),
    );
    for (const dep of dependents) {
      const depId = typeof dep.id === "string" ? dep.id : "?";
      if (humanGateIds.has(depId)) continue;
      if (!dep.guard) {
        failures.push(
          `'${depId}' 直接依赖 loop 节点 '${l.id}' 但未声明 guard —— 耗尽路径可能被静默视为完成`,
        );
        offendingIds.push(depId);
      }
    }
  }
  if (loopNodes.length > 0 && !failures.some((f) => f.includes("耗尽"))) {
    notes.push("耗尽终结于 human_gate/失败");
  }

  const ok = failures.length === 0;
  const detail = ok ? notes.join(" · ") || "无回环节点" : failures.join(" · ");
  return {
    rule: 3,
    key: "bounded-loops",
    label: "③有界回环",
    confidence: "structural",
    ok,
    detail,
    nodeIds: offendingIds,
  };
}

// ── Rule 4 — workspace threading (HEURISTIC) ─────────────────────────────────
//
// §4.2's own round-2 correction: detection = "prompt contains a code-
// operation verb without a workspace field". Word list tuned against the
// REAL (already R4a.1-hardened) `workflow-library-seed.ts` corpus, not just
// the design doc's own quoted pre-hardening examples — traced node-by-node
// while writing this file (see spec for the full trace):
//
//  - Every currently-workspace-having node in the corpus contains at least
//    one of these phrases (mostly "当前 workspace" or an explicit git/build/
//    test verb) — so this pattern would have caught the design doc's own
//    quoted pre-hardening defects ("实现工作项变更", "运行全量测试并采集证据",
//    "对单个仓库运行全量测试套件").
//  - Deliberately EXCLUDES bare "写"/"撰写"/"编写" and bare "改动"/"实现" —
//    `spike-research`'s `report` node ("撰写结构化调研报告") and
//    `sdlc-issue-pipeline`'s `reviewEscalate` node ("...或未解决的关键问题,
//    判定 choice=reject...如果剩下的问题都是...越界改动...") both correctly
//    need NO workspace (pure text synthesis from prior `deps.*.output`, no
//    live repo access) but contain those bare words — a naive "改动"/"写"
//    trigger would false-positive on both. Scoping to git-operation verbs,
//    "当前 workspace", and object-qualified "实现...(功能|代码|变更|规格)"/
//    "运行...(测试|构建|lint|检查|套件)" avoids that while still catching
//    real code-touching instructions.
const CODE_OP_HINT_RE =
  /当前\s*workspace|git\s+(diff|commit|log|push|merge|checkout|fetch)|Read\/Edit\/Write|pnpm\s|运行[^。\n]{0,20}(测试|构建|lint|类型检查|回归|套件)|实现[^。\n]{0,20}(功能|代码|变更|规格|需求)|修复|补齐|生成单屏/i;

function ruleWorkspaceThreading(
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const missing: string[] = [];
  for (const a of effectiveAgents) {
    if (a.workspace) continue;
    if (CODE_OP_HINT_RE.test(a.prompt)) missing.push(a.id);
  }
  const withWorkspace = effectiveAgents.filter((a) => !!a.workspace).length;
  const ok = missing.length === 0;
  const detail = ok
    ? `${withWorkspace}/${effectiveAgents.length} 代码节点带 workspace`
    : `缺 workspace 且提示词含代码操作动词(启发式,可能漏报): ${missing.join(" / ")}`;
  return {
    rule: 4,
    key: "workspace-threading",
    label: "④workspace贯穿",
    confidence: "heuristic",
    ok,
    detail,
    nodeIds: missing,
  };
}

// ── Rule 5 — permission honesty (HEURISTIC) ──────────────────────────────────
//
// §4.2's own round-2 correction: the ORIGINAL word list (literal English
// phrases like "merge PR") missed most real Chinese seed prompts. This is
// the corrected Chinese verb/object regex the design doc specifies verbatim.
// Traced against the current (hardened) corpus while writing this file —
// real matches inside actual `dag.nodes[].prompt` text (description/
// changeNote text is metadata outside `dag` and is never scanned):
//  - `sdlc-verify`'s `report` node: "本节点不在 DAG 内建单" — a FALSE POSITIVE,
//    the substring match has no negation awareness ("不在...建单" still
//    contains "建单").
//  - `sdlc-ui-build`'s `fanout-screens` body: "生成单屏原型 HTML" — a FALSE
//    POSITIVE, "单" here means "single (screen)", not "ticket/order"; the
//    `生成.*单` pattern can't disambiguate the polysemous 单.
//  - `sdlc-promote`'s `promote` node: "合入 base 分支" / "git push origin" —
//    a genuine keyword match. This one is a real, reportable tension: this
//    node's real production dag (adopted verbatim from 101, run 2x
//    successfully) has the vLLM worker do the git merge/push itself inside
//    its own workspace, which the design's "worker 无凭据" framing didn't
//    anticipate — this heuristic can't distinguish "false promise" from
//    "worker genuinely has git write access in its own workspace clone".
// All three are exactly the kind of false positive/negative §4.2 says this
// heuristic is allowed to have ("覆盖有限,需人工评审兜底,不应该承诺穷尽") —
// documented here and in this file's spec rather than special-cased away.
const PERMISSION_VIOLATION_RE =
  /合并|合入|提交[^,。\n]{0,15}PR|发起[^,。\n]{0,15}PR|推送|push|入库|发布|生成[^,。\n]{0,15}单|建单|创建[^,。\n]{0,20}(工作项|issue|ticket)/i;

function rulePermissionHonesty(
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const flagged: string[] = [];
  for (const a of effectiveAgents) {
    if (PERMISSION_VIOLATION_RE.test(a.prompt)) flagged.push(a.id);
  }
  const ok = flagged.length === 0;
  const detail = ok
    ? "无 push/merge/发布/建单类越权承诺"
    : `疑似越权承诺(启发式,可能误报,需人工复核): ${flagged.join(" / ")}`;
  return {
    rule: 5,
    key: "permission-honesty",
    label: "⑤权限诚实",
    confidence: "heuristic",
    ok,
    detail,
    nodeIds: flagged,
  };
}

// ── Rule 6 — timeout & retry (structural) ────────────────────────────────────
//
// Scoped to "dev/qa-class" nodes = agent nodes that touch a real workspace
// AND are not a judgment node (no output_schema.enum) — i.e. workers that do
// actual dev/test/fix work, as opposed to review/audit/gate judgment nodes
// (whose own timeout needs the design doc doesn't scope this rule to) or
// human_gate (no timeout concept — see §4.6, no timeout mechanism exists
// there yet either).

function isDevQaClassNode(a: EffectiveAgentNode): boolean {
  return !!a.workspace && !hasEnumProperty(a.output_schema);
}

function ruleTimeoutRetry(
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const devQa = effectiveAgents.filter(isDevQaClassNode);
  const missingTimeout: string[] = [];
  const missingRetry: string[] = [];
  for (const a of devQa) {
    if (typeof a.timeout_seconds !== "number") missingTimeout.push(a.id);
    const retryMax =
      a.retry && typeof a.retry === "object" ? (a.retry as any).max : undefined;
    if (typeof retryMax !== "number" || retryMax < 1) missingRetry.push(a.id);
  }
  const ok = missingTimeout.length === 0 && missingRetry.length === 0;
  const parts: string[] = [];
  if (missingTimeout.length)
    parts.push(`缺 timeout_seconds: ${missingTimeout.join(" / ")}`);
  if (missingRetry.length)
    parts.push(`缺 retry.max>=1: ${missingRetry.join(" / ")}`);
  if (ok) {
    parts.push(
      devQa.length
        ? `${devQa.length} 个 dev/qa 类节点均声明 timeout_seconds + retry`
        : "无 dev/qa 类节点",
    );
  }
  return {
    rule: 6,
    key: "timeout-retry",
    label: "⑥超时与重试",
    confidence: "structural",
    ok,
    detail: parts.join(" · "),
    nodeIds: [...new Set([...missingTimeout, ...missingRetry])],
  };
}

// ── Rule 7 — engine policy (structural) ──────────────────────────────────────
//
// Per §4.2 point 7's own resolution (implemented by task #79,
// `dag-validator.ts`'s `isClaudeCodeEngineRef`/`nodeTargetsClaudeCode` +
// `server/queue/claude-code-admit.ts`'s concurrency gate): `engine_override`
// resolving to claude-code is a hard validateDag rejection (mirrored here so
// this lint stays meaningful even if called before a save attempt);
// `agent:"claude-code"` is a SANCTIONED first-party review/audit worker, not
// a violation — it is recognized (not rejected) so the concurrency
// admission gate can rate-limit it. This rule does not re-implement that
// gate; it only confirms the mechanism it depends on (isClaudeCodeEngineRef)
// exists and reports which nodes it applies to.

function ruleEnginePolicy(
  effectiveAgents: EffectiveAgentNode[],
): LintRuleResult {
  const overrideViolations = effectiveAgents.filter(
    (a) =>
      typeof a.engine_override === "string" &&
      isClaudeCodeEngineRef(a.engine_override),
  );
  const claudeCodeNodes = effectiveAgents.filter((a) =>
    nodeTargetsClaudeCode({
      agent: a.agent,
      engine_override: a.engine_override,
    }),
  );
  const ok = overrideViolations.length === 0;
  const detail = ok
    ? claudeCodeNodes.length
      ? `${claudeCodeNodes.map((n) => n.id).join(" / ")} 派发时经并发闸健康门;无 claude-code 越权`
      : "无节点命中 claude-code;无 engine_override 越权"
    : `engine_override 越权: ${overrideViolations.map((n) => n.id).join(" / ")}`;
  return {
    rule: 7,
    key: "engine-policy",
    label: "⑦引擎政策",
    confidence: "structural",
    ok,
    detail,
    nodeIds: overrideViolations.map((n) => n.id),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

const RULE_META: Array<{
  rule: number;
  key: string;
  label: string;
  confidence: LintConfidence;
}> = [
  {
    rule: 1,
    key: "input-wiring",
    label: "①输入接线",
    confidence: "structural",
  },
  {
    rule: 2,
    key: "judgment-structure",
    label: "②判断节点结构化",
    confidence: "structural",
  },
  {
    rule: 3,
    key: "bounded-loops",
    label: "③有界回环",
    confidence: "structural",
  },
  {
    rule: 4,
    key: "workspace-threading",
    label: "④workspace贯穿",
    confidence: "heuristic",
  },
  {
    rule: 5,
    key: "permission-honesty",
    label: "⑤权限诚实",
    confidence: "heuristic",
  },
  {
    rule: 6,
    key: "timeout-retry",
    label: "⑥超时与重试",
    confidence: "structural",
  },
  {
    rule: 7,
    key: "engine-policy",
    label: "⑦引擎政策",
    confidence: "structural",
  },
];

function summarize(results: LintRuleResult[]): DispatchGradeLintResult {
  const passCount = results.filter((r) => r.ok).length;
  const ok = passCount === results.length;
  return {
    ok,
    level: ok ? "dispatch-grade" : "card-grade",
    passCount,
    totalCount: results.length,
    results,
  };
}

/**
 * Lint a DAG + inputSchema for "dispatch-grade" readiness (04 doc §4.2, P-C:
 * card-grade templates may exist in the library, but auto-routing may only
 * point at a version that passes all 7 of these). Never throws — malformed
 * input yields an all-failing result rather than an exception, since the
 * live editor panel calls this on every debounced keystroke.
 */
export function lintTemplateDispatchGrade(
  dag: unknown,
  inputSchema: unknown,
): DispatchGradeLintResult {
  const nodes = parseDagNodes(dag);
  if (!nodes) {
    return summarize(
      RULE_META.map((m) => ({
        ...m,
        ok: false,
        detail: "DAG 解析失败或缺少 nodes 数组",
      })),
    );
  }

  const effectiveAgents = collectEffectiveAgentNodes(nodes);
  const schema =
    inputSchema && typeof inputSchema === "object" ? inputSchema : {};

  const results = [
    ruleInputWiring(nodes, effectiveAgents, schema),
    ruleJudgmentStructure(nodes, effectiveAgents),
    ruleBoundedLoops(nodes, effectiveAgents),
    ruleWorkspaceThreading(effectiveAgents),
    rulePermissionHonesty(effectiveAgents),
    ruleTimeoutRetry(effectiveAgents),
    ruleEnginePolicy(effectiveAgents),
  ];
  return summarize(results);
}
