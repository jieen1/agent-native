import { WorkflowEditor } from "@/components/v3/WorkflowEditor";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 新建工作流` }];
}

export default function V3WorkflowNewRoute() {
  return <WorkflowEditor />;
}
