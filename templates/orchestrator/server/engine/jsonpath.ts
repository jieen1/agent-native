// A tiny, safe JSONPath-ish reader (DESIGN §3.5 — never `eval`). Supports a
// dotted path with optional array indices, rooted at a provided context object.
// Used by branch `when` conditions and loop-until-dry `dedupeKey`.
//
// Examples:
//   "deps.review.output.score"   → ctx.deps.review.output.score
//   "items[0].id"                → ctx.items[0].id
//   "$.id" or "id"               → ctx.id  ($ is an optional root marker)

/** Read a dotted/indexed path from a value. Returns undefined if any hop misses. */
export function readPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const tokens = tokenize(path);
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur == null) return undefined;
    if (typeof tok === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tok];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur;
}

/** Split a path into property names (string) and array indices (number). */
function tokenize(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  // Strip a leading "$." or "$" root marker.
  let p = path.trim();
  if (p.startsWith("$.")) p = p.slice(2);
  else if (p === "$") return out;
  for (const seg of p.split(".")) {
    if (seg === "") continue;
    // Split "items[0][1]" into "items", 0, 1.
    const m = seg.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!m) {
      out.push(seg);
      continue;
    }
    if (m[1]) out.push(m[1]);
    const idxPart = m[2];
    if (idxPart) {
      const idxMatches = idxPart.match(/\[(\d+)\]/g) ?? [];
      for (const im of idxMatches) {
        out.push(Number(im.slice(1, -1)));
      }
    }
  }
  return out;
}
