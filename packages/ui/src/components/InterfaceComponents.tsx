import { useEffect, useState } from "react";
import { type ComponentState, type ComponentStatus, fetchInterfaces, respondInterface } from "../api";
import type { ActionSpec, ComponentSpec } from "../lib/content.js";
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
    return () => {
      cancelled = true;
    };
  }, [ids]);

  return (
    <>
      {specs.map((spec) => (
        <InterfaceComponent key={spec.id} spec={spec} state={states[spec.id]} />
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

  const expired = spec.expiresAt !== undefined && Date.parse(spec.expiresAt) <= Date.now();
  const status: ComponentStatus = answer !== null ? "answered" : (state?.status ?? (expired ? "expired" : "open"));
  const open = status === "open" && !busy;

  async function act(action: ActionSpec, value?: unknown, shown?: string) {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const result = await respondInterface(spec.id, action.id, value);
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
      <Body spec={spec} open={open} act={act} />
      <Status status={status} answer={answer ?? answeredLabel(spec, state)} note={state?.note} />
      {error && (
        <div className="iface-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

type Act = (action: ActionSpec, value?: unknown, shown?: string) => void;

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
    default:
      // A kind a plugin added that this UI has no renderer for: the text form
      // core wrote is still a complete question.
      return <div className="ask-prompt">{spec.fallback}</div>;
  }
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
