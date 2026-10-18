/**
 * The kinds of component an agent can send, and how each reads as text.
 *
 * A kind is data: a schema for its props, the actions it gets when the agent
 * names none, and a text form. Surfaces own drawing. The text form is the
 * guarantee — it is what a surface with no renderer shows and what the model
 * reads back — so every kind must have one, and core writes it, not the model.
 *
 * The built-ins register through the same registry a plugin uses.
 */
import { randomBytes } from "node:crypto";
import type { ActionEffect, ActionSpec, ComponentSpec } from "../content/types.js";
import { type Disposer, Registry } from "../registry.js";
import type { JsonSchema } from "../state/types.js";
import { validateAgainstSchema } from "../state/validate.js";

export interface ComponentKind {
  kind: string;
  /** One line for the agent: what this kind is for. */
  description: string;
  /** Checked on every send and update. */
  schema: JsonSchema;
  /** The actions a component of this kind has when the agent supplies none. */
  defaultActions(props: Record<string, unknown>): ActionSpec[];
  /**
   * Whether the agent may supply its own buttons. A choice's buttons come from
   * its options and a confirm's are yes and no, so letting an agent replace
   * them would break the answer; a card has none of its own and takes any.
   */
  customActions?: boolean;
  /** How it reads where it cannot be drawn, including to the model. */
  fallback(props: Record<string, unknown>, actions: ActionSpec[]): string;
  /** Whether it can be bound to a world-state record and show it. */
  bindable?: boolean;
  /** Whether it shows the records a world-state query matches, and needs one. */
  queryable?: boolean;
}

export const componentKindRegistry = new Registry<ComponentKind>("component-kind");

export function registerComponentKind(kind: ComponentKind): Disposer {
  return componentKindRegistry.register(kind.kind, kind);
}

/** Something the agent got wrong, worded to be handed back to it as a correction. */
export class InterfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterfaceError";
  }
}

/** A button the agent asks for on a card. Ids and effects are filled in by core. */
export interface AgentAction {
  label: string;
  effect?: "reply" | "event" | "state";
  /** For an `event` effect: a name subscribers can match on. */
  name?: string;
  /** For a `state` effect: the fields to write. */
  patch?: Record<string, unknown>;
  /** For a `state` effect: the record to write. Defaults to the one the component is bound to. */
  ref?: { type: string; id: string };
}

export interface BuildComponentInput {
  kind: string;
  props: Record<string, unknown>;
  actions?: AgentAction[];
  expiresInMinutes?: number;
  /** Set when updating, so the component keeps its identity. */
  id?: string;
  /** The world-state record it shows; only for a kind that is `bindable`. */
  bind?: { type: string; id: string };
  /** The world-state query it shows; required by a kind that is `queryable`, refused by any other. */
  query?: { type: string; where?: Record<string, unknown>; limit?: number; scopes?: string[] };
}

/**
 * Validate an agent's request and turn it into a component: an id, the
 * actions, and the text form. Throws {@link InterfaceError} with a correction.
 */
export function buildComponent(input: BuildComponentInput, now: Date = new Date()): ComponentSpec {
  const kind = componentKindRegistry.get(input.kind);
  if (!kind) {
    throw new InterfaceError(
      `There is no component kind called "${input.kind}". Kinds: ${componentKindRegistry.list().join(", ")}.`,
    );
  }
  const errors = validateAgainstSchema(kind.schema, input.props);
  if (errors.length) {
    throw new InterfaceError(`The ${input.kind} was not sent:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }
  if (input.actions?.length && !kind.customActions) {
    throw new InterfaceError(
      `A ${input.kind}'s buttons come from its props; \`actions\` is for a card. Leave it out, or send a card.`,
    );
  }
  if (input.bind && !kind.bindable) {
    throw new InterfaceError(`A ${input.kind} cannot show a record; \`bind\` is for a card.`);
  }
  if (kind.queryable && !input.query) {
    throw new InterfaceError(
      `A ${input.kind} shows records: give \`bind\` with the record type, e.g. {"type": "task"}.`,
    );
  }
  if (input.query && !kind.queryable) {
    throw new InterfaceError(`A ${input.kind} cannot show a list of records; send a list.`);
  }
  const actions = input.actions?.length ? agentActions(input.actions, input.bind) : kind.defaultActions(input.props);
  const spec: ComponentSpec = {
    id: input.id ?? `c-${randomBytes(3).toString("hex")}`,
    kind: input.kind,
    props: input.props,
    ...(actions.length ? { actions } : {}),
    fallback: "",
    ...(input.expiresInMinutes && input.expiresInMinutes > 0
      ? { expiresAt: new Date(now.getTime() + input.expiresInMinutes * 60_000).toISOString() }
      : {}),
    ...(input.bind ? { bind: { type: input.bind.type, id: input.bind.id } } : {}),
    ...(input.query ? { query: input.query } : {}),
  };
  spec.fallback = `[${spec.kind} ${spec.id}] ${kind.fallback(input.props, actions)}`;
  return spec;
}

