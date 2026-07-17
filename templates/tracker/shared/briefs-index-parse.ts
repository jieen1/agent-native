/**
 * Deterministic markdown parser for the `briefs-index` sprint artifact —
 * mirrors exactly the bullet structure `actions/extract-briefs.ts` writes
 * (see its `indexParts` assembly), so the Studio page's Briefs step (⑦) can
 * render structured stats from the PERSISTED artifact (via
 * list-sprint-artifacts/get-sprint-artifact) without re-running extract-
 * briefs on every view — extract-briefs itself is only called for the
 * explicit "重新提取"/"强制提取" buttons.
 */

function extractH2Section(content: string, title: string): string | null {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]!.trim());
    if (m && m[1]!.trim() === title) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function bullets(section: string | null): string[] {
  if (section === null) return [];
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s*/, ""));
}

export interface ParsedBriefsIndex {
  briefCount: number | null;
  designSignoffApproved: boolean | null;
  forced: boolean;
  waves: string[][];
  dependencies: string[];
  missingItems: string[];
  scaleWarnings: string[];
}

export function parseBriefsIndex(content: string): ParsedBriefsIndex {
  const summaryLine = content
    .split("\n")
    .find((l) => /^-\s*共\s*\d+\s*个 brief/.test(l.trim()));
  const briefCountMatch = summaryLine
    ? /共\s*(\d+)\s*个 brief/.exec(summaryLine)
    : null;

  const signoffLine = content
    .split("\n")
    .find((l) => /^-\s*design-signoff:/.test(l.trim()));
  let designSignoffApproved: boolean | null = null;
  if (signoffLine) {
    if (signoffLine.includes("已批准")) designSignoffApproved = true;
    else if (signoffLine.includes("未批准")) designSignoffApproved = false;
  }
  const forced = content.includes("已 force=true 强制提取");

  const waveLines = bullets(extractH2Section(content, "Wave 顺序"));
  const waves = waveLines
    .filter((l) => /^Wave\s*\d+:/.test(l))
    .map((l) =>
      l
        .replace(/^Wave\s*\d+:\s*/, "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    );

  const dependencies = bullets(extractH2Section(content, "依赖"));
  const missingItems = bullets(
    extractH2Section(content, "缺失项（被引用但无 §4 小节）"),
  );
  const scaleWarnings = bullets(extractH2Section(content, "规模告警"));

  return {
    briefCount: briefCountMatch ? Number(briefCountMatch[1]) : null,
    designSignoffApproved,
    forced,
    waves,
    dependencies: dependencies.filter((d) => d !== "无"),
    missingItems: missingItems.filter((d) => d !== "无"),
    scaleWarnings: scaleWarnings.filter((d) => d !== "无"),
  };
}
