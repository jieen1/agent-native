// Tracker navigation views and their URL paths.

export const TRACKER_NAVIGATION_VIEWS = [
  "home", // the board (default)
  "board",
  "projects",
  "item",
  "extensions",
  "team",
] as const;

export type TrackerNavigationView = (typeof TRACKER_NAVIGATION_VIEWS)[number];

export interface TrackerNavigationTarget {
  view?: TrackerNavigationView | string | null;
  itemId?: string | null;
  projectId?: string | null;
}

export function trackerRoutePath(
  target: TrackerNavigationTarget,
): string | null {
  const itemId = target.itemId ?? undefined;
  const projectId = target.projectId ?? undefined;

  if (!target.view && itemId) return `/items/${encodeURIComponent(itemId)}`;

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
    case "extensions":
      return "/extensions";
    case "team":
      return "/team";
    default:
      return null;
  }
}
