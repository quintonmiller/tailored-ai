/**
 * The `watch` tool: an agent adds, lists, pauses, resumes and removes its own
 * watches. See `docs/watchers.md`.
 *
 * Settings are plain words a model of any size can write: an address, a
 * phrase near the part that matters, a percent. A setting sent beside
 * `config` rather than inside it is moved in, a number sent as text is read
 * as a number, and a label stands in for an id, so a small model's slip costs
 * it nothing. The caller always comes from the tool context, so an agent only
 * ever touches its own watches.
 */
import type { StateCaller, StateService } from "../state/service.js";
import { StateConflictError, StateError, type StateRecord } from "../state/types.js";
import { summarizeFields } from "../state/validate.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { agentStateCaller } from "../tools/state.js";
import type { WatcherKind, WatcherKindRegistryView } from "../watchers/registry.js";
import {
  basisOf,
  clip,
  configOf,
  LABEL_CHARS,
  MAX_WATCHES,
  NOTE_CHARS,
  ownerOf,
  statusOf,
  WATCH_TYPE,
  whereOf,
  writerFor,
} from "./watchers-records.js";
import { nextCheckAt, type WatchRunner } from "./watchers-runner.js";

export const WATCH_ACTIONS = ["add", "list", "pause", "resume", "remove"];

/**
 * The tool's own parameters. A kind's setting of one of these names is never
 * lifted from beside `config`, since the argument is the tool's: a mail kind's
 * `label` setting has to be sent inside `config`.
 */
export const TOOL_PARAMS: ReadonlySet<string> = new Set(["action", "id", "kind", "config", "label", "every", "note"]);

/** What a call says once the plugin is turned off: only a call already running when it went can see this. */
export const TURNED_OFF = "Watchers are turned off, so this tool does nothing now.";

/** Watches a `list` shows. An agent keeps at most {@link MAX_WATCHES}, so this is all of them. */
const LIST_READ = MAX_WATCHES + 5;

export interface WatchToolOptions {
  service: () => StateService;
  kinds: Pick<WatcherKindRegistryView, "get" | "list" | "validate" | "interval">;
  /** The runner of the load in effect, or null once the plugin is turned off. */
  runner: () => WatchRunner | null;
  now?: () => number;
}

