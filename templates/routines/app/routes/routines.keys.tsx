import { useState } from "react";
import { Link } from "react-router";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconKey,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconDotsVertical } from "@tabler/icons-react";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { KeyFormDialog } from "@/components/routines/KeyFormDialog";
import {
  useAdHocSecrets,
  useDeleteAdHocSecret,
} from "@/hooks/use-adhoc-secrets";
import type { AdHocSecret } from "@/lib/secrets-client";

export function meta() {
  return [{ title: "Keys" }];
}

export default function KeysPage() {
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">Keys</h1>,
  );
  const { data, isLoading, isError, error, refetch, isFetching } =
    useAdHocSecrets();
  const deleteKey = useDeleteAdHocSecret();
  const [pendingDelete, setPendingDelete] = useState<AdHocSecret | null>(null);

  const secrets = data ?? [];

  async function handleConfirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    await deleteKey.mutateAsync(target.name);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/routines">
          <IconArrowLeft className="size-4" />
          Routines
        </Link>
      </Button>

      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Keys</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Secrets your routines can use as{" "}
            <code className="font-mono">{"${keys.NAME}"}</code> in web requests.
            Values are stored securely and never shown again; set a URL
            allowlist to limit where each key may be sent.
          </p>
        </div>
        <KeyFormDialog />
      </header>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorState
          message={
            error instanceof Error ? error.message : "Could not load keys."
          }
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : secrets.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2.5">
          {secrets.map((secret) => (
            <KeyRow
              key={secret.name}
              secret={secret}
              onDelete={() => setPendingDelete(secret)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete key?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be permanently removed. Routines referencing $\{keys.${pendingDelete.name}} will fail until you recreate it.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleConfirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface KeyRowProps {
  secret: AdHocSecret;
  onDelete: () => void;
}

function KeyRow({ secret, onDelete }: KeyRowProps) {
  const allowlist = secret.urlAllowlist ?? [];
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">
            {secret.name}
          </span>
          <Badge variant="secondary" className="gap-1 font-normal">
            <IconKey className="size-3" />
            ••••{secret.last4}
          </Badge>
          {secret.scope === "workspace" ? (
            <Badge variant="outline" className="font-normal">
              Workspace
            </Badge>
          ) : null}
        </div>
        {secret.description ? (
          <p className="truncate text-xs text-muted-foreground">
            {secret.description}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <IconWorld className="size-3.5 shrink-0" />
          {allowlist.length === 0 ? (
            <span>Any origin (no allowlist)</span>
          ) : (
            allowlist.map((origin) => (
              <Badge
                key={origin}
                variant="outline"
                className="max-w-[18rem] truncate font-mono font-normal"
              >
                {origin}
              </Badge>
            ))
          )}
        </div>
      </div>

      <div className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Options for ${secret.name}`}
            >
              <IconDotsVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <KeyFormDialog
              existing={secret}
              trigger={
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <IconPencil className="size-4" />
                  Edit
                </DropdownMenuItem>
              }
            />
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
              onSelect={onDelete}
            >
              <IconTrash className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
          <IconKey className="size-5 text-muted-foreground" />
        </div>
        <CardTitle className="text-base">No keys yet</CardTitle>
        <CardDescription>
          Add a key to let a routine call an external service securely without
          pasting the secret into its instructions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center pb-6">
        <KeyFormDialog
          trigger={
            <Button>
              <IconPlus className="size-4" />
              Add your first key
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

function ErrorState({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-destructive/10">
          <IconAlertTriangle className="size-5 text-destructive" />
        </div>
        <CardTitle className="text-base">Could not load keys</CardTitle>
        <CardDescription className="break-words">{message}</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center pb-6">
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <IconRefresh className="size-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-2.5">
      {[0, 1].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-8 rounded-md" />
        </li>
      ))}
    </ul>
  );
}
