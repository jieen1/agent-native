import { useParams } from "react-router";
import { RunView } from "@/components/v3/RunView";

export default function V3RunDetailRoute() {
  const { runId } = useParams();
  if (!runId) return null;
  return <RunView runId={runId} />;
}
