import { Link, useParams } from "react-router";
import { IconArrowLeft, IconRefresh } from "@tabler/icons-react";
import { useBriefing } from "@/hooks/use-briefings";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { BriefingView } from "@/components/briefings/BriefingView";

/**
 * Detail page for a single briefing (history view). The id comes from the
 * `/briefings/:id` route param; navigation-state writes `briefingId` so the
 * agent's `view-screen` can answer "about this briefing" questions.
 */
export function BriefingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const briefingId = id ?? "";
  const { data, isLoading, error, refetch } = useBriefing(briefingId);

  useSetPageTitle(data?.title ?? "Briefing");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5 pl-2">
          <Link to="/briefings">
            <IconArrowLeft className="size-3.5" />
            Today
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : error || !data ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {error instanceof Error
              ? error.message.replace(/^Action [\w-]+ failed:\s*/, "")
              : "This briefing could not be found, or you don't have access."}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => refetch()}
            >
              <IconRefresh className="size-3.5" />
              Retry
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/briefings">Back to today</Link>
            </Button>
          </div>
        </div>
      ) : (
        <BriefingView briefing={data} />
      )}
    </div>
  );
}
