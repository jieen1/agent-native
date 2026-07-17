import { useMemo } from "react";

/**
 * Lightweight prose renderer for the docKeys that don't get a bespoke
 * interactive view (sprint-doc, ui-spec, tech-design, brainstorm-notes,
 * story, audit-report, verify-report). The `## 质量门自评` tail section is
 * stripped — it's rendered separately by the quality-gate bar, not here.
 * Deliberately not a full markdown engine: headings/bullets/tables get
 * simple structural treatment, everything else is a paragraph.
 */
export function GenericArtifactContent({ content }: { content: string }) {
  const body = useMemo(() => stripSelfAssessment(content), [content]);
  const blocks = useMemo(() => toBlocks(body), [body]);

  if (!body.trim()) {
    return (
      <p className="text-sm italic text-muted-foreground">（产物内容为空）</p>
    );
  }

  return (
    <div className="flex max-w-none flex-col gap-2 text-[13px] leading-relaxed">
      {blocks.map((block, i) => {
        if (block.type === "h2") {
          return (
            <h2 key={i} className="mt-3 text-[14px] font-semibold first:mt-0">
              {block.text}
            </h2>
          );
        }
        if (block.type === "h3") {
          return (
            <h3 key={i} className="mt-2 text-[13px] font-semibold">
              {block.text}
            </h3>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={i} className="ml-4 list-disc space-y-1">
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "table") {
          return (
            <div
              key={i}
              className="overflow-x-auto rounded-md border border-border"
            >
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {block.header.map((h, j) => (
                      <th
                        key={j}
                        className="border-b border-border bg-muted/40 px-2 py-1.5 text-left font-semibold"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td
                          key={k}
                          className="border-b border-border px-2 py-1.5"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap text-foreground">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function stripSelfAssessment(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^##\s+质量门自评\s*$/.test(l.trim()));
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

type Block =
  | { type: "h2" | "h3" | "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] };

function toBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      blocks.push({ type: "h2", text: line.replace(/^##\s+/, "") });
      i++;
      continue;
    }
    if (/^###\s+/.test(line)) {
      blocks.push({ type: "h3", text: line.replace(/^###\s+/, "") });
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      blocks.push({ type: "h2", text: line.replace(/^#\s+/, "") });
      i++;
      continue;
    }
    if (
      /^\|.*\|$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s-:|]+\|$/.test(lines[i + 1]!.trim())
    ) {
      const header = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) {
        rows.push(
          lines[i]!.trim()
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim()),
        );
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|[-*]\s|\|.*\|$)/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }
    blocks.push({ type: "p", text: paraLines.join(" ") });
  }
  return blocks;
}
