import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type ChatEvent,
  deleteSession,
  fetchAgents,
  fetchMessages,
  fetchSessions,
  getStoredChatSessionId,
  getStoredChatSessionKey,
  type Message,
  resolveApproval,
  type SessionRow,
  sendChat,
  setStoredChatSessionId,
  type ToolLogEntry,
  updateSession,
} from "../api";
import type { ComponentSpec, MediaRef } from "../lib/content.js";
import { agentOfKey, draftKey, latestWith, newChatKey, rowFor } from "../lib/conversations";
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
  /** The agent the conversation on screen is with; "" is the default agent. */
  selectedAgent: string;
  /**
   * Talk to another agent: the conversation you left it in comes back, or
   * your latest with it, or a new one starts (always new with `fresh`). Never
   * the last agent's conversation. While a reply is on its way, typed or
   * spoken, the switch waits for it; asking for the agent you are already
   * talking to calls a waiting switch off. `draft` is words written for the
   * conversation you go to, ready to send there once it is on screen: never
   * in the one you are leaving, nor under its name while the switch waits.
   */
  setSelectedAgent: (name: string, opts?: { fresh?: boolean; draft?: string }) => void;
  /** The agent a switch is waiting to go to, until the reply on its way is done; null when none is. */
  nextAgent: string | null;
  /** A spoken turn is on its way, or not: a switch waits for it as for a typed reply. */
  setSpeaking: (speaking: boolean) => void;
  /**
   * What you have typed in the conversation on screen and not sent. Each conversation keeps its own, so moving to
   * another agent, by any way the chat moves, never takes it along, and coming back finds it where you left it.
   */
  draft: string;
  setDraft: (text: string | ((was: string) => string)) => void;
  // Session list (sidebar)
  sessions: SessionRow[];
  refreshSessions: () => void;
  // Actions
  send: (text: string, media?: MediaRef[]) => void;
  interrupt: () => void;
  newChat: () => void;
  /**
   * Open a conversation; `draft` is words written for it, ready to send there. `fromNew` says it is the new chat
   * on screen, now started (a spoken turn gave it its id): what was typed and attached in it goes along.
   */
  loadSession: (s: SessionRow, opts?: { draft?: string; fromNew?: boolean }) => void;
  /**
   * Called whenever a conversation turns out to be another, by `draftKey` (a new chat getting its id), so that
   * whatever else is kept for each conversation, such as files attached, can follow its words. Returns the undo.
   */
  onDraftMoved: (fn: (from: string, to: string) => void) => () => void;
  renameSession: (s: SessionRow, title: string | null) => void;
  togglePin: (s: SessionRow) => void;
  removeSession: (s: SessionRow) => void;
  approve: (requestId: string) => void;
  reject: (requestId: string) => void;
  approveAll: () => void;
  rejectAll: () => void;
  /**
   * What a page showing the agent's body adds to each typed turn: the body,
   * so the agent may move it, and where its cues go. Cleared with `{}`.
   */
  setTurnExtras: (extras: TurnExtras) => void;
  // Request the floating dock open (optionally prefilled). ChatDock subscribes.
  dockSignal: DockSignal | null;
  requestDock: (text?: string) => void;
}

export interface TurnExtras {
  body?: unknown;
  onCue?: (cue: { name: string; target?: string }) => void;
}

