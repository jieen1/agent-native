import {
  table,
  text,
  ownableColumns,
  createSharesTable,
} from "@agent-native/core/db/schema";
import { BRIEFING_KINDS, BRIEFING_STATUSES } from "../../shared/types.js";

/**
 * One row per compiled briefing (never overwritten — history is preserved).
 * See docs/CHIEF_OF_STAFF_DESIGN.md §5.
 *
 * Timestamps are stored as ISO text strings (`new Date().toISOString()`) to
 * match every other ownable template (plan/forms), not integer-timestamps.
 */
export const briefings = table("briefings", {
  id: text("id").primaryKey(), // gen: brief_<nanoid>
  briefingDate: text("briefing_date").notNull(), // YYYY-MM-DD (user-local day)
  kind: text("kind", { enum: BRIEFING_KINDS }).notNull().default("adhoc"),
  title: text("title").notNull(),
  summaryMd: text("summary_md").notNull().default(""), // agent-polished prose
  sourcesJson: text("sources_json").notNull().default("[]"), // BriefingSource[]
  status: text("status", { enum: BRIEFING_STATUSES })
    .notNull()
    .default("compiling"),
  focus: text("focus"), // optional focus for this compile
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(), // owner_email, org_id, visibility
});

export const briefingShares = createSharesTable("briefing_shares");
