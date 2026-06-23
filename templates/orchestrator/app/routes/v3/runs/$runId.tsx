import { useParams } from "react-router";
import { APP_TITLE } from "@/lib/app-config";
import { RunView } from "@/components/v3/RunView";

export function meta() {
  return [{ title: `${APP_TITLE} — V3 Run` }];
}

export default function V3RunViewRoute() {
  const { runId } = useParams<{ runId: string }>();

  if (!runId) return null;

  return <RunView runId={runId} />;
}
