import { ensureAgentHarnessSessionTables } from "@agent-native/core/agent/harness";
import { registerOrchestratorRuntime } from "../register-runtime.js";

// Belt-and-suspenders: also register at server startup and ensure the harness
// session tables exist. The authoritative registration is the module-level
// call in plugins/agent-chat.ts (guaranteed to load); this just covers the
// harness DB tables.
export default async function orchestratorRuntimePlugin(): Promise<void> {
  registerOrchestratorRuntime();
  try {
    await ensureAgentHarnessSessionTables();
  } catch {
    // harness substrate unavailable — Settings page guides install
  }
}
