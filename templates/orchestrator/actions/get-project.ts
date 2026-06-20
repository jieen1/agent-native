import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { parseProjectSchemes } from "../server/work-items/schemes.js";
import { DEFAULT_ENVIRONMENTS } from "../shared/types.js";

// Get a single project, including its resolved status-scheme set (project
// override merged onto the defaults) and effective environment list, so the
// agent/UI can render the board columns without re-deriving the scheme.
export default defineAction({
  description:
    "Get a single project with its resolved status schemes and environment list.",
  schema: z.object({ id: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("project", args.id);
    if (!access) throw new Error(`Project ${args.id} not found`);
    const p = access.resource as Record<string, unknown>;
    let environments: string[] = DEFAULT_ENVIRONMENTS;
    if (typeof p.environments === "string" && p.environments) {
      try {
        const parsed = JSON.parse(p.environments);
        if (Array.isArray(parsed)) environments = parsed.map(String);
      } catch {
        // fall back to defaults on bad JSON
      }
    }
    return {
      id: String(p.id),
      name: String(p.name),
      key: String(p.key),
      description: String(p.description ?? ""),
      workingDir: String(p.workingDir ?? ""),
      gitRemote: (p.gitRemote as string | null) ?? null,
      defaultBranch: (p.defaultBranch as string | null) ?? null,
      defaultWorkflowId: (p.defaultWorkflowId as string | null) ?? null,
      environments,
      schemes: parseProjectSchemes(p.statusSchemes),
      role: access.role,
      createdAt: String(p.createdAt ?? ""),
      updatedAt: String(p.updatedAt ?? ""),
    };
  },
});
