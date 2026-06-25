import {
  AgentChatHome,
  appPath,
  markAgentChatHomeHandoff,
  navigateWithAgentChatViewTransition,
} from "@agent-native/core/client";
import { IconArrowRight, IconLayoutKanban, IconFolders } from "@tabler/icons-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TAB_ID } from "@/lib/tab-id";

const SEO_TITLE = "Tracker - Projects, work items, and orchestrator dispatch";
const SEO_DESCRIPTION =
  "Track requirements and tasks, configure repo/branch once per project, and dispatch work items to the orchestrator's Claude Code brain for autonomous execution.";

export function meta() {
  return [
    { title: SEO_TITLE },
    { name: "description", content: SEO_DESCRIPTION },
    { property: "og:title", content: SEO_TITLE },
    { property: "og:description", content: SEO_DESCRIPTION },
    { name: "twitter:card", content: "summary" },
  ];
}

export default function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleChatRunning(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.isRunning === true) markAgentChatHomeHandoff("tracker");
    }
    window.addEventListener("agentNative.chatRunning", handleChatRunning);
    return () =>
      window.removeEventListener("agentNative.chatRunning", handleChatRunning);
  }, []);

  function openBoard() {
    markAgentChatHomeHandoff("tracker");
    navigateWithAgentChatViewTransition(navigate, "/board");
  }

  return (
    <div className="relative h-[100dvh] min-h-0 overflow-hidden bg-background">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-16 items-center justify-between px-4 sm:px-6">
        <TooltipProvider delayDuration={700}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Open board"
                className="pointer-events-auto flex items-center gap-2 rounded-md text-sm font-semibold text-foreground transition-colors hover:text-foreground/80"
                onClick={openBoard}
              >
                <img
                  src={appPath("/agent-native-icon-light.svg")}
                  alt=""
                  aria-hidden="true"
                  className="block h-4 w-auto shrink-0 dark:hidden"
                />
                <img
                  src={appPath("/agent-native-icon-dark.svg")}
                  alt=""
                  aria-hidden="true"
                  className="hidden h-4 w-auto shrink-0 dark:block"
                />
                Tracker
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open board</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="pointer-events-auto flex items-center gap-1.5">
          <ThemeToggle />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={openBoard}
          >
            Board
            <IconArrowRight className="size-3.5" />
          </Button>
        </div>
      </header>
      <AgentChatHome
        className="relative z-10 h-full min-h-0 overflow-hidden px-4 py-0 sm:px-6 sm:py-0"
        contentClassName="h-full min-h-0 max-w-4xl"
        surfaceClassName="border-0 bg-transparent shadow-none"
        defaultMode="chat"
        storageKey="tracker"
        browserTabId={TAB_ID}
        showHeader={false}
        showTabBar={false}
        dynamicSuggestions={false}
        suggestions={[]}
        emptyStateText="Ask Tracker to create a project, add work items, or dispatch to the orchestrator."
        emptyStateDisplay="hidden"
        centerComposerWhenEmpty
        composerLayoutVariant="hero"
        composerPlaceholder="Create a project, add a work item, or dispatch one to the orchestrator..."
        composerSlot={
          <div className="mx-auto mb-4 max-w-2xl text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              What do you want to track?
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Configure a project's repo once, drop in requirements, and dispatch
              them to the orchestrator's CC brain.
            </p>
            <div
              className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              <span className="inline-flex items-center gap-1.5">
                <IconFolders className="size-3.5" />
                projects
              </span>
              <span className="inline-flex items-center gap-1.5">
                <IconLayoutKanban className="size-3.5" />
                work items
              </span>
            </div>
          </div>
        }
      />
    </div>
  );
}
