import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  approvalGateKeyFor,
  safeParseObject,
} from "../shared/stage-vocabulary.js";
import type {
  StageGateCriteria,
  StageVocabularyEntry,
} from "../shared/types.js";

// Upserts one stage vocabulary entry: its free-text description (new
// stageDescriptions column) and its 3 gate-criteria toggles. The gate
// criteria write REUSES the exact column update-project.ts already performs
// on stageGateConfig (same table, same column) — this does not reinvent that
// write path, it merges a single stage's key into the same JSON blob
// advance-stage.ts already reads, instead of requiring the caller to submit
// the whole blob (as update-project's raw-JSON textarea does).
export default defineAction({
  description:
    "Upsert a stage's vocabulary entry: description + the 3 gate-criteria " +
    "toggles (requireArtifacts / requireApproval / requireGraphValid). " +
    "Merges into the project's stageDescriptions and stageGateConfig " +
    "columns — the same columns update-project/advance-stage already use.",
  schema: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1).describe("Stage name (vocabulary key)"),
    description: z.string().optional(),
    requireArtifacts: z
      .boolean()
      .optional()
      .describe(
        "Whether this stage requires a sprint artifact keyed by its own name",
      ),
    requireApproval: z
      .boolean()
      .optional()
      .describe("Whether this stage requires an approved gate"),
    requireGraphValid: z
      .boolean()
      .optional()
      .describe("Whether this stage requires the dependency graph to be valid"),
  }),
  http: { method: "POST" },
  run: async (args): Promise<StageVocabularyEntry> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const project = (
      await db
        .select({
          id: schema.projects.id,
          stageGateConfig: schema.projects.stageGateConfig,
          stageDescriptions: schema.projects.stageDescriptions,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, args.projectId),
            ownerScope(schema.projects),
          ),
        )
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or not accessible");

    const descriptions = safeParseObject(project.stageDescriptions) as Record<
      string,
      string
    >;
    const gateConfig = safeParseObject(project.stageGateConfig) as Record<
      string,
      StageGateCriteria
    >;

    if (args.description !== undefined) {
      descriptions[args.name] = args.description;
    }

    const existingCriteria = gateConfig[args.name] ?? {};
    const requireArtifacts =
      args.requireArtifacts !== undefined
        ? args.requireArtifacts
        : !!(
            existingCriteria.requireArtifacts &&
            existingCriteria.requireArtifacts.length > 0
          );
    const requireApproval =
      args.requireApproval !== undefined
        ? args.requireApproval
        : !!existingCriteria.requireApproval;
    const requireGraphValid =
      args.requireGraphValid !== undefined
        ? args.requireGraphValid
        : !!existingCriteria.requireGraphValid;

    const nextCriteria: StageGateCriteria = {};
    if (requireArtifacts) nextCriteria.requireArtifacts = [args.name];
    if (requireApproval)
      nextCriteria.requireApproval = approvalGateKeyFor(args.name);
    if (requireGraphValid) nextCriteria.requireGraphValid = true;

    if (Object.keys(nextCriteria).length > 0) {
      gateConfig[args.name] = nextCriteria;
    } else {
      delete gateConfig[args.name];
    }

    const now = new Date().toISOString();
    await db
      .update(schema.projects)
      .set({
        stageDescriptions: JSON.stringify(descriptions),
        stageGateConfig: JSON.stringify(gateConfig),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projects.id, args.projectId),
          ownerScope(schema.projects),
        ),
      );

    return {
      name: args.name,
      description: descriptions[args.name] ?? "",
      requireArtifacts,
      requireApproval,
      requireGraphValid,
    };
  },
});
