import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteAdHocSecret,
  listAdHocSecrets,
  saveAdHocSecret,
  type AdHocSecret,
  type SaveAdHocSecretInput,
} from "@/lib/secrets-client";

export const ADHOC_SECRETS_KEY = ["adhoc-secrets"] as const;

/**
 * List the current user's ad-hoc secrets (masked metadata only — the plaintext
 * value is never returned by the endpoint).
 */
export function useAdHocSecrets() {
  return useQuery<AdHocSecret[]>({
    queryKey: ADHOC_SECRETS_KEY,
    queryFn: listAdHocSecrets,
  });
}

/** Create or update an ad-hoc secret (value + per-key URL allowlist). */
export function useSaveAdHocSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveAdHocSecretInput) => saveAdHocSecret(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ADHOC_SECRETS_KEY });
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, "Failed to save key"));
    },
  });
}

/** Delete an ad-hoc secret by name. */
export function useDeleteAdHocSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteAdHocSecret(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ADHOC_SECRETS_KEY });
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, "Failed to delete key"));
    },
  });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
