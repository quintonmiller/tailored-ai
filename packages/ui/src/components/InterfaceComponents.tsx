import { useEffect, useState } from "react";
import {
  type ComponentState,
  type ComponentStatus,
  fetchInterfaces,
  fetchStateRecord,
  fetchStateRecords,
  respondInterface,
  type StateRecordInfo,
} from "../api";
import type { ActionSpec, ComponentSpec } from "../lib/content.js";
import { stateTitleField, subscribeComponentChanges, subscribeStateChanges } from "../lib/state-events";
import { useChatStore } from "./ChatContext";

/**
 * Components an agent sent this turn, drawn under its reply.
 *
 * Their state lives on the server (still open, answered, closed by the agent,
 * expired), so it is fetched once for everything in view. A `reply` answer
 * continues the conversation as the person's next message, exactly as an
 * <ask> button does.
 */
export function InterfaceComponents({ specs }: { specs: ComponentSpec[] }) {
  const [states, setStates] = useState<Record<string, ComponentState>>({});
  const ids = specs.map((s) => s.id).join(",");

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    fetchInterfaces(ids.split(","))
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, ComponentState> = {};
        for (const c of res.components) if (c) next[c.id] = c;
        setStates(next);
      })
      // Drawing it open is the right failure: the server refuses a stale answer
      // with a sentence the component then shows.
      .catch(() => {});
    // Then live: an answer on Discord, an update or a close by the agent.
    const inView = new Set(ids.split(","));
    const off = subscribeComponentChanges((c) => {
      if (inView.has(c.id)) setStates((prev) => ({ ...prev, [c.id]: c }));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [ids]);

  return (
    <>
      {specs.map((spec) => (
        // The server's copy is the latest: an update replaces the props.
        <InterfaceComponent key={spec.id} spec={states[spec.id]?.spec ?? spec} state={states[spec.id]} />
      ))}
    </>
  );
}

const HEADERS: Record<string, string> = { choice: "Question", form: "Form", confirm: "Confirm" };