const ok = (output: string): ToolResult => ({ success: true, output });
const fail = (error: string): ToolResult => ({ success: false, output: "", error });

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class WatchTool implements Tool {
  name = "watch";
  description =
    "Keep an eye on a web page or a price without a model call, and be woken when it changes. Add one with a kind and plain settings; list, pause, resume or remove yours.";
  parameters: Record<string, unknown>;
  effect = (args: Record<string, unknown>) => (args.action === "list" ? ("read" as const) : ("write" as const));

  private readonly now: () => number;

  constructor(private readonly opts: WatchToolOptions) {
    this.now = opts.now ?? (() => Date.now());
    const kinds = opts.kinds.list();
    this.parameters = {
      type: "object",
      properties: {
        action: { type: "string", enum: WATCH_ACTIONS, description: "add, list, pause, resume or remove." },
        id: { type: "string", description: "pause, resume or remove: which watch, by id or label." },
        kind: {
          type: "string",
          description: `add: what to watch. ${kinds.map((k) => `${k.kind}: ${k.description}`).join(" ")}`,
        },
        config: {
          type: "object",
          description: `add: the kind's settings. ${kinds.map((k) => `${k.kind}: ${summarizeFields(k.schema)}.`).join(" ")}`,
        },
        label: { type: "string", description: 'add: what it watches, in a few words, like "Lisbon hotel price".' },
        every: { type: "string", description: 'add: how often to check, like "2h" or "1 day". Default: the kind\'s.' },
        note: {
          type: "string",
          description: "add: what to do when it changes, such as who to tell. You'll see it then.",
        },
      },
      required: ["action"],
    };
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const caller = agentStateCaller(context, this.name);
    const action = String(args.action ?? "")
      .trim()
      .toLowerCase();
    try {
      const runner = this.opts.runner();
      if (!runner) return fail(TURNED_OFF);
      if (action === "add") return await this.add(caller, runner, args);
      if (action === "list") return await this.list(caller);
      if (!WATCH_ACTIONS.includes(action)) {
        return fail(`Unknown action "${args.action ?? ""}". Use one of: ${WATCH_ACTIONS.join(", ")}.`);
      }
      const asked = text(args.id) ?? text(args.label);
      if (!asked) return fail(`${action} needs the watch's \`id\`. Action list shows yours.`);
      const record = await this.find(caller, asked);
      if (!record) return fail(`You have no watch called "${asked}". Action list shows yours.`);
      if (action === "pause") return await this.pause(caller, record);
      if (action === "resume") return await this.resume(caller, record);
      return await this.remove(caller, record);
    } catch (err) {
      if (err instanceof StateError) return fail(err.message);
      if (err instanceof StateConflictError) return fail("It changed while you were changing it. Try again.");
      return fail(`Watches are unavailable right now: ${(err as Error).message}`);
    }
  }

  private async add(caller: StateCaller, runner: WatchRunner, args: Record<string, unknown>): Promise<ToolResult> {
    const me = caller.actor.name;
    const kinds = this.opts.kinds;
    const named = text(args.kind)?.toLowerCase();
    const known = kinds.list().map((k) => `${k.kind} (${k.description})`);
    if (!named) return fail(`add needs a \`kind\`: ${known.join("; ")}.`);
    const kind = kinds.get(named);
    if (!kind) return fail(`There's no "${named}" kind of watch. Kinds: ${known.join("; ") || "none are loaded"}.`);

    const config = settingsFrom(kind, args);
    if (typeof config === "string") return fail(config);
    const problems = kinds.validate(kind, config);
    if (problems.length) {
      return fail(
        [
          `The settings for a ${kind.kind} watch need fixing:`,
          ...problems.map((p) => `- ${p}`),
          `Settings: ${summarizeFields(kind.schema)}.`,
        ].join("\n"),
      );
    }
    const asked = text(args.every);
    const interval = kinds.interval(kind, asked);
    if (typeof interval === "string") return fail(interval);
    const label = text(args.label) ?? `${kind.kind} on ${whereOf(config) ?? "the page"}`;
    if (label.length > LABEL_CHARS) return fail(`Keep the label to ${LABEL_CHARS} characters.`);
    const note = text(args.note);
    if (note && note.length > NOTE_CHARS) return fail(`Keep the note to ${NOTE_CHARS} characters.`);

    const service = this.opts.service();
    const mine = await this.mine(caller);
    const basis = basisOf(kind.kind, config);
    const same = mine.find((r) => r.data.kind === kind.kind && basisOf(kind.kind, configOf(r)) === basis);
    if (same) {
      const status = statusOf(same);
      const hint = status === "active" ? "" : ` It's ${status}; resume it to start it again.`;
      return ok(
        `You already watch this as ${same.id} ("${String(same.data.label ?? same.id)}"). Nothing new was added.${hint}`,
      );
    }
    if (mine.length >= MAX_WATCHES) {
      return fail(`You keep ${mine.length} watches, the most one agent may. Remove one you no longer need first.`);
    }

    const look = await runner.firstLook(kind, config);
    if (!look.ok)
      return fail(`Nothing was saved: the first look at it failed. ${look.error} Fix the settings and add it again.`);

    const every =
      interval.raisedFrom !== undefined ? kind.minEvery : (asked?.replace(/^\s*every\s+/i, "") ?? kind.defaultEvery);
    const data: Record<string, unknown> = {
      owner: me,
      kind: kind.kind,
      config,
      label,
      every,
      status: "active",
      checkAt: new Date(Date.parse(look.at) + interval.ms).toISOString(),
      checkedAt: look.at,
      snapshot: { basis, data: look.result.snapshot },
      failures: 0,
      ...(look.result.value !== undefined ? { lastValue: look.result.value } : {}),
      ...(note ? { note } : {}),
    };
    const record = await service.put(writerFor(me, this.name), { type: WATCH_TYPE, scope: `agent:${me}`, data });
    const lines = [
      `Watching "${label}" as ${record.id}: ${kind.kind} on ${whereOf(config) ?? "the page"}, every ${every}.`,
    ];
    if (look.result.value !== undefined) lines.push(`It reads ${look.result.value} now.`);
    if (interval.raisedFrom !== undefined) {
      lines.push(`${kind.kind} watches run at most every ${kind.minEvery}, so that's how often this one runs.`);
    }
    lines.push("You'll be woken when it changes from this.");
    return ok(lines.join("\n"));
  }

  private async list(caller: StateCaller): Promise<ToolResult> {
    const mine = await this.mine(caller);
    if (mine.length === 0) {
      return ok(
        `You have no watches. Add one with a kind (${this.opts.kinds
          .list()
          .map((k) => k.kind)
          .join(" or ")}), its settings and how often.`,
      );
    }
    const now = this.now();
    return ok([`Your watches (${mine.length}):`, ...mine.map((r) => `- ${watchLine(r, now)}`)].join("\n"));
  }

  private async pause(caller: StateCaller, record: StateRecord): Promise<ToolResult> {
    if (statusOf(record) === "paused") return ok(`${record.id} is already paused.`);
    await this.write(caller, record, { status: "paused", tellAt: null });
    return ok(`Paused ${record.id}. It isn't checked until you resume it.`);
  }

  private async resume(caller: StateCaller, record: StateRecord): Promise<ToolResult> {
    if (statusOf(record) === "active" && !record.data.failures) return ok(`${record.id} is already running.`);
    await this.write(caller, record, {
      status: "active",
      failures: 0,
      lastError: null,
      // A notice that it broke, still owed, is moot once its owner has resumed it.
      tellAt: null,
      checkAt: new Date(this.now()).toISOString(),
    });
    return ok(`Resumed ${record.id}. It's checked again within a minute.`);
  }

  private async remove(caller: StateCaller, record: StateRecord): Promise<ToolResult> {
    const me = caller.actor.name;
    await this.opts
      .service()
      .archive(writerFor(me, this.name), { type: WATCH_TYPE, id: record.id }, `removed by ${me}`);
    return ok(`Removed ${record.id}. It isn't checked any more; a person can bring it back on the State page.`);
  }

  private write(caller: StateCaller, record: StateRecord, changes: Record<string, unknown>): Promise<StateRecord> {
    return this.opts
      .service()
      .patch(writerFor(caller.actor.name, this.name), { type: WATCH_TYPE, id: record.id }, changes);
  }

  /** The caller's own live watches, oldest first, read as the caller so another agent's are never in reach. */
  private async mine(caller: StateCaller): Promise<StateRecord[]> {
    const records = await this.opts.service().query(caller, {
      type: WATCH_TYPE,
      where: { owner: caller.actor.name },
      orderBy: { field: "createdAt", direction: "asc" },
      limit: LIST_READ,
    });
    return records.filter((r) => ownerOf(r) === caller.actor.name);
  }

  /** One of the caller's watches, by id, or by its label when no id matches. */
  private async find(caller: StateCaller, asked: string): Promise<StateRecord | undefined> {
    const record = await this.opts
      .service()
      .get(caller, { type: WATCH_TYPE, id: asked })
      .catch((err: unknown) => {
        // An id that isn't one an id could be is a label to look for.
        if (err instanceof StateError) return null;
        throw err;
      });
    if (record && !record.archivedAt && ownerOf(record) === caller.actor.name) return record;
    const wanted = asked.toLowerCase();
    return (await this.mine(caller)).find((r) => String(r.data.label ?? "").toLowerCase() === wanted);
  }
}

