/**
 * AST transform: wrap hardcoded English UI literals in `t()` / `tx()` and
 * collect each wrapped English source string as an extraction key.
 *
 * Wrapped positions (see IMPLEMENTATION-PLAN §4.3):
 *   - JSX text nodes containing a letter.
 *   - JSX attributes whose name is whitelisted (placeholder, title, aria-label,
 *     aria-description, alt, label) OR whose lowercased name ends with a
 *     UI-text suffix word (text|label|title|placeholder|tooltip|message|hint|
 *     caption|heading|cta|subtitle), with a string-literal value containing a
 *     letter. Catches e.g. emptyStateText, composerPlaceholder, buttonText.
 *   - String-array attribute values (e.g. `suggestions={[...]}`): each
 *     prose-like StringLiteral element (has a letter AND has whitespace, ends
 *     with sentence punctuation, or is multi-word) is wrapped.
 *   - Object properties whose (non-computed) key name is a known UI-text key
 *     (title, label, subtitle, description, text, message, ...) with a
 *     StringLiteral value (wrapped as `t()`) or a TemplateLiteral value (wrapped
 *     as `tx()` with a `{name}` / `{0}` placeholder map). Catches UI strings
 *     defined in data/config object arrays and interpolated action result
 *     messages such as `{ message: \`Created draft ${id}\` }`. Non-UI-text keys
 *     (`id`, `key`, `className`, ...) are left untouched whatever their value.
 *   - Default parameter values (`function f({ label = "Feedback" })` or
 *     `function f(label = "Feedback")`): the AssignmentPattern default value is
 *     wrapped when the bound identifier name is a known UI-text name. Catches
 *     UI strings indirected through a prop/arg default.
 *   - Named const / let string values whose identifier matches a UI-text naming
 *     convention (e.g. `DEFAULT_SUBMIT_TEXT`, `successMessage`, `ERROR_COPY`):
 *     the StringLiteral / TemplateLiteral init is wrapped. Catches UI strings
 *     hoisted into a named constant and rendered via the variable.
 *   - First string argument of toast / toast.* and `new Error(...)` /
 *     `new AgentActionStopError(...)`.
 *   - First StringLiteral (→`t()`) or TemplateLiteral (→`tx()`) argument of a
 *     UI state-setter call whose bare-identifier callee is in the curated
 *     setter set (`setError`, `setStatus`, `setStatusMessage`, `setMessage`,
 *     `setTitle`, and similar React `useState` setters that render their value
 *     to the user — see UI_STATE_SETTERS). A StringLiteral arg is wrapped ONLY
 *     when it reads as NATURAL LANGUAGE (see isNaturalLanguage: multi-word, ends
 *     with sentence punctuation, or long-with-space) — single-word enum/status
 *     values such as `setStatus("idle")` / `setStatus("saving")` are internal
 *     state compared elsewhere (`status === "idle"`) and are left untouched so
 *     translating them cannot break logic. Template-literal args keep wrapping
 *     (they carry interpolation/prose) but require some non-placeholder text.
 *     Only literal/template first args are wrapped; setters called with a
 *     variable/expression (e.g. `setError(err.message)`) are left untouched, as
 *     are setters with a non-string first arg (e.g. `setCount(5)`) and
 *     identifiers outside the set (e.g. `setUserId("u_123")`).
 *   - StringLiteral / TemplateLiteral operands of a ConditionalExpression
 *     (`cond ? "A" : "B"`) or LogicalExpression (`cond && "msg"`, `x || "y"`),
 *     but ONLY when the conditional/logical sits in a UI position: a JSX-child
 *     expression container, a wrappable JSX attribute value, or a wrapped call
 *     argument (toast / new Error / new AgentActionStopError). Nested and mixed
 *     forms (`a ? "x" : b ? "y" : "z"`, `a && "m"`) recurse. Logic-layer
 *     ternaries that are NOT in a UI position (e.g. `const dir = asc ? "asc" :
 *     "desc"`) are left untouched.
 *   - Template literals in any of the above positions become `tx()` with an
 *     ICU-style `{name}` / `{0}` placeholder map.
 *
 * Over-wrap safety: identifiers, CSS classes, routing targets, URLs/paths,
 * dotted hosts, and code-like single tokens are skipped (see isNonProseValue),
 * along with a denylist of structural attributes (className, id, href, to, …),
 * `data-*` / `on*` handlers, and non-text `aria-*` state attributes.
 *
 * Idempotency: any literal already inside a `t()` / `tx()` call is skipped, and
 * a `// i18n-ignore` comment on the node (or its JSX parent) exempts it.
 */

import { parse } from "@babel/parser";
import _traverse, {
  type NodePath,
  type TraverseOptions,
} from "@babel/traverse";
import _generate, { type GeneratorResult } from "@babel/generator";
import * as t from "@babel/types";

