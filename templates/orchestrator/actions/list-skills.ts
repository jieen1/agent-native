import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { BRAIN_RUNBOOK_PATH, listSkillFiles } from "./_skills-util.js";

// List every editable skill doc (.agents/skills/*/SKILL.md) plus the
// orchestrator brain's own runbook as a pinned pseudo-entry (DESIGN: Skills /
// Runbook editor). `hasOverride` / `updatedAt` reflect the hosted SQL
// override when one exists for that path, else the file's own mtime.
export default defineAction({
  description:
    "List editable skill docs (.agents/skills/*/SKILL.md) plus the orchestrator brain's own runbook, pinned. Each entry has { path, name, title, description, category, pinned, hasOverride, updatedAt }.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const overrides = await db
      .select({
        path: schema.skillOverrides.path,
        updatedAt: schema.skillOverrides.updatedAt,
      })
      .from(schema.skillOverrides);
    const overrideByPath = new Map(overrides.map((o) => [o.path, o]));

    const brainOverride = overrideByPath.get(BRAIN_RUNBOOK_PATH);
    const brainEntry = {
      path: BRAIN_RUNBOOK_PATH,
      name: "brain-runbook",
      title: "Orchestrator Brain Runbook",
      description:
        "The brain's own system prompt — appended via --append-system-prompt on every turn.",
      category: null as string | null,
      pinned: true,
      hasOverride: Boolean(brainOverride),
      updatedAt: brainOverride?.updatedAt ?? null,
    };

    const skillEntries = listSkillFiles().map((file) => {
      const override = overrideByPath.get(file.path);
      return {
        ...file,
        pinned: false,
        hasOverride: Boolean(override),
        updatedAt: override?.updatedAt ?? file.updatedAt,
      };
    });

    return [brainEntry, ...skillEntries];
  },
});
