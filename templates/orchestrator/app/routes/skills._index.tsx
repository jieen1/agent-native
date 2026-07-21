import { useActionQuery } from "@agent-native/core/client";
import { IconBook } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { SkillEditorPane } from "@/components/skills/SkillEditorPane";
import { SkillsNav, type SkillListEntry } from "@/components/skills/SkillsNav";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 技能` }];
}

export default function SkillsRoute() {
  const {
    data: entries = [],
    isLoading,
    error,
    refetch,
  } = useActionQuery("list-skills" as any, {}, undefined) as {
    data?: SkillListEntry[];
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Default to the pinned brain runbook (or the first skill) once the list
  // loads, but never override an explicit user selection.
  useEffect(() => {
    if (selectedPath !== null || entries.length === 0) return;
    setSelectedPath(entries[0]!.path);
  }, [entries, selectedPath]);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-4 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          技能
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          智能体在行动前读取的运行手册与技能文档。托管覆盖内容优先于仓库中的文件。
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          加载技能列表失败。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
          <SkillsNav
            entries={entries}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            isLoading={isLoading}
          />
          {selectedPath ? (
            <SkillEditorPane
              key={selectedPath}
              path={selectedPath}
              onMutated={refetch}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
              <IconBook className="size-6" />
              {isLoading ? "加载中…" : "从左侧选择一个技能。"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
