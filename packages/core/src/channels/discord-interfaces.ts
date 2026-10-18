/**
 * Interface components as Discord messages, and the clicks that answer them.
 *
 * A choice becomes buttons (or a select menu when it has many options), a
 * confirm two buttons, a card an embed with buttons, a form a button that
 * opens a pop-up form. Anything Discord cannot hold — a form with more fields
 * than a pop-up takes, a kind this module has no drawing for — returns null,
 * and the caller posts the component's text form instead.
 *
 * Clicks are routed by custom id rather than by a listener on one message, so
 * a question answered hours later, or after a restart, still finds its
 * component. The id carries only the component and the action; everything
 * else — whether it is still open, who sent it, what the answer means — is
 * read from the stored record when the click arrives.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ActionSpec, ComponentSpec } from "../content/types.js";
import type { EventBus } from "../events.js";
import { boundCardProps } from "../interfaces/bind.js";
import { InterfaceError } from "../interfaces/kinds.js";
import { respondToComponent } from "../interfaces/respond.js";
import type { ComponentRecord, InterfaceStore } from "../interfaces/store.js";
import type { StateService } from "../state/service.js";

/** The kinds this module draws. Declared on the channel's surface capabilities. */
export const DISCORD_COMPONENT_KINDS: readonly string[] = ["choice", "confirm", "card", "form"];

const PREFIX = "iface";
const MAX_BUTTONS = 20; // four rows of five, leaving a row for "Something else"
const MAX_SELECT = 25;
const MAX_MODAL_FIELDS = 5;
const MAX_TEXT = 1900; // a message holds 2000; the rest is the answer line
// A custom id holds 100 characters, and this module's ids carry the component
// id between colons. Generated ids are `c-` and six hex digits.
const MAX_COMPONENT_ID = 60;

