/**
 * Re-exports the `test-plan` markdown parsing helpers from `shared/` — moved
 * there for R4b.2 (Sprint Studio) so the client can render the same scenario
 * cards / coverage matrix the server gates on, without either side importing
 * across the app/server boundary (see `shared/navigation.ts` for the
 * pre-existing precedent of a runtime-logic module shared this way). This
 * file is kept as a re-export so existing server-side imports
 * (`./test-plan-parse.js`) don't need to change.
 */
export * from "../../shared/test-plan-parse.js";
