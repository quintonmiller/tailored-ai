import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DirectoryAgent,
  type DirectoryUpkeep,
  fetchDirectoryAgent,
  handToAgent,
  patchStateRecord,
  runUpkeep,
  type StateRecordInfo,
} from "../api";
import {
  AUTONOMY,
  ago,
  day,
  groupCommitments,
  lastMoved,
  PAGE_SECTIONS,
  type PageSection,
  pageOrder,
  pageSections,
  progressOf,
  recentMisses,
  updatesOf,
  upkeepChanges,
} from "../lib/agent-page";
import { renderMarkdown } from "../lib/markdown";
import { subscribeStateChanges } from "../lib/state-events";
import { Progress, QueryList } from "./InterfaceComponents";

/** The record types an agent's page is drawn from: a change to any of them that is this agent's redraws it. */
const PAGE_TYPES = new Set(["profile", "commitment", "doc", "miss", "page", "upkeep"]);

/** How often the page reads itself again while the agent is tidying up, in case the state stream misses the end. */
const UPKEEP_POLL_MS = 2_000;

/** How long to gather a burst of changes before reading the page again. */
const SETTLE_MS = 120;

/**
 * The sections that list work, and what each says it has none of. When every
 * one shown is empty, as on a fresh agent's page, they're said in one line,
 * so the form isn't pushed below four empty cards.
 */
const QUIET: Record<string, string> = {
  working: "open",
  waiting: "waiting on you",
  results: "finished lately",
  docs: "written up",
};

/** The time, moved on every minute, so ages and the two-week cut-off keep up with a page left open. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * An agent's page: what it's for, what it's working on, what waits on you,
 * what it finished, what it wrote up, what others asked it that nobody could
 * answer, and a form to hand it something. Drawn from the directory's
 * records, in the order the agent chose with its `page` record, and redrawn
 * as those records change, from the same state stream the State page reads.
 *
 * With the directory off it shows the configured description and how to turn
 * the directory on.
 */
