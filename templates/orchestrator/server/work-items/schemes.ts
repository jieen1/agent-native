// Server-side helpers tying the pure status-scheme logic (shared/status-schemes)
// to a project's (possibly overridden) scheme set and to DB lookups the
// transition validator needs (the duplicate-of link check). Kept tiny and pure
// where possible so transition-work-item stays readable.

import {
  defaultSchemeSet,
  resolveScheme,
  type SchemeSet,
  type StatusScheme,
} from "../../shared/status-schemes.js";

/**
 * Parse a project's stored `status_schemes` JSON override into a SchemeSet.
 * Returns the default set when the column is null/empty/invalid so a project
 * never strands a work item without a scheme (DESIGN §6.2a).
 */
export function parseProjectSchemes(raw: unknown): SchemeSet {
  if (raw == null || raw === "") return defaultSchemeSet();
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return defaultSchemeSet();
    }
  }
  if (!value || typeof value !== "object") return defaultSchemeSet();
  // Shallow-merge the project's overrides onto the defaults so a project that
  // overrides only `bug` still gets the built-in `requirement`/`task` schemes.
  return { ...defaultSchemeSet(), ...(value as SchemeSet) };
}

/**
 * Resolve the scheme for a work item's type from a project's (overridden)
 * scheme set, falling back to the default set. Throws a clear error if neither
 * has the type (a misconfigured project, not a silent miss).
 */
export function schemeForType(
  projectSchemesRaw: unknown,
  type: string,
): StatusScheme {
  const set = parseProjectSchemes(projectSchemesRaw);
  const scheme = resolveScheme(set, type);
  if (!scheme) {
    throw new Error(
      `No status scheme for work-item type '${type}'. Configure the project's status_schemes or use a known type.`,
    );
  }
  return scheme;
}
