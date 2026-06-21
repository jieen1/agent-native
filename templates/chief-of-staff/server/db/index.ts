import * as schema from "./schema.js";
import { createGetDb } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "briefing",
  resourceTable: schema.briefings,
  sharesTable: schema.briefingShares,
  displayName: "Briefing",
  titleColumn: "title",
  getResourcePath: (briefing) => `/briefings/${briefing.id}`,
  getDb,
});