function agentActions(actions: AgentAction[], bind: { type: string; id: string } | undefined): ActionSpec[] {
  return actions.map((a, i) => {
    if (typeof a?.label !== "string" || !a.label.trim()) {
      throw new InterfaceError(`actions[${i}] needs a "label": the text on the button.`);
    }
    return { id: `a${i + 1}`, label: a.label.trim(), effect: actionEffect(a, i, bind) };
  });
}

function actionEffect(a: AgentAction, i: number, bind: { type: string; id: string } | undefined): ActionEffect {
  if (a.effect === "event") return { kind: "event", ...(a.name ? { name: a.name } : {}) };
  if (a.effect !== "state") return { kind: "reply" };
  const patch = a.patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new InterfaceError(
      `actions[${i}] ("${a.label}") changes state, so it needs a "patch": the fields to write, e.g. {"status": "done"}.`,
    );
  }
  const ref = isRef(a.ref) ? a.ref : bind;
  if (!ref) {
    throw new InterfaceError(
      `actions[${i}] ("${a.label}") changes state but names no record. Bind the card to one with \`bind\`, or give the button a "ref": {type, id}.`,
    );
  }
  return { kind: "state", ref: { type: ref.type, id: ref.id }, patch };
}

function isRef(v: unknown): v is { type: string; id: string } {
  const r = v as { type?: unknown; id?: unknown } | null;
  return typeof r?.type === "string" && r.type !== "" && typeof r?.id === "string" && r.id !== "";
}

const reply: ActionEffect = { kind: "reply" };

/** Most items a list holds; the rest are counted in `more`. */
export const MAX_LIST_ITEMS = 50;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const choice: ComponentKind = {
  kind: "choice",
  description: "A question with a few options to pick from, drawn as buttons.",
  schema: {
    type: "object",
    required: ["question", "options"],
    additionalProperties: false,
    properties: {
      question: { type: "string", minLength: 1 },
      options: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", minLength: 1 } },
      allowText: { type: "boolean" },
    },
  },
  defaultActions: (props) => [
    ...list(props.options).map((o, i) => ({ id: `option-${i + 1}`, label: str(o), effect: reply })),
    ...(props.allowText ? [{ id: "text", label: "Something else", effect: reply }] : []),
  ],
  fallback: (props) =>
    [
      str(props.question),
      ...list(props.options).map((o, i) => `${i + 1}. ${str(o)}`),
      props.allowText ? "Reply with a number, or in your own words." : "Reply with a number.",
    ].join("\n"),
};

const FIELD_TYPES = ["text", "number", "boolean", "select", "date"];

const form: ComponentKind = {
  kind: "form",
  description: "A few named fields for someone to fill in, sent back together.",
  schema: {
    type: "object",
    required: ["title", "fields"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1 },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
            label: { type: "string" },
            type: { type: "string", enum: FIELD_TYPES },
            required: { type: "boolean" },
            options: { type: "array", items: { type: "string" } },
          },
        },
      },
      submitLabel: { type: "string" },
    },
  },
  defaultActions: (props) => [{ id: "submit", label: str(props.submitLabel) || "Send", effect: reply }],
  fallback: (props) =>
    [
      str(props.title),
      "Reply with:",
      ...list(props.fields).map((f) => {
        const field = f as Record<string, unknown>;
        const type = str(field.type) || "text";
        const detail = [
          type === "select" && list(field.options).length ? `one of ${list(field.options).map(str).join(", ")}` : type,
          field.required ? "required" : "",
        ]
          .filter(Boolean)
          .join(", ");
        return `- ${str(field.label) || str(field.name)} (${detail})`;
      }),
    ].join("\n"),
};

const confirm: ComponentKind = {
  kind: "confirm",
  description: "A yes-or-no decision about something specific, with optional details.",
  schema: {
    type: "object",
    required: ["summary"],
    additionalProperties: false,
    properties: {
      summary: { type: "string", minLength: 1 },
      details: { type: "string" },
      confirmLabel: { type: "string" },
      denyLabel: { type: "string" },
    },
  },
  defaultActions: (props) => [
    { id: "confirm", label: str(props.confirmLabel) || "Yes", effect: reply },
    { id: "deny", label: str(props.denyLabel) || "No", effect: reply },
  ],
  fallback: (props) => {
    const yes = str(props.confirmLabel) || "Yes";
    const no = str(props.denyLabel) || "No";
    return [str(props.summary), ...(props.details ? [str(props.details)] : []), `Reply "${yes}" or "${no}".`].join(
      "\n",
    );
  },
};

const card: ComponentKind = {
  kind: "card",
  description: "Something to look at: a title, text, and label-value fields, optionally with buttons.",
  schema: {
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: "string" },
      fields: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          required: ["label", "value"],
          additionalProperties: false,
          properties: { label: { type: "string" }, value: { type: "string" } },
        },
      },
    },
  },
  defaultActions: () => [],
  customActions: true,
  bindable: true,
  fallback: (props, actions) =>
    [
      str(props.title),
      ...(props.body ? [str(props.body)] : []),
      ...list(props.fields).map((f) => {
        const field = f as Record<string, unknown>;
        return `${str(field.label)}: ${str(field.value)}`;
      }),
      ...(actions.length ? [`Options: ${actions.map((a) => a.label).join(", ")}.`] : []),
    ].join("\n"),
};

