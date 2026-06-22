import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { fetchConversation, streamAsk, streamFollowUp, type Attachment } from "@/lib/api";
import type { ChatTab, Turn } from "@/components/chat-view";
import type { Section } from "@/components/layout/top-nav";
import { conversationsKey } from "@/hooks/use-conversations";

interface UseChatOptions {
  /** Current model id; read at send-time so streaming uses the live value. */
  model: string;
  /** Current section; maps to the server-side vertical at send-time. */
  section: Section;
  /** Owner — used to invalidate that user's conversation list after a turn. */
  userId: string | undefined;
}

/**
 * The chat session: turns, the active conversation, busy state, and the ask/follow-up/select
 * flow that every vertical funnels through. Encapsulates the ref-mirroring needed so the async
 * stream callback reads live model/section/conversationId without re-binding the handlers — so
 * every returned function is referentially stable (lets the shell memoize Sidebar/TopNav).
 */
export function useChat({ model, section, userId }: UseChatOptions) {
  const qc = useQueryClient();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<ChatTab>("answer");

  // Refs mirror live values so runTurn's async closure reads them at send-time without
  // depending on them (keeps the handlers stable across model/section/conversation changes).
  const convIdRef = useRef<string | null>(null);
  const modelRef = useRef(model);
  const sectionRef = useRef(section);
  const userIdRef = useRef(userId);
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    sectionRef.current = section;
  }, [section]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const runTurn = useCallback(
    async (query: string, fresh: boolean, attachments?: Attachment[]) => {
      const id = crypto.randomUUID();
      const turn: Turn = { id, question: query, full: "", status: "streaming" };
      setTurns((prev) => (fresh ? [turn] : [...prev, turn]));
      setBusy(true);

      const onChunk = (full: string) =>
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, full } : t)));

      try {
        // Finance → tool-calling finance agent, Assistant → connected-tools agent, else the
        // Discover web-search path. Streaming + persistence + history are shared across all.
        const vertical =
          sectionRef.current === "Finance"
            ? "finance"
            : sectionRef.current === "Assistant"
              ? "assistant"
              : "discover";
        const existingId = convIdRef.current;
        const result =
          !fresh && existingId
            ? await streamFollowUp(existingId, query, { onChunk, model: modelRef.current, attachments, vertical })
            : await streamAsk(query, { onChunk, model: modelRef.current, attachments, vertical });

        if (result.conversationId) {
          convIdRef.current = result.conversationId;
          setConversationId(result.conversationId);
        }
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done" } : t)));
        // A new thread / auto-title may have changed the list — reconcile the cache.
        qc.invalidateQueries({ queryKey: conversationsKey(userIdRef.current) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "error", error: message } : t)),
        );
      } finally {
        setBusy(false);
      }
    },
    [qc],
  );

  const handleAsk = useCallback(
    (query: string, attachments?: Attachment[]) => {
      setConversationId(null);
      convIdRef.current = null;
      setActiveTab("answer");
      void runTurn(query, true, attachments);
    },
    [runTurn],
  );

  const handleFollowUp = useCallback(
    (query: string, attachments?: Attachment[]) => void runTurn(query, false, attachments),
    [runTurn],
  );

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

  /** If the given (now-deleted) conversation is the open one, clear the chat view. */
  const resetIfActive = useCallback((id: string) => {
    if (convIdRef.current === id) {
      setTurns([]);
      setConversationId(null);
      convIdRef.current = null;
    }
  }, []);

  return {
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
  };
}