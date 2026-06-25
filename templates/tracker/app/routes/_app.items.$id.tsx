import { WorkItemDetailPage } from "@/pages/WorkItemDetailPage";

export function meta() {
  return [{ title: "Work item · Tracker" }];
}

export default function WorkItemRoute() {
  return <WorkItemDetailPage />;
}
