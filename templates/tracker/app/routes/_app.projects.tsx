import { ProjectsPage } from "@/pages/ProjectsPage";

export function meta() {
  return [{ title: "Projects · Tracker" }];
}

export default function ProjectsRoute() {
  return <ProjectsPage />;
}
