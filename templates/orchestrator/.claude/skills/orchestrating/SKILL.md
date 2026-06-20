---
name: orchestrating
description: >-
  How the orchestrator agent executes a task against its workflow DAG —
  walking step runs in order, delegating each to a sub-agent or sibling app
  with the right model, reporting progress, and delivering the final result.
---

# Orchestrating Tasks

You are the **orchestrator**. When asked to execute a task you drive its
workflow DAG to completion using sub-agents, then deliver a result. All AI work
happens through you and the sub-agents you spawn — never fabricate step output.

## Protocol

1. **Read the plan.** Call `get-task` with the task id. It returns the task, its
   `workflow`, and the `stepRuns` already seeded in dependency order by
   `run-orchestrator`. If there are no step runs, tell the user to attach a
   workflow and run the task first.

2. **Walk steps in order.** For each step run whose status is `pending`, in the
   given `ordering` (dependencies always come earlier):

   a. Mark it started: `upsert-step-run({ taskId, stepKey, status: "running" })`.

   b. **Execute the step:**
      - If `assignee` starts with `@` (e.g. `@brain`, `@dispatch`), delegate to
        that sibling app over A2A with `call-agent`. Pass a narrow prompt: the
        step's `prompt`, the task goal, and the **artifact ids / bounded
        summaries** of the steps it depends on — not giant pasted text.
      - Otherwise (`local`), spawn a sub-agent for the step. Use the step's
        `model` and `engine` so different steps run on different models
        (e.g. a cheap local model for bulk work, a strong model for reasoning).
        Give it the step `prompt` plus the dependency outputs.

   c. Capture the sub-agent's result and record it:
      `upsert-step-run({ taskId, stepKey, status: "done", output: <concise summary or artifact id> })`.
      On failure: `status: "failed"`, `error: <message>`, then stop and mark the
      task failed.

   d. **Respect cancellation.** Before starting each step, re-check the task
      status (from `get-task` or `view-screen`). If it is `cancelled`, stop
      immediately and do not run further steps.

3. **Deliver.** When every step is `done`, synthesize the final deliverable from
   the step outputs and call
   `update-task({ id, status: "done", result: <markdown deliverable> })`.
   If any step failed, call `update-task({ id, status: "failed" })` with a short
   explanation in the result.

## Model Routing

Each step carries its own `engine` + `model`. Honor them — that is how the user
assigns different models to different sub-agents. When a step leaves them blank,
use your default. Valid engines include `anthropic`, `ai-sdk:openai` (also for
local vLLM via a base URL), `ai-sdk:ollama`, and `ai-sdk-harness:claude-code`.

## Running As Claude Code

The orchestrator agent itself can run on the Claude Code harness
(`ai-sdk-harness:claude-code`) so it uses a Claude subscription instead of an
API key. That is an engine/runtime choice for this app's agent; the protocol
above is unchanged.

## Keep It Honest

- Never write step output you did not get from a real sub-agent or app.
- Pass artifact ids and bounded summaries between steps, not full transcripts.
- Update `step_runs` as you go so the task board reflects live progress.
