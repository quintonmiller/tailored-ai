import { componentPart, textPart } from "../content/types.js";
import { type AgentAction, buildComponent, InterfaceError } from "../interfaces/kinds.js";
import type { InterfaceStore } from "../interfaces/store.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

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
        description: 'card only: buttons, each {label, effect?: "reply" | "event", name?}.',
      },
      id: { type: "string", description: "update and close: the component's id." },
      expiresInMinutes: { type: "number", description: "send: stop taking answers after this many minutes." },
      note: { type: "string", description: "close: one line on why." },
    },
    required: ["action"],
  };

  constructor(private readonly getStore: () => InterfaceStore) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const store = this.getStore();
    const agent = context.agentName ?? "default";
    const action = String(args.action ?? "").toLowerCase();
    try {
      switch (action) {
        case "send": {
          const kind = typeof args.kind === "string" ? args.kind.trim() : "";
          if (!kind) return fail('send needs a `kind`: "choice", "form", "confirm" or "card".');
          const props = objectArg(args.props, "props");
          if (!props) return fail("send needs `props` for the component.");
          const spec = buildComponent({
            kind,
            props,
            ...(args.actions !== undefined ? { actions: actionsArg(args.actions) } : {}),
            ...(typeof args.expiresInMinutes === "number" ? { expiresInMinutes: args.expiresInMinutes } : {}),
          });
          store.create(spec, agent, context.sessionId);
          return {
            success: true,
            output: {
              parts: [textPart(sentNote(spec.kind, spec.id, spec.actions)), componentPart(spec)],
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
          const props = objectArg(args.props, "props");
          if (!props) return fail("update needs `props`: the component's props as they should now be.");
          const spec = buildComponent({
            kind: record.spec.kind,
            id: record.spec.id,
            props,
            ...(args.actions !== undefined ? { actions: actionsArg(args.actions) } : {}),
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

  private own(store: InterfaceStore, id: unknown, agent: string) {
    if (typeof id !== "string" || !id.trim()) throw new InterfaceError("Say which component with `id`.");
    const record = store.get(id.trim());
    if (!record) throw new InterfaceError(`There is no component with id "${id}".`);
    if (record.agent !== agent)
      throw new InterfaceError(`${record.spec.id} was sent by another agent; only it can change it.`);
    return record;
  }
}

function sentNote(kind: string, id: string, actions: { effect: { kind: string } }[] | undefined): string {
  if (!actions?.length) return `Sent ${kind} ${id}.`;
  return actions.some((a) => a.effect.kind === "reply")
    ? `Sent ${kind} ${id}. The answer will come back as the person's next message.`
    : `Sent ${kind} ${id}. Clicks are announced as interface.action.`;
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
