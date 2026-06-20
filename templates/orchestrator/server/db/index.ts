import * as schema from "./schema.js";
import { createGetDb } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "task",
  resourceTable: schema.tasks,
  sharesTable: schema.taskShares,
  displayName: "Task",
  titleColumn: "title",
  getResourcePath: (task) => `/tasks/${(task as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "workflow",
  resourceTable: schema.workflows,
  sharesTable: schema.workflowShares,
  displayName: "Workflow",
  titleColumn: "name",
  getResourcePath: (wf) => `/workflows/${(wf as { id: string }).id}`,
  getDb,
});
