import { BriefingHistoryPage } from "@/pages/BriefingHistoryPage";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Briefing History — ${APP_TITLE}` }];
}

export default function BriefingHistoryRoute() {
  return <BriefingHistoryPage />;
}
