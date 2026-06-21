/**
 * `audit --unwrapped` core: find user-facing string literals / JSXText that are
 * NOT wrapped in `t()` / `tx()` and are NOT going to be wrapped by the plugin's
 * rules — i.e. residual hardcoded UI text the heuristics in `transformModule`
 * did not catch.
 *
 * Strategy (see IMPLEMENTATION-PLAN P9):
 *   1. Run the SHARED `transformModule` on the file. Every position the plugin
 *      TARGETS becomes a `t()` / `tx()` call in the transformed output, so it is
 *      "covered" by construction.
 *   2. Parse the TRANSFORMED output and walk it. Any natural-language string
 *      literal or JSXText that is NOT inside a `t()` / `tx()` call is a residual
 *      candidate — user-facing text the plugin's positions didn't reach (string
 *      concatenation operands, setState/setError args, date-fns format strings
 *      with English words, template-literal args to non-targeted calls, …).
 *   3. A conservative "natural-language" gate keeps the signal useful: a
 *      candidate must contain a letter and be either multi-word OR end with
 *      sentence punctuation, and must not be a URL / path / dotted host /
 *      code identifier / className / enum-ish token.
 *
 * If `transformModule` returns null (it made no changes), the file still must be
 * scanned for residuals — we parse the ORIGINAL source in that case.
 */

import { parse } from "@babel/parser";
import _traverse, {
  type NodePath,
  type TraverseOptions,
} from "@babel/traverse";
import * as t from "@babel/types";
import { transformModule } from "../vite/transform.js";

type TraverseFn = (node: t.Node, opts: TraverseOptions) => void;
const traverseModule = _traverse as unknown as {
  default?: TraverseFn;
} & TraverseFn;
const traverse: TraverseFn = traverseModule.default ?? traverseModule;

/** A single residual candidate: an unwrapped user-facing string. */
export interface UnwrappedCandidate {
  /** Absolute (POSIX-normalized) file path. */
  file: string;
  /** 1-based line number in the ORIGINAL source. */
  line: number;
  /** The offending string (trimmed, length-capped for display). */
  text: string;
  /** Short reason this string is a candidate. */
  reason: string;
}

const MAX_TEXT_LEN = 120;

/** Cap and single-line a candidate string for stable display + allowlisting. */
function normalizeText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TEXT_LEN
    ? `${oneLine.slice(0, MAX_TEXT_LEN)}…`
    : oneLine;
}

function hasLetter(value: string): boolean {
  return /\p{L}/u.test(value);
}

/** Count whitespace-separated word-ish runs containing a letter. */
function wordCount(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter((w) => hasLetter(w)).length;
}

/**
 * Conservative "is this natural-language user-facing text" gate. Errs toward
 * flagging multi-word prose; never flags single lowercase tokens, code, URLs,
 * paths, dotted hosts, classNames, or enum-like identifiers.
 */
function isNaturalLanguage(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (!hasLetter(value)) return false;
  // URLs / protocol-relative / absolute or relative paths.
  if (value.includes("://")) return false;
  if (/^[./]/.test(value)) return false;
  // Dotted host / file identifier (example.com, a.b.c, file.tsx).
  if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(value)) return false;
  // Mustache/templating-only or format-token-only strings (e.g. "{count}",
  // "yyyy-MM-dd") with no real word are not prose on their own.
  const lettersOutsideBraces = value.replace(/\{[^}]*\}/g, "").trim();
  if (!hasLetter(lettersOutsideBraces)) return false;

  const words = wordCount(value);
  const endsWithSentencePunct = /[.?!…:](["')\]]*)$/.test(value);

  // Multi-word prose, OR a single "sentence" ending in punctuation.
  if (words >= 2) {
    // Reject all-code multi-token strings like "px solid" only if every token
    // is a known non-prose token; otherwise treat 2+ words as prose. Keep the
    // single-token branch strict below.
    return !isCodeyMultiToken(value);
  }
  if (endsWithSentencePunct) return true;
  return false;
}

/**
 * A multi-token string that is plausibly code/CSS rather than prose, e.g.
 * "1px solid", "flex row", "0 auto". Heuristic: every token is short and either
 * numeric, a CSS unit, or a lowercase keyword AND no token is a "real" word
 * (>= 4 letters with a vowel). Conservative — only suppresses obvious code.
 */
const CSS_KEYWORDS = new Set([
  "px",
  "em",
  "rem",
  "vh",
  "vw",
  "auto",
  "solid",
  "dashed",
  "none",
  "flex",
  "row",
  "col",
  "wrap",
  "bold",
  "italic",
  "block",
  "inline",
  "grid",
  "center",
  "left",
  "right",
  "top",
  "bottom",
  "fit",
  "min",
  "max",
]);

function isCodeyMultiToken(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  let realWords = 0;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const numericOrUnit =
      /^-?\d/.test(token) || CSS_KEYWORDS.has(lower.replace(/[^a-z]/g, ""));
    const realWord = /[a-z]{4,}/i.test(token) && /[aeiou]/i.test(token);
    if (realWord && !CSS_KEYWORDS.has(lower)) realWords++;
    if (!numericOrUnit && !realWord) {
      // An unknown short token; not clearly codey.
      return false;
    }
  }
  return realWords === 0;
}

