/**
 * Re-exports the `sprint-doc` markdown parsing helpers from `shared/` —
 * moved there for R4b.2 (Sprint Studio) so the client can run the same
 * step-④ "不适用" heuristic (`hasUiShapedInScope` in
 * shared/studio-step-derive.ts, fed by `parseInScopeOutcomes` here) the
 * server runs, without importing across the app/server boundary. Kept as a
 * re-export so existing server-side imports (`./sprint-doc-parse.js`) don't
 * need to change.
 */
export * from "../../shared/sprint-doc-parse.js";
