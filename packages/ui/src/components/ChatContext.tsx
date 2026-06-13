import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type ChatEvent,
  deleteSession,
  fetchAgents,
  fetchMessages,
  fetchSessions,
  getStoredChatSessionId,
  type Message,
  resolveApproval,
  type SessionRow,
  sendChat,
  setStoredChatSessionId,
  type ToolLogEntry,
  updateSession,
} from "../api";
import { describeError, useToast } from "./Toast";

export interface PendingApproval {
  requestId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
}

/**
 * One-shot request to surface the floating ChatDock. The `nonce` makes each
 * request distinct so the dock can react even when the same `text` is sent
 * twice; `text` (when present) prefills the composer without auto-sending.
 */
export interface DockSignal {
  text?: string;
  nonce: number;
}

export interface ChatStore {
  // Session + transcript
  messages: Message[];
  sessionId: string | undefined;
  sessionKey: string | undefined;
  // Live turn state
  sending: boolean;
  activeTool: string | null;
  activityDesc: string | null;
  /** Assistant text streamed so far this turn (empty when the provider doesn't stream). The final response message supersedes it. */
  streamText: string;
  /** Reasoning/thinking streamed so far this turn (#254). Live display only; the final message carries the persisted trace. */
  streamReasoning: string;
  pendingTools: ToolLogEntry[];
  turnStart: number | null;
  elapsed: number;
  approvals: PendingApproval[];
  // Agent registry + selection
  agents: Record<string, AgentInfo>;
  selectedAgent: string;
  setSelectedAgent: (name: string) => void;
  // Session list (sidebar)
  sessions: SessionRow[];
  refreshSessions: () => void;
  // Actions
  send: (text: string) => void;
  interrupt: () => void;
  newChat: () => void;
  loadSession: (s: SessionRow) => void;
  renameSession: (s: SessionRow, title: string | null) => void;
  togglePin: (s: SessionRow) => void;
  removeSession: (s: SessionRow) => void;
  approve: (requestId: string) => void;
  reject: (requestId: string) => void;
  approveAll: () => void;
  rejectAll: () => void;
  // Request the floating dock open (optionally prefilled). ChatDock subscribes.
  dockSignal: DockSignal | null;
  requestDock: (text?: string) => void;
}