/**
 * The records a query matches, as a checklist. The items are filled by core
 * from the query, never by the agent, and refreshed whenever a record of the
 * type changes. With `check`, ticking an item flips that field on the record:
 * `on` when it is not on, `off` when it is.
 */
const listKind: ComponentKind = {
  kind: "list",
  description: "The records a state query matches, kept current; with `check`, ticking one flips a field.",
  schema: {
    type: "object",
    required: ["title", "items"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1 },
      items: {
        type: "array",
        maxItems: MAX_LIST_ITEMS,
        items: {
          type: "object",
          required: ["id", "label"],
          additionalProperties: false,
          properties: { id: { type: "string" }, label: { type: "string" }, checked: { type: "boolean" } },
        },
      },
      check: {
        type: "object",
        required: ["field"],
        additionalProperties: false,
        properties: { field: { type: "string", minLength: 1 }, on: {}, off: {} },
      },
      more: { type: "integer", minimum: 0 },
    },
  },
  defaultActions: () => [],
  queryable: true,
  fallback: (props) => {
    const check = props.check !== undefined;
    const items = list(props.items) as Record<string, unknown>[];
    return [
      str(props.title),
      ...(items.length
        ? items.map((i) => (check ? `- [${i.checked ? "x" : " "}] ${str(i.label)}` : `- ${str(i.label)}`))
        : ["(nothing matches)"]),
      ...(typeof props.more === "number" && props.more > 0 ? [`…and ${props.more} more.`] : []),
    ].join("\n");
  },
};

/**
 * How far along something is: a number out of a maximum, or a list of steps
 * with the current one marked. Sent once and moved along with `update`, which
 * redraws it in place everywhere it was posted.
 */
const progress: ComponentKind = {
  kind: "progress",
  description: "How far along a job is: a value out of a max, or named steps with the current one marked.",
  schema: {
    type: "object",
    required: ["label"],
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1 },
      value: { type: "number", minimum: 0 },
      max: { type: "number", minimum: 1 },
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 } },
      done: { type: "integer", minimum: 0 },
      note: { type: "string" },
    },
  },
  defaultActions: () => [],
  fallback: (props) => [str(props.label), ...progressLines(props), ...(props.note ? [str(props.note)] : [])].join("\n"),
};

/**
 * A progress component's lines in plain text: "3 of 6 (50%)", or each step
 * marked done, current or still to come. Shared by every surface's text form.
 */
export function progressLines(props: Record<string, unknown>): string[] {
  return progressText(props);
}

/**
 * How many of a progress component's steps are finished: `done`, or else a
 * `value` sent alongside the steps, which is how a local model counted them
 * one run in three.
 */
export function stepsDone(props: Record<string, unknown>): number {
  if (typeof props.done === "number") return props.done;
  if (typeof props.value === "number") return Math.floor(props.value);
  return 0;
}

function progressText(props: Record<string, unknown>): string[] {
  const steps = list(props.steps).map(str);
  if (steps.length) {
    const at = stepsDone(props);
    return steps.map((s, i) => `${i < at ? "✓" : i === at ? "→" : "·"} ${s}`);
  }
  if (typeof props.value === "number") {
    const max = typeof props.max === "number" ? props.max : 100;
    const pct = Math.max(0, Math.min(100, Math.round((props.value / max) * 100)));
    return [max === 100 ? `${pct}%` : `${props.value} of ${max} (${pct}%)`];
  }
  return ["Working…"];
}

/**
 * The records a query matches as rows and columns. Filled and refreshed by
 * core like a list; read-only.
 */
const table: ComponentKind = {
  kind: "table",
  description: "The records a state query matches, as rows and columns, kept current.",
  schema: {
    type: "object",
    required: ["title", "columns", "rows"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1 },
      columns: { type: "array", maxItems: 12, items: { type: "string" } },
      rows: {
        type: "array",
        maxItems: MAX_LIST_ITEMS,
        items: {
          type: "object",
          required: ["id", "cells"],
          additionalProperties: false,
          properties: { id: { type: "string" }, cells: { type: "array", items: { type: "string" } } },
        },
      },
      more: { type: "integer", minimum: 0 },
    },
  },
  defaultActions: () => [],
  queryable: true,
  fallback: (props) => {
    const columns = list(props.columns).map(str);
    const rows = (list(props.rows) as Record<string, unknown>[]).map((r) => list(r.cells).map(str));
    return [
      str(props.title),
      ...(rows.length
        ? [
            `| ${columns.join(" | ")} |`,
            `|${columns.map(() => "---").join("|")}|`,
            ...rows.map((c) => `| ${c.join(" | ")} |`),
          ]
        : ["(nothing matches)"]),
      ...(typeof props.more === "number" && props.more > 0 ? [`…and ${props.more} more.`] : []),
    ].join("\n");
  },
};

for (const kind of [choice, form, confirm, card, listKind, progress, table]) {
  if (!componentKindRegistry.has(kind.kind)) componentKindRegistry.register(kind.kind, kind);
}
