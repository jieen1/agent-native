import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  buildStageVocabularyOrder,
  safeParseFlows,
  safeParseObject,
} from "../shared/stage-vocabulary.js";
import type {
  StageConfigResponse,
  StageGateCriteria,
} from "../shared/types.js";

// Returns the project's Stage Configuration: the derived stage vocabulary
// (name + description + the 3 existing stageGateConfig criteria, read-only
// booleans), the reusable stage flows, and the work-item-type → flow
// assignment. Purely a READ over the existing stageGateConfig column (M1-6)
// plus the new M2 columns — does not write anything.
export default defineAction({
  description:
    "Get a project's Stage Configuration: the stage vocabulary (derived as " +
    "the union of stage names across all configured flows plus the legacy " +
    "7-stage defaults, each with its description and gate criteria), the " +
    "reusable stage flows, and the work-item-type → flow assignment.",
  schema: z.object({
    projectId: z
      .string()
      .min(1)
      .describe("Project to read Stage Configuration for"),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args): Promise<StageConfigResponse> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const project = (
      await db
        .select({
          id: schema.projects.id,
          stageGateConfig: schema.projects.stageGateConfig,
          stageDescriptions: schema.projects.stageDescriptions,
          stageFlows: schema.projects.stageFlows,
          stageTypeAssignment: schema.projects.stageTypeAssignment,
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

    const gateConfig = safeParseObject(project.stageGateConfig) as Record<
      string,
      StageGateCriteria
    >;
    const descriptions = safeParseObject(project.stageDescriptions) as Record<
      string,
      string
    >;
    const flows = safeParseFlows(project.stageFlows);
    const typeAssignment = safeParseObject(
      project.stageTypeAssignment,
    ) as Record<string, string>;

    const order = buildStageVocabularyOrder(flows, descriptions, gateConfig);
    const vocabulary = order.map((name) => {
      const criteria = gateConfig[name] ?? {};
      return {
        name,
        description: descriptions[name] ?? "",
        requireArtifacts:
          Array.isArray(criteria.requireArtifacts) &&
          criteria.requireArtifacts.length > 0,
        requireApproval: !!criteria.requireApproval,
        requireGraphValid: !!criteria.requireGraphValid,
      };
    });

    return { vocabulary, flows, typeAssignment };
  },
});
