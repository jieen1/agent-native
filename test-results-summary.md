# Test Results Summary — Orchestrator Template

**Date:** 2026-06-23
**Status:** 1 FAILURE, 1 INFRASTRUCTURE ERROR

| Metric          | Value |
|-----------------|-------|
| Test Files      | 34    |
| Passed          | 30    |
| Failed          | 2     |
| Skipped         | 2     |
| Total Tests     | 390   |
| Tests Passed    | 386   |
| Tests Failed    | 1     |
| Tests Skipped   | 3     |

---

## Failures

### 1. `server/runtime/executors/claude-stream.spec.ts` — Assertion Mismatch

**Test:** `builds the in-VM claude stream-json command with the node prompt + model`

The expected string does not include `--permission-mode acceptEdits`, which is now present in the actual command output.

```
Expected to contain: "claude --output-format stream-json --verbose -p"
Actual:              "claude --output-format stream-json --verbose --permission-mode acceptEdits -p 'Create /work/hello.txt with 'hi'.' --model 'claude-sonnet-4-6'"
```

**Fix:** Update the assertion in `server/runtime/executors/claude-stream.spec.ts:113` to include `--permission-mode acceptEdits`.

### 2. `server/runtime/smoke.spec.ts` — OpenTelemetry ESM Resolution Error

**Error:** `Directory import ...@opentelemetry/semantic-conventions/build/esm/trace is not supported resolving ES modules`

This is an infrastructure/module compatibility issue with `@opentelemetry/semantic-conventions@1.40.0` and Vite 8's module runner. No tests in the file ran.

---

## Warnings

- 16 React Router v8 future-flag warnings (informational, not failures)
- Vite server close timed out after 10000ms (hanging process)
