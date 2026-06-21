import {
  appBasePath,
  appPath,
  markAgentChatHomeHandoff,
  useAgentRouteState,
} from "@agent-native/core/client";
import { useLocation } from "react-router";
import { TAB_ID } from "@/lib/tab-id";

export interface NavigationState {
  view: string;
  path?: string;
  /** Briefing id when the user is viewing a specific briefing's detail page. */
  briefingId?: string;
  /** Briefing date (YYYY-MM-DD) the today panel is scoped to. */
  date?: string;
}

/** Local-timezone YYYY-MM-DD. The today panel scopes to this date. */
function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Extract the briefing id from a /briefings/:id pathname, if present. */
function briefingIdFromPath(pathname: string): string | undefined {
  const match = /^\/briefings\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function useNavigationState() {
  const location = useLocation();
  useAgentRouteState<NavigationState>({
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    getNavigationState: ({ pathname }) => {
      const view = viewForPath(pathname);
      if (view === "briefing") {
        const briefingId = briefingIdFromPath(pathname);
        return {
          view,
          path: appPath(pathname),
          // Detail page carries the open briefing id; the today panel
          // (/briefings) instead scopes to today's date.
          ...(briefingId ? { briefingId } : { date: todayLocalDate() }),
        };
      }
      return {
        view,
        path: appPath(pathname),
      };
    },
    getCommandPath: (command) =>
      routerPath(command.path || pathForView(command.view)),
    onNavigate: (_command, path) => {
      if (location.pathname === "/" && pathnameFromPath(path) !== "/") {
        markAgentChatHomeHandoff("chief-of-staff");
      }
    },
  });
}

function pathnameFromPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

function viewForPath(pathname: string): string {
  if (pathname.startsWith("/briefings")) return "briefing";
  if (pathname.startsWith("/database")) return "database";
  if (pathname.startsWith("/extensions")) return "extensions";
  if (pathname.startsWith("/observability")) return "observability";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/team")) return "team";
  return "chat";
}

function pathForView(view?: string): string {
  switch (view) {
    case "chat":
    case "home":
    case "ask":
      return "/";
    case "briefing":
      return "/briefings";
    case "database":
      return "/database";
    case "extensions":
      return "/extensions";
    case "observability":
      return "/observability";
    case "settings":
      return "/settings";
    case "team":
      return "/team";
    default:
      return "/";
  }
}

function routerPath(path: string): string {
  const basePath = appBasePath();
  if (!basePath) return path;
  if (path === basePath) return "/";
  if (path.startsWith(`${basePath}/`)) {
    return path.slice(basePath.length) || "/";
  }
  return path;
}