export function AgentPage({ name, description }: { name: string; description?: string }) {
  // undefined while loading; null when the directory is off.
  const [agent, setAgent] = useState<DirectoryAgent | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(() => {
    // Only the newest read lands, so a slow early answer never replaces a later one.
    const seq = ++latest.current;
    fetchDirectoryAgent(name)
      .then((a) => {
        if (seq !== latest.current) return;
        setAgent(a);
        setError(null);
      })
      .catch((e) => seq === latest.current && setError((e as Error).message));
  }, [name]);

  useEffect(() => {
    setAgent(undefined);
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeStateChanges((c) => {
      if (!PAGE_TYPES.has(c.type)) return;
      // Its own records, or one just reassigned to or from it.
      const mine = c.after?.owner === name || c.before?.owner === name || (c.type === "page" && c.id === name);
      if (!mine) return;
      clearTimeout(timer);
      timer = setTimeout(load, SETTLE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [name, load]);

  // While it tidies up, read the page now and then too, so the end shows even when the stream drops it.
  const tidying = !!agent?.upkeep?.running;
  useEffect(() => {
    if (!tidying) return;
    const timer = setInterval(load, UPKEEP_POLL_MS);
    return () => clearInterval(timer);
  }, [tidying, load]);

  if (error && agent === undefined)
    return <div className="agent-section agent-empty">Couldn't load the page: {error}</div>;
  if (agent === undefined) return <div className="agent-section agent-loading">Loading…</div>;
  if (agent === null) return <DirectoryOff description={description} />;
  return <PageBody agent={agent} reload={load} />;
}

/** What a page shows with the directory off: the configured description, and how to turn it on. */
export function DirectoryOff({ description }: { description?: string }) {
  return (
    <section className="agent-section agent-page-about" aria-label="What I'm for">
      <h2>What I'm for</h2>
      {description ? (
        <p className="agent-page-purpose">{description}</p>
      ) : (
        <p className="agent-empty">No description configured.</p>
      )}
      <p className="agent-page-hint">
        Turn on the directory (<code>builtin:directory</code> under <code>plugins</code>) to see what it's working on
        and hand it work here.
      </p>
    </section>
  );
}

function PageBody({ agent, reload }: { agent: DirectoryAgent; reload: () => void }) {
  const now = useNow();
  const page = agent.page?.data;
  const extra = new Map(pageSections(page).map((s) => [s.id, s]));
  const groups = groupCommitments(agent.commitments, now);
  const misses = recentMisses(agent.misses, now);
  const docs = agent.docs.filter((d) => !d.archivedAt);
  const order = pageOrder(page);
  const counts: Record<string, number> = {
    working: groups.working.length,
    waiting: groups.waiting.length,
    results: groups.results.length,
    docs: docs.length,
  };
  const quiet = order.filter((id) => id in QUIET);
  const allQuiet = quiet.length > 1 && quiet.every((id) => counts[id] === 0);

  const section = (id: string) => {
    if (allQuiet && id in QUIET) return id === quiet[0] ? <Quiet key="quiet" ids={quiet} /> : null;
    switch (id) {
      case "about":
        return <About key={id} agent={agent} />;
      case "working":
        return (
          <Section key={id} id={id} count={groups.working.length}>
            {groups.working.length === 0 ? (
              <p className="agent-empty">Nothing open right now.</p>
            ) : (
              <ul className="agent-page-list">
                {groups.working.map((r) => (
                  <Working key={r.id} record={r} agent={agent.name} now={now} reload={reload} rooms={agent.rooms} />
                ))}
              </ul>
            )}
          </Section>
        );
      case "waiting":
        return (
          <Section key={id} id={id} count={groups.waiting.length} tone={groups.waiting.length ? "amber" : undefined}>
            {groups.waiting.length === 0 ? (
              <p className="agent-empty">Nothing is waiting on you.</p>
            ) : (
              <ul className="agent-page-list">
                {groups.waiting.map((r) => (
                  <Waiting key={r.id} record={r} agent={agent.name} now={now} />
                ))}
              </ul>
            )}
          </Section>
        );
      case "results":
        return (
          <Section key={id} id={id} count={groups.results.length}>
            {groups.results.length === 0 ? (
              <p className="agent-empty">Nothing finished in the last two weeks.</p>
            ) : (
              <ul className="agent-page-list">
                {groups.results.map((r) => (
                  <Result key={r.id} record={r} />
                ))}
              </ul>
            )}
          </Section>
        );
      case "docs":
        return (
          <Section key={id} id={id} count={docs.length}>
            {docs.length === 0 ? <p className="agent-empty">Nothing written up yet.</p> : <Docs docs={docs} />}
          </Section>
        );
      case "misses":
        // Only when there are some: an empty list of questions nobody could answer is no news.
        return misses.length === 0 ? null : (
          <Section key={id} id={id} count={misses.length}>
            <ul className="agent-page-list">
              {misses.map((m) => (
                <Miss key={m.id} record={m} />
              ))}
            </ul>
          </Section>
        );
      default: {
        const own = extra.get(id);
        return own ? <Extra key={id} section={own} /> : null;
      }
    }
  };

  return (
    <div className="agent-page">
      {agent.upkeep && <Upkeep agent={agent.name} upkeep={agent.upkeep} now={now} reload={reload} />}
      {order.map(section)}
      <HandOver agent={agent.name} example={list(agent.profile?.data.takesOn)[0]} />
    </div>
  );
}

/** The sections that list work, all empty, said in one line. */
function Quiet({ ids }: { ids: string[] }) {
  const words = ids.map((id) => QUIET[id]);
  const said = words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words[0];
  return (
    <section className="agent-section agent-page-section agent-page-quiet" aria-label="Nothing yet">
      <p className="agent-empty">Nothing {said} yet. Hand it something below.</p>
    </section>
  );
}

function Section({ id, count, tone, children }: { id: string; count?: number; tone?: "amber"; children: ReactNode }) {
  const title = PAGE_SECTIONS[id];
  return (
    <section className={`agent-section agent-page-section agent-page-${id}`} aria-label={title}>
      <h2>
        {title}
        {count ? <span className={`agent-page-count${tone ? ` ${tone}` : ""}`}>{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

function About({ agent }: { agent: DirectoryAgent }) {
  const p = agent.profile?.data;
  const purpose = text(p?.purpose);
  const takesOn = list(p?.takesOn);
  const howToAsk = text(p?.howToAsk);
  const note = text(agent.page?.data.note);
  const leads = agent.leads ?? [];
  return (
    <section className="agent-section agent-page-section agent-page-about" aria-label={PAGE_SECTIONS.about}>
      <h2>{PAGE_SECTIONS.about}</h2>
      {purpose ? (
        <p className="agent-page-purpose">{purpose}</p>
      ) : agent.description ? (
        <>
          <p className="agent-page-purpose">{agent.description}</p>
          <p className="agent-page-hint">Its configured description: it hasn't written a profile yet.</p>
        </>
      ) : (
        <p className="agent-empty">It hasn't said what it's for yet.</p>
      )}
      {note && (
        <figure className="agent-page-note">
          <blockquote>{note}</blockquote>
          <figcaption>In its own words</figcaption>
        </figure>
      )}
      {(takesOn.length > 0 || howToAsk || leads.length > 0) && (
        <dl className="agent-page-facts">
          {takesOn.length > 0 && (
            <div>
              <dt>Takes on</dt>
              <dd className="agent-page-chips">
                {takesOn.map((t) => (
                  <span key={t} className="agent-tool-chip">
                    {t}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {howToAsk && (
            <div>
              <dt>How to ask</dt>
              <dd>{howToAsk}</dd>
            </div>
          )}
          {leads.length > 0 && (
            <div>
              <dt>Leads</dt>
              <dd className="agent-page-chips">
                {leads.map((room) => (
                  <a key={room} className="agent-tool-chip" href={`#/rooms/${encodeURIComponent(room)}`}>
                    #{room}
                  </a>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

/** A commitment's goal, marked private when only its agent can see it. */
function Goal({ record, agent }: { record: StateRecordInfo; agent: string }) {
  return (
    <div className="agent-page-goal">
      <span>{text(record.data.goal) ?? record.id}</span>
      {record.scope === `agent:${agent}` && (
        <span className="agent-page-tag" title="Only this agent and you can see it">
          private
        </span>
      )}
    </div>
  );
}

/** A line of small facts, broken between them rather than inside one. A fact may be a control, like a select. */
export function Meta({ parts }: { parts: (string | ReactElement)[] }) {
  return (
    <div className="agent-page-meta">
      {parts.map((p, i) => (
        <span key={typeof p === "string" ? p : `control-${i}`}>
          {i > 0 && " · "}
          <span className="agent-page-nowrap">{p}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * How much the agent may do on its own about a commitment, which a person can
 * change here: the agent can only ask first, so more is yours to grant. The
 * pick shows at once and holds until the record comes back changed; a
 * refusal goes to `onError`, said under the line rather than inside it.
 */
function AutonomyPick({
  record,
  reload,
  onError,
}: {
  record: StateRecordInfo;
  reload: () => void;
  onError: (error: string | null) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const current = text(record.data.autonomy) ?? "suggest";
  // A new version is the record as saved, whoever saved it: it speaks for itself again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new version clears the pick.
  useEffect(() => setPending(null), [record.version]);
  async function change(next: string) {
    setPending(next);
    onError(null);
    try {
      await patchStateRecord(record.type, record.id, { autonomy: next }, record.version);
      // Read again rather than wait on the stream, which may miss it.
      reload();
    } catch (err) {
      setPending(null);
      onError(
        (err as { status?: number }).status === 409
          ? "This changed while you were looking. Pick again."
          : (err as Error).message,
      );
    }
  }
  const shown = pending ?? current;
  return (
    <span className="agent-page-autonomy">
      <select
        aria-label={`What it may do on its own about “${text(record.data.goal) ?? record.id}”`}
        title="It can only ask first; acting on its own is yours to grant."
        value={shown}
        onChange={(e) => change(e.target.value)}
      >
        {Object.entries(AUTONOMY).map(([value, words]) => (
          <option key={value} value={value}>
            {words}
          </option>
        ))}
        {!(shown in AUTONOMY) && <option value={shown}>{shown}</option>}
      </select>
    </span>
  );
}

/** The dated updates behind a commitment, opened on request, each saying who wrote it when it says. */
export function Updates({ record }: { record: StateRecordInfo }) {
  const updates = updatesOf(record);
  if (updates.length === 0) return null;
  return (
    <details className="agent-page-updates">
      <summary>
        {updates.length} update{updates.length === 1 ? "" : "s"}
      </summary>
      <ol>
        {updates.map((u, i) => (
          <li key={`${u.at}-${i}`}>
            <time dateTime={u.at}>{day(u.at)}</time>
            <span>
              {u.text}
              {u.by && <span className="agent-page-by"> · {u.by}</span>}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function Working({
  record,
  agent,
  now,
  reload,
  rooms,
}: {
  record: StateRecordInfo;
  agent: string;
  now: Date;
  reload: () => void;
  /** Room names by ref, for a commitment taken on for a room. */
  rooms?: Record<string, string>;
}) {
  const d = record.data;
  const progress = progressOf(d.progress);
  const [error, setError] = useState<string | null>(null);
  const room = text(d.room) && rooms?.[text(d.room) as string];
  const meta = [
    text(d.nextCheck) && `check ${text(d.nextCheck)}`,
    <AutonomyPick key="autonomy" record={record} reload={reload} onError={setError} />,
    room && (
      <a key="room" href={`#/rooms/${encodeURIComponent(room)}`}>
        for #{room}
      </a>
    ),
    text(d.from) && `from ${text(d.from)}`,
    `updated ${ago(lastMoved(record), now)}`,
  ].filter((p): p is string | ReactElement => !!p);
  return (
    <li className="agent-page-item">
      <Goal record={record} agent={agent} />
      {text(d.nextStep) && (
        <div className="agent-page-line">
          <span className="agent-page-label">Next</span> {text(d.nextStep)}
        </div>
      )}
      {text(d.doneWhen) && (
        <div className="agent-page-line">
          <span className="agent-page-label">Done when</span> {text(d.doneWhen)}
        </div>
      )}
      {progress &&
        ("label" in progress ? (
          <div className="agent-page-line">
            <span className="agent-page-label">At</span> {progress.label}
          </div>
        ) : (
          <div className="agent-page-progress">
            <Progress props={{ label: "", value: progress.value, max: progress.max }} />
          </div>
        ))}
      <Meta parts={meta} />
      {error && (
        <p className="agent-page-error agent-page-item-error" role="alert">
          {error}
        </p>
      )}
      <Updates record={record} />
    </li>
  );
}

function Waiting({ record, agent, now }: { record: StateRecordInfo; agent: string; now: Date }) {
  const d = record.data;
  return (
    <li className="agent-page-item">
      <Goal record={record} agent={agent} />
      <div className="agent-page-line">
        <span className="agent-page-label">Waiting on</span> {text(d.waitingOn) ?? "someone"}
      </div>
      {text(d.nextStep) && (
        <div className="agent-page-line">
          <span className="agent-page-label">Then</span> {text(d.nextStep)}
        </div>
      )}
      <div className="agent-page-meta">since {ago(lastMoved(record), now)}</div>
      <Updates record={record} />
    </li>
  );
}

function Result({ record }: { record: StateRecordInfo }) {
  const said = updatesOf(record)[0]?.text;
  return (
    <li className="agent-page-item agent-page-result">
      <div className="agent-page-goal">
        <span className="agent-page-done" aria-hidden="true">
          ✓
        </span>
        <span>{text(record.data.goal) ?? record.id}</span>
        <time className="agent-page-date" dateTime={lastMoved(record)}>
          {day(lastMoved(record))}
        </time>
      </div>
      {said && said !== "Done." && <div className="agent-page-meta">{said}</div>}
    </li>
  );
}

export function Docs({ docs }: { docs: StateRecordInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="agent-page-list">
      {docs.map((d) => {
        const reviewed = text(d.data.reviewedAt);
        const isOpen = open === d.id;
        return (
          <li key={d.id} className={`agent-page-item agent-page-doc${isOpen ? " open" : ""}`}>
            <button
              type="button"
              className="agent-page-doc-title"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : d.id)}
            >
              <span>{text(d.data.title) ?? d.id}</span>
              <span className="agent-page-date">{reviewed ? `reviewed ${day(reviewed)}` : "never reviewed"}</span>
            </button>
            {text(d.data.summary) && <div className="agent-page-summary">{text(d.data.summary)}</div>}
            {isOpen && <DocBody doc={d} />}
          </li>
        );
      })}
    </ul>
  );
}

function DocBody({ doc }: { doc: StateRecordInfo }) {
  const body = text(doc.data.body);
  const html = useMemo(() => (body ? renderMarkdown(body) : ""), [body]);
  const tags = list(doc.data.tags);
  return (
    <div className="agent-page-doc-body">
      {html ? (
        // renderMarkdown sanitizes: a doc can hold text from an email or a web page.
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="agent-empty">This doc has no body.</p>
      )}
      {tags.length > 0 && (
        <div className="agent-page-chips">
          {tags.map((t) => (
            <span key={t} className="agent-tool-chip">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Miss({ record }: { record: StateRecordInfo }) {
  const askedBy = list(record.data.askedBy);
  const at = text(record.data.at) ?? record.createdAt;
  return (
    <li className="agent-page-item">
      <div className="agent-page-goal">
        <span>“{text(record.data.query) ?? record.id}”</span>
        <time className="agent-page-date" dateTime={at}>
          {day(at)}
        </time>
      </div>
      {askedBy.length > 0 && <div className="agent-page-meta">asked by {askedBy.join(", ")}</div>}
    </li>
  );
}

/** A section the agent added: its title, over the list its query matches, kept current like a list it sends. */
function Extra({ section }: { section: PageSection }) {
  return (
    <section className="agent-section agent-page-section agent-page-extra" aria-label={section.title}>
      <h2>{section.title}</h2>
      <QueryList
        spec={{
          id: `page-section-${section.id}`,
          kind: "list",
          props: { title: "", items: [] },
          query: section.query,
          fallback: section.title,
        }}
      />
    </section>
  );
}

/** Why an agent won't see a commitment it was handed in its prompt, by the reason the server gives. */
const NOT_IN_PROMPT: Record<string, string> = {
  tool: "It doesn't have the commitment tool, so it won't see this in its prompt.",
  pin: "The “Your commitments” block is turned off, so it won't see this unless it looks.",
};

/**
 * Hand the agent a commitment of its own, from you. `example` is a kind of
 * work it takes on, for the hint. `send` says where it goes when the page is
 * a room's and the work goes to its lead; `note` says so under the heading.
 */
export function HandOver({
  agent,
  example,
  send,
  note,
}: {
  agent: string;
  example?: string;
  send?: (input: {
    goal: string;
    doneWhen?: string;
    autonomy?: string;
  }) => Promise<{ inPrompt: boolean; why?: string }>;
  note?: string;
}) {
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [autonomy, setAutonomy] = useState("suggest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handed, setHanded] = useState<{ goal: string; inPrompt: boolean; why?: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = {
        goal: goal.trim(),
        ...(doneWhen.trim() ? { doneWhen: doneWhen.trim() } : {}),
        ...(autonomy !== "suggest" ? { autonomy } : {}),
      };
      const res = await (send ? send(input) : handToAgent(agent, input));
      setHanded({ goal: goal.trim(), inPrompt: res.inPrompt, why: res.why });
      setGoal("");
      setDoneWhen("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-section agent-page-section agent-page-hand" aria-label="Hand it something">
      <h2>Hand it something</h2>
      {note && <p className="agent-page-hint agent-page-hand-note">{note}</p>}
      <form className="agent-page-form" onSubmit={submit}>
        <label>
          <span>Goal</span>
          <input
            type="text"
            value={goal}
            maxLength={300}
            placeholder={example ? `Something like: ${example}` : "What should it take on?"}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <label>
          <span>Done when</span>
          <input
            type="text"
            value={doneWhen}
            maxLength={500}
            placeholder="Optional: how you'll know it's done"
            onChange={(e) => setDoneWhen(e.target.value)}
          />
        </label>
        <label>
          <span>On its own, it</span>
          <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
            {Object.entries(AUTONOMY).map(([value, words]) => (
              <option key={value} value={value}>
                {words}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={!goal.trim() || busy}>
          {busy ? "Handing over…" : "Hand it over"}
        </button>
      </form>
      {handed && (
        <output className="agent-page-handed">
          Handed to {agent}: “{handed.goal}”.{" "}
          {handed.inPrompt
            ? "It sees this under “Your commitments” on its next turn."
            : ((handed.why && NOT_IN_PROMPT[handed.why]) ?? "It won't see this in its prompt on its own.")}
        </output>
      )}
      {error && (
        <p className="agent-page-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The agent's upkeep, in a line: when it last looked after what it owns and
 * what that changed, counted from its records' history, or that it is doing
 * so now. "Tidy up now" asks for a turn at once.
 */
function Upkeep({
  agent,
  upkeep,
  now,
  reload,
}: {
  agent: string;
  upkeep: DirectoryUpkeep;
  now: Date;
  reload: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a turn this page saw running has finished, so the line says it just did.
  const [finished, setFinished] = useState(false);
  const wasRunning = useRef(upkeep.running);
  useEffect(() => {
    if (wasRunning.current && !upkeep.running) setFinished(true);
    wasRunning.current = upkeep.running;
    // An upkeep under way is news past an earlier refusal, which would otherwise sit under it.
    if (upkeep.running) setError(null);
  }, [upkeep.running]);
  // So is one that finished, the scheduled kind included.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new finish time is the trigger.
  useEffect(() => setError(null), [upkeep.at]);

  const running = upkeep.running || asking;
  const changes = upkeepChanges(upkeep.changed);

  async function tidy() {
    setAsking(true);
    setError(null);
    setFinished(false);
    try {
      await runUpkeep(agent);
      wasRunning.current = true;
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAsking(false);
    }
  }

  const last = upkeep.at && (
    <>
      {finished && (
        <span className="agent-page-done" aria-hidden="true">
          ✓{" "}
        </span>
      )}
      {finished ? "Tidied up" : "Last upkeep"} {ago(upkeep.at, now)}
      {changes ? `: ${changes}` : ""}.
    </>
  );
  let status: ReactNode;
  if (running) {
    status = (
      <span>
        <span className="agent-now-pulse" aria-hidden="true" />
        Tidying up: going over its commitments, docs, page and notes…
      </span>
    );
  } else if (upkeep.error) {
    // When it failed and why, with the last good one after it, so an old failure reads as old.
    status = (
      <>
        <span className="agent-page-upkeep-failed" title={upkeep.error}>
          Couldn't tidy up{upkeep.failedAt ? ` ${ago(upkeep.failedAt, now)}` : ""}: {upkeep.error}
        </span>
        {last && <span>{last}</span>}
      </>
    );
  } else if (last) {
    status = <span>{last}</span>;
  } else {
    status = <span>No upkeep yet.</span>;
  }

  return (
    <section className="agent-section agent-page-upkeep" aria-label="Upkeep">
      <output className="agent-page-upkeep-status" aria-live="polite">
        {status}
        {upkeep.every && !running && <span className="agent-page-upkeep-every">Comes round every {upkeep.every}.</span>}
      </output>
      <button type="button" onClick={tidy} disabled={running}>
        {running ? "Tidying up…" : "Tidy up now"}
      </button>
      {error && (
        <p className="agent-page-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