function InterfaceComponent({ spec, state }: { spec: ComponentSpec; state?: ComponentState }) {
  const store = useChatStore();
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const bound = useBoundRecord(spec.bind);
  const listed = useListItems(spec);

  // "Done" after a state button fades on its own; the card itself shows the change.
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 2500);
    return () => clearTimeout(timer);
  }, [done]);

  const expired = spec.expiresAt !== undefined && Date.parse(spec.expiresAt) <= Date.now();
  const status: ComponentStatus = answer !== null ? "answered" : (state?.status ?? (expired ? "expired" : "open"));
  const open = status === "open" && !busy;

  async function act(action: ActionSpec, value?: unknown, shown?: string) {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const result = await respondInterface(spec.id, action.id, value);
      if (result.effect === "state") {
        // Not an answer: the component stays open for the next click.
        setDone(`Done: ${action.label ?? action.id}`);
        if (spec.bind) bound.set(result.record.data);
        return;
      }
      setAnswer(shown ?? action.label ?? action.id);
      if (result.effect === "reply") store.send(result.reply);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const header = HEADERS[spec.kind];
  return (
    <div className={`iface iface-${spec.kind} ${status !== "open" ? "iface-done" : ""}`}>
      {header && (
        <div className="ask-header">
          <span className="ask-label">{header}</span>
        </div>
      )}
      <Body
        spec={
          listed
            ? { ...spec, props: listed }
            : bound.data
              ? { ...spec, props: boundView(spec.props, bound.data, bound.titleField) }
              : spec
        }
        open={open}
        act={act}
      />
      {bound.data === null && <div className="iface-details">This record was deleted.</div>}
      <Status status={status} answer={answer ?? answeredLabel(spec, state)} note={state?.note} />
      {done && (
        <div className="iface-status" role="status">
          {done}
        </div>
      )}
      {error && (
        <div className="iface-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

type Act = (action: ActionSpec, value?: unknown, shown?: string) => void;

/**
 * The record a bound card shows, kept current: fetched once, then replaced by
 * every change the state stream reports for it. `null` once it is deleted;
 * `undefined` for a card that is not bound, or before the first read.
 */
function useBoundRecord(bind: ComponentSpec["bind"]) {
  const [data, setData] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [titleField, setTitleField] = useState<string | undefined>(undefined);
  const type = bind?.type;
  const id = bind?.id;

  useEffect(() => {
    if (!type || !id) return;
    let cancelled = false;
    fetchStateRecord(type, id)
      .then((r) => !cancelled && setData(r.data))
      // Unreadable now: keep drawing it as it was sent.
      .catch(() => {});
    stateTitleField(type).then((t) => !cancelled && setTitleField(t));
    const off = subscribeStateChanges((c) => {
      if (c.type !== type || c.id !== id) return;
      setData(c.op === "delete" ? null : (c.after ?? null));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [type, id]);

  return { data, titleField, set: setData };
}

/**
 * A list's props from a fresh read of its query, kept current: re-read
 * whenever the state stream reports a change to a record of its type.
 * `undefined` for anything that is not a list, or before the first read.
 */
function useListItems(spec: ComponentSpec): Record<string, unknown> | undefined {
  const [props, setProps] = useState<Record<string, unknown> | undefined>(undefined);
  const query = spec.query;
  const key = query ? JSON.stringify(query) : "";
  const base = spec.props;
  const kind = spec.kind;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the query
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const limit = Math.min(Math.max(1, query.limit ?? 10), 50);
    const load = () =>
      // Oldest first, as core orders a list, so a tick does not move the item.
      Promise.all([
        fetchStateRecords(query.type, 500, { where: query.where, orderBy: "createdAt" }),
        stateTitleField(query.type),
      ])
        .then(([res, titleField]) => {
          if (cancelled) return;
          const view = kind === "table" ? tableView : listView;
          setProps(view(base, res.records, limit, query.scopes, titleField));
        })
        // Unreadable now: keep drawing the items it was sent with.
        .catch(() => {});
    load();
    const off = subscribeStateChanges((c) => {
      if (c.type === query.type) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);

  return props;
}

/** A table's props from its records. Mirrors `tableProps` in core's `interfaces/bind.ts`. */
function tableView(
  props: Record<string, unknown>,
  records: StateRecordInfo[],
  limit: number,
  scopes: string[] | undefined,
  titleField: string | undefined,
): Record<string, unknown> {
  const visible = scopes ? records.filter((r) => scopes.includes(r.scope)) : records;
  const shown = visible.slice(0, limit);
  const given = Array.isArray(props.columns) ? (props.columns as unknown[]).filter((c) => typeof c === "string") : [];
  let columns = given as string[];
  if (!columns.length) {
    const seen: string[] = titleField ? [titleField] : [];
    for (const r of shown) for (const k of Object.keys(r.data)) if (!seen.includes(k)) seen.push(k);
    columns = seen.slice(0, 6);
  }
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return {
    ...props,
    columns,
    rows: shown.map((r) => ({ id: r.id, cells: columns.map((c) => text(r.data[c])) })),
    more: Math.max(0, visible.length - limit),
  };
}

/** A list's props from its records. Mirrors `listProps` in core's `interfaces/bind.ts`. */
function listView(
  props: Record<string, unknown>,
  records: StateRecordInfo[],
  limit: number,
  scopes: string[] | undefined,
  titleField: string | undefined,
): Record<string, unknown> {
  const visible = scopes ? records.filter((r) => scopes.includes(r.scope)) : records;
  const check = props.check as { field?: string; on?: unknown } | undefined;
  const on = check?.on ?? true;
  return {
    ...props,
    items: visible.slice(0, limit).map((r) => {
      const named = titleField ? r.data[titleField] : undefined;
      return {
        id: r.id,
        label: typeof named === "string" && named.trim() ? named : r.id,
        ...(check?.field ? { checked: r.data[check.field] === on } : {}),
      };
    }),
    more: Math.max(0, visible.length - limit),
  };
}

/** A bound card's props from its record. Mirrors `boundCardProps` in core's `interfaces/bind.ts`. */
function boundView(
  props: Record<string, unknown>,
  data: Record<string, unknown>,
  titleField: string | undefined,
): Record<string, unknown> {
  const named = titleField ? data[titleField] : undefined;
  return {
    ...props,
    title: typeof named === "string" && named.trim() ? named : props.title,
    fields: Object.entries(data)
      .filter(([key]) => key !== titleField)
      .slice(0, 20)
      .map(([key, value]) => ({ label: key, value: typeof value === "string" ? value : JSON.stringify(value) })),
  };
}

function Body({ spec, open, act }: { spec: ComponentSpec; open: boolean; act: Act }) {
  const p = spec.props;
  const actions = spec.actions ?? [];
  switch (spec.kind) {
    case "choice":
      return <Choice question={str(p.question)} actions={actions} open={open} act={act} />;
    case "confirm":
      return (
        <>
          <div className="ask-prompt">{str(p.summary)}</div>
          {p.details ? <div className="iface-details">{str(p.details)}</div> : null}
          <Buttons actions={actions} open={open} act={act} />
        </>
      );
    case "form":
      return <Form spec={spec} open={open} act={act} />;
    case "card":
      return (
        <>
          <div className="iface-card-title">{str(p.title)}</div>
          {p.body ? <div className="iface-details">{str(p.body)}</div> : null}
          {Array.isArray(p.fields) && p.fields.length > 0 && (
            <dl className="iface-card-fields">
              {(p.fields as Record<string, unknown>[]).map((f, i) => (
                <div key={i} className="iface-card-field">
                  <dt>{str(f.label)}</dt>
                  <dd>{str(f.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {actions.length > 0 && <Buttons actions={actions} open={open} act={act} />}
        </>
      );
    case "list": {
      const items = (Array.isArray(p.items) ? p.items : []) as { id: string; label: string; checked?: boolean }[];
      const ticks = p.check !== undefined;
      return (
        <>
          <div className="iface-card-title">{str(p.title)}</div>
          {items.length === 0 ? (
            <div className="iface-details">Nothing matches.</div>
          ) : (
            <ul className="iface-list">
              {items.map((item) => (
                <li key={item.id}>
                  {ticks ? (
                    <label className="iface-list-item">
                      <input
                        type="checkbox"
                        checked={item.checked === true}
                        disabled={!open}
                        onChange={() =>
                          act({
                            id: `check:${item.id}`,
                            label: item.label,
                            effect: { kind: "state", ref: { type: spec.query?.type ?? "", id: item.id }, patch: {} },
                          })
                        }
                      />
                      <span>{item.label}</span>
                    </label>
                  ) : (
                    <span>{item.label}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {typeof p.more === "number" && p.more > 0 && <div className="iface-details">…and {p.more} more.</div>}
        </>
      );
    }
    case "progress":
      return <Progress props={p} />;
    case "table": {
      const columns = (Array.isArray(p.columns) ? p.columns : []).map(str);
      const rows = (Array.isArray(p.rows) ? p.rows : []) as { id: string; cells: string[] }[];
      return (
        <>
          <div className="iface-card-title">{str(p.title)}</div>
          {rows.length === 0 ? (
            <div className="iface-details">Nothing matches.</div>
          ) : (
            <div className="iface-table-wrap">
              <table className="iface-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {columns.map((c, i) => (
                        <td key={c}>{r.cells[i] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {typeof p.more === "number" && p.more > 0 && <div className="iface-details">…and {p.more} more.</div>}
        </>
      );
    }
    default:
      // A kind a plugin added that this UI has no renderer for: the text form
      // core wrote is still a complete question.
      return <div className="ask-prompt">{spec.fallback}</div>;
  }
}

/** A bar for a value out of a maximum, or the steps with the current one marked. */
function Progress({ props }: { props: Record<string, unknown> }) {
  const steps = Array.isArray(props.steps) ? props.steps.map(str) : [];
  // Mirrors `stepsDone` in core: `done`, or a `value` sent alongside the steps.
  const at =
    typeof props.done === "number" ? props.done : typeof props.value === "number" ? Math.floor(props.value) : 0;
  const max = typeof props.max === "number" ? props.max : 100;
  const pct =
    typeof props.value === "number" ? Math.max(0, Math.min(100, Math.round((props.value / max) * 100))) : null;
  return (
    <>
      <div className="iface-card-title">{str(props.label)}</div>
      {steps.length > 0 ? (
        <ol className="iface-steps">
          {steps.map((s, i) => (
            <li key={s} className={i < at ? "done" : i === at ? "current" : ""}>
              <span aria-hidden="true">{i < at ? "✓" : i === at ? "→" : "·"}</span> {s}
            </li>
          ))}
        </ol>
      ) : pct !== null ? (
        <div className="iface-progress">
          <div
            className="iface-progress-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={str(props.label)}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="iface-progress-text">
            {max === 100 ? `${pct}%` : `${String(props.value)} of ${max} (${pct}%)`}
          </span>
        </div>
      ) : (
        <div className="iface-details">Working…</div>
      )}
      {props.note ? <div className="iface-details">{str(props.note)}</div> : null}
    </>
  );
}

function Choice({
  question,
  actions,
  open,
  act,
}: {
  question: string;
  actions: ActionSpec[];
  open: boolean;
  act: Act;
}) {
  const [text, setText] = useState("");
  const buttons = actions.filter((a) => a.id !== "text");
  const free = actions.find((a) => a.id === "text");
  return (
    <>
      <div className="ask-prompt">{question}</div>
      <Buttons actions={buttons} open={open} act={act} />
      {free && open && (
        <div className="ask-text-input iface-free-text">
          <input
            type="text"
            value={text}
            placeholder="Or say something else…"
            aria-label="Answer in your own words"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) {
                e.preventDefault();
                act(free, text.trim(), text.trim());
              }
            }}
          />
          <button
            type="button"
            className="ask-send"
            disabled={!text.trim()}
            onClick={() => act(free, text.trim(), text.trim())}
          >
            Send
          </button>
        </div>
      )}
    </>
  );
}

function Buttons({ actions, open, act }: { actions: ActionSpec[]; open: boolean; act: Act }) {
  if (actions.length === 0) return null;
  return (
    <div className="ask-choices">
      {actions.map((a) => (
        <button key={a.id} type="button" className="ask-choice" disabled={!open} onClick={() => act(a)}>
          {a.label ?? a.id}
        </button>
      ))}
    </div>
  );
}

interface FieldSpec {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

function Form({ spec, open, act }: { spec: ComponentSpec; open: boolean; act: Act }) {
  const fields = (Array.isArray(spec.props.fields) ? spec.props.fields : []) as FieldSpec[];
  const submit = spec.actions?.find((a) => a.id === "submit") ?? spec.actions?.[0];
  const [values, setValues] = useState<Record<string, unknown>>({});
  const set = (name: string, value: unknown) => setValues((prev) => ({ ...prev, [name]: value }));
  const missing = fields.some((f) => f.required && (values[f.name] === undefined || values[f.name] === ""));

  return (
    <form
      className="iface-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (submit && !missing) act(submit, values, "Sent");
      }}
    >
      <div className="ask-prompt">{str(spec.props.title)}</div>
      {fields.map((f) => {
        const id = `${spec.id}-${f.name}`;
        const label = `${f.label || f.name}${f.required ? " *" : ""}`;
        return (
          <div key={f.name} className="iface-field">
            <label htmlFor={id}>{label}</label>
            {f.type === "boolean" ? (
              <input id={id} type="checkbox" disabled={!open} onChange={(e) => set(f.name, e.target.checked)} />
            ) : f.type === "select" ? (
              <select id={id} disabled={!open} defaultValue="" onChange={(e) => set(f.name, e.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                disabled={!open}
                onChange={(e) => set(f.name, f.type === "number" ? Number(e.target.value) : e.target.value)}
              />
            )}
          </div>
        );
      })}
      {submit && (
        <button type="submit" className="ask-send" disabled={!open || missing}>
          {submit.label ?? "Send"}
        </button>
      )}
    </form>
  );
}

function Status({ status, answer, note }: { status: ComponentStatus; answer: string | null; note?: string }) {
  if (status === "open") return null;
  const text =
    status === "answered"
      ? answer
        ? `You answered: ${answer}`
        : "Answered"
      : status === "closed"
        ? `Closed by the agent${note ? `: ${note}` : ""}`
        : "This question expired.";
  return <div className="ask-replied iface-status">{text}</div>;
}

/** What an earlier answer was, read back from the server's record. */
function answeredLabel(spec: ComponentSpec, state?: ComponentState): string | null {
  const response = state?.response;
  if (!response) return null;
  if (typeof response.value === "string") return response.value;
  if (spec.kind === "form") return "Sent";
  return spec.actions?.find((a) => a.id === response.actionId)?.label ?? response.actionId;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
