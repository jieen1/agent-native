import { Navigate } from "react-router";

// The v2 work-item board is the canonical home. The v1 tasks UI is retained
// only as a historical detail route (`/tasks/:id`) for legacy task rows; new
// work flows through the board → /items/:id → /runs/:runId path.
export default function IndexRoute() {
  return <Navigate to="/board" replace />;
}
