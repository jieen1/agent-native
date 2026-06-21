import { useEffect, useState } from "react";
import { IconLoader2, IconPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSaveAdHocSecret } from "@/hooks/use-adhoc-secrets";
import type { AdHocSecret } from "@/lib/secrets-client";

/** Key names are restricted by the framework endpoint to [A-Za-z0-9_-]+. */
const KEY_NAME_RE = /^[A-Za-z0-9_-]+$/;

interface KeyFormDialogProps {
  /** When editing, the existing key (its value stays write-only). */
  existing?: AdHocSecret;
  trigger?: React.ReactNode;
}

/**
 * Create/edit dialog for an ad-hoc key.
 *
 * The framework write endpoint always requires a value (it never returns the
 * stored plaintext to pre-fill), so "edit" is really "rotate": the name is
 * locked as the identity, and the user re-enters the value to change the
 * allowlist/description. This is the honest model — there is no metadata-only
 * update seam. The URL allowlist is one origin per line, validated to http(s).
 */
export function KeyFormDialog({ existing, trigger }: KeyFormDialogProps) {
  const isEdit = !!existing;
  const save = useSaveAdHocSecret();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState(existing?.name ?? "");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [allowlistText, setAllowlistText] = useState(
    (existing?.urlAllowlist ?? []).join("\n"),
  );

  // Reset the draft whenever the dialog (re)opens so stale edits never linger.
  useEffect(() => {
    if (open) {
      setName(existing?.name ?? "");
      setValue("");
      setDescription(existing?.description ?? "");
      setAllowlistText((existing?.urlAllowlist ?? []).join("\n"));
    }
  }, [open, existing]);

  function parseAllowlist(): { origins: string[]; error?: string } {
    const lines = allowlistText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const origins: string[] = [];
    for (const line of lines) {
      let url: URL;
      try {
        url = new URL(line);
      } catch {
        return { origins, error: `Not a valid URL: "${line}".` };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          origins,
          error: `Only http/https origins are allowed: "${line}".`,
        };
      }
      if (!origins.includes(url.origin)) origins.push(url.origin);
    }
    return { origins };
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!isEdit && !KEY_NAME_RE.test(trimmedName)) {
      toast.error("Use only letters, numbers, underscores, and hyphens.");
      return;
    }
    // The endpoint requires a value on every write, so editing means re-entering
    // (rotating) the secret — there is no value to preserve on the client.
    if (!value.trim()) {
      toast.error(
        isEdit
          ? "Re-enter the value to update this key."
          : "Enter the secret value.",
      );
      return;
    }

    const { origins, error } = parseAllowlist();
    if (error) {
      toast.error(error);
      return;
    }

    try {
      await save.mutateAsync({
        name: isEdit ? existing.name : trimmedName,
        value,
        description: description.trim() || undefined,
        urlAllowlist: origins,
      });
      toast.success(isEdit ? "Key updated." : "Key created.");
      setOpen(false);
    } catch {
      // useSaveAdHocSecret surfaces the server error via toast.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <IconPlus className="size-4" />
            New key
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit key" : "New key"}</DialogTitle>
            <DialogDescription>
              Reference this key from a routine as{" "}
              <code className="font-mono">{`\${keys.${name || "NAME"}}`}</code>.
              The value is stored securely and never shown again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="SLACK_WEBHOOK"
                className="font-mono"
                disabled={isEdit}
                autoFocus={!isEdit}
              />
              {isEdit ? (
                <p className="text-xs text-muted-foreground">
                  The name is fixed. Delete and recreate to rename.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Letters, numbers, underscores, and hyphens only.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-value">Value</Label>
              <Input
                id="key-value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={
                  isEdit
                    ? `Re-enter to rotate (current ends ••••${existing.last4})`
                    : "Paste the secret value"
                }
                className="font-mono"
                autoComplete="off"
              />
              {isEdit ? (
                <p className="text-xs text-muted-foreground">
                  The stored value can't be shown, so saving replaces it.
                  Re-enter the same value to keep it while changing the
                  allowlist.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-description">
                Description{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="key-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this key is for"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-allowlist">
                URL allowlist{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="key-allowlist"
                value={allowlistText}
                onChange={(event) => setAllowlistText(event.target.value)}
                placeholder={"https://hooks.slack.com\nhttps://api.example.com"}
                rows={3}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                One origin per line. When set, a routine using this key may only
                call these origins; requests elsewhere are blocked. Empty =
                unrestricted.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : null}
              {isEdit ? "Save changes" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
