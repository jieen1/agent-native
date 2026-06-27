import { useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  IconUsers,
  IconMenu2,
  IconX,
  IconMessageCircle,
  IconLayoutKanban,
  IconFolders,
  IconStack2,
  IconListDetails,
} from "@tabler/icons-react";
import { OrgSwitcher } from "@agent-native/core/client/org";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useProjects } from "@/hooks/use-tracker";
import {
  DevDatabaseLink,
  FeedbackButton,
  appPath,
  focusAgentChat,
  navigateWithAgentChatViewTransition,
} from "@agent-native/core/client";
import { ExtensionsSidebarSection } from "@agent-native/core/client/extensions";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projectsData, isLoading } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);

  function navigateHomeChat(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (isMobile) setMobileOpen(false);
    focusAgentChat();
    navigateWithAgentChatViewTransition(navigate, "/");
  }

  function navLink(
    to: string,
    label: string,
    icon: React.ReactNode,
    active: boolean,
  ) {
    return (
      <Link
        to={to}
        onClick={() => isMobile && setMobileOpen(false)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm min-h-[44px]",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 basis-0 truncate">{label}</span>
      </Link>
    );
  }

  const sidebarContent = (
    <div
      className={cn(
        "flex h-screen w-60 min-w-0 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/30",
        isMobile && "w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md text-base font-semibold tracking-tight text-foreground transition-colors hover:text-foreground/80"
          onClick={() => {
            if (isMobile) setMobileOpen(false);
            focusAgentChat();
            navigateWithAgentChatViewTransition(navigate, "/");
          }}
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
          <span className="truncate">Tracker</span>
        </button>
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMobileOpen(false)}
          >
            <IconX size={18} />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-w-0 max-w-full overflow-hidden py-2",
            isMobile ? "w-full" : "w-60",
          )}
        >
          <Link
            to="/"
            onClick={navigateHomeChat}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm min-h-[44px]",
              location.pathname === "/"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <IconMessageCircle size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 basis-0 truncate">Ask Tracker</span>
          </Link>

          {navLink(
            "/board",
            "看板",
            <IconLayoutKanban size={14} className="shrink-0" />,
            location.pathname === "/board",
          )}
          {navLink(
            "/sprints",
            "Sprint",
            <IconStack2 size={14} className="shrink-0" />,
            location.pathname.startsWith("/sprints"),
          )}
          {navLink(
            "/queue",
            "执行队列",
            <IconListDetails size={14} className="shrink-0" />,
            location.pathname === "/queue",
          )}
          {navLink(
            "/projects",
            "项目",
            <IconFolders size={14} className="shrink-0" />,
            location.pathname === "/projects",
          )}

          <div className="mt-2 px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Projects
          </div>
          {isLoading && projects.length === 0
            ? Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2.5 px-3 py-2 min-h-[44px]"
                >
                  <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
                  <Skeleton
                    className="h-3.5"
                    style={{ width: `${50 + ((i * 17) % 40)}%` }}
                  />
                </div>
              ))
            : null}
          {projects.map((p) => (
            <Link
              key={p.id}
              to={`/board?project=${encodeURIComponent(p.id)}`}
              onClick={() => isMobile && setMobileOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm min-h-[44px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              title={p.name}
            >
              <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground/80">
                {p.key}
              </span>
              <span className="min-w-0 flex-1 basis-0 truncate">{p.name}</span>
            </Link>
          ))}
          {!isLoading && projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground/70">
              No projects yet. Create one on the Projects page.
            </p>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-border px-3 py-1.5">
        <Link
          to="/team"
          onClick={() => isMobile && setMobileOpen(false)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm min-h-[44px]",
            location.pathname === "/team"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <IconUsers size={14} className="shrink-0" />
          <span>Team</span>
        </Link>
      </div>

      <div className="shrink-0 border-t border-border px-1.5 py-1.5">
        <ExtensionsSidebarSection />
      </div>

      <div className="shrink-0 space-y-2 border-t border-border px-3 py-2">
        <OrgSwitcher />
        <DevDatabaseLink />
        <div className="flex items-center gap-2">
          <FeedbackButton className="min-w-0 flex-1" />
          <ThemeToggle className="h-9 w-9 shrink-0" />
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-2 left-2 z-40 h-10 w-10 md:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open sidebar"
        >
          <IconMenu2 size={20} />
        </Button>
        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setMobileOpen(false)}
            />
            <div className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw]">
              {sidebarContent}
            </div>
          </>
        )}
      </>
    );
  }

  return sidebarContent;
}
