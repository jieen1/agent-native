import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconExternalLink } from "@tabler/icons-react";
import {
  useClaudeConnect,
  useClaudeConnectComplete,
  useClaudeDisconnect,
  useClaudeStatus,
} from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Relative date like "in 3 days" / "12 days ago" — keeps the connected row to one
// short line without a verbose absolute timestamp.
function relativeDate(iso: string | null): string {
  if (!iso) return "—";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "—";
  const diffDays = Math.round((target - Date.now()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffDays) >= 30) return rtf.format(Math.round(diffDays / 30), "month");
  return rtf.format(diffDays, "day");
}

// Claude Code subscription connection — one compact row, with an in-app OAuth
// dialog when not connected. Drives claudeStatus / claudeConnect /
// claudeConnectComplete / claudeDisconnect.
export function ClaudeCodeCard() {
  const { t } = useTranslation();
  const { data: status, refetch } = useClaudeStatus();
  const connect = useClaudeConnect();
  const complete = useClaudeConnectComplete();
  const disconnect = useClaudeDisconnect();

  const [open, setOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const connected = !!status?.connected && !!status?.loggedIn;
  const expired = !!status?.expired;

  async function startConnect() {
    setError(null);
    setCode("");
    setAuthUrl(null);
    setSessionId(null);
    setOpen(true);
    try {
      const res = await connect.mutateAsync({});
      setAuthUrl(res.authUrl);
      setSessionId(res.sessionId);
    } catch {
      setError(t("settings.claudeConnectError"));
    }
  }

  async function submitCode() {
    if (!sessionId || !code.trim()) return;
    setError(null);
    try {
      const res = await complete.mutateAsync({
        sessionId,
        code: code.trim(),
      });
      if (res.loggedIn) {
        setOpen(false);
        refetch();
      } else {
        setError(res.error ?? t("settings.claudeConnectError"));
      }
    } catch {
      setError(t("settings.claudeConnectError"));
    }
  }

  async function onDisconnect() {
    await disconnect.mutateAsync({});
    refetch();
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <span
          className={`size-2 shrink-0 rounded-full ${
            connected
              ? "bg-emerald-500"
              : expired
                ? "bg-amber-500"
                : "bg-muted-foreground/40"
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("settings.claudeName")}</p>
          <p className="truncate text-xs text-muted-foreground">
            {connected
              ? [
                  t("settings.claudeConnected"),
                  status?.subscriptionType,
                  status?.expiresAt
                    ? t("settings.claudeExpiresAt", {
                        date: relativeDate(status.expiresAt),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : expired
                ? t("settings.claudeExpired")
                : t("settings.claudeNotConnected")}
          </p>
        </div>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onDisconnect}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? <Spinner className="size-4" /> : null}
            {t("settings.claudeDisconnect")}
          </Button>
        ) : (
          <Button size="sm" onClick={startConnect} disabled={connect.isPending}>
            {connect.isPending ? <Spinner className="size-4" /> : null}
            {t("settings.claudeConnect")}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.claudeConnectTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <Button
              variant="outline"
              asChild={!!authUrl}
              disabled={!authUrl}
              className="justify-start"
            >
              {authUrl ? (
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  <IconExternalLink className="size-4" />
                  {t("settings.claudeOpenAuth")}
                </a>
              ) : (
                <span>
                  <Spinner className="size-4" />
                  {t("settings.claudeOpenAuth")}
                </span>
              )}
            </Button>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("settings.claudeCodePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex justify-end">
              <Button
                onClick={submitCode}
                disabled={!sessionId || !code.trim() || complete.isPending}
              >
                {complete.isPending ? <Spinner className="size-4" /> : null}
                {t("settings.claudeComplete")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
