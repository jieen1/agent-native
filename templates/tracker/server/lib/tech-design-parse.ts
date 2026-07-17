/**
 * R4b.1 `extract-briefs` — deterministic tech-design markdown parsing + brief
 * dependency topology. Zero LLM, pure text in / structured out — mirrors
 * `extract-goal-metrics.ts`'s `extractSuccessMetricsSection`/
 * `parseSuccessMetrics` shape (regex-locate a numbered `## §N` section,
 * regex-parse its rows) per docs/sdlc-product-design/
 * r4-workflow-families-planning-skills.md §5.2/§5.3.
 *
 * Tech-design doc convention this module assumes (authored by the
 * `/sprint-design` skill, see its SKILL.md for the producer side):
 *
 *   ## §4 工作项设计
 *   ### §4.1 {itemKey} · {标题}
 *   - **依赖**: itemKeyA, itemKeyB   (or 无)
 *   ...free-form body...
 *
 *   ## §6 API 表
 *   | 方法 | 路径 | 生产方 | 消费方 | 说明 |
 *
 *   ## §7 文件变更矩阵
 *   | 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |
 *
 * Only `##`-level headings delimit top-level §N sections; `###`-level
 * headings delimit §4.N per-item subsections. Section text runs from one
 * `##` heading to the next (or EOF).
 */

const H2_RE = /^##\s+§(\d+)\b.*$/;
const H3_ITEM_RE = /^###\s+§4\.\d+\s+([\w.-]+)\s*[·:]\s*(.+?)\s*$/;
const DEPENDS_RE = /^[-*]\s*\*\*依赖\*\*\s*[:：]\s*(.+)$/;

export interface TechDesignItem {
  itemKey: string;
  title: string;
  /** Raw body text of this §4.N subsection (between its heading and the next). */
  body: string;
  /** Explicit `- **依赖**: X, Y` declarations parsed out of the body. */
  dependsOn: string[];
}

export interface FileMatrixRow {
  path: string;
  operation: string;
  itemKey: string;
  note: string;
  dependsOnFiles: string[];
}

export interface ApiTableRow {
  method: string;
  path: string;
  producer: string;
  consumer: string;
  note: string;
}

export interface DependencyEdge {
  /** The item that must wait. */
  itemKey: string;
  /** The item it waits on. */
  dependsOn: string;
  /** Where this edge came from — for debugging/inspection, not load-bearing. */
  source: "declared" | "api-table" | "file-matrix";
}

/** Extract the raw text of a `## §N ...` section (up to the next `##` heading
 *  or EOF). Returns null if the heading isn't present. */
export function extractSection(
  content: string,
  sectionNumber: number,
): string | null {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = H2_RE.exec(lines[i]!.trim());
    if (m && Number(m[1]) === sectionNumber) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (H2_RE.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Parse every `### §4.N {itemKey} · {title}` subsection out of §4's text. */
export function parseTechDesignItems(content: string): TechDesignItem[] {
  const section = extractSection(content, 4);
  if (section === null) return [];

  const lines = section.split("\n");
  const boundaries: Array<{ idx: number; itemKey: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = H3_ITEM_RE.exec(lines[i]!.trim());
    if (m) boundaries.push({ idx: i, itemKey: m[1]!, title: m[2]! });
  }

  const items: TechDesignItem[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i]!;
    const next = boundaries[i + 1];
    const bodyLines = lines.slice(cur.idx + 1, next ? next.idx : lines.length);
    const body = bodyLines.join("\n").trim();

    const dependsOn: string[] = [];
    for (const raw of bodyLines) {
      const dm = DEPENDS_RE.exec(raw.trim());
      if (!dm) continue;
      const listText = dm[1]!.trim();
      if (/^(无|none|n\/a)$/i.test(listText)) continue;
      for (const tok of listText.split(/[,，、]/)) {
        const key = tok.trim();
        if (key) dependsOn.push(key);
      }
    }

    items.push({ itemKey: cur.itemKey, title: cur.title, body, dependsOn });
  }
  return items;
}

/** Parse a markdown pipe-table's data rows (skips header + separator rows). */
function parseTableRows(tableText: string): string[][] {
  const rows: string[][] = [];
  for (const raw of tableText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row (--- | --- | ...)
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    rows.push(cells);
  }
  // First captured row is the header — drop it.
  return rows.slice(1);
}

/** Parse §7's file-change matrix (5 columns: 文件路径/操作/所属工作项/说明/依赖文件). */
export function parseFileMatrix(content: string): FileMatrixRow[] {
  const section = extractSection(content, 7);
  if (section === null) return [];
  const rows = parseTableRows(section);
  return rows
    .filter((r) => r.length >= 3)
    .map((r) => ({
      path: (r[0] ?? "").replace(/`/g, "").trim(),
      operation: (r[1] ?? "").toUpperCase(),
      itemKey: r[2] ?? "",
      note: r[3] ?? "",
      dependsOnFiles: (r[4] ?? "")
        .split(/[,，、]/)
        .map((s) => s.replace(/`/g, "").trim())
        .filter(Boolean),
    }))
    .filter((r) => r.path !== "");
}

