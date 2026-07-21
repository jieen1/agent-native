import { IconBrain, IconFileText, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SkillListEntry {
  path: string;
  name: string;
  title: string;
  description: string;
  category: string | null;
  pinned: boolean;
  hasOverride: boolean;
  updatedAt: string | null;
}

export interface SkillsNavProps {
  entries: SkillListEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  isLoading?: boolean;
}

function matchesQuery(entry: SkillListEntry, query: string): boolean {
  if (!query) return true;
  const haystack =
    `${entry.title} ${entry.name} ${entry.description}`.toLowerCase();
  return haystack.includes(query);
}

function SkillNavItem({
  entry,
  isActive,
  onSelect,
}: {
  entry: SkillListEntry;
  isActive: boolean;
  onSelect: (path: string) => void;
}) {
  const Icon = entry.pinned ? IconBrain : IconFileText;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.path)}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
        entry.pinned && !isActive && "border bg-accent/40",
        isActive
          ? "bg-accent font-medium text-accent-foreground"
          : "hover:bg-accent/60",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      {entry.hasOverride ? (
        <span
          aria-label="有托管覆盖内容"
          title="有托管覆盖内容"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
    </button>
  );
}

/** Left sidebar of the Skills / Runbook editor: a search box, the pinned
 * brain-runbook section, then the rest of the skills grouped by category. */
export function SkillsNav({
  entries,
  selectedPath,
  onSelect,
  isLoading,
}: SkillsNavProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const { pinned, groups } = useMemo(() => {
    const filtered = entries.filter((entry) =>
      matchesQuery(entry, normalizedQuery),
    );
    const pinnedEntries = filtered.filter((entry) => entry.pinned);
    const rest = filtered.filter((entry) => !entry.pinned);
    const byCategory = new Map<string, SkillListEntry[]>();
    for (const entry of rest) {
      const category = entry.category || "General";
      const bucket = byCategory.get(category);
      if (bucket) bucket.push(entry);
      else byCategory.set(category, [entry]);
    }
    const sortedGroups = Array.from(byCategory.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return { pinned: pinnedEntries, groups: sortedGroups };
  }, [entries, normalizedQuery]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2.5">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能…"
            aria-label="搜索技能"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="h-8 animate-pulse rounded-md bg-muted"
              />
            ))}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="mb-2.5 border-b pb-2.5">
                <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                  大脑运行手册
                </div>
                <div className="space-y-0.5">
                  {pinned.map((entry) => (
                    <SkillNavItem
                      key={entry.path}
                      entry={entry}
                      isActive={entry.path === selectedPath}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            )}

            {groups.map(([category, items]) => (
              <div key={category} className="mb-1">
                <div className="px-2 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground first:pt-0.5">
                  {category}
                </div>
                <div className="space-y-0.5">
                  {items.map((entry) => (
                    <SkillNavItem
                      key={entry.path}
                      entry={entry}
                      isActive={entry.path === selectedPath}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            ))}

            {pinned.length === 0 && groups.length === 0 && (
              <div className="rounded-lg border p-4 text-center text-xs text-muted-foreground">
                未找到匹配的技能。
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
