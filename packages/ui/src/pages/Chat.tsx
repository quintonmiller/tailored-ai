import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMessages, fetchSessions, type SessionRow, setStoredChatSessionId } from "../api";
import { groupTurns } from "../chat-grouping";
import { ApprovalArgs } from "../components/ApprovalArgs";
import { useChatStore } from "../components/ChatContext";
import { lastExchange, TalkButton, TalkSlot, useChatStage } from "../components/ChatStage";
import { ChatWith, RoomLines, RoomWith, useRoomTalk } from "../components/ChatWith";
import { AttachmentTray, filesFromDrop, filesFromPaste, useAttachments } from "../components/Composer.js";
import { MessageBubble, ThinkingDisclosure, ToolLogPanel } from "../components/MessageBubble";
import { SuggestionChips } from "../components/SuggestionChips";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { lastLines, TALK_BRIEF, TALK_LINES, WorldTalk } from "../components/WorldTalk";
import { useActiveProject } from "../hooks/useActiveProject";
import { useCovered } from "../hooks/useCovered";
import type { MediaRef } from "../lib/content.js";
import { agentOfKey, askedIn, rowFor } from "../lib/conversations";

export function Chat(props: { sessionKey?: string; sessionId?: string }) {
  const store = useChatStore();
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const _activeProject = useActiveProject();

  // Honor an explicit ?session=… route param by loading that session into
  // the shared store. Without this, deep links would no-op on a cold load
  // because the provider already restored its own last-active session.
  //
  // Only when the route itself changes. Reacting to every store update made
  // this fight the URL sync below: a reply that moved the store to another
  // conversation had this load the old one back from the stale URL, the sync
  // point the URL at the old one, and the two bounced, reloading each time.
  const routed = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route alone decides; the store is read, not followed.
  useEffect(() => {
    if (!props.sessionId || props.sessionId === routed.current) return;
    routed.current = props.sessionId;
    if (props.sessionId === store.sessionId) return;
    setStoredChatSessionId(props.sessionId, props.sessionKey ?? null);
    fetchMessages(props.sessionId)
      .then((msgs) => {
        // Touch the store via loadSession analogue: cheapest path is to
        // mimic by calling the store's own loadSession with a minimal row.
        store.loadSession(rowFor(props.sessionId!, props.sessionKey ?? null));
        // loadSession will re-fetch the messages itself; the msgs above are
        // discarded but the fetch warmed the cache.
        void msgs;
      })
      .catch(() => {});
  }, [props.sessionId, props.sessionKey]);

  // A link that names an agent but no conversation, like the Agents page's "Open in chat", is a new conversation
  // with that agent. Once per link, as for a conversation's link above.
  const asked = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route alone decides; the store is read, not followed.
  useEffect(() => {
    if (props.sessionId || !props.sessionKey || props.sessionKey === asked.current) return;
    asked.current = props.sessionKey;
    const who = agentOfKey(props.sessionKey);
    if (who !== undefined) store.setSelectedAgent(who, { fresh: true });
  }, [props.sessionId, props.sessionKey]);

  // Load sessions list when sidebar opens or project filter changes.
  useEffect(() => {
    if (sidebarOpen) store.refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen, store]);

  // Escape interrupts an in-flight turn (page-only — dock has its own Esc behavior). Not while something is open
  // in the world: there Escape closes it, and it may be what hides the turn it would cut off. Which
  // window listener hears the key first depends on which was added first, so all three are asked: a panel or menu
  // that closed on it says so, one still open is in `overStage`, and focus in a menu is inside its dialog.
  const overStage = useRef(false);
  useEffect(() => {
    if (!store.sending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || overStage.current) return;
      if ((e.target as HTMLElement | null)?.closest?.("[role='dialog']")) return;
      e.preventDefault();
      store.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store.sending, store]);

  const displayMessages = useMemo(
    () => groupTurns(store.messages).filter((m) => m.role !== "system"),
    [store.messages],
  );

  const agentNames = Object.keys(store.agents).filter((name) => name !== "default");
  // What you last said and its answer, for the bubbles over you and the agent when you talk to it on a visit.
  const exchange = useMemo(() => lastExchange(displayMessages), [displayMessages]);

  // The agent's body behind the conversation, when it has one, and talking
  // out loud into the same conversation. In the world your conversation shows
  // beside whoever you talk to, so the whole chat in a column beside the world
  // starts hidden, a click on Chat away.
  const [panelOpen, setPanelOpen] = useState(false);
  // In a meeting room: the room's own conversation is on screen, rather than yours with one of its members.
  const [reading, setReading] = useState(true);
  // What covers the scene: the toolbar along the top, and on a phone the chat along the bottom, or whatever
  // opened in its place. The camera frames the agent in what is left.
  const chatBox = useRef<HTMLDivElement>(null);
  // What opens in the world as a sheet over the foot of a phone's stage, the stage frames round by itself.
  const covered = useCovered(chatBox, {
    top: ":scope > .chat-toolbar",
    bottom: ":scope > .chat-with, :scope > .chat-room-note, :scope > .chat-messages, :scope > .chat-input-bar",
  });
  const scene = useChatStage({
    agent: store.selectedAgent,
    sessionKey: store.sessionKey,
    sending: store.sending,
    panelOpen,
    covered,
    setTurnExtras: store.setTurnExtras,
    setSpeaking: store.setSpeaking,
    onChatWith: (name) => {
      // Choosing someone to talk to is leaving the room's own conversation for theirs, in a meeting room too.
      setReading(false);
      store.setSelectedAgent(name === "default" ? "" : name);
    },
    // A message written for someone shows in your conversation with them in the world, ready to send, as it does in
    // the chat beside it when that is open: the box to type in is the same one.
    onDraft: (name, text) => {
      // A message written for someone is a chat with them, out of a meeting room's own conversation too.
      setReading(false);
      store.setSelectedAgent(name === "default" ? "" : name, { fresh: true });
      setInput(text);
    },
    onReply: (name, session, text) => {
      // An answer goes where the question is: the conversation it asked in, which has everything it was about.
      setReading(false);
      setInput(text);
      const who = name === "default" ? "" : name;
      if (session && session === store.sessionId) return;
      // Otherwise your chat with it as it stands, and while a reply is on its way, after it (the switch waits).
      const asItStands = () => store.setSelectedAgent(who);
      if (!session || store.sending) return asItStands();
      fetchSessions({ limit: 500 })
        .then((rows) => {
          const row = askedIn(rows, session, who);
          if (row) store.loadSession(row);
          else asItStands();
        })
        .catch(asItStands);
    },
    chatApprovals: store.approvals.map((a) => a.requestId),
    onShowChat: () => {
      setReading(false);
      setPanelOpen(true);
    },
    exchange,
    dialogue: true,
    readingRoom: reading,
    onSpoken: (conversation, key) => {
      if (!conversation) return;
      // Loading the conversation shows the spoken turn with the rest, and
      // makes it the one a typed message goes into next.
      store.loadSession(rowFor(conversation, key));
    },
  });
  overStage.current = scene.showStage && !!scene.worldPanel;

  // In a meeting room there is nobody in particular to talk to: the panel reads out the room's own
  // conversation, until you pick one of its members to talk to.
  const meeting = scene.showStage && scene.visiting?.startsWith("room:") ? scene.visiting : null;
  useEffect(() => {
    if (meeting) setReading(true);
  }, [meeting]);
  const showRoom = !!meeting && reading;
  // Read again every little while only while it is on screen.
  const talk = useRoomTalk(meeting, showRoom && panelOpen);

  const { attachments, add, remove, clear, readyIds, busy } = useAttachments();
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSend() {
    const text = input.trim();
    const media = attachments.filter((a) => a.status === "ready" && a.ref).map((a) => a.ref as MediaRef);
    // An image with no caption is a message. Blocking it here is the same bug
    // Slack had, one layer up.
    if ((!text && media.length === 0) || store.sending || busy) return;
    setInput("");
    clear();
    store.send(text, media);
  }

  function handleNewChat() {
    store.newChat();
    window.location.hash = "/chat";
  }

  function handleLoadSession(s: SessionRow) {
    store.loadSession(s);
    setSidebarOpen(false);
    const params = new URLSearchParams();
    if (s.key) params.set("key", s.key);
    params.set("session", s.id);
    window.location.hash = `/chat?${params}`;
  }

  function handleRename(s: SessionRow) {
    const current = s.title ?? "";
    const next = window.prompt("Rename session", current);
    if (next === null) return;
    store.renameSession(s, next.trim() || null);
  }

  function handleDeleteSession(s: SessionRow) {
    if (!window.confirm(`Delete session "${s.title ?? s.key ?? s.id.slice(0, 8)}"?`)) return;
    store.removeSession(s);
  }

  // The box to type in, as the chat beside the world has it and as your conversation in the world has it: the same
  // words in both, sent the same way.
  const typing = {
    value: input,
    onChange: (e: { target: { value: string } }) => setInput(e.target.value),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      // The one that matters: pasting a screenshot is how anyone
      // actually sends one.
      const files = filesFromPaste(e);
      if (files.length === 0) return;
      e.preventDefault();
      void add(files);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    disabled: store.sending,
  };
  const talkButton = scene.voiceEnabled ? (
    <TalkButton voice={scene.voice} />
  ) : (
    <VoiceInputButton
      disabled={store.sending}
      onTranscript={(text) => setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
    />
  );
  const sendButton = store.sending ? (
    <button type="button" onClick={store.interrupt} className="chat-stop-btn" title="Stop generating">
      Stop
    </button>
  ) : (
    <button type="button" onClick={handleSend} disabled={(!input.trim() && !readyIds.length) || busy}>
      Send
    </button>
  );
  // A glance at the conversation; only its last exchange while a card has most of the room.
  const brief = !!scene.talk?.brief;
  const talkLines = useMemo(
    () => lastLines(displayMessages, brief ? TALK_BRIEF : TALK_LINES),
    [displayMessages, brief],
  );
  // What the agent is doing about your turn, in the words its body's sign says it in, until its reply is coming in.
  const doing =
    store.sending && !store.streamText
      ? `${store.activeTool ? `Calling ${store.activeTool}…` : (store.activityDesc ?? "Thinking…")}${store.elapsed > 0 ? ` · ${store.elapsed}s` : ""}`
      : scene.voice.phase === "listening"
        ? "Listening…"
        : scene.voice.phase === "thinking"
          ? "Thinking…"
          : undefined;
  const approvalPanel =
    store.approvals.length > 0 ? (
      <ApprovalPanel
        approvals={store.approvals}
        onApprove={store.approve}
        onReject={store.reject}
        onApproveAll={store.approveAll}
        onRejectAll={store.rejectAll}
      />
    ) : null;
  // Your conversation in the world, beside whoever you talk to: what was said, the reply coming in, and the box.
  const talkPanel = scene.talk ? (
    <WorldTalk
      name={scene.talk.name}
      phone={scene.talk.phone}
      lines={talkLines}
      {...(scene.spoken
        ? { heard: scene.spoken.heard, replying: scene.spoken.replying }
        : store.sending
          ? { replying: store.streamText }
          : {})}
      {...(doing ? { status: doing } : {})}
      approvals={approvalPanel}
      {...(scene.voice.error ? { problem: scene.voice.error } : {})}
      onFull={() => setPanelOpen(true)}
    >
      <AttachmentTray attachments={attachments} onRemove={remove} />
      <div className="world-talk-bar">
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={store.sending}
          title="Attach a file"
          aria-label="Attach a file"
        >
          +
        </button>
        <input
          type="text"
          className="world-talk-input"
          placeholder={store.selectedAgent ? `Message ${store.selectedAgent}…` : "Message…"}
          aria-label={`Message ${scene.talk.name}`}
          {...typing}
        />
        {talkButton}
        {sendButton}
      </div>
    </WorldTalk>
  ) : null;

  // Reflect store session changes in the URL hash so reload preserves the
  // location and so route prop drives the canonical state.
  const hadSession = useRef(false);
  useEffect(() => {
    if (!store.sessionId) {
      // Switched to another agent, or a new chat: the URL lets go of the old conversation, so a reload
      // doesn't open it again. Not before one was shown, or a link to one would be dropped as it loads.
      if (hadSession.current && window.location.hash.includes("session=")) window.location.hash = "/chat";
      hadSession.current = false;
      return;
    }
    hadSession.current = true;
    const params = new URLSearchParams();
    if (store.sessionKey) params.set("key", store.sessionKey);
    params.set("session", store.sessionId);
    const next = `/chat?${params}`;
    if (window.location.hash.slice(1) !== next) {
      window.location.hash = next;
    }
  }, [store.sessionId, store.sessionKey]);

  return (
    <div className="chat-layout">
      {sidebarOpen && (
        <div className="chat-sidebar" aria-label="Session list">
          <div className="chat-sidebar-header">
            <span>Sessions</span>
            <button
              type="button"
              className="chat-sidebar-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close session sidebar"
            >
              x
            </button>
          </div>
          <div className="chat-sidebar-search">
            <input
              type="search"
              placeholder="Search sessions"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              aria-label="Search sessions"
            />
          </div>
          <div className="chat-sidebar-list">
            {store.sessions.length === 0 && <div className="chat-sidebar-empty">No sessions yet</div>}
            {(() => {
              const q = sidebarSearch.trim().toLowerCase();
              const filtered = q
                ? store.sessions.filter((s) => `${s.title ?? ""} ${s.key ?? ""} ${s.id}`.toLowerCase().includes(q))
                : store.sessions;
              const pinned = filtered.filter((s) => s.pinned);
              const recent = filtered.filter((s) => !s.pinned);
              return (
                <>
                  {pinned.length > 0 && <div className="chat-sidebar-section-label">Pinned</div>}
                  {pinned.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === store.sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={(s2) => store.togglePin(s2)}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                  {pinned.length > 0 && recent.length > 0 && <div className="chat-sidebar-section-label">Recent</div>}
                  {recent.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === store.sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={(s2) => store.togglePin(s2)}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      )}

      <div
        ref={chatBox}
        className={`chat${scene.showStage ? " chat-with-stage" : ""}${scene.showStage && !panelOpen ? " chat-panel-hidden" : ""}${scene.showStage && scene.worldPanel ? " chat-world-open" : ""}`}
      >
        {scene.stage && (
          <TalkSlot.Provider value={talkPanel}>
            <div className="chat-stage">{scene.stage}</div>
          </TalkSlot.Provider>
        )}
        <div className="chat-toolbar">
          <button
            type="button"
            className="chat-toolbar-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle sessions"
          >
            Sessions
          </button>
          <button type="button" className="chat-toolbar-btn chat-new-btn" onClick={handleNewChat}>
            + New Chat
          </button>
          {agentNames.length > 0 && !scene.showStage && (
            <select
              className="chat-agent-select"
              value={store.nextAgent ?? store.selectedAgent}
              onChange={(e) => store.setSelectedAgent(e.target.value)}
              aria-label="Choose agent"
            >
              <option value="">Default agent</option>
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {store.sessionKey && !showRoom && <span className="chat-session-label">Session: {store.sessionKey}</span>}
          <span className="chat-toolbar-spacer" />
          {scene.has3d && (
            <button
              type="button"
              className="chat-toolbar-btn"
              aria-pressed={scene.stageOn}
              onClick={() => scene.setStageOn(!scene.stageOn)}
              title="Show the agent in its room"
            >
              3D
            </button>
          )}
          {scene.showStage && (
            <button
              type="button"
              className="chat-toolbar-btn"
              aria-pressed={panelOpen && !scene.chatCovered}
              onClick={() => {
                // Asked for while a panel has its place, the chat comes back: the panel closes.
                if (scene.chatCovered) {
                  scene.closePanel();
                  setPanelOpen(true);
                } else setPanelOpen(!panelOpen);
              }}
              title="Show or hide the conversation over the scene"
            >
              Chat
            </button>
          )}
        </div>

        {scene.showStage &&
          (meeting ? (
            <RoomWith
              talk={talk}
              fallbackName={scene.placeName}
              reading={reading}
              agent={store.selectedAgent}
              next={store.nextAgent}
              activities={scene.activities}
              onRead={() => setReading(true)}
              onTalk={(name) => {
                setReading(false);
                store.setSelectedAgent(name === "default" ? "" : name);
              }}
            />
          ) : (
            <ChatWith
              agent={store.selectedAgent}
              agents={agentNames}
              activity={scene.activities[store.selectedAgent || "default"]}
              next={store.nextAgent}
              onSwitch={(name) => store.setSelectedAgent(name)}
            />
          ))}

        <div className="chat-messages">
          {showRoom ? (
            <RoomLines talk={talk} />
          ) : (
            <>
              {store.messages.length === 0 && !store.sending && (
                <div className="chat-empty-state">
                  <SuggestionChips onPick={(text) => store.send(text)} />
                  <div className="chat-empty-text">
                    Send a message to start a conversation
                    {store.selectedAgent ? ` with the "${store.selectedAgent}" agent` : ""}.
                  </div>
                </div>
              )}
              {displayMessages.map((m, i) => (
                <MessageBubble key={i} message={m} />
              ))}
              {store.sending && store.streamReasoning && <ThinkingDisclosure reasoning={store.streamReasoning} live />}
              {store.sending && store.streamText && (
                <MessageBubble message={{ role: "assistant", content: store.streamText }} />
              )}
              {store.sending &&
                !store.streamText &&
                (store.pendingTools.length > 0 ? (
                  <ToolLogPanel entries={store.pendingTools} live elapsed={store.elapsed} />
                ) : (
                  <div className="tool-activity">
                    <div className="spinner" />
                    <span>
                      {store.activeTool ? `Calling ${store.activeTool}…` : (store.activityDesc ?? "Thinking…")}
                      {store.elapsed > 0 ? ` · ${store.elapsed}s` : ""}
                    </span>
                  </div>
                ))}
              {scene.spoken && (
                <>
                  <MessageBubble message={{ role: "user", content: scene.spoken.heard }} />
                  <MessageBubble message={{ role: "assistant", content: scene.spoken.replying || "…" }} />
                </>
              )}
            </>
          )}
          {approvalPanel}
        </div>
        {scene.voice.error && <div className="chat-voice-error">{scene.voice.error}</div>}
        {showRoom && (
          <p className="chat-room-note">The room's own conversation, to read. Pick someone above to talk to them.</p>
        )}
        <AttachmentTray attachments={attachments} onRemove={remove} />
        {/*
          Drag handlers sit on the bar itself so the whole strip is a target.
          The linter flags interaction handlers on a non-interactive element;
          giving it a role to quiet that would be worse accessibility than the
          warning, since the element is not a button or a listbox. WCAG 2.5.7
          asks instead for a single-pointer alternative to any dragging
          movement, and the "+" button below is exactly that — keyboard
          reachable, and the only path screen-reader users need.
        */}
        <div
          className={`chat-input-bar${dragging ? " dragging" : ""}`}
          hidden={showRoom}
          onDragOver={(e) => {
            // Only claim the drop when files are actually being dragged;
            // otherwise text selections inside the page start looking droppable.
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            const files = filesFromDrop(e);
            if (files.length === 0) return;
            e.preventDefault();
            setDragging(false);
            void add(files);
          }}
        >
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void add(files);
              // Reset so choosing the same file twice still fires a change.
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={store.sending}
            title="Attach a file"
            aria-label="Attach a file"
          >
            +
          </button>
          <input
            type="text"
            // The default agent's own name is in the header: here it would only crowd the box.
            placeholder={
              scene.showStage
                ? store.selectedAgent
                  ? `Message ${store.selectedAgent}…`
                  : "Message…"
                : "Type a message..."
            }
            {...typing}
            aria-label="Compose message"
          />
          {talkButton}
          {sendButton}
        </div>
      </div>
    </div>
  );
}

function SessionItem(props: {
  session: SessionRow;
  active: boolean;
  onLoad: (s: SessionRow) => void;
  onRename: (s: SessionRow) => void;
  onTogglePin: (s: SessionRow) => void;
  onDelete: (s: SessionRow) => void;
}) {
  const { session: s, active, onLoad, onRename, onTogglePin, onDelete } = props;
  const label = s.title ?? s.key ?? s.id.slice(0, 8);
  return (
    <div className={`chat-sidebar-item${active ? " active" : ""}`}>
      <button
        type="button"
        className="chat-sidebar-item-main"
        onClick={() => onLoad(s)}
        aria-label={`Load session ${label}`}
      >
        <div className="chat-sidebar-item-key">{label}</div>
        <div className="chat-sidebar-item-meta">
          {s.provider}/{s.model} · {formatTime(s.updated_at)}
        </div>
      </button>
      <div className="chat-sidebar-item-actions">
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onTogglePin(s)}
          title={s.pinned ? "Unpin" : "Pin"}
          aria-label={s.pinned ? "Unpin session" : "Pin session"}
        >
          {s.pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onRename(s)}
          title="Rename"
          aria-label="Rename session"
        >
          ✎
        </button>
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onDelete(s)}
          title="Delete"
          aria-label="Delete session"
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface PendingApprovalShape {
  requestId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
}

function ApprovalPanel(props: {
  approvals: PendingApprovalShape[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const { approvals, onApprove, onReject, onApproveAll, onRejectAll } = props;
  return (
    <div className="chat-approvals">
      <div className="chat-approvals-header">
        <span>
          {approvals.length} tool call{approvals.length === 1 ? "" : "s"} need approval
        </span>
        {approvals.length > 1 && (
          <div className="chat-approvals-bulk">
            <button type="button" className="chat-approve-btn" onClick={onApproveAll}>
              Approve all
            </button>
            <button type="button" className="chat-reject-btn" onClick={onRejectAll}>
              Reject all
            </button>
          </div>
        )}
      </div>
      <div className="chat-approvals-list">
        {approvals.map((a) => (
          <div key={a.requestId} className="chat-approval-item">
            <div className="chat-approval-info">
              <div className="chat-approval-tool">{a.toolName}</div>
              {a.description && <div className="chat-approval-desc">{a.description}</div>}
              {a.toolArgs && <ApprovalArgs args={a.toolArgs} />}
            </div>
            <div className="chat-approval-actions">
              <button type="button" className="chat-approve-btn" onClick={() => onApprove(a.requestId)}>
                Approve
              </button>
              <button type="button" className="chat-reject-btn" onClick={() => onReject(a.requestId)}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
