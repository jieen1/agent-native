import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// ── Runtime (vLLM / Claude Code) ──────────────────────────────────────────

export interface RuntimeConfigItem {
  id: string;
  name: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
  /** Extra model ids this endpoint serves (DESIGN §8.3 item4); widens the picker. */
  models: string[];
  active: boolean;
}

export interface RuntimeStatus {
  chatEngine: string | null;
  chatModel: string | null;
  chatBaseUrl: string | null;
  executionRuntime: string;
  claudeCodeInstalled: boolean;
  claudeCodeLoggedIn?: boolean;
  claudeCodeExpired?: boolean;
  claudeCodeExpiresAt?: string | null;
  claudeCodeSubscription?: string | null;
  claudeCodeCredentialsFound?: boolean;
}

export function useRuntimeConfigs() {
  return useActionQuery("list-runtime-configs", {}) as {
    data?: RuntimeConfigItem[];
    isLoading: boolean;
  };
}

export function useRuntimeStatus() {
  return useActionQuery("get-runtime-status", {}) as {
    data?: RuntimeStatus;
    isLoading: boolean;
    isFetching: boolean;
    refetch: () => void;
  };
}

function invalidateRuntime(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-runtime-configs"] });
  qc.invalidateQueries({ queryKey: ["action", "get-runtime-status"] });
}

export function useSaveRuntimeConfig() {
  const qc = useQueryClient();
  return useActionMutation("save-runtime-config", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useActivateRuntime() {
  const qc = useQueryClient();
  return useActionMutation("activate-runtime", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useDeleteRuntimeConfig() {
  const qc = useQueryClient();
  return useActionMutation("delete-runtime-config", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useStartClaudeCode() {
  return useActionMutation("start-claude-code", {});
}

// ── Claude Code connection (subscription login via in-app OAuth) ─────────────

export interface ClaudeStatus {
  loggedIn: boolean;
  expired: boolean;
  subscriptionType: string | null;
  expiresAt: string | null;
  connected: boolean;
}

export function useClaudeStatus() {
  return useActionQuery("claudeStatus", {}) as {
    data?: ClaudeStatus;
    isLoading: boolean;
    isFetching: boolean;
    refetch: () => void;
  };
}

export function useClaudeConnect() {
  return useActionMutation("claudeConnect", {}) as {
    mutateAsync: (vars: Record<string, never>) => Promise<{
      sessionId: string;
      authUrl: string;
    }>;
    isPending: boolean;
  };
}

export function useClaudeConnectComplete() {
  return useActionMutation("claudeConnectComplete", {}) as {
    mutateAsync: (vars: { sessionId: string; code: string }) => Promise<{
      loggedIn: boolean;
      error?: string;
    }>;
    isPending: boolean;
  };
}

export function useClaudeDisconnect() {
  // useActionMutation already invalidates all ["action"] queries on success,
  // so claudeStatus refetches automatically.
  return useActionMutation("claudeDisconnect", {}) as {
    mutateAsync: (vars: Record<string, never>) => Promise<{ ok: boolean }>;
    isPending: boolean;
  };
}

export function useTestRuntimeConfig() {
  return useActionMutation("test-runtime-config", {});
}

// ── microVM images (Settings → Images, read-only, DESIGN §7.4.8) ────────────

export interface RuntimeImage {
  ref: string;
  runtime: string;
  description: string;
  tools: string[];
  status: "prebaked" | "missing";
  default: boolean;
}

export function useRuntimeImages() {
  return useActionQuery("list-runtime-images", {}) as {
    data?: { images: RuntimeImage[]; note: string };
    isLoading: boolean;
  };
}

// ── Credentials (Settings → Credentials, key presence only, DESIGN §7.4.7) ──

export interface CredentialKey {
  key: string;
  present: boolean;
  description: string;
  mountedBy: string[];
}

export function useRuntimeCredentials() {
  return useActionQuery("list-runtime-credentials", {}) as {
    data?: { credentials: CredentialKey[]; note: string };
    isLoading: boolean;
  };
}
