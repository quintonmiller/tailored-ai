/**
 * DM mirror — puts agent-to-agent direct messages somewhere a person can read.
 *
 * Everything an agent says in a room leaves a transcript. A direct message left
 * a session row and nothing else, so a pair of agents could talk all night and
 * the only evidence was a row you had to already suspect existed to go looking
 * for. `deliverAgentMessage` now emits `agent.messaged`; this turns that into a
 * line in a room.
 *
 * Mirroring is a workflow opinion, not a property of direct messages, so it
 * lives here rather than in `runtime.ts`. Core emits the event; whether that
 * becomes a message, a metric or nothing is this plugin's call, and a
 * deployment that wants none of it leaves the plugin disabled — which is the
 * default, because a mirror copies private-by-default traffic into a place
 * other people read, and that should be a decision somebody made out loud.
 *
 * ## The loop this must not create
 *
 * A mirror that wakes an agent is a machine for making its own input. The
 * mirrored line lands in the room, the room wakes an agent, the agent answers,
 * something delivers a message, and the mirror posts again. Two guards, because
 * one is not enough:
 *
 * - **Post with no `to`.** The line reaches the transcript without addressing
 *   anyone, exactly as `builtin:room-announcer` does. An agent watching that
 *   room with `wakeOn: "named"` is not named and does not wake.
 * - **Refuse to run at all** when the mirror room has any subscriber whose
 *   `wakeOn` is not `"none"`. `wakeOn: "all"` wakes on anything, addressed or
 *   not, so the first guard does not cover it. Re-checked on every reload,
 *   because an agent can subscribe *itself* to a room at runtime and turn a
 *   safe configuration into a loop without anyone editing config.
 *
 * Refusing is loud and reversible; a loop is neither.
 */

import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { getRoomBackend } from "../rooms/registry.js";
import { parseRoomRef } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";

/** Characters of message/reply kept before truncation. Two of these per post. */
const DEFAULT_MAX_BODY_CHARS = 500;

export interface DmMirrorConfig {
  /**
   * Room to mirror into, by name or `<backend>:<id>` ref. Required — there is
   * no sensible default destination for other people's mail.
   */
  room?: string;
  /**
   * Only mirror exchanges involving these agents, as sender or recipient.
   * Empty or omitted mirrors every exchange.
   */
  agents?: string[];
  /**
   * Which surfaces to mirror. `delegate` traffic is machine-generated task
   * handoff and is high-volume in a deployment that delegates; the default
   * mirrors only `dm`, the case where an agent chose to say something.
   */
  via?: string[];
  /** Characters kept from the message and from the reply. Default 500. */
  maxBodyChars?: number;
  /** Identity the mirrored line is posted under. Default "dm". */
  speaker?: string;
}

export interface DmMirrorOptions extends DmMirrorConfig {
  runtime: AgentRuntime;
}

