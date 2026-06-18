import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { User } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import {
  deleteConversation,
  fetchConversation,
  fetchConversations,
  renameConversation,
  streamAsk,
  streamFollowUp,
  type ConversationSummary,
} from "@/lib/api";
import { AppShell } from "@/components/layout/app-shell";
import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/top-nav";
import { SearchHero } from "@/components/search-hero";
import { ChatView, type ChatTab, type Turn } from "@/components/chat-view";
import { DEFAULT_MODEL } from "@/components/model-menu";

export default function Dashboard() {
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [activeTab, setActiveTab] = useState<ChatTab>("answer");

  // Async stream callbacks read the live conversation id / model without re-binding.
  const convIdRef = useRef<string | null>(null);
  const modelRef = useRef<string>(model);
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  // ── Auth guard ──────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        navigate("/auth");
        return;
      }
      setUser(data.session.user);
      setAuthChecked(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUser(null);
        navigate("/auth");
      } else {
        setUser(session.user);
        setAuthChecked(true);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  // ── Load conversation history ─────────────────────────────────────────────
  const refreshConversations = useCallback(() => {
    fetchConversations()
      .then(setConversations)
      .catch((e) => {
        console.error(e);
        setConversations([]);
      })
      .finally(() => setLoadingConversations(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoadingConversations(true);
    refreshConversations();
  }, [user, refreshConversations]);

  // ── Ask / follow-up ───────────────────────────────────────────────────────
  const runTurn = useCallback(
    async (query: string, fresh: boolean) => {
      const id = crypto.randomUUID();
      const turn: Turn = { id, question: query, full: "", status: "streaming" };
      setTurns((prev) => (fresh ? [turn] : [...prev, turn]));
      setBusy(true);

      const onChunk = (full: string) =>
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, full } : t)));

      try {
        const existingId = convIdRef.current;
        const result =
          !fresh && existingId
            ? await streamFollowUp(existingId, query, { onChunk, model: modelRef.current })
            : await streamAsk(query, { onChunk, model: modelRef.current });

        if (result.conversationId) {
          convIdRef.current = result.conversationId;
          setConversationId(result.conversationId);
        }
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done" } : t)));
        refreshConversations();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "error", error: message } : t)),
        );
      } finally {
        setBusy(false);
      }
    },
    [refreshConversations],
  );

  const handleAsk = useCallback(
    (query: string) => {
      setConversationId(null);
      convIdRef.current = null;
      setActiveTab("answer");
      void runTurn(query, true);
    },
    [runTurn],
  );

  const handleFollowUp = useCallback((query: string) => void runTurn(query, false), [runTurn]);

  const handleNewChat = useCallback(() => {
    setTurns([]);
    setConversationId(null);
    convIdRef.current = null;
    setActiveTab("answer");
  }, []);

  const handleSelectConversation = useCallback(async (id: string) => {
    setConversationId(id);
    convIdRef.current = id;
    setActiveTab("answer");
    setBusy(true);
    try {
      const conv = await fetchConversation(id);
      const built: Turn[] = [];
      let current: Turn | null = null;
      for (const m of conv.messages) {
        if (m.role === "user") {
          current = { id: `m-${m.id}`, question: m.content, full: "", status: "done" };
          built.push(current);
        } else if (current) {
          current.full = m.content;
          current = null;
        } else {
          built.push({ id: `m-${m.id}`, question: "", full: m.content, status: "done" });
        }
      }
      setTurns(built);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c))); // optimistic
      try {
        await renameConversation(id, trimmed);
      } catch (e) {
        console.error(e);
      } finally {
        refreshConversations();
      }
    },
    [refreshConversations],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id)); // optimistic remove
      if (convIdRef.current === id) {
        setTurns([]);
        setConversationId(null);
        convIdRef.current = null;
      }
      try {
        await deleteConversation(id);
      } catch (e) {
        console.error(e);
      } finally {
        refreshConversations();
      }
    },
    [refreshConversations],
  );

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  }, [navigate]);

  if (!authChecked || !user) {
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
          onRenameConversation={handleRenameConversation}
          onDeleteConversation={handleDeleteConversation}
          onSignOut={handleSignOut}
        />
      }
      header={
        <TopNav
          mode={inChat ? "chat" : "home"}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
      }
    >
      {inChat ? (
        <ChatView turns={turns} activeTab={activeTab} onFollowUp={handleFollowUp} busy={busy} />
      ) : (
        <SearchHero onSubmit={handleAsk} model={model} onModelChange={setModel} />
      )}
    </AppShell>
  );
}
