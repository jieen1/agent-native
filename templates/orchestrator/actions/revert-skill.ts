import { defineAction } from "@agent-native/core";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { BRAIN_PROMPT } from "../server/brain/brain-session.js";
import { getDb, schema } from "../server/db/index.js";
import { BRAIN_RUNBOOK_PATH, readSkillFile } from "./_skills-util.js";

// Revert a skill doc to its file/constant default by deleting its hosted SQL
// override (idempotent no-op if there was none — e.g. Local File Mode, where
// saves write the real file directly and never create an override row).
export default defineAction({
  description:
    "Revert a skill doc to its file/constant default by deleting its hosted SQL override, if any. Returns the resulting default content.",
  schema: z.object({
    path: z.string().min(1),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const db = getDb();
    await db
      .delete(schema.skillOverrides)
      .where(eq(schema.skillOverrides.path, args.path));

    if (args.path === BRAIN_RUNBOOK_PATH) {
      return { path: args.path, content: BRAIN_PROMPT, ok: true };
    }

    const file = readSkillFile(args.path);
    if (!file) throw new Error(`Skill "${args.path}" not found`);
    return { path: args.path, content: file.body, ok: true };
  },
});
