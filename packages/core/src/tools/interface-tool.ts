import { componentPart, textPart } from "../content/types.js";
import { boundCardProps } from "../interfaces/bind.js";
import { type AgentAction, buildComponent, componentKindRegistry, InterfaceError } from "../interfaces/kinds.js";
import type { InterfaceStore } from "../interfaces/store.js";
import type { StateService } from "../state/service.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { agentStateCaller } from "./state.js";

/**
 * Lets an agent send something interactive instead of plain text.
 *
 * The component travels in this tool's result, the way a screenshot does:
 * results are stored, and each surface reads what a turn produced from the
 * stored messages. The web UI draws it; anything else shows the text form
 * core wrote for it, and the model reads that text form too.
 *
 * The sender comes from the tool context, never from an argument, so an agent
 * can only update or close what it sent itself.
 */
export class InterfaceTool implements Tool {
  name = "interface";
  description =
    "Send something interactive instead of plain text: a choice, a form, a yes/no confirmation, or a card. A person's answer comes back as their next message.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send", "update", "close"],
        description:
          "send: a new component. update: change one you sent that is still open. close: stop it taking answers.",
      },
      kind: {
        type: "string",
        description:
          "send: choice (a question with options), form (fields to fill in), confirm (yes or no), or card (something to look at, with optional buttons).",
      },
      props: {
        type: "object",
        description:
          "choice {question, options[], allowText?}. form {title, fields[{name, label?, type?: text|number|boolean|select|date, required?, options?}], submitLabel?}. confirm {summary, details?, confirmLabel?, denyLabel?}. card {title, body?, fields?[{label, value}]}.",
      },
      actions: {
        type: "array",
        items: { type: "object" },
        description:
          'card only: buttons, each {label, effect?: "reply" | "event" | "state", name?, patch?}. A state button writes `patch` to the bound record when clicked.',
      },
      bind: {
        type: "object",
        description: "card: show a state record {type, id}; the card stays current as the record changes.",
      },
      id: { type: "string", description: "update and close: the component's id." },
      expiresInMinutes: { type: "number", description: "send: stop taking answers after this many minutes." },
      note: { type: "string", description: "close: one line on why." },
    },
    required: ["action"],
  };

  constructor(
    private readonly getStore: () => InterfaceStore,
    private readonly getState?: () => StateService,
  ) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const store = this.getStore();
    const agent = context.agentName ?? "default";
    const action = String(args.action ?? "").toLowerCase();
    try {
      switch (action) {
        case "send": {
          const kind = typeof args.kind === "string" ? args.kind.trim() : "";
          if (!kind) return fail('send needs a `kind`: "choice", "form", "confirm" or "card".');
          const bind = refArg(args.bind);
          let props = objectArg(args.props, "props") ?? (bind ? {} : undefined);
          if (!props) return fail("send needs `props` for the component.");
          const lifted = liftActions(props, args.actions);
          props = lifted.props;
          const ignoredFields = Boolean(bind) && props.fields !== undefined;
          if (bind) props = await this.boundProps(kind, props, bind, context);
          const spec = buildComponent({
            kind,
            props,
            ...(bind ? { bind } : {}),
            ...(lifted.actions !== undefined ? { actions: actionsArg(lifted.actions) } : {}),
            ...(typeof args.expiresInMinutes === "number" ? { expiresInMinutes: args.expiresInMinutes } : {}),
          });
          store.create(spec, agent, context.sessionId);
          return {
            success: true,
            output: {
              parts: [
                textPart(sentNote(spec.kind, spec.id, spec.actions) + (ignoredFields ? FIELDS_FROM_RECORD : "")),
                componentPart(spec),
              ],
              structured: { componentId: spec.id },
            },
          };
        }
        case "update": {
          const record = this.own(store, args.id, agent);
          if (record.status !== "open")
            return fail(`${record.spec.kind} ${record.spec.id} is ${record.status}; it can no longer change.`);
          if (typeof args.kind === "string" && args.kind.trim() && args.kind.trim() !== record.spec.kind) {
            return fail(
              `${record.spec.id} is a ${record.spec.kind}; an update cannot change its kind. Send a new one instead.`,
            );
          }
          const bind = refArg(args.bind) ?? record.spec.bind;
          let props =
            objectArg(args.props, "props") ??
            (bind ? (record.spec.props.body ? { body: record.spec.props.body } : {}) : undefined);
          if (!props) return fail("update needs `props`: the component's props as they should now be.");
          const lifted = liftActions(props, args.actions);
          props = lifted.props;
          if (bind) props = await this.boundProps(record.spec.kind, props, bind, context);
          const spec = buildComponent({
            kind: record.spec.kind,
            id: record.spec.id,
            props,
            ...(bind ? { bind } : {}),
            ...(lifted.actions !== undefined ? { actions: actionsArg(lifted.actions) } : {}),
            ...(typeof args.expiresInMinutes === "number" ? { expiresInMinutes: args.expiresInMinutes } : {}),
          });
          if (!spec.expiresAt && record.spec.expiresAt) spec.expiresAt = record.spec.expiresAt;
          if (!store.update(spec)) return fail(`${record.spec.id} is no longer open.`);
          return {
            success: true,
            output: {
              parts: [textPart(`Updated ${spec.kind} ${spec.id}.`), componentPart(spec)],
              structured: { componentId: spec.id },
            },
          };
        }
        case "close": {
          const record = this.own(store, args.id, agent);
          const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
          // Tidying up after an answer is what a careful agent does, and measured
          // on a local model it did so two runs in three. The goal — no more
          // answers — already holds, so it succeeds and says what the answer was,
          // rather than costing a round on an error for doing the right thing.
          if (record.status === "answered") {
            const answer = describeAnswer(record);
            return {
              success: true,
              output: `${record.spec.kind} ${record.spec.id} was already answered${answer ? ` (${answer})` : ""}; it takes no more answers.`,
            };
          }
          if (!store.close(record.spec.id, note)) {
            return fail(`${record.spec.kind} ${record.spec.id} is already ${record.status}.`);
          }
          return { success: true, output: `Closed ${record.spec.kind} ${record.spec.id}; it no longer takes answers.` };
        }
        default:
          return fail(`Unknown action "${args.action}". Use one of: send, update, close.`);
      }
    } catch (err) {
      if (err instanceof InterfaceError) return fail(err.message);
      throw err;
    }
  }

  /** A bound card's props, filled from the record as the agent can see it now. */
  private async boundProps(
    kind: string,
    props: Record<string, unknown>,
    bind: { type: string; id: string },
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    if (!componentKindRegistry.get(kind)?.bindable) {
      throw new InterfaceError(`A ${kind} cannot show a record; \`bind\` is for a card.`);
    }
    const state = this.getState?.();
    if (!state) throw new InterfaceError("World state is not set up here, so a card cannot show a record.");
    const record = await state.get(agentStateCaller(context, "interface"), bind).catch((err: Error) => {
      throw new InterfaceError(err.message);
    });
    if (!record) throw new InterfaceError(`There is no ${bind.type} record "${bind.id}" you can see.`);
    return boundCardProps(props, record, state.getType(bind.type)?.title);
  }

  private own(store: InterfaceStore, id: unknown, agent: string) {
    if (typeof id !== "string" || !id.trim()) throw new InterfaceError("Say which component with `id`.");
    const record = store.get(id.trim());
    if (!record) throw new InterfaceError(`There is no component with id "${id}".`);
    if (record.agent !== agent)
      throw new InterfaceError(`${record.spec.id} was sent by another agent; only it can change it.`);
    return record;
  }
}