/** Parse §6's API table (5 columns: 方法/路径/生产方/消费方/说明). */
export function parseApiTable(content: string): ApiTableRow[] {
  const section = extractSection(content, 6);
  if (section === null) return [];
  const rows = parseTableRows(section);
  return rows
    .filter((r) => r.length >= 4)
    .map((r) => ({
      method: r[0] ?? "",
      path: r[1] ?? "",
      producer: r[2] ?? "",
      consumer: r[3] ?? "",
      note: r[4] ?? "",
    }))
    .filter((r) => r.path !== "");
}

/**
 * Build the deduplicated dependency edge list among a tech-design's §4 items:
 * declared `- **依赖**` lines, §6 API table producer→consumer pairs, and §7
 * file-matrix 依赖文件 references resolved back to their owning item.
 */
export function buildDependencyGraph(
  items: TechDesignItem[],
  apiRows: ApiTableRow[],
  fileRows: FileMatrixRow[],
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (
    itemKey: string,
    dependsOn: string,
    source: DependencyEdge["source"],
  ) => {
    if (!itemKey || !dependsOn || itemKey === dependsOn) return;
    const key = `${itemKey} ${dependsOn}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ itemKey, dependsOn, source });
  };

  for (const item of items) {
    for (const dep of item.dependsOn) addEdge(item.itemKey, dep, "declared");
  }

  for (const row of apiRows) {
    if (row.producer && row.consumer)
      addEdge(row.consumer, row.producer, "api-table");
  }

  const fileOwner = new Map<string, string>();
  for (const row of fileRows) {
    if (row.path && row.itemKey) fileOwner.set(row.path, row.itemKey);
  }
  for (const row of fileRows) {
    if (!row.itemKey) continue;
    for (const depFile of row.dependsOnFiles) {
      const ownerOfDep = fileOwner.get(depFile);
      if (ownerOfDep) addEdge(row.itemKey, ownerOfDep, "file-matrix");
    }
  }

  return edges;
}

export interface WaveResult {
  /** Wave N = edges[N] all resolved by an earlier wave — items ready to run in parallel. */
  waves: string[][];
  /** Non-empty only when a cycle prevented full layering — lists the unresolved edges. */
  cycleEdges: DependencyEdge[];
  /** itemKeys referenced by an edge (either side) that have no §4 section of their own. */
  missingItems: string[];
}

/**
 * Topologically layer a set of known itemKeys into dispatch Waves using the
 * dependency edges (Kahn's algorithm, layer-at-a-time so independent items
 * share a Wave). Edges pointing at an itemKey outside `knownItemKeys` are
 * reported as `missingItems` and excluded from the in-degree count (a
 * referenced-but-undocumented item can't gate a real item's wave forever).
 */
export function computeWaves(
  knownItemKeys: string[],
  edges: DependencyEdge[],
): WaveResult {
  const known = new Set(knownItemKeys);
  const missing = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.itemKey)) missing.add(e.itemKey);
    if (!known.has(e.dependsOn)) missing.add(e.dependsOn);
  }

  // Only edges between two known items participate in layering.
  const relevantEdges = edges.filter(
    (e) => known.has(e.itemKey) && known.has(e.dependsOn),
  );
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const key of knownItemKeys) inDegree.set(key, 0);
  for (const e of relevantEdges) {
    inDegree.set(e.itemKey, (inDegree.get(e.itemKey) ?? 0) + 1);
    if (!dependents.has(e.dependsOn)) dependents.set(e.dependsOn, []);
    dependents.get(e.dependsOn)!.push(e.itemKey);
  }

  const waves: string[][] = [];
  const resolved = new Set<string>();
  let remaining = new Set(knownItemKeys);

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((k) => (inDegree.get(k) ?? 0) === 0)
      .sort();
    if (ready.length === 0) break; // cycle among what's left

    waves.push(ready);
    for (const k of ready) {
      resolved.add(k);
      remaining.delete(k);
      for (const dep of dependents.get(k) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      }
    }
  }

  const cycleEdges =
    remaining.size > 0
      ? relevantEdges.filter(
          (e) => remaining.has(e.itemKey) || remaining.has(e.dependsOn),
        )
      : [];

  return { waves, cycleEdges, missingItems: [...missing].sort() };
}