/** One line of the mirrored post, or the whole thing when it fits. */
export function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}… _(${clean.length - max} more characters)_`;
}

export class DmMirror {
  private readonly runtime: AgentRuntime;
  private readonly room: string | undefined;
  private readonly agents: Set<string>;
  private readonly via: Set<string>;
  private readonly maxBodyChars: number;
  private readonly speaker: string;
  private readonly subscriptions: Subscription[] = [];
  /** Set while a guard is tripped, so the refusal is stated once per cause. */
  private blockedReason: string | null = null;

  constructor(opts: DmMirrorOptions) {
    this.runtime = opts.runtime;
    this.room = opts.room;
    this.agents = new Set(opts.agents ?? []);
    this.via = new Set(opts.via ?? ["dm"]);
    this.maxBodyChars = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    this.speaker = opts.speaker ?? "dm";

    if (!this.room) {
      console.warn(
        '[dm-mirror] no `room` configured, so nothing will be mirrored. Set plugin config `room: "<name>"`.',
      );
      return;
    }

    this.checkGuard();
    this.subscriptions.push(this.runtime.events.on("agent.messaged", (e) => this.mirror(e)));
    // An agent can subscribe itself to a room at runtime, so a configuration
    // that was safe at boot can stop being safe without anyone editing config.
    this.subscriptions.push(this.runtime.events.on("runtime.reloaded", () => this.checkGuard()));
  }

  stop(): void {
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions.length = 0;
  }

  /** Whether the mirror is currently refusing, and why. Exposed for tests. */
  get blocked(): string | null {
    return this.blockedReason;
  }

  /**
   * Refuse when anything in the mirror room would wake on what we post.
   *
   * Checked by subscription rather than by what we send: `wakeOn: "all"` wakes
   * on an unaddressed line, so "we post with no `to`" is not on its own an
   * argument that nothing wakes.
   */
  private checkGuard(): void {
    const previous = this.blockedReason;
    this.blockedReason = null;
    if (!this.room) return;

    const room = this.runtime.getRoomStore().resolve(this.room);
    if (!room) {
      this.blockedReason = `no room named "${this.room}"`;
    } else {
      const ref = `${room.ref.backend}:${room.ref.id}`;
      const awake = this.runtime
        .getRoomStore()
        .listSubscriptionsForRoom(ref)
        .filter((s) => s.wakeOn !== "none");
      if (awake.length > 0) {
        const who = awake.map((s) => `${s.agent} (wakeOn: ${s.wakeOn})`).join(", ");
        this.blockedReason = `${who} would wake on mirrored traffic — set wakeOn: none, or mirror into a room nobody staffs`;
      }
    }

    if (this.blockedReason && this.blockedReason !== previous) {
      console.warn(`[dm-mirror] not mirroring into "${this.room}": ${this.blockedReason}.`);
    } else if (!this.blockedReason && previous) {
      console.log(`[dm-mirror] mirroring into "${this.room}" — the earlier problem is resolved.`);
    }
  }

  /** The post a given exchange produces, or null when it produces none. */
  lineFor(e: RuntimeEventPayload<"agent.messaged">): string | null {
    if (!this.via.has(e.via)) return null;
    if (this.agents.size > 0 && !this.agents.has(e.from) && !this.agents.has(e.to)) return null;

    const header = e.via === "dm" ? `**${e.from} → ${e.to}**` : `**${e.from} → ${e.to}** _(${e.via})_`;
    return [
      header,
      truncate(e.body, this.maxBodyChars),
      "",
      `**${e.to} replied**`,
      truncate(e.reply, this.maxBodyChars),
    ]
      .join("\n")
      .trim();
  }

  private async mirror(e: RuntimeEventPayload<"agent.messaged">): Promise<void> {
    if (this.blockedReason || !this.room) return;

    const line = this.lineFor(e);
    if (!line) return;

    const room = this.runtime.getRoomStore().resolve(this.room);
    if (!room) return;
    const ref = parseRoomRef(`${room.ref.backend}:${room.ref.id}`);
    const backend = ref ? getRoomBackend(ref.backend) : undefined;
    if (!ref || !backend) return;

    try {
      // No `to`: reaches the transcript without addressing anyone. See the
      // header — this is one of the two loop guards, not a formatting choice.
      await backend.post(ref.id, { body: line, speaker: this.speaker });
    } catch (err) {
      // A deleted room or a disconnected transport is an ordinary state, and
      // nothing here is worth throwing out of an event handler over.
      console.warn(`[dm-mirror] could not mirror into ${this.room}: ${(err as Error).message}`);
    }
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins: builtin:dm-mirror`.
 * Disabled by default; reads `room`, `agents`, `via`, `maxBodyChars` and
 * `speaker` from `ctx.config`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const cfg = ctx.config;
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  const mirror = new DmMirror({
    runtime: ctx.runtime,
    room: typeof cfg.room === "string" ? cfg.room : undefined,
    agents: strings(cfg.agents),
    via: strings(cfg.via),
    maxBodyChars: typeof cfg.maxBodyChars === "number" ? cfg.maxBodyChars : undefined,
    speaker: typeof cfg.speaker === "string" ? cfg.speaker : undefined,
  });
  return () => mirror.stop();
};

export const meta: PluginMeta = {
  name: "DM mirror",
  description:
    "Mirrors agent-to-agent direct messages into a room so they are readable, instead of living only in a session row. Off by default; refuses to run if anything in the target room would wake on what it posts.",
  registers: [{ kind: "eventSubscriber", id: "dm-mirror" }],
};

export default plugin;