export interface DiscordComponentMessage {
  content?: string;
  embeds?: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

type Op = "a" | "s" | "f" | "t" | "m" | "mt";

export function interfaceCustomId(componentId: string, op: Op, actionId?: string): string {
  return actionId ? `${PREFIX}:${componentId}:${op}:${actionId}` : `${PREFIX}:${componentId}:${op}`;
}

export function isInterfaceCustomId(customId: string): boolean {
  return customId.startsWith(`${PREFIX}:`);
}

export function parseInterfaceCustomId(customId: string): { componentId: string; op: Op; actionId?: string } | null {
  const [prefix, componentId, op, ...rest] = customId.split(":");
  if (prefix !== PREFIX || !componentId || !["a", "s", "f", "t", "m", "mt"].includes(op)) return null;
  return { componentId, op: op as Op, ...(rest.length ? { actionId: rest.join(":") } : {}) };
}

/** A component as a Discord message, or null when Discord cannot hold it; post the text form then. */
export function buildComponentMessage(spec: ComponentSpec): DiscordComponentMessage | null {
  return draw(spec, null);
}

/** The same message, finished: every control disabled, the chosen one marked, the answer stated. */
export function buildAnsweredMessage(
  spec: ComponentSpec,
  answer: { actionId?: string; label: string },
): DiscordComponentMessage | null {
  return draw(spec, { actionId: answer.actionId, line: `✅ ${answer.label}` });
}

/**
 * How a component's message should look now, from its stored record: live
 * while it is open (with `props` in place of the stored ones, for a bound
 * card redrawn from its record), finished once it is answered, closed or
 * expired. A click and a redraw from elsewhere both go through here, so the
 * same state always looks the same.
 */
export function messageFor(record: ComponentRecord, props?: Record<string, unknown>): DiscordComponentMessage | null {
  const spec = props ? { ...record.spec, props } : record.spec;
  switch (record.status) {
    case "open":
      return buildComponentMessage(spec);
    case "answered": {
      const response = record.response;
      const label =
        typeof response?.value === "string"
          ? response.value
          : response?.value !== undefined
            ? "Sent"
            : (spec.actions?.find((a) => a.id === response?.actionId)?.label ?? response?.actionId ?? "Answered");
      return buildAnsweredMessage(spec, { actionId: response?.actionId, label: `${label} — ${who(response?.by)}` });
    }
    case "closed":
      return draw(spec, { line: record.note ? `Closed: ${record.note}` : "Closed" });
    case "expired":
      return draw(spec, { line: "Expired" });
  }
}

/** A finished message for a bound card whose record is gone. */
export function buildRecordGoneMessage(spec: ComponentSpec): DiscordComponentMessage | null {
  return draw(spec, { line: "This record was deleted." });
}

/** Who answered, as Discord shows it: a mention for a Discord user, the plain name otherwise. */
function who(by: string | undefined): string {
  if (!by) return "someone";
  return by.startsWith("discord:") ? `<@${by.slice("discord:".length)}>` : by;
}

function draw(
  spec: ComponentSpec,
  finished: { actionId?: string; line: string } | null,
): DiscordComponentMessage | null {
  if (spec.id.length > MAX_COMPONENT_ID || spec.id.includes(":")) return null;
  const p = spec.props;
  const actions = spec.actions ?? [];
  const done = finished !== null;
  const footer = finished ? `\n${finished.line}` : "";
  const answered = finished;

  switch (spec.kind) {
    case "choice": {
      const options = actions.filter((a) => a.id !== "text");
      const free = actions.find((a) => a.id === "text");
      const content = `**${clip(str(p.question), MAX_TEXT)}**${footer}`;
      if (options.length <= MAX_BUTTONS) {
        const rows = buttonRows(spec.id, options, answered?.actionId, done);
        if (free) rows.push(row([textButton(spec.id, free, done)]));
        return { content, components: rows };
      }
      if (options.length > MAX_SELECT) return null;
      const select = new StringSelectMenuBuilder()
        .setCustomId(interfaceCustomId(spec.id, "s"))
        .setPlaceholder("Choose…")
        .setDisabled(done)
        .addOptions(
          options.map((a) => ({
            label: clip(a.label ?? a.id, 100),
            value: a.id,
            default: a.id === answered?.actionId,
          })),
        );
      const rows = [row([select])];
      if (free) rows.push(row([textButton(spec.id, free, done)]));
      return { content, components: rows };
    }
    case "confirm": {
      const details = p.details ? `\n${str(p.details)}` : "";
      const body = clip(`**${str(p.summary)}**${details}`, MAX_TEXT);
      const styled = actions.map((a) =>
        actionButton(
          spec.id,
          a,
          done,
          a.id === "confirm" ? ButtonStyle.Success : ButtonStyle.Secondary,
          answered?.actionId,
        ),
      );
      return { content: `${body}${footer}`, components: styled.length ? [row(styled)] : [] };
    }
    case "card": {
      const embed = new EmbedBuilder().setTitle(clip(str(p.title), 256));
      if (p.body) embed.setDescription(clip(str(p.body), 4096));
      const fields = (Array.isArray(p.fields) ? p.fields : []) as Record<string, unknown>[];
      if (fields.length) {
        embed.addFields(
          fields.slice(0, 25).map((f) => ({
            name: clip(str(f.label) || "—", 256),
            value: clip(str(f.value) || "—", 1024),
            inline: true,
          })),
        );
      }
      if (actions.length > MAX_BUTTONS) return null;
      return {
        ...(answered ? { content: footer.trim() } : {}),
        embeds: [embed],
        components: buttonRows(spec.id, actions, answered?.actionId, done),
      };
    }
    case "form": {
      const fields = Array.isArray(p.fields) ? p.fields : [];
      if (fields.length > MAX_MODAL_FIELDS) return null;
      const submit = actions.find((a) => a.id === "submit") ?? actions[0];
      const open = new ButtonBuilder()
        .setCustomId(interfaceCustomId(spec.id, "f"))
        .setLabel(clip(submit?.label && submit.label !== "Send" ? submit.label : "Fill in", 80))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(done);
      return { content: `**${clip(str(p.title), MAX_TEXT)}**${footer}`, components: [row([open])] };
    }
    default:
      return null;
  }
}

/** The pop-up form for a `form` component: one text input per field, with a hint for typed fields. */
export function buildFormModal(spec: ComponentSpec): ModalBuilder {
  const fields = (Array.isArray(spec.props.fields) ? spec.props.fields : []) as Record<string, unknown>[];
  const modal = new ModalBuilder()
    .setCustomId(interfaceCustomId(spec.id, "m"))
    .setTitle(clip(str(spec.props.title) || "Form", 45));
  for (const f of fields.slice(0, MAX_MODAL_FIELDS)) {
    const input = new TextInputBuilder()
      .setCustomId(str(f.name))
      .setLabel(clip(str(f.label) || str(f.name), 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(f.required === true);
    const hint = placeholder(f);
    if (hint) input.setPlaceholder(clip(hint, 100));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}

/** The pop-up for a choice's "something else": one free-text answer. */
export function buildTextModal(spec: ComponentSpec): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(interfaceCustomId(spec.id, "mt"))
    .setTitle(clip(str(spec.props.question) || "Your answer", 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("answer")
          .setLabel("Your answer")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
    );
}

/**
 * What a pop-up form's text inputs mean, typed per field. Discord pop-ups only
 * hold text, so a number, a yes/no or a pick from a list arrives as words and
 * is checked here, with a reason the person sees when it does not fit.
 */
export function coerceFormValues(spec: ComponentSpec, raw: Record<string, string>): Record<string, unknown> {
  const fields = (Array.isArray(spec.props.fields) ? spec.props.fields : []) as Record<string, unknown>[];
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const name = str(f.name);
    const label = str(f.label) || name;
    const text = (raw[name] ?? "").trim();
    if (!text) continue;
    switch (f.type) {
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n)) throw new InterfaceError(`${label} must be a number.`);
        out[name] = n;
        break;
      }
      case "boolean": {
        const yes = /^(y|yes|true|1)$/i.test(text);
        const no = /^(n|no|false|0)$/i.test(text);
        if (!yes && !no) throw new InterfaceError(`${label}: answer yes or no.`);
        out[name] = yes;
        break;
      }
      case "select": {
        const options = (Array.isArray(f.options) ? f.options : []).map(str);
        const match = options.find((o) => o.toLowerCase() === text.toLowerCase());
        if (!match) throw new InterfaceError(`${label} must be one of: ${options.join(", ")}.`);
        out[name] = match;
        break;
      }
      default:
        out[name] = text;
    }
  }
  return out;
}

type InterfaceInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export interface InterfaceInteractionDeps {
  store: InterfaceStore;
  events?: EventBus;
  /** Whether this person may answer this component. The answer lands in the component's conversation. */
  authorize: (interaction: InterfaceInteraction, record: ComponentRecord) => { ok: boolean; reason?: string };
  /**
   * Why the agent cannot take an answer right now — paused, or still on the
   * previous message — or undefined when it can. Checked before the answer is
   * recorded, so a refused click leaves the question open to try again.
   */
  unavailable?: (record: ComponentRecord) => string | undefined;
  /** Where a `state` button writes. Without it, such a button is refused with a reason. */
  state?: StateService;
  /** Run the conversation's next turn with the answer as the person's message, and post what the agent says. */
  continueWith: (record: ComponentRecord, reply: string, where: { channelId: string; userId: string }) => Promise<void>;
}

/**
 * One click, select or pop-up submission on a component.
 *
 * Discord wants an answer to an interaction within three seconds, so the
 * message is updated first — controls disabled, answer stated — and the
 * agent's turn, which can take far longer, runs after.
 */
export async function handleInterfaceInteraction(
  interaction: InterfaceInteraction,
  deps: InterfaceInteractionDeps,
): Promise<void> {
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const parsed = parseInterfaceCustomId(interaction.customId);
  if (!parsed) return;
  const record = deps.store.get(parsed.componentId);
  if (!record) {
    await ephemeral("This question is no longer available.");
    return;
  }
  const auth = deps.authorize(interaction, record);
  if (!auth.ok) {
    await ephemeral(auth.reason ?? "You can't answer this here.");
    return;
  }
  if (record.status !== "open") {
    await ephemeral(closedReason(record));
    return;
  }
  // A state button runs no agent, so a busy or paused agent does not stop it.
  const action = parsed.op === "a" ? record.spec.actions?.find((a) => a.id === parsed.actionId) : undefined;
  if (action?.effect.kind === "state") {
    await pressStateButton(interaction, deps, record, action);
    return;
  }
  const busy = deps.unavailable?.(record);
  if (busy) {
    await ephemeral(busy);
    return;
  }

  // Opening a pop-up is not an answer yet; the answer arrives with its submission.
  if (parsed.op === "f" && interaction.isButton()) {
    await interaction.showModal(buildFormModal(record.spec));
    return;
  }
  if (parsed.op === "t" && interaction.isButton()) {
    await interaction.showModal(buildTextModal(record.spec));
    return;
  }

  let actionId: string | undefined;
  let value: unknown;
  let shown: string | undefined;
  try {
    if (parsed.op === "a") actionId = parsed.actionId;
    else if (parsed.op === "s" && interaction.isStringSelectMenu()) actionId = interaction.values[0];
    else if (parsed.op === "m" && interaction.isModalSubmit()) {
      actionId = record.spec.actions?.find((a) => a.id === "submit")?.id ?? record.spec.actions?.[0]?.id;
      const raw: Record<string, string> = {};
      for (const f of (Array.isArray(record.spec.props.fields) ? record.spec.props.fields : []) as Record<
        string,
        unknown
      >[]) {
        const name = str(f.name);
        try {
          raw[name] = interaction.fields.getTextInputValue(name);
        } catch {
          // A field the pop-up did not carry is simply unanswered.
        }
      }
      value = coerceFormValues(record.spec, raw);
      shown = "Sent";
    } else if (parsed.op === "mt" && interaction.isModalSubmit()) {
      actionId = "text";
      value = interaction.fields.getTextInputValue("answer").trim();
      shown = String(value);
    }
    if (!actionId) return;
    const result = await respondToComponent(deps.store, deps.events, {
      id: record.spec.id,
      actionId,
      value,
      by: `discord:${interaction.user.id}`,
    });
    const label = shown ?? record.spec.actions?.find((a) => a.id === actionId)?.label ?? actionId;
    const answered = deps.store.get(record.spec.id);
    const finished = answered ? messageFor(answered) : null;

    if (
      finished &&
      (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        (interaction.isModalSubmit() && interaction.isFromMessage()))
    ) {
      await interaction.update(finished);
    } else {
      await ephemeral(`Sent: ${label}`);
    }
    if (result.effect === "reply" && interaction.channelId) {
      await deps.continueWith(record, result.reply, { channelId: interaction.channelId, userId: interaction.user.id });
    }
  } catch (err) {
    if (err instanceof InterfaceError) {
      await ephemeral(err.message);
      return;
    }
    throw err;
  }
}

