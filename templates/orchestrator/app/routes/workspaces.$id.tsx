import { useParams } from "react-router";

import { WorkspaceView } from "@/components/v3/WorkspaceView";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — Workspace` }];
}

export default function V3WorkspaceDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <WorkspaceView workspaceId={id} />;
}
