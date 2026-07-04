import { refreshManagedTokenIfNeeded } from "../claude-login.js";

// Managed OAuth token pre-refresh scheduler.
//
// The container's managed Claude Code access token lives only ~8h. Brain turns
// refresh it on spawn (brain-session.ts), but a long idle period with no
// dispatch could still let it lapse; and the account-usage panel needs a live
// token too. This durable tick calls refreshManagedTokenIfNeeded() every
// REFRESH_TICK_MS — a no-op that touches NO network unless the token is within
// the 5-minute expiry skew (single-flight inside the helper), so the actual
// refresh round-trip happens at most once per ~8h token lifetime. As long as
// the long-lived refresh token survives (weeks), the credential never lapses
// and the operator is never forced to re-login. The loop is `unref`-ed so it
// never blocks shutdown.
const REFRESH_TICK_MS = Number(
  process.env.ORCH_TOKEN_REFRESH_TICK_MS || 30 * 60 * 1000, // 30 min
);

export default async function orchestratorTokenRefreshPlugin(): Promise<void> {
  // Kick once on boot so a token that expired while the process was down is
  // renewed before the first brain turn or usage read.
  void refreshManagedTokenIfNeeded().catch(() => {});

  const timer = setInterval(() => {
    void refreshManagedTokenIfNeeded().catch(() => {});
  }, REFRESH_TICK_MS);
  // Do not keep the event loop alive solely for this timer.
  (timer as { unref?: () => void }).unref?.();
}