// Babel ships CJS default exports; under ESM interop the callable lives on
// `.default` (esbuild/bundler resolution) but is the module itself under
// NodeNext. Normalize both shapes behind an explicit, resolution-independent
// call signature so this file typechecks under either `moduleResolution`.
type TraverseFn = (node: t.Node, opts: TraverseOptions) => void;
type GenerateFn = (
  ast: t.Node,
  opts?: {
    retainLines?: boolean;
    sourceMaps?: boolean;
    sourceFileName?: string;
  },
  code?: string,
) => GeneratorResult;

const traverseModule = _traverse as unknown as {
  default?: TraverseFn;
} & TraverseFn;
const traverse: TraverseFn = traverseModule.default ?? traverseModule;
const generateModule = _generate as unknown as {
  default?: GenerateFn;
} & GenerateFn;
const generate: GenerateFn = generateModule.default ?? generateModule;

export interface TransformOutput {
  code: string;
  map: GeneratorResult["map"];
  keys: string[];
}

const WRAPPABLE_ATTRS = new Set([
  "placeholder",
  "title",
  "aria-label",
  "aria-description",
  "alt",
  "label",
]);

/**
 * Attribute names whose lowercased form ends with one of these UI-text suffixes
 * are also wrappable (e.g. `emptyStateText`, `composerPlaceholder`,
 * `buttonText`, `headerTitle`). Kept as a single anchored alternation so a name
 * like `subtitle` matches but `style` (no suffix word boundary) does not.
 */
const UI_TEXT_ATTR_SUFFIX =
  /(text|label|title|placeholder|tooltip|message|hint|caption|heading|cta|subtitle)$/;

/**
 * Object-property key names (lowercased, non-computed) whose StringLiteral value
 * is treated as user-visible UI text. Catches config/data object arrays such as
 * `{ title: "...", description: "..." }`.
 */
const UI_TEXT_OBJECT_KEYS = new Set([
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
  "emptytext",
  "emptystatetext",
  "message",
  "summary",
  "prompt",
  "question",
  "suggestion",
  "caption",
  "confirmlabel",
  "cancellabel",
  // Login-page marketing (auth plugins + core auth-marketing): the tagline and
  // feature bullets are user-visible pre-auth copy. The app NAME is a proper
  // noun and is intentionally left as passthrough (IMPLEMENTATION-PLAN §8.5).
  "tagline",
  "features",
]);

/**
 * UI-text object keys whose value is an ARRAY of user-visible copy strings
 * (e.g. login marketing `features: ["…", "…"]`). Each prose-like element is
 * wrapped in `t()` using the same per-element heuristic as JSX string arrays.
 */
const UI_TEXT_ARRAY_OBJECT_KEYS = new Set(["features", "suggestions"]);

/**
 * Bound identifier names (lowercased) whose default value in a destructured /
 * parameter AssignmentPattern is treated as user-visible UI text. Catches
 * indirected props/args such as `function f({ label = "Feedback" })`.
 */
const UI_TEXT_DEFAULT_PARAM_NAMES = new Set([
  "label",
  "title",
  "text",
  "placeholder",
  "message",
  "hint",
  "caption",
  "heading",
  "subtitle",
  "tooltip",
  "cta",
  "description",
  "summary",
  "prompt",
  "question",
  "confirmlabel",
  "cancellabel",
  "emptytext",
  "successmessage",
  "errormessage",
]);

/**
 * Named const / let identifiers whose StringLiteral / TemplateLiteral init is
 * treated as user-visible UI text. Matches when one of the UI-text words sits
 * at a word boundary inside the identifier (case-insensitive), e.g.
 * `DEFAULT_SUBMIT_TEXT`, `successMessage`, `emptyLabel`, `ERROR_COPY`. Arbitrary
 * string consts like `API_BASE` or `STORAGE_KEY` do not match.
 *
 * A UI-text word counts only when it is a whole identifier segment, in one of
 * two boundary styles, so an embedded substring like the "text" inside
 * `contextValue` is NOT matched:
 *   - SCREAMING_SNAKE / underscore segment: the word is bounded by start /
 *     underscore on the left and end / underscore on the right, and may itself
 *     be upper- or lower-case (`DEFAULT_SUBMIT_TEXT`, `submit_text`, `text`).
 *   - camelCase segment: a lowercase run is followed by the word with a leading
 *     capital and matching capitalized spelling, ending at end / underscore /
 *     the next capital (`successMessage`, `emptyLabel`, `errorCopy`).
 * Each branch lists the words once per casing it needs; no global `i` flag is
 * used because that would loosen the segment boundaries into any-letter.
 */
const UI_TEXT_WORDS_UPPER =
  "LABEL|TEXT|MSG|MESSAGE|PLACEHOLDER|TITLE|HEADING|HINT|CTA|TOOLTIP|SUBTITLE|DESCRIPTION|SUCCESS|ERROR|EMPTY|CONFIRM|CANCEL|PROMPT|COPY|CAPTION";
