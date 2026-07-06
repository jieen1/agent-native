import { defineAction } from "@agent-native/core";
import {
  isLocalWorkspaceResourcesEnabled,
  writeLocalWorkspaceResource,
} from "@agent-native/core/local-artifacts";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import {
  BRAIN_RUNBOOK_PATH,
  rebuildSkillFileContent,
  readSkillFile,
} from "./_skills-util.js";

// Save one skill doc's editable content by `path`. Mode detection reuses the
// framework's own local-file-mode gate (@agent-native/core/local-artifacts —
// the same helper the framework already uses for AGENTS.md/skills editing)
// rather than inventing a new one:
//   - Local File Mode ON  -> write the real .agents/skills/<name>/SKILL.md
//     file directly (frontmatter preserved verbatim, only the body changes);
//     the file stays the source of truth, so any stale hosted override for
//     this path is dropped.
//   - Local File Mode OFF (the default hosted/collaborative mode — see the
//     storing-data skill), OR the "brain-runbook" pseudo-path (BRAIN_PROMPT
//     is a .ts source constant, not a file this feature rewrites) -> upsert
//     a row in the additive orchestrator_skill_overrides table instead.
export default defineAction({
  description:
    'Save one skill doc\'s editable content by `path` ("skills/<name>/SKILL.md", or "brain-runbook" for the orchestrator brain\'s own runbook). Writes the real file in Local File Mode; otherwise upserts a hosted SQL override that shadows the file/constant default.',
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const db = getDb();
    const now = nowIso();
    const updatedBy = getRequestUserEmail() ?? null;

    if (args.path !== BRAIN_RUNBOOK_PATH) {
      const file = readSkillFile(args.path);
      if (!file) throw new Error(`Skill "${args.path}" not found`);

      const localFileMode = await isLocalWorkspaceResourcesEnabled();
      if (localFileMode) {
        const fullContent = rebuildSkillFileContent(
          file.frontmatterRaw,
          args.content,
        );
        await writeLocalWorkspaceResource({
          path: args.path,
          content: fullContent,
        });
        // The file is source of truth again — drop any stale override left
        // over from a previous hosted-mode save.
        await db
          .delete(schema.skillOverrides)
          .where(eq(schema.skillOverrides.path, args.path));
        return { path: args.path, mode: "file" as const, ok: true };
      }
    }

    const existing = await db
      .select({ id: schema.skillOverrides.id })
      .from(schema.skillOverrides)
      .where(eq(schema.skillOverrides.path, args.path))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.skillOverrides)
        .set({ content: args.content, updatedAt: now, updatedBy })
        .where(eq(schema.skillOverrides.id, existing[0]!.id));
    } else {
      await db.insert(schema.skillOverrides).values({
        id: newId("sko"),
        path: args.path,
        content: args.content,
        updatedAt: now,
        updatedBy,
      });
    }

    return { path: args.path, mode: "override" as const, ok: true };
  },
});
