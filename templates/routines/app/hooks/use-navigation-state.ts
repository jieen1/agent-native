import {
  appBasePath,
  appPath,
  markAgentChatHomeHandoff,
  useAgentRouteState,
} from "@agent-native/core/client";
import { useLocation } from "react-router";
import { TAB_ID } from "@/lib/tab-id";

/**
 * Navigation state the agent reads via `view-screen` and writes via `navigate`.
 *
 * `screen` is the high-level view (§8 / ROUTINES_DESIGN): the agent answers
 * "which routines do I have" / "which one am I editing" from `screen` +
 * `routineName`. `view`/`path` are kept for parity with the other framework
 * screens (database/extensions/observability) and the raw URL.
 */
export interface NavigationState {
  screen: string;
  view: string;
  routineName?: string;
  path?: string;
}

export function useNavigationState() {
  const location = useLocation();
  useAgentRouteState<NavigationState>({
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    getNavigationState: ({ pathname }) => {
      const screen = screenForPath(pathname);
      const routineName = routineNameForPath(pathname);
      return {
        screen,
        view: screen,
        ...(routineName ? { routineName } : {}),
        path: appPath(pathname),
      };
    },
    getCommandPath: (command) =>
      routerPath(
        command.path || pathForCommand(command.view, command.routineName),
      ),
    onNavigate: (_command, path) => {
      if (location.pathname === "/" && pathnameFromPath(path) !== "/") {
        markAgentChatHomeHandoff("chat");
      }
    },
  });
}

function pathnameFromPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

/** Map a router pathname to the high-level `screen` the agent reasons about. */
export function screenForPath(pathname: string): string {
  if (pathname === "/routines/keys") return "keys";
  if (pathname === "/routines" || pathname === "/routines/new") {
    return "routines";
  }
  if (pathname.startsWith("/routines/")) {
    return pathname.endsWith("/runs") ? "runs" : "routine-edit";
  }
  if (pathname.startsWith("/database")) return "database";
  if (pathname.startsWith("/extensions")) return "extensions";
  if (pathname.startsWith("/observability")) return "observability";
  if (pathname.startsWith("/team")) return "team";
  return "chat";
}

/** Extract the routine slug from a `/routines/{name}[/runs]` pathname. */
export function routineNameForPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/routines\/([^/]+)(?:\/runs)?$/);
  if (!match) return undefined;
  const name = decodeURIComponent(match[1]);
  // "new" and "keys" are static sibling routes, not routine slugs.
  return name === "new" || name === "keys" ? undefined : name;
}

/** Map an agent `navigate` command (view + routineName) to a router path. */
export function pathForCommand(view?: string, routineName?: string): string {
  switch (view) {
    case "routines":
      return "/routines";
    case "routine-edit":
      return routineName ? `/routines/${routineName}` : "/routines";
    case "runs":
      return routineName ? `/routines/${routineName}/runs` : "/routines";
    case "keys":
      return "/routines/keys";
    case "database":
      return "/database";
    case "extensions":
      return "/extensions";
    case "observability":
      return "/observability";
    case "team":
      return "/team";
    case "chat":
    case "home":
    case "ask":
      return "/";
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
