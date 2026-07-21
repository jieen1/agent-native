// Minimal owner-scoping for tracker reads. The tracker keeps a lean access model
// (no per-row sharing in v1): rows are visible to their owner_email, and — when
// an org is active — to the same org. Mirrors the orchestrator's direct
// owner-scoping rather than pulling in the full sharing substrate.

import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, or, type SQL } from "drizzle-orm";

interface OwnableTable {
  ownerEmail: any;
  orgId: any;
}

/** WHERE clause admitting rows the current user owns (or shares via their org). */
export function ownerScope(t: OwnableTable): SQL {
  const userEmail = getRequestUserEmail();
  const orgId = getRequestOrgId();
  const clauses: SQL[] = [];
  if (userEmail) clauses.push(eq(t.ownerEmail, userEmail));
  if (orgId) clauses.push(eq(t.orgId, orgId));
  // If somehow unauthenticated, fall back to a never-true clause.
  if (clauses.length === 0) return eq(t.ownerEmail, "__no_such_owner__");
  return clauses.length === 1 ? clauses[0]! : or(...clauses)!;
}

export { and };