/**
 * A watch's settings from a call: `config` as an object, as JSON text, or as
 * a bare address; then any of the kind's own settings sent beside it moved in
 * (except one named like a parameter of the tool, see {@link TOOL_PARAMS}),
 * and numbers sent as text ("5", "5%") read as numbers. A string back is the
 * correction to send.
 */
export function settingsFrom(kind: WatcherKind, args: Record<string, unknown>): Record<string, unknown> | string {
  let raw = args.config;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed)) raw = { url: trimmed };
    else if (trimmed === "") raw = undefined;
    else {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return '`config` is an object of settings, like {"url": "https://…"}, and this text isn\'t one.';
      }
    }
  }
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return '`config` is an object of settings, like {"url": "https://…"}.';
  }
  const config: Record<string, unknown> = { ...((raw as Record<string, unknown> | undefined) ?? {}) };
  const properties = kind.schema.properties ?? {};
  for (const [name, schema] of Object.entries(properties)) {
    const lift = !TOOL_PARAMS.has(name) && args[name] !== undefined && args[name] !== null && args[name] !== "";
    if (config[name] === undefined && lift) {
      config[name] = args[name];
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const value = config[name];
    if ((types.includes("number") || types.includes("integer")) && typeof value === "string") {
      const match = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(value);
      if (match) config[name] = Number(match[1]);
    }
    if (typeof config[name] === "string") config[name] = (config[name] as string).trim();
  }
  return config;
}

/** "in 40 minutes", "3 hours ago": a time relative to now, for a list line. */
function relative(iso: unknown, now: number): string | undefined {
  if (typeof iso !== "string") return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const minutes = Math.round(Math.abs(at - now) / 60_000);
  const words =
    minutes < 1
      ? "a moment"
      : minutes < 90
        ? `${minutes} minute${minutes === 1 ? "" : "s"}`
        : minutes < 36 * 60
          ? `${Math.round(minutes / 60)} hours`
          : `${Math.round(minutes / 1440)} days`;
  return at >= now ? `in ${words}` : `${words} ago`;
}

/** A watch in one line: id, label, what and how often, status, the reading now, the last change, the next check. */
export function watchLine(record: StateRecord, now: number): string {
  const d = record.data;
  const status = statusOf(record);
  const where = whereOf(configOf(record));
  const parts = [
    `${record.id} "${clip(String(d.label ?? record.id), 60)}": ${String(d.kind)}${where ? ` on ${where}` : ""}`,
  ];
  if (typeof d.every === "string" && d.every) parts.push(`every ${d.every}`);
  parts.push(status === "broken" ? `broken: ${String(d.lastError ?? "it failed")} Resume to try again` : status);
  if (d.lastValue !== undefined && d.lastValue !== null) parts.push(`reads ${clip(String(d.lastValue), 60)}`);
  const change = d.lastChange as { at?: unknown; text?: unknown } | undefined;
  if (typeof change?.text === "string") {
    parts.push(`last change ${relative(change.at, now) ?? ""}: ${clip(change.text, 140)}`.replace("  ", " "));
  }
  if (status === "active") {
    if (typeof d.failures === "number" && d.failures > 0)
      parts.push(`last check failed: ${clip(String(d.lastError ?? ""), 100)}`);
    const next = relative(nextCheckAt(record), now);
    if (next) parts.push(`next check ${next.endsWith("ago") ? "now" : next}`);
  }
  return parts.join(", ");
}
