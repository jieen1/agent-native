---
name: sprint-story
description: >-
  Post-sprint walk-through verification from a newcomer's perspective. After a
  sprint is delivered, ACTUALLY invoke the produced entry points (real HTTP
  requests via curl/fetch, real page operations) and capture real command +
  real output as evidence. Any capability that cannot be walk-through-verified
  in the current environment MUST be labeled `unverifiable` with the reason —
  never marked verified on the basis of reading code, unit tests, or seed data
  alone. Use after a sprint reaches "已完成" or "已发布" status.
scope: dev
metadata:
  internal: true
---

# Sprint Story — Real Walk-Through Verification

After a sprint is delivered, verify it from a **newcomer's perspective**:
someone who has never seen this codebase, following only the documented entry
points. The goal is to produce a `sprint-story` artifact that records what
actually happened when each capability was exercised for real — not what the
code *looks like* it should do.

## Why this matters (Lesson L15)

Shipping on seed-data-only verification cost **16 fix PRs** in the original
system. Reading code and running unit tests confirms the code compiles and
passes assertions; it does NOT confirm the feature works when a real user hits
the real endpoint with real (possibly empty, possibly malformed) data. This
skill exists to close that gap.

## Process

### 1. Identify the produced entry points

Read the sprint's work items and their delivered artifacts. For each work item
that claims to deliver a user-facing capability, identify:

- The HTTP endpoint(s) or page route(s) it produces.
- The expected request shape (method, path, body/params).
- The expected response or visible behavior.

### 2. Actually invoke each entry point

For every identified entry point, **execute a real invocation**:

```bash
# Example: a new REST endpoint
curl -s -X POST http://localhost:3000/api/sprints \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Sprint","goal":"Verify M5"}' | jq .

# Example: a page route (check HTTP status + key content)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/sprints
```

Capture:
- The **exact command** you ran (copy-pasteable).
- The **real output** (trimmed to the relevant portion if very long).
- Whether the output matches the expected behavior: ✅ verified / ❌ failed.

If the server is not running, start it first (`pnpm dev` or equivalent). If
you cannot start it, that capability is `unverifiable` — say so explicitly.

### 3. Mark unverifiable capabilities honestly

A capability is `unverifiable` when:

- The required service/dependency is not available in this environment.
- The entry point requires authentication you cannot obtain.
- The feature is a background job with no synchronous observable output.
- The feature depends on external state (e.g. a real orchestrator run) that
  does not exist yet.

For each `unverifiable` capability, record:
- What the capability is.
- Why it cannot be walk-through-verified here.
- What would be needed to verify it.

**Never** mark a capability as verified based on:
- Reading the source code and reasoning about it.
- Running unit tests (they test the code, not the deployed behavior).
- Observing seed data or mock responses.
- The fact that the build succeeded.

### 4. Write the sprint-story artifact

Produce a `sprint-story` artifact (via `create-sprint-artifact` with
`docKey: "sprint-story"`) containing:

```markdown
# Sprint Story — <sprint name>

## Walk-Through Verification

### <Work Item Key>: <title>

**Entry point:** `POST /api/sprints`

**Command:**
\`\`\`bash
curl -s -X POST http://localhost:3000/api/sprints ...
\`\`\`

**Output:**
\`\`\`json
{ "id": "spr_abc123", "status": "规划" }
\`\`\`

**Result:** ✅ Verified — returns 201 with a valid sprint object.

---

### <Work Item Key>: <title>

**Entry point:** Background reconciler (no HTTP endpoint)

**Result:** ⚠️ Unverifiable — no synchronous entry point exists; the
reconciler runs on a timer inside the orchestrator process. Would require
a running orchestrator with a dispatched work item to observe.
```

### 5. Summary table

End the artifact with a summary:

| Work Item | Capability | Status |
|-----------|-----------|--------|
| M5-1 | `GET /sprints/:id` stage timing | ✅ Verified |
| M5-2 | Release button idempotency | ✅ Verified |
| M5-3 | Background reconciler writeback | ⚠️ Unverifiable |

## Checklist

- [ ] Every delivered work item has at least one real invocation attempt.
- [ ] Every invocation shows the exact command and real output.
- [ ] No capability is marked ✅ without a real invocation.
- [ ] Every ⚠️ Unverifiable entry states the specific reason.
- [ ] The sprint-story artifact is written via `create-sprint-artifact`.