/**
 * A button that writes state. The component stays open, so the message is
 * redrawn rather than finished: a bound card from the record as the click
 * left it, anything else unchanged with a quiet confirmation.
 */
async function pressStateButton(
  interaction: InterfaceInteraction,
  deps: InterfaceInteractionDeps,
  record: ComponentRecord,
  action: ActionSpec,
): Promise<void> {
  try {
    const result = await respondToComponent(
      deps.store,
      deps.events,
      { id: record.spec.id, actionId: action.id, by: `discord:${interaction.user.id}` },
      { ...(deps.state ? { state: deps.state } : {}), surface: "discord" },
    );
    const bind = record.spec.bind;
    if (result.effect === "state" && bind && interaction.isButton()) {
      const props = boundCardProps(record.spec.props, result.record, deps.state?.getType(bind.type)?.title);
      const redrawn = buildComponentMessage({ ...record.spec, props });
      if (redrawn) {
        await interaction.update(redrawn);
        return;
      }
    }
    await interaction.reply({ content: `Done: ${action.label ?? action.id}`, flags: MessageFlags.Ephemeral });
  } catch (err) {
    if (err instanceof InterfaceError) {
      await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw err;
  }
}

function closedReason(record: ComponentRecord): string {
  return record.status === "expired"
    ? "This question has expired."
    : record.status === "answered"
      ? "This has already been answered."
      : "This was closed by the agent.";
}

function buttonRows(
  componentId: string,
  actions: ActionSpec[],
  chosen: string | undefined,
  done: boolean,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (let i = 0; i < actions.length; i += 5) {
    rows.push(
      row(actions.slice(i, i + 5).map((a) => actionButton(componentId, a, done, ButtonStyle.Secondary, chosen))),
    );
  }
  return rows;
}

function actionButton(
  componentId: string,
  action: ActionSpec,
  done: boolean,
  style: ButtonStyle,
  chosen?: string,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(interfaceCustomId(componentId, "a", action.id))
    .setLabel(clip(action.label ?? action.id, 80))
    .setStyle(done && action.id === chosen ? ButtonStyle.Success : style)
    .setDisabled(done);
}

function textButton(componentId: string, action: ActionSpec, done: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(interfaceCustomId(componentId, "t"))
    .setLabel(clip(action.label ?? "Something else", 80))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(done);
}

function row(items: MessageActionRowComponentBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...items);
}

function placeholder(field: Record<string, unknown>): string | undefined {
  switch (field.type) {
    case "number":
      return "A number";
    case "boolean":
      return "yes or no";
    case "date":
      return "e.g. 2026-05-12";
    case "select":
      return `One of: ${(Array.isArray(field.options) ? field.options : []).map(str).join(", ")}`;
    default:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