const UI_TEXT_WORDS_LOWER = UI_TEXT_WORDS_UPPER.toLowerCase();
const UI_TEXT_WORDS_CAPITAL =
  "Label|Text|Msg|Message|Placeholder|Title|Heading|Hint|Cta|Tooltip|Subtitle|Description|Success|Error|Empty|Confirm|Cancel|Prompt|Copy|Caption";
const UI_TEXT_CONST_NAME = new RegExp(
  // SCREAMING_SNAKE / underscore segment (upper or lower case word).
  `(^|_)(${UI_TEXT_WORDS_UPPER}|${UI_TEXT_WORDS_LOWER})($|_)` +
    // OR a capitalized camelCase segment after a lowercase run.
    `|[a-z](${UI_TEXT_WORDS_CAPITAL})($|_|[A-Z])`,
);

/**
 * Attribute names that must NEVER be wrapped regardless of suffix match. These
 * carry identifiers, CSS, routing targets, or enum-like tokens — not prose.
 */
const NEVER_WRAP_ATTRS = new Set([
  "classname",
  "class",
  "key",
  "id",
  "htmlfor",
  "name",
  "type",
  "role",
  "variant",
  "size",
  "color",
  "href",
  "src",
  "to",
  "as",
  "slot",
  "mode",
  "storagekey",
  "style",
  "target",
  "rel",
  "dir",
  "lang",
]);

/**
 * ARIA attributes that hold non-text state (booleans / id references), as
 * opposed to the user-visible `aria-label` / `aria-description`. Never wrap.
 */
const NON_TEXT_ARIA_ATTRS = new Set([
  "aria-hidden",
  "aria-live",
  "aria-expanded",
  "aria-controls",
  "aria-checked",
  "aria-selected",
  "aria-current",
  "aria-haspopup",
]);

const ERROR_CTORS = new Set(["Error", "AgentActionStopError"]);

/**
 * Curated set of React `useState` setter names (bare identifiers) whose first
 * argument is user-visible UI copy rendered straight back to the user. The
 * first StringLiteral / TemplateLiteral argument of a call to one of these is
 * wrapped in `t()` / `tx()`. Setters are always bare identifiers in practice
 * (member-expression callees such as `obj.setError(...)` are not matched), and
 * non-literal first args (`setError(err.message)`) are left untouched so only
 * inline copy is localized. Names outside this set (e.g. `setUserId`,
 * `setCount`) never match.
 */
const UI_STATE_SETTERS = new Set([
  "setError",
  "setErrorMessage",
  "setStatus",
  "setStatusMessage",
  "setStatusText",
  "setMessage",
  "setTitle",
  "setSubtitle",
  "setNotice",
  "setWarning",
  "setWarningMessage",
  "setSuccess",
  "setSuccessMessage",
  "setInfo",
  "setInfoMessage",
  "setHint",
  "setLabel",
  "setCaption",
  "setDescription",
  "setPlaceholder",
  "setBanner",
  "setToast",
  "setFeedback",
]);

/** A string is wrappable only if it carries at least one letter. */
function hasLetter(value: string): boolean {
  return /\p{L}/u.test(value);
}

/** Count whitespace-separated runs that contain a letter. */
function wordCount(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter((w) => hasLetter(w)).length;
}

/**
 * Conservative "is this natural-language user-facing copy" gate, mirroring the
 * `audit --unwrapped` `isNaturalLanguage` heuristic so setter wrapping and the
 * residual audit agree. A value qualifies as prose when it has a letter and is
 * EITHER multi-word (carries whitespace between letter-bearing tokens) OR ends
 * with sentence punctuation (`. ? ! … : ·`) OR is long (length >= 16) with a
 * space. Single lowercase enum/status tokens with no space (`idle`, `live`,
 * `error`, `success`, `all`, `completed`, `polling`, `saving`, `starting`,
 * `errored`) are NOT prose and must be skipped — they are internal state values
 * compared elsewhere (`status === "idle"`), so translating them breaks logic.
 *
 * URLs, paths, dotted hosts, and code-like single tokens are rejected up front
 * via `isNonProseValue` so this gate never localizes routing/enum identifiers.
 */
