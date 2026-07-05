// Orchestrator MCP client — the tracker dispatches work to the orchestrator app
// by a STRUCTURED MCP `tools/call` over its `/_agent-native/mcp` endpoint, then
// reads activity back the same way. Auth is an HS256 JWT signed with the SHARED
// A2A_SECRET env (the tracker container MUST receive the same A2A_SECRET as the
// orchestrator). NOT the A2A natural-language loop (which would need an online
// chat LLM); this is a deterministic JSON-RPC call.
//
// Verified contract (orchestrator src/mcp + build-server.ts):
//  - Endpoint: POST <base>/_agent-native/mcp  (stateless Streamable HTTP, JSON)
//  - Tool names are the action filename without `.ts`: brain-send, brain-thread,
//    runsList, spawnList (hyphens preserved, no namespacing over the wire).
//  - JWT: HS256, secret = A2A_SECRET, claims { sub, iat, exp, catalog_scope:"full" }.
//    `sub` is the authoritative actor identity. exp is enforced if present.
//  - Headers: Authorization: Bearer <jwt>, Accept: application/json,
//    text/event-stream (the SDK transport requires both advertised).
//
// The JWT minting + MCP HTTP transport + response parsing are shared with
// content-client.ts via ./mcp-client.ts — this file only resolves the
// orchestrator's base URL/endpoint and exposes its tool-call wrapper.

import { callMcpTool, mintA2aJwt, type McpCallResult } from "./mcp-client.js";

/**
 * Base URL of the orchestrator, reachable from the tracker container. Prefer the
 * same-docker-network service hostname; fall back to the gateway route. Override
 * with ORCHESTRATOR_BASE_URL.
 */
export function orchestratorBaseUrl(): string {
  return (
    process.env.ORCHESTRATOR_BASE_URL?.replace(/\/$/, "") ||
    "http://an-orchestrator:3002"
  );
}

function mcpEndpoint(): string {
  return `${orchestratorBaseUrl()}/orchestrator/_agent-native/mcp`;
}

/** Mint an HS256 JWT for the orchestrator MCP endpoint (no extra deps). */
export function mintOrchestratorJwt(actorEmail: string): string {
  return mintA2aJwt(actorEmail, "the orchestrator");
}

/**
 * Call an orchestrator action by its MCP tool name over JSON-RPC `tools/call`.
 * The orchestrator endpoint is mounted under /orchestrator in the gateway and
 * also at the container root; we hit the gateway-prefixed path on the service
 * host so the same path works for both same-network and gateway routing.
 */
export async function callOrchestratorTool(
  actorEmail: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return callMcpTool({
    endpoint: mcpEndpoint(),
    actorEmail,
    appLabel: "Orchestrator",
    appDescription: "the orchestrator",
    toolName,
    args,
  });
}