/** What was chosen, read from the record: the action's label, or the free text a choice allowed. */
function describeAnswer(record: {
  spec: { actions?: { id: string; label?: string }[] };
  response?: { actionId: string; value?: unknown };
}): string | undefined {
  const response = record.response;
  if (!response) return undefined;
  if (typeof response.value === "string") return `"${response.value}"`;
  const label = record.spec.actions?.find((a) => a.id === response.actionId)?.label;
  return label ? `"${label}"` : undefined;
}

function sentNote(kind: string, id: string, actions: { effect: { kind: string } }[] | undefined): string {
  if (!actions?.length) return `Sent ${kind} ${id}.`;
  const effects = new Set(actions.map((a) => a.effect.kind));
  const notes = [`Sent ${kind} ${id}.`];
  if (effects.has("reply")) {
    notes.push(`The answer will come back as the person's next message, and the ${kind} closes itself once answered.`);
  } else if (effects.has("event")) {
    notes.push("Clicks are announced as interface.action.");
  }
  // Said outright, so the agent does not wait for a reply that never comes.
  if (effects.has("state")) notes.push("Its state buttons write the record directly; no message comes back to you.");
  return notes.join(" ");
}

const FIELDS_FROM_RECORD = " It shows the record's own fields, so the fields you gave were left out.";

/**
 * Buttons put inside `props` instead of beside it, which a local model did
 * two runs in three. Lifted rather than refused: the intent is unambiguous,
 * and on a bound card the props are rebuilt, so left in place they would
 * vanish and the card would go out with no buttons.
 */
function liftActions(
  props: Record<string, unknown>,
  actions: unknown,
): { props: Record<string, unknown>; actions: unknown } {
  if (actions !== undefined || props.actions === undefined) return { props, actions };
  const { actions: inner, ...rest } = props;
  return { props: rest, actions: inner };
}

/** A `{type, id}` reference, accepted as an object or the JSON text small models often send. */
function refArg(value: unknown): { type: string; id: string } | undefined {
  const ref = objectArg(value, "bind");
  if (!ref) return undefined;
  if (typeof ref.type !== "string" || !ref.type || typeof ref.id !== "string" || !ref.id) {
    throw new InterfaceError('`bind` needs a record\'s `type` and `id`, e.g. {"type": "plan", "id": "trip"}.');
  }
  return { type: ref.type, id: ref.id };
}

/** Small models often send an object argument as a JSON string; accept that. */
function objectArg(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new InterfaceError(`\`${name}\` must be an object, and this text is not valid JSON.`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InterfaceError(`\`${name}\` must be an object.`);
  }
  return value as Record<string, unknown>;
}

function actionsArg(value: unknown): AgentAction[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new InterfaceError("`actions` must be a list, and this text is not valid JSON.");
    }
  }
  if (!Array.isArray(value)) throw new InterfaceError("`actions` must be a list of {label, effect?}.");
  return value as AgentAction[];
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
