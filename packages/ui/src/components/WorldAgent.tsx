import { useCallback, useEffect, useState } from "react";
import { type ExploratoryAgent, type ExploratoryRun, fetchExploratoryAgents, fetchExploratoryRuns } from "../api";
import type { AgentActivity } from "../avatar/doing";
import { toggleWear, WEAR, wearWords } from "../avatar/wear";
import { nameOf } from "../lib/conversations";
import { asleepWords, clockTime as clock, lastDid, wakeWords } from "../lib/did";
import { ago, lasting } from "../lib/tasks";
import { nextTurn } from "../lib/wakes";
import { agentColor, roleWord } from "./WorldMap";
import { WorldPanel } from "./WorldPanel";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "a coder", "an artist". */
const aOrAn = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/** The last thing an agent said, as its `speech` record has it. */
export interface Said {
  text: string;
  at: string;
  to?: string[];
  /** The room it was said in, as `<backend>:<id>`; absent for a direct message. */
  room?: string;
}

/** An interval in a few words: "45 min", "90 min", "3 h", "2.5 h". */
const every = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(ms / 1_800_000) / 2} h`;
};

/** How an agent that runs on its own stands: switched off, paused until when, or when it goes next. */
function ownTurns(agent: ExploratoryAgent, allOn: boolean): string {
  if (!allOn) return "Set to run on its own, but running on their own is switched off for every agent.";
  const next = nextTurn(agent);
  if (next.kind === "off") return "Switched off: it doesn't run on its own until it is woken.";
  if (next.kind === "paused") return `Paused until ${clock(next.until)}.`;
  if (next.kind === "unknown") return "Runs on its own.";
  const when = next.at - Date.now() < 60_000 ? "any minute now" : `around ${clock(next.at)}`;
  return next.every
    ? `Runs on its own about every ${every(next.every)}. Next ${when}.`
    : `Runs on its own. Next ${when}.`;
}

/**
 * An agent, in the world: who it is and what it is for, what it is doing,
 * what it last said and where, when it next runs on its own, where its body
 * is, what it wears, and what you can do about it, from talking to it to
 * sending it home. Its full page is a link at the bottom.
 */
export function WorldAgent({
  agent,
  role,
  wear,
  chosen,
  onWear,
  activity,
  said,
  roomName,
  where,
  openTasks,
  online,
  talking,
  tasksWake,
  onChat,
  onVisit,
  onSendHome,
  onTasks,
  onRedoRoom,
  onNeed,
  onClose,
}: {
  agent: string;
  /** What it is for, in a word, when that can be read from what it is told to do. */
  role?: string;
  /** What its body wears, by name, as the map says; undefined until the map is in. */
  wear?: string[];
  /** Someone chose what it wears, rather than it being what suits its role. */
  chosen?: boolean;
  /** Dress it in these, or (null) in whatever suits its role again. */
  onWear?: (wear: string[] | null) => Promise<void>;
  activity: AgentActivity | undefined;
  said: Said | undefined;
  /** A room's name, by the ref a line was said in. */
  roomName: (ref: string) => string | undefined;
  /** The place its body is in; undefined until the map is in. */
  where: { id: string; name: string; home: boolean } | undefined;
  openTasks: number;
  /** It is set to run on its own: what pausing and waking apply to. */
  online: boolean;
  /** It is the agent the chat is with now. */
  talking: boolean;
  /** Whether a task given to it wakes it, as the task watcher runs; undefined until the server has said. */
  tasksWake: boolean | undefined;
  onChat: () => void;
  /** Go to where its body is; undefined when you are there already. */
  onVisit?: () => void;
  onSendHome?: () => Promise<void>;
  onTasks: () => void;
  /** Ask it, in a chat with the words written, to make its room show what it has been working on. */
  onRedoRoom?: () => void;
  /** Open what it is waiting on you for; undefined when it waits on nothing. */
  onNeed?: () => void;
  onClose: () => void;
}) {
  const [own, setOwn] = useState<{ agent: ExploratoryAgent | undefined; allOn: boolean } | null>(null);
  const [lastRun, setLastRun] = useState<ExploratoryRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // What it wears as last asked for here, until the map catches up.
  const [dressed, setDressed] = useState<string[] | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: what the map says now is what is worn; asking is over.
  useEffect(() => {
    setDressed(undefined);
  }, [(wear ?? []).join(",")]);
  const worn = dressed ?? wear ?? [];
  const load = useCallback(async () => {
    if (!online) return;
    const [state, runs] = await Promise.all([
      fetchExploratoryAgents(),
      fetchExploratoryRuns({ agent, limit: 1 }).catch(() => ({ runs: [] as ExploratoryRun[] })),
    ]);
    setOwn({ agent: state.agents?.find((a) => a.name === agent), allOn: !!state.enabled });
    setLastRun(runs.runs?.[0] ?? null);
  }, [agent, online]);
  useEffect(() => {
    setOwn(null);
    setLastRun(null);
    setProblem(null);
    load().catch(() => {});
  }, [load]);

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      await load();
    } catch (err) {
      setProblem(`Couldn't ${what}: ${message(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const dress = (next: string[] | null) =>
    void act("change what it wears", async () => {
      setDressed(next ?? undefined);
      try {
        await onWear?.(next);
      } catch (err) {
        // Not saved, so not worn: the chips go back to what the body still wears.
        setDressed(undefined);
        throw err;
      }
    });
  const post = (path: string, body?: unknown) =>
    fetch(`/api/exploratory/agents/${encodeURIComponent(agent)}/${path}`, {
      method: "POST",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }).then((res) => {
      if (!res.ok) throw new Error(String(res.status));
    });
  // Paused or switched off: what "Wake up" undoes.
  const next = own?.agent ? nextTurn(own.agent).kind : undefined;
  const resting = next === "paused" || next === "off";
  const doing = activity && activity.doing !== "idle" ? activity : undefined;
  const room = said?.room ? roomName(said.room) : undefined;
  const name = nameOf(agent);
  // The switch that pauses every agent, as its activity says while it has nothing to do: the worker then skips
  // them all, whatever each one's own turns say.
  const allPaused = activity?.detail === "agents are paused";

  return (
    <WorldPanel
      kicker="Agent"
      label={`About ${name}`}
      title={
        <span className="world-agent-name">
          <span className="world-agent-dot" style={{ background: agentColor(agent) }} aria-hidden="true" />
          {name}
          {roleWord(agent, role) && <span className="world-agent-role">{role}</span>}
        </span>
      }
      className="world-agent"
      onClose={onClose}
      {...(agent !== "default"
        ? {
            footer: (
              <a className="world-panel-link" href={`#/agents/${encodeURIComponent(agent)}`}>
                Open its page
              </a>
            ),
          }
        : {})}
    >
      <dl className="world-facts">
        <dt>Now</dt>
        <dd className={`world-agent-doing doing-${activity?.doing ?? "idle"}`}>
          {doing ? doing.what : "Idle"}
          {doing?.doing === "asleep" ? ` · ${asleepWords(doing)}` : doing?.detail ? ` · ${doing.detail}` : ""}
          {lasting(activity?.since) ? `${doing ? " ·" : ""} for ${lasting(activity?.since)}` : ""}
          {onNeed && (
            <>
              {" · "}
              <button type="button" className="world-panel-inline" onClick={onNeed}>
                see what it needs
              </button>
            </>
          )}
        </dd>
        {lastDid(activity?.last) && (
          <>
            <dt>Last did</dt>
            <dd>{lastDid(activity?.last)}</dd>
          </>
        )}
        <dt>Last said</dt>
        <dd>
          {said ? (
            <>
              <q className="world-agent-said">{said.text.length > 160 ? `${said.text.slice(0, 159)}…` : said.text}</q>
              <span className="world-agent-when">
                {room ? ` in #${room}` : said.to?.length ? ` to ${said.to.map(nameOf).join(", ")}` : ""}
                {ago(said.at) ? ` · ${ago(said.at)}` : ""}
              </span>
            </>
          ) : (
            "Nothing yet"
          )}
        </dd>
        <dt>On its own</dt>
        <dd>
          {online
            ? allPaused
              ? "Every agent is paused, so it doesn't run on its own until that is lifted."
              : own?.agent
                ? ownTurns(own.agent, own.allOn)
                : "Runs on its own."
            : `Doesn't run on its own. It works when you talk to it, or ${tasksWake ? "a room, a task" : "a room"} or a wake it booked calls it.${
                wakeWords(activity?.next) ? ` Next wake: ${wakeWords(activity?.next)}.` : ""
              }`}
          {lastRun && (
            <span className="world-agent-run">
              {" "}
              Last ran {ago(lastRun.started_at)}
              {lastRun.summary
                ? `: ${lastRun.summary.length > 140 ? `${lastRun.summary.slice(0, 139)}…` : lastRun.summary}`
                : "."}
            </span>
          )}
        </dd>
        <dt>Where</dt>
        <dd>{where ? (where.home ? "At home" : `In ${where.name}`) : "…"}</dd>
        <dt>Tasks</dt>
        <dd>
          <button type="button" className="world-panel-inline" onClick={onTasks}>
            {openTasks === 0 ? "None open" : openTasks === 1 ? "1 open" : `${openTasks} open`} · see them
          </button>
        </dd>
        {wear && onWear && (
          <>
            <dt>Wears</dt>
            <dd className="world-agent-wear">
              <span>
                {wearWords(worn)[0].toUpperCase()}
                {wearWords(worn).slice(1)}
                {!chosen && role && <span className="world-agent-when"> · what suits {aOrAn(role)}</span>}
                {chosen && role && (
                  <>
                    {" · "}
                    <button type="button" className="world-panel-inline" disabled={busy} onClick={() => dress(null)}>
                      back to what suits {aOrAn(role)}
                    </button>
                  </>
                )}
              </span>
              <span className="world-wear" role="group" aria-label={`What ${name} wears`}>
                {Object.keys(WEAR).map((thing) => (
                  <button
                    key={thing}
                    type="button"
                    className="world-wear-chip"
                    aria-pressed={worn.includes(thing)}
                    disabled={busy}
                    onClick={() => dress(toggleWear(worn, thing))}
                  >
                    {thing}
                  </button>
                ))}
              </span>
            </dd>
          </>
        )}
      </dl>
      <div className="world-panel-row world-agent-actions">
        {talking ? (
          <span className="world-panel-quiet">You're talking to {agent === "default" ? "it" : name} now.</span>
        ) : (
          <button type="button" className="talk-tool" onClick={onChat}>
            Chat with {name}
          </button>
        )}
        {onVisit && (
          <button type="button" className="talk-tool" onClick={onVisit}>
            Go to it
          </button>
        )}
        {onRedoRoom && (
          <button
            type="button"
            className="talk-tool"
            title="Ask it to make its room reflect what it has been working on"
            onClick={onRedoRoom}
          >
            Redo its room
          </button>
        )}
        {where && !where.home && onSendHome && (
          <button
            type="button"
            className="talk-tool"
            disabled={busy}
            onClick={() => void act("send it home", onSendHome)}
          >
            Send home
          </button>
        )}
        {online &&
          (resting ? (
            <button
              type="button"
              className="talk-tool"
              disabled={busy}
              onClick={() => void act("wake it", () => post("resume"))}
            >
              Wake up
            </button>
          ) : (
            <button
              type="button"
              className="talk-tool"
              disabled={busy}
              onClick={() => void act("pause it", () => post("pause", { hours: 4 }))}
            >
              Pause for 4 hours
            </button>
          ))}
      </div>
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </WorldPanel>
  );
}