const ChatContext = createContext<ChatStore | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const toast = useToast();

  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionKey, setSessionKey] = useState<string | undefined>();
  // Read when a turn is sent, not rendered: a ref keeps the page from re-rendering the store.
  const turnExtras = useRef<TurnExtras>({});
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
  const [selectedAgent, setAgent] = useState("");
  const [nextAgent, setNextAgent] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [dockSignal, setDockSignal] = useState<DockSignal | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const dockNonce = useRef(0);
  // Moved on by every switch, opened conversation and message sent: a latest
  // conversation that turns up after any of them is too late to open.
  const turns = useRef(0);
  // Moved on by every conversation opened or let go of: messages that turn up after either are another one's.
  const opened = useRef(0);
  /** A switch asked for while a reply was on its way, with any words written for where it goes. */
  const queued = useRef<{ name: string; fresh: boolean; draft?: string } | null>(null);
  // A reply on its way, typed or spoken: a switch waits for it.
  const busy = sending || speaking;
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const agentNow = useRef(selectedAgent);
  agentNow.current = selectedAgent;
  const shownNow = useRef<{ id: string; key: string | null } | null>(null);
  shownNow.current = sessionId ? { id: sessionId, key: sessionKey ?? null } : null;
  /** Where you left each agent: the conversation you were in with it, or a new one you hadn't written in yet. */
  const left = useRef(new Map<string, { id: string; key: string | null } | "fresh">());
  /** What is typed in each conversation and not sent, by `draftKey`. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const here = draftKey(selectedAgent, sessionId);
  const draft = drafts[here] ?? "";
  const putDraft = useCallback((key: string, text: string | ((was: string) => string)) => {
    setDrafts((all) => {
      const was = all[key] ?? "";
      const next = typeof text === "function" ? text(was) : text;
      if (next === was) return all;
      const { [key]: _, ...rest } = all;
      return next ? { ...rest, [key]: next } : rest;
    });
  }, []);
  /** Told when a conversation turns out to be another, so what else is kept for each follows. */
  const draftMoved = useRef(new Set<(from: string, to: string) => void>());
  const onDraftMoved = useCallback((fn: (from: string, to: string) => void) => {
    draftMoved.current.add(fn);
    return () => {
      draftMoved.current.delete(fn);
    };
  }, []);
  /**
   * A conversation turned out to be another: a new one got its id, or a turn moved it. What was typed goes along,
   * after any words already waiting there, so neither is lost.
   */
  const moveDraft = useCallback((from: string, to: string) => {
    if (from === to) return;
    setDrafts((all) => {
      const text = all[from];
      if (!text) return all;
      const { [from]: _, ...rest } = all;
      const there = rest[to];
      return { ...rest, [to]: there ? `${there} ${text}` : text };
    });
    for (const fn of draftMoved.current) fn(from, to);
  }, []);
  const setDraft = useCallback((text: string | ((was: string) => string)) => putDraft(here, text), [putDraft, here]);

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
    // The key too: it is what the next message continues this conversation by.
    const storedKey = getStoredChatSessionKey();
    fetchMessages(stored)
      .then((msgs) => {
        setSessionId(stored);
        setMessages(msgs);
        if (storedKey) setSessionKey(storedKey);
        // Who it is with, so the next message goes to them and not to the default agent.
        const who = agentOfKey(storedKey);
        if (who !== undefined) setAgent(who);
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
    (text: string, media?: MediaRef[]) => {
      // An image with no caption is a real message — requiring text here would
      // repeat the bug this feature exists to fix.
      if ((!text.trim() && !media?.length) || sending) return;
      turns.current++;
      setSending(true);
      setPendingTools([]);
      setApprovals([]);
      setStreamText("");
      setStreamReasoning("");
      setTurnStart(Date.now());
      // Echo the turn locally exactly as the server will store it: a plain
      // string when there is no media, parts when there is.
      const localContent = media?.length
        ? {
            parts: [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...media.map((m) => ({ type: "media" as const, media: m })),
            ],
          }
        : text;
      setMessages((prev) => [...prev, { role: "user", content: localContent }]);

      let finalTools: ToolLogEntry[] = [];
      let recalled: { count: number; sources: string[]; pinned?: string[] } | undefined;
      // Components the turn's tools sent, by id so an update replaces in place.
      const components = new Map<string, ComponentSpec>();

      // A new conversation is named for the agent it is with, so it can be found again by going to them.
      const key = sessionKey ?? (sessionId ? undefined : newChatKey(selectedAgent));
      abortRef.current = sendChat(
        text,
        key,
        (event: ChatEvent) => {
          switch (event.type) {
            case "cue":
              if (typeof event.data.name === "string")
                turnExtras.current.onCue?.({
                  name: event.data.name,
                  ...(typeof event.data.target === "string" ? { target: event.data.target } : {}),
                });
              break;
            case "delta":
              setStreamText((prev) => prev + ((event.data.text as string) ?? ""));
              break;
            case "reasoning":
              setStreamReasoning((prev) => prev + ((event.data.text as string) ?? ""));
              break;
            case "activity":
              setActivityDesc((event.data.description as string | null | undefined) ?? null);
              break;
            case "component": {
              const spec = event.data as unknown as ComponentSpec;
              if (spec?.id) components.set(spec.id, spec);
              break;
            }
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
              // The conversation this turn was sent in, now named: anything written for it meanwhile stays with it.
              moveDraft(draftKey(selectedAgent, sessionId), draftKey(selectedAgent, event.data.sessionId as string));
              setSessionKey(event.data.sessionKey as string);
              setSessionId(event.data.sessionId as string);
              setStoredChatSessionId(event.data.sessionId as string, (event.data.sessionKey as string) ?? null);
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
                  ...(components.size > 0 ? { components: [...components.values()] } : {}),
                  ...(Array.isArray(event.data.media) && event.data.media.length
                    ? { turnMedia: event.data.media as MediaRef[] }
                    : {}),
                },
              ]);
              recalled = undefined;
              components.clear();
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
        media?.map((m) => m.id),
        turnExtras.current.body,
        // No key for the conversation on screen (restored from an older link):
        // name it by id, so the message continues it instead of starting anew.
        sessionKey ? undefined : sessionId,
      );
    },
    [sending, sessionKey, sessionId, selectedAgent, toast, moveDraft],
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
    turns.current++;
    opened.current++;
    setMessages([]);
    setSessionKey(undefined);
    setSessionId(undefined);
    setStoredChatSessionId(null);
  }, []);

  const loadSession = useCallback(
    (s: SessionRow, opts?: { draft?: string; fromNew?: boolean }) => {
      if (opts?.draft !== undefined) putDraft(draftKey("", s.id), opts.draft);
      // A conversation whose key says who it is with goes on with them.
      const who = agentOfKey(s.key);
      // The new chat on screen, started: it is this conversation now, and what was written in it is this one's.
      if (opts?.fromNew) moveDraft(draftKey(who ?? agentNow.current, undefined), draftKey("", s.id));
      turns.current++;
      const mine = ++opened.current;
      setSessionId(s.id);
      setSessionKey(s.key ?? undefined);
      setStoredChatSessionId(s.id, s.key ?? null);
      // Opening a conversation with another agent is leaving the one on screen, as switching is: going back to
      // that agent finds it, and what was typed in it.
      const leaving = who !== undefined && who !== agentNow.current;
      if (leaving && (shownNow.current || draftsNow.current[draftKey(agentNow.current, undefined)]))
        left.current.set(agentNow.current, shownNow.current ?? "fresh");
      if (who !== undefined) setAgent(who);
      setMessages([]);
      fetchMessages(s.id)
        .then((msgs) => {
          // Another conversation is on screen by now: these are not its messages.
          if (opened.current === mine) setMessages(msgs);
        })
        .catch((err) => toast.error(`Failed to load session: ${describeError(err)}`));
    },
    [toast, putDraft, moveDraft],
  );

  const switchTo = useCallback(
    (name: string, fresh: boolean, draft?: string) => {
      if (name === agentNow.current && !fresh) {
        if (draft !== undefined) putDraft(draftKey(name, shownNow.current?.id), draft);
        return;
      }
      // Where you leave this agent is where you find it again when you come back.
      left.current.set(agentNow.current, shownNow.current ?? "fresh");
      // Off the last agent's conversation at once: what is typed now starts one with this agent.
      newChat();
      setAgent(name);
      const was = fresh ? "fresh" : left.current.get(name);
      // Words written for this agent wait in the conversation that opens with it.
      if (draft !== undefined) putDraft(draftKey(name, was && was !== "fresh" ? was.id : undefined), draft);
      if (was === "fresh") return;
      if (was) {
        loadSession(rowFor(was.id, was.key));
        return;
      }
      const turn = turns.current;
      fetchSessions({ limit: 500 })
        .then((rows) => {
          if (turns.current !== turn) return;
          const latest = latestWith(rows, name);
          if (!latest) return;
          // Your chat with it as it stands turns out to be this one: what you typed while it was looked for, and
          // anything written for it, goes on into it.
          loadSession(latest, { fromNew: true });
        })
        .catch(() => {
          // Nothing to pick up: the new conversation stands.
        });
    },
    [newChat, loadSession, putDraft],
  );

  const setSelectedAgent = useCallback(
    (name: string, opts?: { fresh?: boolean; draft?: string }) => {
      const fresh = !!opts?.fresh;
      const draft = opts?.draft;
      // A reply on its way is never cut off: the switch waits for it. Asking for the agent the reply is from
      // calls the wait off, as coming back to it before the reply is done does. Words written for where the switch
      // goes wait with it, out of sight, rather than showing in the conversation the reply is coming into.
      if (busyNow.current) {
        const staying = name === agentNow.current && !fresh;
        // A waiting switch this one replaces keeps what was written for it in the conversation it was going to.
        const before = queued.current;
        if (before?.draft !== undefined && draft === undefined) {
          const was = before.fresh ? "fresh" : left.current.get(before.name);
          putDraft(draftKey(before.name, was && was !== "fresh" ? was.id : undefined), before.draft);
        }
        queued.current = staying ? null : { name, fresh, ...(draft !== undefined ? { draft } : {}) };
        setNextAgent(staying ? null : name);
        if (staying && draft !== undefined) putDraft(draftKey(name, shownNow.current?.id), draft);
        return;
      }
      queued.current = null;
      setNextAgent(null);
      switchTo(name, fresh, draft);
    },
    [switchTo, putDraft],
  );

  useEffect(() => {
    if (busy || !queued.current) return;
    const { name, fresh, draft } = queued.current;
    queued.current = null;
    setNextAgent(null);
    switchTo(name, fresh, draft);
  }, [busy, switchTo]);

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
          // Gone, so not somewhere to come back to.
          for (const [who, at] of left.current) if (at !== "fresh" && at.id === s.id) left.current.delete(who);
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

  const setTurnExtras = useCallback((extras: TurnExtras) => {
    turnExtras.current = extras;
  }, []);

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
      nextAgent,
      setSpeaking,
      draft,
      setDraft,
      onDraftMoved,
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
      setTurnExtras,
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
      setSelectedAgent,
      nextAgent,
      draft,
      setDraft,
      onDraftMoved,
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
      setTurnExtras,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatStore(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatStore must be used inside <ChatProvider>");
  return ctx;
}
