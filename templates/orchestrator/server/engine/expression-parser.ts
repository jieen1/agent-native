// Expression parser: tokenizer + recursive-descent evaluator for guard/until conditions.

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExpressionContext {
  inputs: Record<string, unknown>;
  deps: Record<string, {
    output?: unknown;
    previous_iteration?: { output?: unknown };
    history?: Array<Record<string, { output?: unknown }>>;
  }>;
  item?: unknown;
  iteration?: number;
}

// ── Token types ─────────────────────────────────────────────────────────────

const TK = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  IDENT: "IDENT",
  BOOL: "BOOL",
  NULL: "NULL",
  OP: "OP",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  LBRACKET: "LBRACKET",
  RBRACKET: "RBRACKET",
  COMMA: "COMMA",
  EOF: "EOF",
} as const;

type TK = (typeof TK)[keyof typeof TK];

interface Tok {
  type: TK;
  value?: string | number | boolean;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const c = input.charCodeAt(i);

    // skip whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }

    // strings
    if (c === 34 || c === 39) {
      const quote = input[i];
      let j = i + 1;
      while (j < len && input[j] !== quote) {
        if (input[j] === "\\") j++;
        j++;
      }
      out.push({ type: TK.STRING, value: input.slice(i + 1, j).replace(/\\(.)/g, "$1") });
      i = j + 1;
      continue;
    }

    // dot — could be start of float like .5 or path separator
    if (c === 46) {
      if (i + 1 < len && input.charCodeAt(i + 1) >= 48 && input.charCodeAt(i + 1) <= 57) {
        // check if this looks like a float start (no preceding identifier char)
        if (i === 0 || !isIdentOrDot(input.charCodeAt(i - 1))) {
          let j = i + 1;
          while (j < len && input.charCodeAt(j) >= 48 && input.charCodeAt(j) <= 57) j++;
          out.push({ type: TK.NUMBER, value: Number(input.slice(i, j)) });
          i = j;
          continue;
        }
      }
      out.push({ type: TK.COMMA }); // placeholder; replaced below
      out[out.length - 1] = { type: TK.COMMA as TK };
      out[out.length - 1] = { type: TK.LBRACKET as TK };
      out[out.length - 1] = { type: TK.LPAREN as TK };
      out[out.length - 1] = { type: TK.RPAREN as TK };
      out[out.length - 1] = { type: TK.RBRACKET as TK };
      // none match, it's actually a dot path separator — we handle it below
      // by NOT consuming it here and letting the ident parser include it
      out.pop();
      // skip dot; the ident handler below will merge it
      i++;
      continue;
    }

    // numbers
    if (c >= 48 && c <= 57) {
      let j = i;
      while (j < len && input.charCodeAt(j) >= 48 && input.charCodeAt(j) <= 57) j++;
      // handle decimal
      if (j < len && input.charCodeAt(j) === 46) {
        // peek further to see if this is .5 (float) or .foo (path)
        if (j + 1 < len && input.charCodeAt(j + 1) >= 48 && input.charCodeAt(j + 1) <= 57) {
          j++;
          while (j < len && input.charCodeAt(j) >= 48 && input.charCodeAt(j) <= 57) j++;
        }
      }
      out.push({ type: TK.NUMBER, value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }

    // two-char operators
    if (i + 1 < len) {
      const two = input[i] + input[i + 1];
      if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
        out.push({ type: TK.OP, value: two });
        i += 2;
        continue;
      }
    }

    // single-char symbols
    if (c === 60) { out.push({ type: TK.OP, value: "<" }); i++; continue; }
    if (c === 62) { out.push({ type: TK.OP, value: ">" }); i++; continue; }
    if (c === 33) { out.push({ type: TK.OP, value: "!" }); i++; continue; }
    if (c === 40) { out.push({ type: TK.LPAREN }); i++; continue; }
    if (c === 41) { out.push({ type: TK.RPAREN }); i++; continue; }
    if (c === 91) { out.push({ type: TK.LBRACKET }); i++; continue; }
    if (c === 93) { out.push({ type: TK.RBRACKET }); i++; continue; }
    if (c === 44) { out.push({ type: TK.COMMA }); i++; continue; }
    if (c === 45) { out.push({ type: TK.OP, value: "-" }); i++; continue; }

    // identifiers and keywords (including dot-separated paths as one token)
    if (isIdentStart(c)) {
      let j = i;
      while (j < len) {
        const cc = input.charCodeAt(j);
        if (isIdentOrDot(cc)) { j++; continue; }
        break;
      }
      const word = input.slice(i, j);
      if (word === "true") { out.push({ type: TK.BOOL, value: true }); }
      else if (word === "false") { out.push({ type: TK.BOOL, value: false }); }
      else if (word === "null") { out.push({ type: TK.NULL }); }
      else { out.push({ type: TK.IDENT, value: word }); }
      i = j;
      continue;
    }

    throw new Error(`Unexpected character '${input[i]}' at position ${i}`);
  }

