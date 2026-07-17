// Tracker navigation views and their URL paths.

export const TRACKER_NAVIGATION_VIEWS = [
  "home", // the board (default)
  "board",
  "projects",
  "item",
  "sprints",
  "sprint",
  "sprint-studio",
  "queue",
  "inbox",
  "new-item",
  "extensions",
  "team",
] as const;

export type TrackerNavigationView = (typeof TRACKER_NAVIGATION_VIEWS)[number];

export interface TrackerNavigationTarget {
  view?: TrackerNavigationView | string | null;
  itemId?: string | null;
  projectId?: string | null;
  sprintId?: string | null;
  /** Sprint Studio's active step rail number (1-7), R4b.2. */
  activeStep?: number | null;
}

export function trackerRoutePath(
  target: TrackerNavigationTarget,
): string | null {
  const itemId = target.itemId ?? undefined;
  const projectId = target.projectId ?? undefined;
  const sprintId = target.sprintId ?? undefined;
  const activeStep = target.activeStep ?? undefined;

  if (!target.view && itemId) return `/items/${encodeURIComponent(itemId)}`;
  if (!target.view && sprintId)
    return sprintId ? `/sprints/${encodeURIComponent(sprintId)}` : null;

  switch (target.view) {
    case "home":
    case "board":
      return projectId
        ? `/board?project=${encodeURIComponent(projectId)}`
        : "/board";
    case "projects":
      return "/projects";
    case "item":
      return itemId ? `/items/${encodeURIComponent(itemId)}` : null;
    case "sprints":
      return "/sprints";
    case "sprint":
      return sprintId ? `/sprints/${encodeURIComponent(sprintId)}` : null;
    case "sprint-studio":
      if (!sprintId) return null;
      return activeStep
        ? `/sprints/${encodeURIComponent(sprintId)}/studio?step=${activeStep}`
        : `/sprints/${encodeURIComponent(sprintId)}/studio`;
    case "queue":
      return "/queue";
    case "inbox":
      return "/inbox";
    case "new-item":
      return "/items/new";
    case "extensions":
      return "/extensions";
    case "team":
      return "/team";
    default:
      return null;
  }
}
