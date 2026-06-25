import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { HeaderActionsProvider } from "./HeaderActions";
import {
  AgentSidebar,
  focusAgentChat,
  navigateWithAgentChatViewTransition,
  useAgentChatHomeHandoff,
} from "@agent-native/core/client";
import { InvitationBanner } from "@agent-native/core/client/org";
import { TAB_ID } from "@/lib/tab-id";

const NO_HEADER_PREFIXES = ["/extensions"];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const chatHomeHandoffActive = useAgentChatHomeHandoff({
    storageKey: "tracker",
    activePath: location.pathname,
  });

  // Bind chat to the currently-open work item (/items/:id) so the agent shares
  // a thread with the item the user is looking at.
  const itemScope = useMemo(() => {
    const match = location.pathname.match(/^\/items\/([^/]+)/);
    const itemId = match?.[1];
    if (!itemId) return null;
    return { type: "work-item" as const, id: itemId };
  }, [location.pathname]);
  const sidebarScope = chatHomeHandoffActive ? null : itemScope;

  const showHeader = !NO_HEADER_PREFIXES.some((prefix) =>
    location.pathname.startsWith(prefix),
  );

  function openAskAgentFullscreen() {
    focusAgentChat();
    navigateWithAgentChatViewTransition(navigate, "/");
  }

  return (
    <HeaderActionsProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <AgentSidebar
          position="right"
          defaultOpen
          chatViewTransition
          storageKey="tracker"
          browserTabId={TAB_ID}
          openOnChatRunning={chatHomeHandoffActive}
          onFullscreenRequest={openAskAgentFullscreen}
          emptyStateText="Ask me anything about your projects and work items"
          suggestions={[
            "Create a project for my repo",
            "Add a work item with a requirement",
            "Dispatch this item to the orchestrator",
          ]}
          scope={sidebarScope}
        >
          <div className="flex h-full flex-1 flex-col overflow-hidden">
            {showHeader ? <Header /> : null}
            <InvitationBanner />
            <main className="flex-1 overflow-auto">{children}</main>
          </div>
        </AgentSidebar>
      </div>
    </HeaderActionsProvider>
  );
}
