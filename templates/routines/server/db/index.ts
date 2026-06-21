/**
 * Routines app Drizzle handle.
 *
 * `getDb` is the owner-scoped read surface for `routine_runs`. The table is
 * created by core's lazy `ensureTable` (on first engine write) AND mirrored in
 * the app's `runMigrations` (`server/plugins/db.ts`) with an identical
 * `CREATE TABLE IF NOT EXISTS`, so reads never race a not-yet-written table.
 */

import { createGetDb } from "@agent-native/core/db";
import { schema } from "./schema.js";

export const getDb = createGetDb(schema);
export { schema };
