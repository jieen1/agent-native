import {
  AgentChatHome,
  appPath,
  markAgentChatHomeHandoff,
  navigateWithAgentChatViewTransition,
} from "@agent-native/core/client";
import {
  IconArrowRight,
  IconLayoutKanban,
  IconFolders,
} from "@tabler/icons-react";
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

const SEO_TITLE = "Tracker - 项目、工作项与编排器调度";
const SEO_DESCRIPTION =
  "跟踪需求与任务,为每个项目一次性配置仓库/分支,并将工作项调度给编排器的 Claude Code 大脑以自主执行。";

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
                aria-label="打开看板"
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
            <TooltipContent side="bottom">打开看板</TooltipContent>
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
            看板
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
        emptyStateText="让 Tracker 创建项目、添加工作项,或调度给编排器。"
        emptyStateDisplay="hidden"
        centerComposerWhenEmpty
        composerLayoutVariant="hero"
        composerPlaceholder="创建项目、添加工作项,或将其调度给编排器……"
        composerSlot={
          <div className="mx-auto mb-4 max-w-2xl text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              你想跟踪什么?
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              为项目一次性配置好仓库,填入需求,然后将它们调度给编排器的 CC 大脑。
            </p>
            <div
              className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              <span className="inline-flex items-center gap-1.5">
                <IconFolders className="size-3.5" />
                项目
              </span>
              <span className="inline-flex items-center gap-1.5">
                <IconLayoutKanban className="size-3.5" />
                工作项
              </span>
            </div>
          </div>
        }
      />
    </div>
  );
}