const ChatContext = createContext<ChatStore | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const toast = useToast();

  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionKey, setSessionKey] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [activityDesc, setActivityDesc] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [pendingTools, setPendingTools] = useState<ToolLogEntry[]>([]);
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [selectedAgent, setSelectedAgent] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [dockSignal, setDockSignal] = useState<DockSignal | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const dockNonce = useRef(0);

  const requestDock = useCallback((text?: string) => {
    dockNonce.current += 1;
    setDockSignal({ text, nonce: dockNonce.current });
  }, []);

  // Load agents once.
  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err) => toast.error(`Failed to load agents: ${describeError(err)}`));
  }, [toast]);

  // Restore last-active session on mount so revisiting /chat resumes where
  // we left off. If a route prop later wants to override this, the page
  // calls loadSession() explicitly.
  useEffect(() => {
    const stored = getStoredChatSessionId();
    if (!stored) return;
    fetchMessages(stored)
      .then((msgs) => {
        setSessionId(stored);
        setMessages(msgs);
      })
      .catch(() => {
        // Stored id is stale (db reset, etc.) — drop it silently.
        setStoredChatSessionId(null);
      });
  }, []);

  const refreshSessions = useCallback(() => {
    fetchSessions()
      .then(setSessions)
      .catch((err) => toast.error(`Failed to load sessions: ${describeError(err)}`));
  }, [toast]);

  // Tick elapsed seconds during an in-flight turn.
  useEffect(() => {
    if (turnStart === null) return;
    setElapsed(Math.floor((Date.now() - turnStart) / 1000));
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - turnStart) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [turnStart]);

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || sending) return;
      setSending(true);
      setPendingTools([]);
      setApprovals([]);
      setStreamText("");
      setStreamReasoning("");
      setTurnStart(Date.now());
      setMessages((prev) => [...prev, { role: "user", content: text }]);

      let finalTools: ToolLogEntry[] = [];
      let recalled: { count: number; sources: string[]; pinned?: string[] } | undefined;

      abortRef.current = sendChat(
        text,
        sessionKey,
        (event: ChatEvent) => {
          switch (event.type) {
            case "delta":
              setStreamText((prev) => prev + ((event.data.text as string) ?? ""));
              break;
            case "reasoning":
              setStreamReasoning((prev) => prev + ((event.data.text as string) ?? ""));
              break;
            case "activity":
              setActivityDesc((event.data.description as string | null | undefined) ?? null);
              break;
            case "memory_recalled": {
              recalled = {
                count: (event.data.count as number) ?? 0,
                sources: ((event.data.sources as string[]) ?? []).slice(0, 5),
                pinned: ((event.data.pinned as string[]) ?? []).slice(0, 5),
              };
              break;
            }
            case "approval_request": {
              const req: PendingApproval = {
                requestId: event.data.requestId as string,
                toolName: event.data.toolName as string,
                toolArgs: event.data.toolArgs as Record<string, unknown> | undefined,
                description: event.data.description as string | undefined,
              };
              setApprovals((prev) => (prev.some((a) => a.requestId === req.requestId) ? prev : [...prev, req]));
              break;
            }
            case "tool_call":
              // A new tool round: clear text streamed during the previous
              // provider call (it was that round's reasoning, captured in
              // the tool log / final response, not part of the answer).
              setStreamText("");
              setStreamReasoning("");
              setActiveTool(event.data.name as string);
              setPendingTools((prev) => [
                ...prev,
                {
                  kind: "tool",
                  id: `tc-${Date.now()}-${prev.length}`,
                  name: event.data.name as string,
                  args: event.data.args as Record<string, unknown>,
                },
              ]);
              break;
            case "tool_result": {
              setActiveTool(null);
              const output = event.data.output as string;
              setPendingTools((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  const e = next[i];
                  if (e.kind !== "text" && e.output === undefined) {
                    next[i] = { ...e, output };
                    break;
                  }
                }
                finalTools = next;
                return next;
              });
              break;
            }
            case "response": {
              setActiveTool(null);
              setActivityDesc(null);
              setStreamText("");
              setStreamReasoning("");
              setSending(false);
              setTurnStart(null);
              setApprovals([]);
              abortRef.current = null;
              setSessionKey(event.data.sessionKey as string);
              setSessionId(event.data.sessionId as string);
              setStoredChatSessionId(event.data.sessionId as string);
              setPendingTools((prev) => {
                finalTools = prev;
                return [];
              });
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: event.data.content as string,
                  toolLog: finalTools.length > 0 ? finalTools : undefined,
                  recalled,
                  reasoning: (event.data.reasoning as string | undefined) || undefined,
                },
              ]);
              recalled = undefined;
              break;
            }
            case "error": {
              setActiveTool(null);
              setActivityDesc(null);
              setStreamText("");
              setStreamReasoning("");
              setSending(false);
              setTurnStart(null);
              setApprovals([]);
              abortRef.current = null;
              setPendingTools((prev) => {
                finalTools = prev;
                return [];
              });
              const msg = (event.data.message as string) ?? "Unknown error";
              toast.error(msg);
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `Error: ${msg}`,
                  toolLog: finalTools.length > 0 ? finalTools : undefined,
                },
              ]);
              break;
            }
          }
        },
        selectedAgent || undefined,
      );
    },
    [sending, sessionKey, selectedAgent, toast],
  );

  const interrupt = useCallback(() => {
    if (!sending) return;
    for (const a of approvals) {
      resolveApproval(a.requestId, false, "interrupted by user").catch(() => {});
    }
    setApprovals([]);
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveTool(null);
    setActivityDesc(null);
    setStreamText("");
    setStreamReasoning("");
    setSending(false);
    setTurnStart(null);
    const tools = pendingTools;
    setPendingTools([]);
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "[Interrupted]",
        toolLog: tools.length > 0 ? tools : undefined,
      },
    ]);
  }, [sending, approvals, pendingTools]);

  const newChat = useCallback(() => {
    setMessages([]);
    setSessionKey(undefined);
    setSessionId(undefined);
    setStoredChatSessionId(null);
  }, []);

  const loadSession = useCallback(
    (s: SessionRow) => {
      setSessionId(s.id);
      setSessionKey(s.key ?? undefined);
      setStoredChatSessionId(s.id);
      setMessages([]);
      fetchMessages(s.id)
        .then(setMessages)
        .catch((err) => toast.error(`Failed to load session: ${describeError(err)}`));
    },
    [toast],
  );

  const renameSession = useCallback(
    (s: SessionRow, title: string | null) => {
      updateSession(s.id, { title })
        .then((updated) => setSessions((prev) => prev.map((row) => (row.id === updated.id ? updated : row))))
        .catch((err) => toast.error(`Rename failed: ${describeError(err)}`));
    },
    [toast],
  );

  const togglePin = useCallback(
    (s: SessionRow) => {
      updateSession(s.id, { pinned: !s.pinned })
        .then((updated) =>
          setSessions((prev) =>
            [...prev.map((row) => (row.id === updated.id ? updated : row))].sort(
              (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated_at.localeCompare(a.updated_at),
            ),
          ),
        )
        .catch((err) => toast.error(`Pin failed: ${describeError(err)}`));
    },
    [toast],
  );

  const removeSession = useCallback(
    (s: SessionRow) => {
      deleteSession(s.id)
        .then(() => {
          setSessions((prev) => prev.filter((row) => row.id !== s.id));
          if (sessionId === s.id) {
            setMessages([]);
            setSessionId(undefined);
            setSessionKey(undefined);
            setStoredChatSessionId(null);
          }
        })
        .catch((err) => toast.error(`Delete failed: ${describeError(err)}`));
    },
    [sessionId, toast],
  );

  const approve = useCallback((requestId: string) => {
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    resolveApproval(requestId, true).catch(() => {});
  }, []);

  const reject = useCallback((requestId: string) => {
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    resolveApproval(requestId, false, "rejected by user").catch(() => {});
  }, []);

  const approveAll = useCallback(() => {
    const ids = approvals.map((a) => a.requestId);
    setApprovals([]);
    for (const id of ids) resolveApproval(id, true).catch(() => {});
  }, [approvals]);

  const rejectAll = useCallback(() => {
    const ids = approvals.map((a) => a.requestId);
    setApprovals([]);
    for (const id of ids) resolveApproval(id, false, "rejected by user").catch(() => {});
  }, [approvals]);

  const value = useMemo<ChatStore>(
    () => ({
      messages,
      sessionId,
      sessionKey,
      sending,
      activeTool,
      activityDesc,
      streamText,
      streamReasoning,
      pendingTools,
      turnStart,
      elapsed,
      approvals,
      agents,
      selectedAgent,
      setSelectedAgent,
      sessions,
      refreshSessions,
      send,
      interrupt,
      newChat,
      loadSession,
      renameSession,
      togglePin,
      removeSession,
      approve,
      reject,
      approveAll,
      rejectAll,
      dockSignal,
      requestDock,
    }),
    [
      messages,
      sessionId,
      sessionKey,
      sending,
      activeTool,
      activityDesc,
      streamText,
      streamReasoning,
      pendingTools,
      turnStart,
      elapsed,
      approvals,
      agents,
      selectedAgent,
      sessions,
      refreshSessions,
      send,
      interrupt,
      newChat,
      loadSession,
      renameSession,
      togglePin,
      removeSession,
      approve,
      reject,
      approveAll,
      rejectAll,
      dockSignal,
      requestDock,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatStore(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatStore must be used inside <ChatProvider>");
  return ctx;
}
