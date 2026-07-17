import {
  appBasePath,
  markAgentChatHomeHandoff,
  useAgentRouteState,
} from "@agent-native/core/client";
import { trackerRoutePath } from "@shared/navigation";
import { useLocation } from "react-router";

import { TAB_ID } from "@/lib/tab-id";

interface NavigationState {
  view: string;
  itemId?: string;
  projectId?: string;
  sprintId?: string;
  /** Sprint Studio's active step rail number (1-7), R4b.2. */
  activeStep?: number;
}

interface NavigateCommand extends NavigationState {
  path?: string;
  url?: string;
}

function localPathFromCommandUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost";
    const url = new URL(trimmed, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function trackerNavigateCommandPath(
  cmd: NavigateCommand,
): string | null {
  const path =
    localPathFromCommandUrl(cmd.path) ??
    localPathFromCommandUrl(cmd.url) ??
    trackerRoutePath(cmd);
  return path ? routerPath(path) : null;
}

function routerPath(path: string): string {
  const basePath = appBasePath();
  if (!basePath) return path;
  let result = path;
  for (let i = 0; i < 4; i += 1) {
    if (result === basePath) return "/";
    if (result.startsWith(`${basePath}/`)) {
      result = result.slice(basePath.length) || "/";
      continue;
    }
    if (
      result.startsWith(`${basePath}?`) ||
      result.startsWith(`${basePath}#`)
    ) {
      result = `/${result.slice(basePath.length)}`;
      continue;
    }
    break;
  }
  return result;
}

export function useNavigationState() {
  const location = useLocation();

  useAgentRouteState<NavigationState, NavigateCommand>({
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    getNavigationState: ({ pathname, searchParams }) => {
      const state: NavigationState = { view: "board" };

      if (pathname === "/") {
        state.view = "home";
      } else if (pathname === "/items/new") {
        state.view = "new-item";
      } else if (pathname.startsWith("/items/")) {
        const match = pathname.match(/\/items\/([^/]+)/);
        state.view = "item";
        if (match) state.itemId = decodeURIComponent(match[1]);
      } else if (pathname.startsWith("/board")) {
        state.view = "board";
        const projectId = searchParams.get("project");
        if (projectId) state.projectId = projectId;
      } else if (pathname.startsWith("/projects")) {
        state.view = "projects";
      } else if (pathname.startsWith("/team")) {
        state.view = "team";
      } else if (pathname.startsWith("/extensions")) {
        state.view = "extensions";
      } else if (/\/sprints\/[^/]+\/studio/.test(pathname)) {
        const match = pathname.match(/\/sprints\/([^/]+)\/studio/);
        state.view = "sprint-studio";
        if (match) state.sprintId = decodeURIComponent(match[1]);
        const step = Number(searchParams.get("step"));
        if (Number.isFinite(step) && step > 0) state.activeStep = step;
      } else if (pathname.startsWith("/sprints/")) {
        const match = pathname.match(/\/sprints\/([^/]+)/);
        state.view = "sprint";
        if (match) state.sprintId = decodeURIComponent(match[1]);
      } else if (pathname.startsWith("/sprints")) {
        state.view = "sprints";
      } else if (pathname.startsWith("/queue")) {
        state.view = "queue";
      } else if (pathname.startsWith("/inbox")) {
        state.view = "inbox";
      }

      return state;
    },
    getCommandPath: (cmd) => trackerNavigateCommandPath(cmd),
    refetchInterval: 500,
    navigateOptions: { flushSync: true, replace: true },
    onNavigate: (_command, path) => {
      if (location.pathname === "/" && path !== "/") {
        markAgentChatHomeHandoff("tracker");
      }
    },
  });
}
