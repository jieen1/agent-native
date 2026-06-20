import { registerBuiltinAgentHarnesses } from "@agent-native/core/agent/harness";

// Registers the Claude Code / Codex / Pi harnesses in the current process.
// Idempotent. Call from any context that starts a harness run (server plugin,
// the start-claude-code action, CLI) — each process has its own registry.
//
// Note: vLLM is NOT a custom engine here. It runs on the framework's built-in
// `ai-sdk:openai` engine pointed at a baseUrl (see actions/activate-runtime.ts),
// so it lives in the framework's own engine registry — no custom registration,
// no dual-registry pitfalls, and it shows up in the status route + model picker.
let done = false;

export function registerOrchestratorRuntime(): void {
  if (done) return;
  done = true;
  try {
    registerBuiltinAgentHarnesses();
  } catch {
    // harness packages optional
  }
}
