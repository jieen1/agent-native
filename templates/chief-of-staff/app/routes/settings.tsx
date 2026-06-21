import { BriefingSettingsPage } from "@/pages/BriefingSettingsPage";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Briefing settings — ${APP_TITLE}` }];
}

export default function SettingsRoute() {
  return <BriefingSettingsPage />;
}