  out.push({ type: TK.EOF });
  return out;
}

function isIdentStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
}

function isIdentOrDot(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57) || code === 46;
}

// ── Parser / Evaluator ──────────────────────────────────────────────────────

interface P {
  toks: Tok[];
  pos: number;
  ctx: ExpressionContext;
}

function peek(p: P): Tok { return p.toks[p.pos]; }

function advance(p: P): Tok { return p.toks[p.pos++]; }

function expect(p: P, type: TK, value?: string | number): Tok {
  const t = advance(p);
  if (t.type !== type || (value !== undefined && t.value !== value)) {
    throw new Error(`Expected ${type}${value !== undefined ? "(" + value + ")" : ""}, got ${t.type}`);
  }
  return t;
}

// Precedence:  ||  <  &&  <  comparison  <  unary  <  primary

function expr(p: P): unknown { return orE(p); }

function orE(p: P): unknown {
  let left = andE(p);
  while (peek(p).type === TK.OP && peek(p).value === "||") {
    advance(p);
    const lv = toBool(left);
    const rv = toBool(andE(p));
    left = lv || rv;
  }
  return left;
}

function andE(p: P): unknown {
  let left = cmpE(p);
  while (peek(p).type === TK.OP && peek(p).value === "&&") {
    advance(p);
    const lv = toBool(left);
    const rv = toBool(cmpE(p));
    left = lv && rv;
  }
  return left;
}

function cmpE(p: P): unknown {
  let left = unaryE(p);
  const top = peek(p);
  if (top.type !== TK.OP || !isCmpOp(String(top.value))) return left;
  while (true) {
    const op = String(advance(p).value);
    const right = unaryE(p);
    left = doCmp(op, left, right);
    if (peek(p).type !== TK.OP || !isCmpOp(String(peek(p).value))) break;
  }
  return left;
}

const CMP_OPS = new Set(["==", "!=", ">", ">=", "<", "<="]);
function isCmpOp(v: string): boolean { return CMP_OPS.has(v); }

function doCmp(op: string, l: unknown, r: unknown): boolean {
  const ln = toNum(l);
  const rn = toNum(r);
  const ls = String(l ?? "");
  const rs = String(r ?? "");
  switch (op) {
    case "==": return ln === rn || ls === rs;
    case "!=": return ln !== rn && ls !== rs;
    case ">": return Number.isNaN(ln) ? ls > rs : ln > rn;
    case ">=": return Number.isNaN(ln) ? ls >= rs : ln >= rn;
    case "<": return Number.isNaN(ln) ? ls < rs : ln < rn;
    case "<=": return Number.isNaN(ln) ? ls <= rs : ln <= rn;
    default: throw new Error(`Unknown operator '${op}'`);
  }
}

function unaryE(p: P): unknown {
  const top = peek(p);
  if (top.type === TK.OP && top.value === "!") { advance(p); return !unaryE(p); }
  if (top.type === TK.OP && top.value === "-") {
    advance(p);
    const v = unaryE(p);
    if (typeof v !== "number") throw new Error("Unary minus requires a numeric operand");
    return -v;
  }
  return prim(p);
}

