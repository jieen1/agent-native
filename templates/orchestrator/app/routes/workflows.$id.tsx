import { useParams } from "react-router";
import { APP_TITLE } from "@/lib/app-config";
import { WorkflowEditor } from "@/components/v3/WorkflowEditor";

export function meta() {
  return [{ title: `${APP_TITLE} — 工作流编辑` }];
}

export default function V3WorkflowDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  // Keyed by id so navigating directly between two templates (e.g. Save's
  // redirect to the newly-created version) fully remounts the editor instead
  // of reusing state seeded from the previous template.
  return <WorkflowEditor key={id} templateId={id} />;
}
