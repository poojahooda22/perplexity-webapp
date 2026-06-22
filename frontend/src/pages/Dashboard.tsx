import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
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
import { ChatView } from "@/components/chat-view";
import { DEFAULT_MODEL } from "@/components/model-menu";

export default function Dashboard() {
  const { user, loading } = useRequireAuth();
  const navigate = useNavigate();

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
      }
      header={
        <TopNav
          mode={inChat ? "chat" : "home"}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          section={section}
          onSectionChange={setSection}
        />
      }
    >
      {inChat ? (
        <ChatView turns={turns} activeTab={activeTab} onFollowUp={handleFollowUp} busy={busy} />
      ) : section === "Finance" ? (
        <FinanceView onAsk={handleAsk} />
      ) : section === "Academic" ? (
        <AcademicView onAsk={handleAsk} />
      ) : section === "Health" ? (
        <HealthView onAsk={handleAsk} />
      ) : (
        <SearchHero onSubmit={handleAsk} model={model} onModelChange={setModel} />
      )}
    </AppShell>
  );
}