function isNaturalLanguage(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (!hasLetter(value)) return false;
  if (isNonProseValue(value)) return false;
  // Strip mustache/placeholder spans; a value that is only placeholders + code
  // (no real word outside braces) is not prose on its own.
  const lettersOutsideBraces = value.replace(/\{[^}]*\}/g, "").trim();
  if (!hasLetter(lettersOutsideBraces)) return false;

  const hasSpace = /\s/.test(value);
  if (wordCount(value) >= 2) return true;
  if (/[.?!…:·](["')\]]*)$/.test(value)) return true;
  if (value.length >= 16 && hasSpace) return true;
  return false;
}

/**
 * True if a template literal's STATIC quasi text (the parts outside `${…}`
 * interpolation) contains a real letter — i.e. there is some user-visible prose
 * around the placeholders, not just a bare `${value}` enum passthrough.
 */
function templateHasProseText(node: t.TemplateLiteral): boolean {
  const staticText = node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
    .join(" ");
  return hasLetter(staticText);
}

/**
 * True if a value is obviously non-prose: a URL, an absolute path, a dotted
 * host/identifier (`a.b.c`), or a single code-like token with no whitespace
 * (camelCase / snake_case / kebab-case identifier). Such values are skipped so
 * the broader rules never localize routing targets, CSS classes, enum tokens,
 * or programmatic identifiers.
 */
function isNonProseValue(value: string): boolean {
  const trimmed = value.trim();
  if (!hasLetter(trimmed)) return true;
  // URLs and protocol-relative or absolute paths.
  if (trimmed.includes("://")) return true;
  if (trimmed.startsWith("/")) return true;
  // Dotted host / file identifiers like "example.com" or "a.b-c.d".
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed)) return true;
  // Single code-like token (no whitespace): camelCase / snake / kebab / dotted
  // identifiers with no separating space are treated as code, not prose.
  if (!/\s/.test(trimmed)) {
    if (/^[A-Za-z][A-Za-z0-9]*([_-][A-Za-z0-9]+)+$/.test(trimmed)) return true; // snake_case / kebab-case
    if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(trimmed)) return true; // camelCase
  }
  return false;
}

/**
 * Hard denylist gate shared by every attribute rule: structural attributes,
 * `data-*` / `on*` handlers, and non-text `aria-*` state attributes are never
 * touched (whatever their value shape — string, template, or array).
 */
function isDenylistedAttr(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("data-")) return true;
  if (lower.startsWith("on")) return true;
  if (NEVER_WRAP_ATTRS.has(lower)) return true;
  if (lower.startsWith("aria-")) {
    // Only the explicitly whitelisted aria-* text attrs survive the gate.
    return !(WRAPPABLE_ATTRS.has(lower) && !NON_TEXT_ARIA_ATTRS.has(lower));
  }
  return false;
}

/**
 * Whether a JSX attribute name is wrappable for STRING / TEMPLATE values: it is
 * in the explicit whitelist OR its lowercased form ends with a UI-text suffix
 * word. (Array values use only the denylist gate plus the per-element prose
 * heuristic, since array names like `suggestions` carry no text suffix.)
 */
function isWrappableTextAttr(name: string): boolean {
  if (isDenylistedAttr(name)) return false;
  const lower = name.toLowerCase();
  if (WRAPPABLE_ATTRS.has(lower)) return true;
  return UI_TEXT_ATTR_SUFFIX.test(lower);
}

/**
 * Whether a string array element looks like user-visible copy rather than a
 * short enum-like token: it has a letter AND (contains whitespace, ends with
 * sentence punctuation, or is more than one word). Single short tokens such as
 * `"sm"` or `"primary"` are left alone.
 */
function isWrappableArrayElement(value: string): boolean {
  const trimmed = value.trim();
  if (!hasLetter(trimmed)) return false;
  if (isNonProseValue(trimmed)) return false;
  if (/\s/.test(trimmed)) return true;
  if (/[.?!…]$/.test(trimmed)) return true;
  return false;
}

/** True if the call target is `t` or `tx` (the i18n runtime helpers). */
function isTranslationCallee(callee: t.Node): boolean {
  return (
    t.isIdentifier(callee, { name: "t" }) ||
    t.isIdentifier(callee, { name: "tx" })
  );
}

/**
 * Walk up from a path; return true if any ancestor is a `t()` / `tx()` call.
 * This is what makes the transform idempotent against prior (manual or
 * plugin-emitted) wraps.
 */
