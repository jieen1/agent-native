/**
 * Thin analytics re-export that reports stats for a single staged dataset.
 */
import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getCredentialContext } from "@agent-native/core/server/request-context";
import { getStagedDatasetMeta } from "@agent-native/core/provider-api/staged-datasets-store";
import { ANALYTICS_APP_ID } from "../server/lib/provider-credentials";

export default defineAction({
  description:
    "Report stats for a single staged dataset stored by provider-api-request (stageAs). " +
    "Returns its row count, column count, byte size, and column names without reading any rows. " +
    "Use after staging, or with a dataset id from list-staged-datasets, to size a dataset before querying it with query-staged-dataset.",
  schema: z.object({
    datasetId: z
      .string()
      .min(1)
      .describe(
        "Dataset id from provider-api-request stageAs result, or from list-staged-datasets.",
      ),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const ctx = getCredentialContext();
    if (!ctx) throw new Error("No authenticated context for dataset-stats.");

    const meta = await getStagedDatasetMeta({
      id: args.datasetId,
      appId: ANALYTICS_APP_ID,
      ownerEmail: ctx.userEmail,
    });
    if (!meta) {
      throw new Error(
        `Dataset ${args.datasetId} not found (or belongs to a different owner/app).`,
      );
    }

    return {
      rowCount: meta.rowCount,
      columnCount: meta.columns.length,
      byteSize: meta.byteSize,
      columns: meta.columns,
    };
  },
});
