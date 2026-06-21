import { Spinner } from "@/components/ui/spinner";
import { BriefingDetailPage } from "@/pages/BriefingDetailPage";
import { PublicBriefingView } from "@/components/briefings/PublicBriefingView";
import { APP_TITLE } from "@/lib/app-config";
import { buildBriefingMetaDescription } from "@shared/briefing-meta-format";
import type { Route } from ".react-router/types/app/routes/+types/briefings.$id";
import { fetchPublicBriefing } from "../../server/lib/briefing-meta.server";

/**
 * Briefing detail route (Phase C / §455, §462).
 *
 * The `loader` runs server-side (global SSR is on) and reads the briefing
 * through the shallow public reader, which returns content ONLY when
 * `visibility === "public"`. When public, the body is server-rendered from
 * loader data so the real title + summary land in the SSR HTML source (the
 * "查 HTML 源含简报正文" gate) and `meta` emits OG tags for unfurls. Private or
 * logged-in briefings get `null` here and fall back to the CSR detail shell,
 * which fetches access-scoped data through `get-briefing`.
 */
export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) return { briefing: null };
  const briefing = await fetchPublicBriefing(id);
  return { briefing };
}

export const meta: Route.MetaFunction = ({ data }) => {
  const briefing = data?.briefing;
  if (!briefing) {
    return [{ title: `Briefing — ${APP_TITLE}` }];
  }
  const title = `${briefing.title} — ${APP_TITLE}`;
  const description = buildBriefingMetaDescription(briefing.summaryMd);
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: briefing.title },
    { property: "og:description", content: description },
    { property: "og:type", content: "article" },
  ];
};

export function HydrateFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <Spinner className="size-8 text-foreground" />
    </div>
  );
}

export default function BriefingDetailRoute({
  loaderData,
}: Route.ComponentProps) {
  // Public briefing: render the curated narrative server-side for anyone
  // (including link-unfurl bots) — no session, no client fetch.
  if (loaderData?.briefing) {
    return <PublicBriefingView briefing={loaderData.briefing} />;
  }
  // Private / logged-in: the CSR shell loads access-scoped detail via
  // `get-briefing` (a ForbiddenError → "not found, or no access").
  return <BriefingDetailPage />;
}
