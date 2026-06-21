import { TodayBriefingPage } from "@/pages/TodayBriefingPage";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Today — ${APP_TITLE}` }];
}

export default function TodayBriefingRoute() {
  return <TodayBriefingPage />;
}
