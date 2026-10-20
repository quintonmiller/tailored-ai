import { useEffect, useState } from "react";
import {
  addProjectTaskComment,
  fetchProjectTask,
  type ProjectTask,
  type ProjectTaskWithComments,
  updateProjectTask,
} from "../api";
import { useAgentColor } from "../lib/body-colors";
import { nameOf } from "../lib/conversations";
import { answerable, type Need, ownFlow, questionIn } from "../lib/needs";
import { lasting } from "../lib/tasks";
import { ApprovalArgs } from "./ApprovalArgs";
import { WorldPanel } from "./WorldPanel";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How long it has waited, in a few words: "waiting 12 min". */
const waited = (need: Need) => {
  const long = lasting(need.since);
  return long ? `waiting ${long}` : undefined;
};

/** What a need is, in the words its row and card head use. */
function needWords(need: Need): string {
  if (need.kind === "approval") return need.tool ? `wants your OK to use ${need.tool}` : "wants your OK";
  return need.what;
}

/**
 * Everything agents are waiting on you for, longest first after approvals:
 * who, what, how long, and where its body is. A row takes you to the agent,
 * standing in front of it, with what it waits on open.
 */
export function NeedsList({
  needs,
  whereOf,
  onOpen,
  onClose,
}: {
  needs: Need[];
  /** Where an agent's body is, in a few words: "here", "at home", "in #trip". */
  whereOf: (agent: string) => string | undefined;
  onOpen: (need: Need) => void;
  onClose: () => void;
}) {
  return (
    <WorldPanel kicker="Needs you" title="Waiting on you" className="world-needs" onClose={onClose}>
      {needs.length === 0 ? (
        <p className="world-panel-quiet">
          Nothing is waiting on you. When an agent is, it shows here, and as a ! over its head.
        </p>
      ) : (
        <ul className="world-needs-list">
          {needs.map((need) => (
            <li key={need.key}>
              <button type="button" className="world-needs-row doing-waiting" onClick={() => onOpen(need)}>
                <span className="world-map-dot" aria-hidden="true">
                  !
                </span>
                <span className="world-needs-who">{nameOf(need.agent)}</span>
                <span className="world-needs-when">{waited(need) ?? ""}</span>
                <span className="world-needs-what">
                  {needWords(need)}
                  {need.detail ? ` · ${need.detail}` : ""}
                </span>
                {whereOf(need.agent) && <span className="world-needs-where">{whereOf(need.agent)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </WorldPanel>
  );
}

/**
 * What one agent is waiting on you for, answered where you stand: an
 * approval with everything the chat's approval panel shows (the call, what
 * the approver is told, every argument, the raw call), and Approve or Deny
 * with a note; a question on a task, answered as the Tasks page answers it,
 * back to the backlog with your answer as a comment; any other question,
 * answered in the chat it was asked in. What you did stays on the card after
 * the agent stops waiting, and a request answered somewhere else says so.
 *
 * Approve is never the first thing focused, nothing approves on a key of its
 * own or on the second click of a double click, and it is offered only for a
 * request whose details the server sent (`answerable`): a purchase, or
 * anything else with a stricter flow of its own, shows its details, where to
 * approve it, and Deny.
 */
export function NeedCard({
  agent,
  needs,
  loading,
  failed,
  onOpenTask,
  onAnswered,
  onReply,
  inChat,
  onShowChat,
  onAbout,
  onBack,
  onClose,
}: {
  agent: string;
  /** What it waits on now, as the world knows it. */
  needs: Need[];
  /** The details of the approvals it waits on are still being asked for. */
  loading: boolean;
  /** Asking for them failed. */
  failed: boolean;
  onOpenTask: (id: string) => void;
  /** A task was answered: the boards and the `!` take it at once. */
  onAnswered: (task: ProjectTask) => void;
  /** Answer a question in a chat with the agent, a message already started: in the conversation it asked in, when known. */
  onReply?: (text: string, session?: string) => void;
  /** Whether the chat on this page is the one holding an approval request, its approval panel showing it. */
  inChat?: (request: string) => boolean;
  /** Put the chat on screen, in place of the card. */
  onShowChat?: () => void;
  onAbout: () => void;
  /** Back to the list it was opened from. */
  onBack?: () => void;
  onClose: () => void;
}) {
  // Every request shown since the card opened, in the order they came, so one answered stays to say what happened.
  const [shown, setShown] = useState<Need[]>(needs);
  const [said, setSaid] = useState<Record<string, string>>({});
  useEffect(() => {
    setShown((was) => {
      const live = new Map(needs.map((n) => [n.key, n]));
      const kept = was.map((n) => (said[n.key] ? n : (live.get(n.key) ?? n)));
      const known = new Set(was.map((n) => n.key));
      const next = [...kept, ...needs.filter((n) => !known.has(n.key))];
      // The page draws often; nothing new is the same list, so the card isn't drawn again for it.
      return next.length === was.length && next.every((n, i) => n === was[i]) ? was : next;
    });
  }, [needs, said]);
  const live = new Set(needs.map((n) => n.key));
  const name = nameOf(agent);
  const color = useAgentColor()(agent);
  const done = (key: string, words: string) => setSaid((s) => ({ ...s, [key]: words }));

  return (
    <WorldPanel
      kicker="Needs you"
      label={`What ${name} is waiting on you for`}
      title={
        <span className="world-agent-name">
          <span className="world-agent-dot" style={{ background: color }} aria-hidden="true" />
          {name}
        </span>
      }
      className="world-need"
      onClose={onClose}
      {...(onBack ? { onBack, backLabel: "Everything waiting on you" } : {})}
      footer={
        <button type="button" className="world-panel-inline world-panel-link" onClick={onAbout}>
          More about {agent === "default" ? "the default agent" : name}
        </button>
      }
    >
      {shown.length === 0 && <p className="world-panel-quiet">{name} isn't waiting on you for anything now.</p>}
      {shown.map((need) => {
        const outcome = said[need.key] ?? (live.has(need.key) ? undefined : ELSEWHERE);
        const props = { need, name, outcome, onDone: (words: string) => done(need.key, words) };
        if (need.kind === "approval")
          return (
            <ApprovalNeed
              key={need.key}
              {...props}
              loading={loading}
              failed={failed}
              here={!!need.request && !!inChat?.(need.request)}
              {...(onShowChat ? { onShowChat } : {})}
            />
          );
        if (need.task)
          return (
            <TaskQuestion key={need.key} {...props} task={need.task} onOpenTask={onOpenTask} onAnswered={onAnswered} />
          );
        return <ChatQuestion key={need.key} {...props} {...(onReply ? { onReply } : {})} />;
      })}
    </WorldPanel>
  );
}

interface ItemProps {
  need: Need;
  name: string;
  /** What happened to it, once something has. */
  outcome: string | undefined;
  onDone: (words: string) => void;
}

/** One request's head: what it wants and how long it has waited; once seen to, only what it wanted. */
function NeedHead({ need, over }: { need: Need; over: boolean }) {
  return (
    <p className={`world-need-head${over ? " over" : ""}`}>
      <strong>{needWords(need)}</strong>
      {!over && waited(need) && <span className="world-need-when"> · {waited(need)}</span>}
    </p>
  );
}

/** What a request that stopped waiting without you says: you may not know which way it went. */
const ELSEWHERE = "Answered somewhere else, or it stopped waiting.";

/** What happened, where the eye is: what you did in green, what happened without you quieter. */
function Outcome({ words }: { words: string }) {
  return (
    <p className={`${words === ELSEWHERE ? "world-panel-quiet" : "new-task-made"} world-panel-said`} aria-live="polite">
      {words}
    </p>
  );
}

/**
 * Your OK on a tool call: the call in full, and Approve or Deny with an
 * optional note. One with a stricter flow of its own is approved in the chat
 * that asked for it; denying it is safe anywhere, so that stays.
 */
function ApprovalNeed({
  need,
  name,
  outcome,
  onDone,
  loading,
  failed,
  here,
  onShowChat,
}: ItemProps & {
  loading: boolean;
  failed: boolean;
  /** The chat on this page holds the request: its approval panel shows it. */
  here: boolean;
  onShowChat?: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = need.approval;
  const strict = ownFlow(request?.toolName ?? need.tool);
  const decide = async (approved: boolean) => {
    // The details on screen are what is decided: nothing is approved that the card doesn't show.
    if (!request || (approved && !answerable(need))) return;
    setBusy(true);
    setProblem(null);
    try {
      const why = note.trim();
      const res = await fetch(`/api/approvals/${encodeURIComponent(request.requestId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, ...(why ? { reason: why } : {}) }),
      });
      if (res.status === 404) onDone("Already answered somewhere else.");
      else if (!res.ok) throw new Error(`the server said ${res.status}`);
      else
        onDone(
          approved ? `Approved. ${name} carries on.` : `Denied. ${name} has been told${why ? ", with your note" : ""}.`,
        );
    } catch (err) {
      setProblem(`Couldn't send that: ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="world-need-item" aria-label={needWords(need)}>
      <NeedHead need={need} over={!!outcome} />
      {request ? (
        <div className="world-need-call">
          <div className="chat-approval-tool">{request.toolName}</div>
          {request.description && <p className="world-need-desc">{request.description}</p>}
          {request.toolArgs && <ApprovalArgs args={request.toolArgs} />}
        </div>
      ) : outcome ? null : loading ? (
        <p className="world-panel-quiet">Getting the details…</p>
      ) : failed ? (
        <p className="agent-menu-problem">Couldn't get the details from the server. Close this and try again.</p>
      ) : (
        <p className="world-panel-quiet">
          It was asked somewhere the world can't answer for, like Discord. Answer it there.
        </p>
      )}
      {outcome ? (
        <Outcome words={outcome} />
      ) : request ? (
        <>
          {strict && (
            <p className="world-need-strict">
              Anything that may spend money, or has an approval of its own, is approved in the chat that asked for it,
              not from the world.{" "}
              {here ? "That's the chat on this page." : "That chat is open in another tab or on another device."} You
              can still deny it here.
            </p>
          )}
          <label className="world-need-note">
            Note for {name} (optional)
            <textarea value={note} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="world-panel-row">
            {!strict && answerable(need) && (
              <button
                type="button"
                className="talk-tool world-need-approve"
                disabled={busy}
                onClick={(e) => {
                  // The second click of a double click is one aimed at whatever was here before: the row of the list
                  // this card took the place of, say. Approving takes a click of its own.
                  if (e.detail > 1) return;
                  void decide(true);
                }}
              >
                Approve
              </button>
            )}
            <button type="button" className="talk-tool" disabled={busy} onClick={() => void decide(false)}>
              Deny
            </button>
            {strict && here && onShowChat && (
              <button type="button" className="talk-tool" onClick={onShowChat}>
                Show the chat
              </button>
            )}
          </div>
        </>
      ) : null}
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </section>
  );
}

/**
 * A question on a task: the question as the agent asked it, and your answer,
 * which goes on the task as a comment and puts it back in the backlog, as
 * the Tasks page does. A task waiting on you for anything else (it errored,
 * it needs checking) opens.
 */
function TaskQuestion({
  need,
  name,
  outcome,
  onDone,
  task: id,
  onOpenTask,
  onAnswered,
}: ItemProps & { task: string; onOpenTask: (id: string) => void; onAnswered: (task: ProjectTask) => void }) {
  const [task, setTask] = useState<ProjectTaskWithComments | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    fetchProjectTask(id)
      .then((t) => {
        if (!gone) setTask(t);
      })
      .catch((err: unknown) => {
        if (!gone) setProblem(`Couldn't open the task: ${message(err)}`);
      });
    return () => {
      gone = true;
    };
  }, [id]);
  const asking = task?.status === "blocked" && task.blocked_reason === "question";
  const question = task ? questionIn(task.comments, need.question ?? need.detail) : (need.question ?? need.detail);
  const send = async () => {
    const words = answer.trim();
    if (!task || !words) return;
    setBusy(true);
    setProblem(null);
    try {
      await addProjectTaskComment(task.id, { author: "user", content: words });
      // Back to the backlog, which is what puts it back in the queue for the agent to pick up.
      const updated = await updateProjectTask(task.id, { status: "backlog", blocked_reason: null });
      setTask((t) => (t ? { ...t, ...updated } : t));
      onAnswered(updated);
      onDone(`Answered. The task is back in the backlog for ${name} to pick up.`);
    } catch (err) {
      setProblem(`Couldn't send your answer: ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="world-need-item" aria-label={needWords(need)}>
      <NeedHead need={need} over={!!outcome} />
      <p className="world-need-about">
        On the task{" "}
        <button type="button" className="world-panel-inline" onClick={() => onOpenTask(id)}>
          {task?.title ?? need.detail ?? "…"}
        </button>
      </p>
      {question && question !== task?.title && <p className="world-need-question">{question}</p>}
      {outcome ? (
        <Outcome words={outcome} />
      ) : asking ? (
        <>
          <label className="world-need-note">
            Your answer, as a comment on the task
            <textarea value={answer} rows={3} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <div className="world-panel-row">
            <button type="button" className="talk-tool" disabled={busy || !answer.trim()} onClick={() => void send()}>
              {busy ? "Sending…" : "Send answer"}
            </button>
          </div>
        </>
      ) : task ? (
        <div className="world-panel-row">
          <button type="button" className="talk-tool" onClick={() => onOpenTask(id)}>
            Open the task
          </button>
        </div>
      ) : null}
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </section>
  );
}

/**
 * A question asked anywhere else: answered in a chat with the agent, the
 * question quoted to start it. The conversation it asked in when that is one
 * of yours with it, which has everything the question was about.
 */
function ChatQuestion({
  need,
  name,
  outcome,
  onReply,
}: ItemProps & { onReply?: (text: string, session?: string) => void }) {
  const question = need.question ?? need.detail;
  return (
    <section className="world-need-item" aria-label={needWords(need)}>
      <NeedHead need={need} over={!!outcome} />
      {question && <p className="world-need-question">{question}</p>}
      {outcome ? (
        <Outcome words={outcome} />
      ) : (
        onReply && (
          <div className="world-panel-row">
            <button
              type="button"
              className="talk-tool"
              onClick={() => onReply(question ? `About your question, “${question}”: ` : "", need.session)}
            >
              Answer in the chat
            </button>
            <span className="world-panel-quiet">Opens your chat with {name}, your answer still to write.</span>
          </div>
        )
      )}
    </section>
  );
}
