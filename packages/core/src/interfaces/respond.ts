/**
 * A person answering a component.
 *
 * Checked against the stored record — still open, the action exists, the value
 * fits the kind — then recorded once. A `reply` action hands back the text that
 * continues the conversation as the person's next message; an `event` action
 * is announced as `interface.action` for subscriptions and hooks to route.
 */
import type { ActionSpec } from "../content/types.js";
import type { EventBus } from "../events.js";
import type { StateService } from "../state/service.js";
import { StateConflictError, StateError, type StateRecord } from "../state/types.js";
import { InterfaceError } from "./kinds.js";
import type { ComponentRecord, InterfaceStore } from "./store.js";

export interface RespondInput {
  id: string;
  actionId: string;
  /** Free text for a choice that allows it, or field values for a form. */
  value?: unknown;
  /** Who responded, for the record and the event. */
  by: string;
}

export type RespondResult =
  | { effect: "reply"; reply: string }
  | { effect: "event" }
  /** The record as the click left it. */
  | { effect: "state"; record: StateRecord };

export interface RespondOptions {
  /** Where `state` actions write. Without it a `state` action is refused. */
  state?: StateService;
  /** The surface the click came from, recorded on the state change: `web`, `discord`. */
  surface?: string;
}

export async function respondToComponent(
  store: InterfaceStore,
  events: EventBus | undefined,
  input: RespondInput,
  opts: RespondOptions = {},
): Promise<RespondResult> {
  const record = store.get(input.id);
  if (!record) throw new InterfaceError(`There is no component with id "${input.id}".`);
  if (record.status !== "open") {
    throw new InterfaceError(
      record.status === "expired"
        ? "This question has expired."
        : record.status === "answered"
          ? "This has already been answered."
          : "This was closed by the agent.",
    );
  }
  const action = record.spec.actions?.find((a) => a.id === input.actionId);
  if (!action) throw new InterfaceError(`This ${record.spec.kind} has no action "${input.actionId}".`);

  // A state button is not an answer: it writes, and the component stays open
  // for the next click, the way a checkbox does.
  if (action.effect.kind === "state") {
    if (!opts.state) throw new InterfaceError("This button changes state, and state is not available here.");
    try {
      const written = await opts.state.patch(
        {
          actor: { kind: "user", name: input.by },
          source: { ...(opts.surface ? { surface: opts.surface } : {}), interfaceId: record.spec.id },
        },
        action.effect.ref,
        action.effect.patch,
      );
      return { effect: "state", record: written };
    } catch (err) {
      // Worded for the person who clicked: the record is gone, or the write does not fit.
      if (err instanceof StateConflictError || err instanceof StateError) throw new InterfaceError(err.message);
      throw err;
    }
  }

  const reply = replyText(record, action, input.value);
  const recorded = store.respond(input.id, {
    actionId: action.id,
    ...(input.value !== undefined ? { value: input.value } : {}),
    by: input.by,
    at: new Date().toISOString(),
  });
  // Two clicks racing: the store let exactly one through.
  if (!recorded) throw new InterfaceError("This has already been answered.");

  if (action.effect.kind === "event") {
    events?.emit("interface.action", {
      componentId: record.spec.id,
      kind: record.spec.kind,
      actionId: action.id,
      ...(action.label ? { label: action.label } : {}),
      ...(action.effect.name ? { name: action.effect.name } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      agent: record.agent,
      sessionId: record.sessionId,
      by: input.by,
    });
    return { effect: "event" };
  }
  return { effect: "reply", reply };
}

/**
 * What the person's answer says, as the message that continues the
 * conversation. Plain words, because the agent reads it like anything else
 * the person typed.
 */
function replyText(record: ComponentRecord, action: ActionSpec, value: unknown): string {
  const { spec } = record;
  if (spec.kind === "choice" && action.id === "text") {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new InterfaceError("Say something in the text box first.");
    return text;
  }
  if (spec.kind === "form") {
    const values = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const fields = Array.isArray(spec.props.fields) ? (spec.props.fields as Record<string, unknown>[]) : [];
    const missing = fields.filter((f) => f.required && isBlank(values[String(f.name)])).map((f) => label(f));
    if (missing.length) throw new InterfaceError(`Fill in: ${missing.join(", ")}.`);
    const lines = fields
      .filter((f) => !isBlank(values[String(f.name)]))
      .map((f) => `${label(f)}: ${String(values[String(f.name)])}`);
    return [String(spec.props.title ?? "Form"), ...lines].join("\n");
  }
  return action.label ?? action.id;
}

function label(field: Record<string, unknown>): string {
  return String(field.label || field.name);
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}