function isInsideTranslationCall(path: NodePath): boolean {
  let current: NodePath | null = path.parentPath;
  while (current) {
    if (
      current.isCallExpression() &&
      isTranslationCallee(current.node.callee)
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

/** Does any comment attached to this node (or its ancestors) request ignore. */
function commentRequestsIgnore(node: t.Node): boolean {
  const comments = [
    ...(node.leadingComments ?? []),
    ...(node.innerComments ?? []),
  ];
  return comments.some((c) => c.value.includes("i18n-ignore"));
}

function pathRequestsIgnore(path: NodePath): boolean {
  let current: NodePath | null = path;
  // Walk up checking each node's leading comment. Stop once we have passed the
  // nearest enclosing statement (comments most often attach to the statement
  // or JSX element that contains the literal).
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.node && commentRequestsIgnore(current.node)) return true;
    const isStatement = current.isStatement?.();
    current = current.parentPath;
    if (isStatement) break;
  }
  return false;
}

/** Build a `t("key")` call node. */
function makeTCall(key: string): t.CallExpression {
  return t.callExpression(t.identifier("t"), [t.stringLiteral(key)]);
}

/**
 * Build a `tx("key", { ...vars })` call from a template literal. Returns null
 * if the resulting cooked text carries no letter (nothing user-visible).
 */
function makeTxCall(
  node: t.TemplateLiteral,
): { call: t.CallExpression; key: string } | null {
  let key = "";
  const props: t.ObjectProperty[] = [];
  let positional = 0;
  const seen = new Set<string>();

  node.quasis.forEach((quasi, index) => {
    key += quasi.value.cooked ?? quasi.value.raw;
    if (index < node.expressions.length) {
      const expr = node.expressions[index];
      if (t.isIdentifier(expr)) {
        const name = expr.name;
        key += `{${name}}`;
        if (!seen.has(name)) {
          seen.add(name);
          props.push(t.objectProperty(t.identifier(name), t.identifier(name)));
        }
      } else {
        const slot = positional++;
        key += `{${slot}}`;
        // Positional keys are numeric — quote them as string-literal keys.
        props.push(
          t.objectProperty(t.stringLiteral(String(slot)), expr as t.Expression),
        );
      }
    }
  });

  if (!hasLetter(key)) return null;

  return {
    call: t.callExpression(t.identifier("tx"), [
      t.stringLiteral(key),
      t.objectExpression(props),
    ]),
    key,
  };
}

/**
 * Wrap an expression node (string literal or template literal) for one of the
 * call-argument / attribute positions. Records the key and marks which helper
 * was used. Returns the replacement expression or null if not wrappable.
 */
function wrapExpression(
  node: t.Expression,
  keys: Set<string>,
  used: { t: boolean; tx: boolean },
): t.Expression | null {
  if (t.isStringLiteral(node)) {
    const value = node.value;
    if (!hasLetter(value)) return null;
    keys.add(value);
    used.t = true;
    return makeTCall(value);
  }
  if (t.isTemplateLiteral(node)) {
    const built = makeTxCall(node);
    if (!built) return null;
    keys.add(built.key);
    used.tx = true;
    return built.call;
  }
  return null;
}

/**
 * Wrap each prose-like StringLiteral element of an array expression in `t()`,
 * in place. Elements already inside a `t()`/`tx()` call, non-prose tokens, or
 * single short words are left untouched. Returns true if anything changed.
 */
function wrapArrayElements(
  array: t.ArrayExpression,
  keys: Set<string>,
  used: { t: boolean; tx: boolean },
): boolean {
  let changed = false;
  array.elements = array.elements.map((element) => {
    if (!element || !t.isStringLiteral(element)) return element;
    if (!isWrappableArrayElement(element.value)) return element;
    keys.add(element.value);
    used.t = true;
    changed = true;
    return makeTCall(element.value);
  });
  return changed;
}

/**
 * Recursively wrap the StringLiteral / TemplateLiteral operands of a
 * ConditionalExpression or LogicalExpression in place. Nested conditional /
 * logical operands recurse so `a ? "x" : (b ? "y" : "z")` and `cond && "msg"`
 * are fully covered. Operands already inside a `t()`/`tx()` call, non-prose
 * tokens, or letter-free strings are left untouched. Returns true if anything
 * changed.
 *
 * The position gate (UI vs logic-layer) is the caller's responsibility — this
 * helper only rewrites operands once a UI position has been established.
 */
function wrapBranchOperand(
  operand: t.Expression,
  keys: Set<string>,
  used: { t: boolean; tx: boolean },
  result: { changed: boolean },
): t.Expression {
  if (t.isConditionalExpression(operand)) {
    operand.consequent = wrapBranchOperand(
      operand.consequent,
      keys,
      used,
      result,
    );
    operand.alternate = wrapBranchOperand(
      operand.alternate,
      keys,
      used,
      result,
    );
    return operand;
  }
  if (t.isLogicalExpression(operand)) {
    operand.left = wrapBranchOperand(
      operand.left,
      keys,
      used,
      result,
    ) as t.Expression;
    operand.right = wrapBranchOperand(
      operand.right,
      keys,
      used,
      result,
    ) as t.Expression;
    return operand;
  }
  if (t.isStringLiteral(operand)) {
    if (isNonProseValue(operand.value)) return operand;
    const wrapped = wrapExpression(operand, keys, used);
    if (wrapped) {
      result.changed = true;
      return wrapped;
    }
    return operand;
  }
  if (t.isTemplateLiteral(operand)) {
    const wrapped = wrapExpression(operand, keys, used);
    if (wrapped) {
      result.changed = true;
      return wrapped;
    }
    return operand;
  }
  return operand;
}

/**
 * Whether a JSXExpressionContainer is a JSX CHILD (its parent is a JSX element
 * or fragment), as opposed to an attribute value container.
 */
function isJsxChildContainer(path: NodePath): boolean {
  if (!path.isJSXExpressionContainer()) return false;
  const parent = path.parentPath;
  if (!parent) return false;
  return parent.isJSXElement() || parent.isJSXFragment();
}

/**
 * Whether a JSXExpressionContainer is the value of a wrappable JSX attribute
 * (reusing the existing attribute gate). Returns false for denylisted or
 * non-text attribute names.
 */
function isWrappableAttrContainer(path: NodePath): boolean {
  if (!path.isJSXExpressionContainer()) return false;
  const parent = path.parentPath;
  if (!parent || !parent.isJSXAttribute()) return false;
  const attr = parent.node;
  return isWrappableTextAttr(attributeName(attr.name));
}

/**
 * Whether a path is a (direct) argument of a call/new expression the plugin
 * already targets: toast() / toast.* , new Error(), new AgentActionStopError().
 */
function isWrappedCallArgument(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  // Must occupy an `arguments` slot of the parent call / new expression.
  if (path.listKey !== "arguments") return false;
  if (parent.isCallExpression()) {
    return isToastCallee(parent.node.callee);
  }
  if (parent.isNewExpression()) {
    const callee = parent.node.callee;
    return t.isIdentifier(callee) && ERROR_CTORS.has(callee.name);
  }
  return false;
}

/**
 * Decide whether a ConditionalExpression / LogicalExpression node sits in a UI
 * position AND is the OUTERMOST such expression (so we only process the root
 * once; nested operands are handled by recursion in wrapBranchOperand). Returns
 * false when the expression is a logic-layer value (plain assignment, return,
 * non-targeted call arg, etc.).
 *
 * UI positions:
 *   (a) the expression inside a JSXExpressionContainer that is a JSX child,
 *   (b) the value expression of a wrappable JSX attribute,
 *   (c) a direct argument of toast()/new Error()/AgentActionStopError().
 *
 * To find the "root", we skip over enclosing Conditional/Logical operand
 * positions: if the parent chain reaches the container/attr/call through only
 * Conditional / Logical operand links, this node is the root iff its immediate
 * parent is NOT itself a Conditional/Logical (i.e. it is not someone else's
 * operand).
 */
function conditionalIsUiRoot(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  // Not the root if this node is itself an operand of an enclosing
  // conditional / logical expression — the enclosing one is the root.
  if (parent.isConditionalExpression() || parent.isLogicalExpression()) {
    return false;
  }
  // (a) JSX child container, or (b) wrappable JSX attribute value container.
  if (parent.isJSXExpressionContainer()) {
    return isJsxChildContainer(parent) || isWrappableAttrContainer(parent);
  }
  // (c) targeted call / new argument.
  return isWrappedCallArgument(path);
}

/** The JSX attribute name as a plain string (handles namespaced names). */
function attributeName(name: t.JSXIdentifier | t.JSXNamespacedName): string {
  if (t.isJSXNamespacedName(name)) {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return name.name;
}

export function transformModule(
  code: string,
  filename: string,
): TransformOutput | null {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const keys = new Set<string>();
  const used = { t: false, tx: false };
  let mutated = false;

  // Detect any pre-existing import of t / tx from "locale-kit" so we don't add
  // a duplicate import (P1 already imports them in some modules).
  let importsT = false;
  let importsTx = false;

  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.source.value !== "locale-kit") return;
      for (const spec of path.node.specifiers) {
        if (!t.isImportSpecifier(spec)) continue;
        const imported = t.isIdentifier(spec.imported)
          ? spec.imported.name
          : spec.imported.value;
        if (imported === "t") importsT = true;
        if (imported === "tx") importsTx = true;
      }
    },

    JSXText(path) {
      const raw = path.node.value;
      const trimmed = raw.trim();
      if (!trimmed || !hasLetter(trimmed)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;

      keys.add(trimmed);
      used.t = true;
      mutated = true;

      // Preserve leading / trailing whitespace as sibling JSX text so layout
      // and inline spacing are unchanged.
      const leadingMatch = raw.match(/^\s*/);
      const trailingMatch = raw.match(/\s*$/);
      const leading = leadingMatch ? leadingMatch[0] : "";
      const trailing = trailingMatch ? trailingMatch[0] : "";

      const replacement: t.Node[] = [];
      if (leading) replacement.push(t.jsxText(leading));
      replacement.push(t.jsxExpressionContainer(makeTCall(trimmed)));
      if (trailing) replacement.push(t.jsxText(trailing));
      path.replaceWithMultiple(replacement);
    },

    JSXAttribute(path) {
      const name = attributeName(path.node.name);
      // The denylist applies to every value shape; the text-suffix/whitelist
      // gate applies only to string / template values.
      if (isDenylistedAttr(name)) return;
      const value = path.node.value;
      if (!value) return;
      if (pathRequestsIgnore(path)) return;

      const textAttr = isWrappableTextAttr(name);

      // value is `"..."` (StringLiteral) or `{...}` (JSXExpressionContainer).
      if (t.isStringLiteral(value)) {
        if (!textAttr) return;
        if (isInsideTranslationCall(path)) return;
        if (isNonProseValue(value.value)) return;
        const wrapped = wrapExpression(value, keys, used);
        if (!wrapped) return;
        path.node.value = t.jsxExpressionContainer(wrapped);
        mutated = true;
        return;
      }
      if (t.isJSXExpressionContainer(value)) {
        const expr = value.expression;
        if (t.isJSXEmptyExpression(expr)) return;
        // Skip if already a t()/tx() call.
        if (t.isCallExpression(expr) && isTranslationCallee(expr.callee)) {
          return;
        }
        // String arrays: `suggestions={["...", "..."]}`. Wrap each prose-like
        // string element in place. The per-element prose heuristic is the
        // safety net here, so this fires for any non-denylisted attribute name.
        if (t.isArrayExpression(expr)) {
          if (wrapArrayElements(expr, keys, used)) mutated = true;
          return;
        }
        if (!textAttr) return;
        if (t.isStringLiteral(expr)) {
          if (isNonProseValue(expr.value)) return;
          const wrapped = wrapExpression(expr as t.Expression, keys, used);
          if (!wrapped) return;
          value.expression = wrapped;
          mutated = true;
          return;
        }
        if (t.isTemplateLiteral(expr)) {
          const wrapped = wrapExpression(expr as t.Expression, keys, used);
          if (!wrapped) return;
          value.expression = wrapped;
          mutated = true;
        }
      }
    },

    ObjectProperty(path) {
      const node = path.node;
      if (node.computed) return;
      const value = node.value;
      // Resolve a non-computed key name (Identifier or string/numeric literal).
      let keyName: string | null = null;
      if (t.isIdentifier(node.key)) keyName = node.key.name;
      else if (t.isStringLiteral(node.key)) keyName = node.key.value;
      if (keyName === null) return;
      const lowerKey = keyName.toLowerCase();
      // Array-valued UI-text keys (e.g. login marketing `features: [...]`): wrap
      // each prose-like string element in place, reusing the JSX-array heuristic.
      if (t.isArrayExpression(value)) {
        if (!UI_TEXT_ARRAY_OBJECT_KEYS.has(lowerKey)) return;
        if (isInsideTranslationCall(path)) return;
        if (pathRequestsIgnore(path)) return;
        if (wrapArrayElements(value, keys, used)) mutated = true;
        return;
      }
      // StringLiteral values wrap to `t()`; TemplateLiteral values (e.g.
      // interpolated action result messages like `Created draft ${id}`) wrap to
      // `tx()` via the shared template-literal→tx conversion. Any other value
      // shape is ignored.
      if (!t.isStringLiteral(value) && !t.isTemplateLiteral(value)) return;
      // Only UI-text keys are wrapped; non-text keys like `id`, `key`,
      // `className` keep their TemplateLiteral / StringLiteral values untouched.
      if (!UI_TEXT_OBJECT_KEYS.has(lowerKey)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      // The non-prose gate applies only to plain string values; the template
      // path relies on makeTxCall's own letter check (matching the
      // AssignmentPattern / VariableDeclarator rules).
      if (t.isStringLiteral(value) && isNonProseValue(value.value)) return;
      const wrapped = wrapExpression(value as t.Expression, keys, used);
      if (!wrapped) return;
      node.value = wrapped;
      mutated = true;
    },

    AssignmentPattern(path) {
      // Default value in a destructured / parameter default:
      //   function f({ label = "Feedback" }) {}   (ObjectProperty value)
      //   function f(label = "Feedback") {}        (direct param)
      // Gate on the bound IDENTIFIER name being a known UI-text name.
      const node = path.node;
      if (!t.isIdentifier(node.left)) return;
      if (!UI_TEXT_DEFAULT_PARAM_NAMES.has(node.left.name.toLowerCase())) {
        return;
      }
      const right = node.right;
      if (!t.isStringLiteral(right) && !t.isTemplateLiteral(right)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      if (t.isStringLiteral(right) && isNonProseValue(right.value)) return;
      const wrapped = wrapExpression(right as t.Expression, keys, used);
      if (!wrapped) return;
      node.right = wrapped;
      mutated = true;
    },

    VariableDeclarator(path) {
      // Named const / let whose identifier matches a UI-text naming convention:
      //   const DEFAULT_SUBMIT_TEXT = "Send feedback";
      //   const successMessage = `Thanks, ${name}!`;
      const node = path.node;
      if (!t.isIdentifier(node.id)) return;
      if (!UI_TEXT_CONST_NAME.test(node.id.name)) return;
      const init = node.init;
      if (!init) return;
      if (!t.isStringLiteral(init) && !t.isTemplateLiteral(init)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      if (t.isStringLiteral(init) && isNonProseValue(init.value)) return;
      const wrapped = wrapExpression(init as t.Expression, keys, used);
      if (!wrapped) return;
      node.init = wrapped;
      mutated = true;
    },

    CallExpression(path) {
      const callee = path.node.callee;
      // toast() / toast.* OR a curated bare-identifier UI state-setter.
      const isToast = isToastCallee(callee);
      const isSetter = isUiStateSetterCallee(callee);
      if (!isToast && !isSetter) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      const first = path.node.arguments[0];
      if (!first) return;
      if (t.isStringLiteral(first)) {
        // Skip obvious non-prose values (URLs/paths/code-idents/no-letter) so
        // setters never localize identifiers; wrapExpression also re-checks the
        // letter requirement.
        if (isNonProseValue(first.value)) return;
        // Setters additionally require NATURAL-LANGUAGE copy: single-word
        // enum/status values (`setStatus("idle")`, `setStatus("saving")`) are
        // internal state compared elsewhere and must NOT be wrapped. toast() /
        // Error() copy is always prose and keeps the looser gate.
        if (isSetter && !isNaturalLanguage(first.value)) return;
        const wrapped = wrapExpression(first as t.Expression, keys, used);
        if (!wrapped) return;
        path.node.arguments[0] = wrapped;
        mutated = true;
        return;
      }
      if (t.isTemplateLiteral(first)) {
        // Template-literal setter args almost always carry interpolation or
        // prose; keep wrapping them. For setters, still require some
        // non-placeholder text (a letter outside the interpolated spans) so a
        // bare `setStatus(`${s}`)` enum passthrough is not localized.
        if (isSetter && !templateHasProseText(first)) return;
        const wrapped = wrapExpression(first as t.Expression, keys, used);
        if (!wrapped) return;
        path.node.arguments[0] = wrapped;
        mutated = true;
      }
    },

    NewExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !ERROR_CTORS.has(callee.name)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      const first = path.node.arguments[0];
      if (!first) return;
      if (t.isStringLiteral(first) || t.isTemplateLiteral(first)) {
        const wrapped = wrapExpression(first as t.Expression, keys, used);
        if (!wrapped) return;
        path.node.arguments[0] = wrapped;
        mutated = true;
      }
    },

    ConditionalExpression(path) {
      if (!conditionalIsUiRoot(path)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      const result = { changed: false };
      path.node.consequent = wrapBranchOperand(
        path.node.consequent,
        keys,
        used,
        result,
      );
      path.node.alternate = wrapBranchOperand(
        path.node.alternate,
        keys,
        used,
        result,
      );
      if (result.changed) mutated = true;
    },

    LogicalExpression(path) {
      if (!conditionalIsUiRoot(path)) return;
      if (isInsideTranslationCall(path)) return;
      if (pathRequestsIgnore(path)) return;
      const result = { changed: false };
      // For `&&` the right operand is the rendered value; the left is the
      // boolean guard, so only the right is wrapped. For `||` / `??` either
      // side can be the rendered fallback, so both are wrapped.
      if (path.node.operator === "&&") {
        path.node.right = wrapBranchOperand(
          path.node.right,
          keys,
          used,
          result,
        ) as t.Expression;
      } else {
        path.node.left = wrapBranchOperand(
          path.node.left,
          keys,
          used,
          result,
        ) as t.Expression;
        path.node.right = wrapBranchOperand(
          path.node.right,
          keys,
          used,
          result,
        ) as t.Expression;
      }
      if (result.changed) mutated = true;
    },
  });

  if (!mutated) return null;

  // Inject `import { t, tx } from "locale-kit";` for only the helpers used and
  // not already imported.
  const needed: ("t" | "tx")[] = [];
  if (used.t && !importsT) needed.push("t");
  if (used.tx && !importsTx) needed.push("tx");
  if (needed.length > 0) {
    const specifiers = needed.map((name) =>
      t.importSpecifier(t.identifier(name), t.identifier(name)),
    );
    const importDecl = t.importDeclaration(
      specifiers,
      t.stringLiteral("locale-kit"),
    );
    ast.program.body.unshift(importDecl);
  }

  const output = generate(
    ast,
    { retainLines: false, sourceMaps: true, sourceFileName: filename },
    code,
  );

  return { code: output.code, map: output.map, keys: [...keys] };
}

/**
 * True if the callee is a bare identifier in the curated UI state-setter set
 * (`setError`, `setStatus`, `setMessage`, …). Member-expression callees are
 * intentionally not matched — these are React `useState` setters, always called
 * as plain identifiers.
 */
function isUiStateSetterCallee(callee: t.Node): boolean {
  return t.isIdentifier(callee) && UI_STATE_SETTERS.has(callee.name);
}

/** True if the callee is `toast` or `toast.error|success|warning|info`. */
function isToastCallee(callee: t.Node): boolean {
  if (t.isIdentifier(callee, { name: "toast" })) return true;
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: "toast" }) &&
    t.isIdentifier(callee.property) &&
    ["error", "success", "warning", "info"].includes(callee.property.name)
  ) {
    return true;
  }
  return false;
}
