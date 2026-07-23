import { defineAction } from "@agent-native/core";
import { isLocalWorkspaceResourcesEnabled } from "@agent-native/core/local-artifacts";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { BRAIN_PROMPT } from "../server/brain/brain-session.js";
import { getDb, schema } from "../server/db/index.js";
import { BRAIN_RUNBOOK_PATH, readSkillFile } from "./_skills-util.js";

// Get one skill's current editable content — the hosted SQL override when
// one exists for `path`, else the file (or, for the brain runbook, the
// BRAIN_PROMPT constant) default. Only the markdown BODY is editable/
// returned as `content`; each skill's YAML frontmatter fence is preserved
// verbatim and re-attached by save-skill's Local File Mode write path.
export default defineAction({
  description:
    'Get one skill doc\'s current editable content by `path` ("skills/<name>/SKILL.md", or "brain-runbook" for the orchestrator brain\'s own runbook). Returns hosted override content when one exists, else the file/constant default.',
  schema: z.object({
    path: z.string().min(1),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getDb();
    const overrideRows = await db
      .select()
      .from(schema.skillOverrides)
      .where(eq(schema.skillOverrides.path, args.path))
      .limit(1);
    const override = overrideRows[0];
    // P4 finding #5 (Codex review 2026-07-23): "brain-runbook" is the ONLY
    // path whose content is actually read back at runtime
    // (resolveBrainRunbookPrompt, brain-prompt.ts). Every other skill under
    // `.agents/skills/` is dev-time guidance read from disk by a CODING
    // agent working on this app's own source (this project's own CLAUDE.md
    // convention) — the production brain never loads them, so a hosted-mode
    // SQL override for a non-runbook path has no runtime consumer at all;
    // only this editor's own round-trip reads it back. Surfaced to the UI
    // so it can say so instead of implying every save takes effect.
    const runtimeConsumed = args.path === BRAIN_RUNBOOK_PATH;
    const localFileMode = await isLocalWorkspaceResourcesEnabled();

    if (args.path === BRAIN_RUNBOOK_PATH) {
      return {
        path: args.path,
        name: "brain-runbook",
        title: "Orchestrator Brain Runbook",
        description:
          "The brain's own system prompt — appended via --append-system-prompt on every turn.",
        category: null as string | null,
        content: override?.content ?? BRAIN_PROMPT,
        fileContent: BRAIN_PROMPT,
        hasOverride: Boolean(override),
        updatedAt: override?.updatedAt ?? null,
        updatedBy: override?.updatedBy ?? null,
        runtimeConsumed,
        localFileMode,
      };
    }

    const file = readSkillFile(args.path);
    if (!file) throw new Error(`Skill "${args.path}" not found`);

    return {
      path: file.path,
      name: file.name,
      title: file.title,
      description: file.description,
      category: file.category,
      content: override?.content ?? file.body,
      fileContent: file.body,
      hasOverride: Boolean(override),
      updatedAt: override?.updatedAt ?? file.updatedAt,
      updatedBy: override?.updatedBy ?? null,
      runtimeConsumed,
      localFileMode,
    };
  },
});