/** True if any ancestor of `path` is a `t()` / `tx()` call. */
function isInsideTranslationCall(path: NodePath): boolean {
  let current: NodePath | null = path.parentPath;
  while (current) {
    if (
      current.isCallExpression() &&
      (t.isIdentifier(current.node.callee, { name: "t" }) ||
        t.isIdentifier(current.node.callee, { name: "tx" }))
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

/**
 * True if the string literal sits in a position that is structurally NOT
 * user-facing even when it is prose: an import/export source, a TS type literal,
 * an object/property KEY, a `case` test, a non-UI attribute, etc. These are the
 * positions the plugin intentionally never targets, so flagging them would be
 * noise.
 */
function isStructuralStringPosition(path: NodePath<t.StringLiteral>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  // import "x" / export ... from "x"
  if (parent.isImportDeclaration() || parent.isExportNamedDeclaration()) {
    return true;
  }
  if (parent.isImportDeclaration()) return true;
  // TS literal type: `type X = "a" | "b"`.
  if (parent.isTSLiteralType()) return true;
  // Object property KEY (not value).
  if (parent.isObjectProperty() && parent.node.key === path.node) return true;
  if (parent.isObjectMethod() && parent.node.key === path.node) return true;
  // Class member / TS signature keys.
  if (
    (parent.isClassProperty() || parent.isClassMethod()) &&
    (parent.node as { key?: t.Node }).key === path.node
  ) {
    return true;
  }
  // `case "x":`
  if (parent.isSwitchCase()) return true;
  // JSX attribute NAME side is never a StringLiteral; attribute VALUES that are
  // not wrappable are handled by the attribute-name gate below.
  return false;
}

/** User-visible JSX text attributes (mirrors the plugin whitelist). */
const USER_FACING_ATTRS = new Set([
  "placeholder",
  "title",
  "alt",
  "label",
  "aria-label",
  "aria-description",
]);

/**
 * State-setter / UI-feedback call names whose FIRST string argument renders to
 * the user but which the plugin does NOT target (it only wraps toast / Error /
 * AgentActionStopError). These are exactly the IMPLEMENTATION-PLAN §8.5 known
 * residuals — `setError("…")`, `setMessage("…")`, `setStatus("…")`, and the
 * browser dialogs `alert` / `confirm` — surfaced as candidates so a reviewer
 * either wraps them or allowlists them.
 */
const UI_SINK_CALL_NAMES = new Set([
  "alert",
  "confirm",
  "seterror",
  "setmessage",
  "setstatus",
  "setsuccess",
  "setwarning",
  "seterrormessage",
  "setsuccessmessage",
  "setstatusmessage",
  "setnotice",
  "settoast",
  "setlabel",
  "settitle",
  "setdescription",
]);

/**
 * Object-property key names whose VALUE is user-visible copy (mirrors the
 * plugin's UI_TEXT_OBJECT_KEYS). A bare prose value under one of these keys in
 * the transformed output is a residual the plugin's heuristic missed (e.g. a
 * concatenated `message`).
 */
const UI_TEXT_KEYS = new Set([
  "title",
  "label",
  "subtitle",
  "description",
  "text",
  "hint",
  "heading",
  "tooltip",
  "cta",
  "placeholder",
  "message",
  "summary",
  "caption",
  "prompt",
  "question",
]);

/**
 * Lowercased member-call method names that consume a string as DATA, not as
 * rendered copy (comparison / matching / parsing). A prose-looking literal in
 * one of these argument positions is NOT a UI residual and must be skipped,
 * which is what removes the bulk of false positives (`err.includes("failed to
 * fetch")`, `name.startsWith("Untitled")`, …).
 */
const DATA_MEMBER_METHODS = new Set([
  "includes",
  "startswith",
  "endswith",
  "indexof",
  "lastindexof",
  "match",
  "matchall",
  "search",
  "replace",
  "replaceall",
  "split",
  "localecompare",
  "test",
  "has",
  "get",
  "set",
  "add",
  "delete",
]);

/** The lowercased name of a call/new callee, or null for complex callees. */
function calleeName(callee: t.Node): string | null {
  if (t.isIdentifier(callee)) return callee.name.toLowerCase();
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    return callee.property.name.toLowerCase();
  }
  return null;
}

/**
 * Classify the POSITION of a prose string/template node (already established as
 * natural-language and NOT inside a t()/tx() call) in the transformed AST.
 * Returns a human reason when the position is a PLAUSIBLE user-facing sink the
 * plugin's narrow heuristic could have missed, or null when the position is
 * structural / data-layer / model-instruction (skip — would be noise).
 *
 * Plausible UI sinks (the residual surface, per IMPLEMENTATION-PLAN §8.5):
 *   - a user-facing JSX attribute value (placeholder/title/alt/label/aria-*),
 *   - the first argument of a UI-feedback / state-setter / dialog call
 *     (setError, setMessage, alert, confirm, …), or
 *   - the value of a UI-text object property (message/summary/title/…) — which
 *     post-transform means the plugin could not wrap it (e.g. concatenation).
 *
 * Everything else — plain returns, variable inits, generic function args,
 * comparison/matching operands, import/type/key positions — is NOT flagged.
 */
function classifyStringPosition(path: NodePath): string | null {
  const parent = path.parentPath;
  if (!parent) return null;

  // (a) JSX attribute value: only the user-facing text attributes.
  if (parent.isJSXAttribute()) {
    const nameNode = parent.node.name;
    const name = t.isJSXNamespacedName(nameNode)
      ? `${nameNode.namespace.name}:${nameNode.name.name}`
      : nameNode.name;
    return USER_FACING_ATTRS.has(name.toLowerCase())
      ? "bare user-facing JSX attribute value"
      : null;
  }

  // (b) first argument of a UI-sink call (state-setter / dialog).
  if (
    path.listKey === "arguments" &&
    path.key === 0 &&
    (parent.isCallExpression() || parent.isNewExpression())
  ) {
    const name = calleeName(parent.node.callee);
    if (name && UI_SINK_CALL_NAMES.has(name)) {
      return `bare string argument to ${name}()`;
    }
    return null;
  }

  // A string that is an argument to a DATA member method (includes/startsWith/
  // …) is matched/parsed, not rendered — never a residual.
  if (
    path.listKey === "arguments" &&
    parent.isCallExpression() &&
    t.isMemberExpression(parent.node.callee) &&
    t.isIdentifier(parent.node.callee.property) &&
    DATA_MEMBER_METHODS.has(parent.node.callee.property.name.toLowerCase())
  ) {
    return null;
  }

  // (c) value of a UI-text object property.
  if (parent.isObjectProperty() && parent.node.value === path.node) {
    if (parent.node.computed) return null;
    const key = parent.node.key;
    let keyName: string | null = null;
    if (t.isIdentifier(key)) keyName = key.name;
    else if (t.isStringLiteral(key)) keyName = key.value;
    if (keyName && UI_TEXT_KEYS.has(keyName.toLowerCase())) {
      return "bare prose value of a UI-text object key";
    }
    return null;
  }

  // Anything else is not a plausible UI sink — skip to stay useful.
  return null;
}

/**
 * Scan one source file for residual unwrapped user-facing strings. Parses the
 * TRANSFORMED output (so every plugin-targeted position is already a `t()` /
 * `tx()` call) and reports natural-language strings / JSXText that remain bare.
 *
 * Line numbers come from the transform output's AST; since we map back by text,
 * we re-derive the line from the ORIGINAL source where possible for accuracy.
 */
export function scanFileForUnwrapped(
  code: string,
  filename: string,
): UnwrappedCandidate[] {
  // 1. Transform; fall back to original source if the plugin made no changes.
  let transformed = code;
  try {
    const out = transformModule(code, filename);
    if (out) transformed = out.code;
  } catch {
    // Parse error during transform — scan the original source instead.
  }

  let ast: t.File;
  try {
    ast = parse(transformed, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    // If even the transformed output fails to parse, try the original.
    try {
      ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });
    } catch {
      return [];
    }
  }

  const candidates: UnwrappedCandidate[] = [];
  const seen = new Set<string>();
  const push = (line: number, text: string, reason: string): void => {
    const normalized = normalizeText(text);
    const dedupe = `${line} ${normalized}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    candidates.push({ file: filename, line, text: normalized, reason });
  };

  traverse(ast, {
    JSXText(path) {
      const value = path.node.value;
      if (!isNaturalLanguage(value)) return;
      if (isInsideTranslationCall(path)) return;
      const line = path.node.loc?.start.line ?? 0;
      push(line, value, "bare JSX text not wrapped in t()");
    },
    StringLiteral(path) {
      const value = path.node.value;
      if (!isNaturalLanguage(value)) return;
      if (isInsideTranslationCall(path)) return;
      if (isStructuralStringPosition(path)) return;
      // Only flag prose that sits in a PLAUSIBLE user-facing sink the plugin's
      // narrow heuristic could have missed (JSX text attr, state-setter/dialog
      // call arg, UI-text object value). Data-layer prose (comparisons, prompt
      // assembly, generic returns/args) is intentionally NOT flagged.
      const reason = classifyStringPosition(path);
      if (!reason) return;
      const line = path.node.loc?.start.line ?? 0;
      push(line, value, reason);
    },
    TemplateLiteral(path) {
      // A template literal that survived transform (was not converted to tx)
      // and reads as prose is a candidate ONLY when it sits in a UI sink — e.g.
      // a concatenation/format string passed to setError(...) or assigned to a
      // `message` field. Generic template literals (prompt assembly, log lines)
      // are skipped by the same position gate.
      if (isInsideTranslationCall(path)) return;
      const cooked = path.node.quasis
        .map((q) => q.value.cooked ?? q.value.raw)
        .join(" ");
      if (!isNaturalLanguage(cooked)) return;
      const reason = classifyStringPosition(path);
      if (!reason) return;
      const line = path.node.loc?.start.line ?? 0;
      push(line, cooked, reason);
    },
  });

  return candidates;
}
