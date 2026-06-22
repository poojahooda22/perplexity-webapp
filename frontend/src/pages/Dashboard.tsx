import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRequireAuth } from "@/lib/auth-context";
import {
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from "@/hooks/use-conversations";
import { useChat } from "@/hooks/use-chat";
import { AppShell } from "@/components/layout/app-shell";
import { Sidebar } from "@/components/layout/sidebar";
import { TopNav, type Section } from "@/components/layout/top-nav";
import { FinanceView } from "@/components/finance/finance-view";
import { AcademicView } from "@/components/discover/topic-discover-view";
import { HealthView } from "@/components/discover/health-view";
import { SearchHero } from "@/components/search-hero";
import { AssistantView } from "@/components/assistant/assistant-view";
import { ChatView } from "@/components/chat-view";
import { DEFAULT_MODEL } from "@/components/model-menu";
import { RenderProfiler } from "@/lib/render-profiler";

export default function Dashboard() {
  const { user, loading } = useRequireAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Shell-level UI state shared with the top-nav (section) and composer (model).
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [section, setSection] = useState<Section>("Discover");

  const userId = user?.id;

  // Server state: the conversation list lives in the query cache, keyed by user.
  const { data: conversations = [], isLoading: loadingConversations } = useConversations(userId);
  const { mutate: renameMutate } = useRenameConversation(userId);
  const { mutate: deleteMutate } = useDeleteConversation(userId);

  // Chat session: turns, the open conversation, the ask/follow-up/select flow.
  const {
    turns,
    conversationId,
    busy,
    activeTab,
    setActiveTab,
    handleAsk,
    handleFollowUp,
    handleNewChat,
    handleSelectConversation,
    resetIfActive,
  } = useChat({ model, section, userId });

  const handleRename = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (trimmed) renameMutate({ id, title: trimmed });
    },
    [renameMutate],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutate(id);
      resetIfActive(id); // clear the view if the open conversation was the one deleted
    },
    [deleteMutate, resetIfActive],
  );

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  }, [navigate]);

  // Open the Assistant tab when arriving with a hint: ?connected=gmail (post-OAuth callback) or
  // ?tab=assistant (e.g. "Back" from the Connectors page). Then strip the param.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const tab = searchParams.get("tab");
    if (connected || tab === "assistant") setSection("Assistant");
    if (connected || tab) {
      searchParams.delete("connected");
      searchParams.delete("tab");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const inChat = turns.length > 0;

  return (
    <AppShell
      sidebar={
        <RenderProfiler id="Sidebar">
          <Sidebar
            user={user}
            conversations={conversations}
            loadingConversations={loadingConversations}
            activeConversationId={conversationId}
            onNewChat={handleNewChat}
            onSelectConversation={handleSelectConversation}
            onRenameConversation={handleRename}
            onDeleteConversation={handleDelete}
            onSignOut={handleSignOut}
          />
        </RenderProfiler>
      }
      header={
        <RenderProfiler id="TopNav">
          <TopNav
            mode={inChat ? "chat" : "home"}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            section={section}
            onSectionChange={setSection}
          />
        </RenderProfiler>
      }
    >
      {inChat ? (
        <RenderProfiler id="ChatView">
          <ChatView turns={turns} activeTab={activeTab} onFollowUp={handleFollowUp} busy={busy} />
        </RenderProfiler>
      ) : section === "Finance" ? (
        <RenderProfiler id="FinanceView">
          <FinanceView onAsk={handleAsk} />
        </RenderProfiler>
      ) : section === "Academic" ? (
        <RenderProfiler id="AcademicView">
          <AcademicView onAsk={handleAsk} />
        </RenderProfiler>
      ) : section === "Health" ? (
        <RenderProfiler id="HealthView">
          <HealthView onAsk={handleAsk} />
        </RenderProfiler>
      ) : section === "Assistant" ? (
        <RenderProfiler id="AssistantView">
          <AssistantView onSubmit={handleAsk} model={model} onModelChange={setModel} />
        </RenderProfiler>
      ) : (
        <RenderProfiler id="SearchHero">
          <SearchHero onSubmit={handleAsk} model={model} onModelChange={setModel} />
        </RenderProfiler>
      )}
    </AppShell>
  );
}