function prim(p: P): unknown {
  const t = peek(p);
  if (t.type === TK.STRING) { advance(p); return t.value; }
  if (t.type === TK.NUMBER) { advance(p); return t.value; }
  if (t.type === TK.BOOL) { advance(p); return t.value; }
  if (t.type === TK.NULL) { advance(p); return null; }
  if (t.type === TK.LPAREN) {
    advance(p);
    const v = expr(p);
    expect(p, TK.RPAREN);
    return v;
  }
  if (t.type === TK.IDENT) {
    // check for function call
    const nxt = p.toks[p.pos + 1];
    if (nxt && nxt.type === TK.LPAREN) return callFn(p);
    return resolvePath(p);
  }
  const desc = t.type === TK.EOF ? "EOF" : `"${t.type}"`;
  throw new Error(`Unexpected token: ${desc}`);
}

// ── Path resolution ─────────────────────────────────────────────────────────

function resolvePath(p: P): unknown {
  const t = advance(p);
  const raw = String(t.value ?? "");
  const segments = raw.split(".");
  // consume bracket subscripts: [0], ["key"], and trailing dot-identifiers
  // e.g. deps.history[0].review.output — after [0], ".review.output" is a
  // second IDENT token (because dots are absorbed into identifiers by tokenizer)
  while (peek(p).type === TK.LBRACKET || peek(p).type === TK.IDENT) {
    if (peek(p).type === TK.LBRACKET) {
      advance(p);
      const idx = peek(p);
      advance(p);
      segments.push(idx.type === TK.NUMBER ? String(idx.value ?? "") : String(idx.value ?? ""));
      expect(p, TK.RBRACKET);
    } else {
      // e.g. ".review.output" after [0] — advance the IDENT, split on dots
      const dotId = advance(p);
      const extra = String(dotId.value ?? "").split(".");
      segments.push(...extra);
    }
  }
  return walk(p.ctx, segments);
}

function walk(ctx: ExpressionContext, parts: string[]): unknown {
  let cur: unknown = undefined;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (i === 0) {
      if (key === "inputs") cur = ctx.inputs;
      else if (key === "deps") cur = ctx.deps;
      else if (key === "item") cur = ctx.item;
      else if (key === "iteration") cur = ctx.iteration;
      else cur = undefined;
    } else {
      if (cur === undefined || cur === null) return undefined;
      cur = (cur as any)[key];
    }
  }
  return cur;
}

// ── Built-in functions ──────────────────────────────────────────────────────

function callFn(p: P): unknown {
  const name = String(advance(p).value ?? "");
  expect(p, TK.LPAREN);
  const args: unknown[] = [];
  if (peek(p).type !== TK.RPAREN) {
    do { args.push(expr(p)); } while (peek(p).type === TK.COMMA && (advance(p), true));
  }
  expect(p, TK.RPAREN);
  return builtin(name, args);
}

function builtin(name: string, args: unknown[]): unknown {
  switch (name) {
    case "len": {
      const x = args[0];
      return Array.isArray(x) ? x.length : String(x ?? "").length;
    }
    case "contains": return String(args[0] ?? "").includes(String(args[1] ?? ""));
    case "startsWith": return String(args[0] ?? "").startsWith(String(args[1] ?? ""));
    case "endsWith": return String(args[0] ?? "").endsWith(String(args[1] ?? ""));
    case "exists": return args[0] !== undefined && args[0] !== null;
    case "coalesce": {
      for (const a of args) {
        if (a !== null && a !== undefined) return a;
      }
      return undefined;
    }
    default: throw new Error(`Unknown function '${name}'`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toNum(x: unknown): number {
  if (typeof x === "number") return x;
  return Number(String(x));
}

function toBool(x: unknown): boolean {
  if (typeof x === "boolean") return x;
  if (typeof x === "number") return x !== 0;
  if (typeof x === "string") return x !== "";
  return x != null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  const toks = tokenize(expression);
  const parser: P = { toks, pos: 0, ctx: context };
  const result = expr(parser);
  if (peek(parser).type !== TK.EOF) {
    throw new Error(`Unexpected token after expression at position ${parser.pos}`);
  }
  return result;
}

export function validateExpressionSyntax(expression: string): { ok: boolean; error?: string } {
  try {
    const toks = tokenize(expression);
    const parser: P = { toks, pos: 0, ctx: { inputs: {}, deps: {} } };
    expr(parser);
    if (peek(parser).type !== TK.EOF) {
      return { ok: false, error: "Unexpected token after expression" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
