/**
 * The agent-facing surface for rooms: read what was said, say something, open
 * a room, invite someone in, subscribe to it.
 *
 * Two things are deliberately NOT under the model's control:
 *
 *   1. **Who it speaks as.** The `[speaker]` envelope is stamped from
 *      `context.agentName`, never from an argument, so an agent cannot post as
 *      another agent by asking to.
 *   2. **How often it may repeat itself.** Posts route through the
 *      NotificationGate with a window derived from `urgency`, so a nag that
 *      says the same thing an hour later is suppressed while genuinely new
 *      information always goes through.
 *
 * Everything about *behavior* — when to escalate, what tone, who to ask — is
 * prompt and config, not code.
 */

import type { NotificationGateLike } from "../notifications/dedup.js";
import { resolveGate } from "../notifications/dedup.js";
import { extractLeadingAddressees, renderTranscriptLine } from "../rooms/envelope.js";
import { enrichRoomMessage, type IdentityResolver } from "../rooms/identities.js";
import { getRoomBackend, listRoomBackends, requireRoomBackend } from "../rooms/registry.js";
import type { RoomStore, WakeOn } from "../rooms/store.js";
import { DEFAULT_URGENCY_WINDOW_HOURS, formatRoomRef, type Room, type RoomUrgency } from "../rooms/types.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface RoomToolOptions {
  store: RoomStore;
  /** Rebuilt per call so a config reload is visible immediately. */
  identities: () => IdentityResolver;
  getNotificationGate?: () => NotificationGateLike | undefined;
  /** Per-urgency suppression windows, in hours. */
  urgencyWindowHours?: () => Partial<Record<RoomUrgency, number>> | undefined;
  /** Backend used when a room is created without naming one. */
  defaultBackend?: () => string | undefined;
}

const URGENCIES: RoomUrgency[] = ["high", "medium", "low"];
const WAKE_MODES: WakeOn[] = ["named", "addressed", "all", "none"];

export class RoomTool implements Tool {
  name = "room";
  description =
    "Shared rooms where several agents and people talk. Read new messages, post (address someone with `to`), open a room, invite a participant, or subscribe.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "read",
          "post",
          "pass",
          "create",
          "invite",
          "remove",
          "members",
          "purpose",
          "subscribe",
          "unsubscribe",
        ],
        description:
          "list: rooms you can see. read: new messages (all your rooms when `room` is omitted). post: say something. pass: say nothing this turn. create: open a room. invite/remove: add or drop a participant. members: who is in it. purpose: read it, or set it by passing `purpose`. subscribe/unsubscribe: control whether it wakes you, and how often you look in unprompted.",
      },
      room: {
        type: "string",
        description: "Room name or ref. Omit on read to get unread across every room you watch.",
      },
      body: { type: "string", description: "What to say. Required for post." },
      to: {
        type: "array",
        items: { type: "string" },
        description: "Participants to address, by name. Omit to speak to the room.",
      },
      urgency: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "How soon the same point may be raised again if nothing changes: high ~15min, medium ~daily, low ~weekly. Default high.",
      },
      key: {
        type: "string",
        description:
          "Stable id for a recurring point, e.g. 'task:ptask_ab12:blocked'. Keeps suppression working when you rephrase.",
      },
      name: { type: "string", description: "Room name. Required for create." },
      purpose: {
        type: "string",
        description: "What the room is for. Shown as the Discord channel topic and given to every agent woken here.",
      },
      backend: { type: "string", description: "Transport for create, e.g. 'discord' or 'local'." },
      member: { type: "string", description: "Participant to add. Required for invite." },
      wake_on: {
        type: "string",
        enum: ["named", "addressed", "all", "none"],
        description:
          "For subscribe: named = only when someone writes your name; addressed = that plus loose questions from a person; all; none. Default addressed.",
      },
      check_in_minutes: {
        type: "number",
        description:
          "For subscribe: also wake you every N minutes with no new messages, so you can act on time passing. 0 turns it off.",
      },
      limit: { type: "number", description: "Cap for read. Default 20." },
    },
    required: ["action"],
  };

  constructor(private opts: RoomToolOptions) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    // Identity comes from the runtime, not the arguments. An agent with no
    // name (an anonymous chat session) may read but must not speak, or its
    // messages would be unattributable in a multi-party room.
    const agentName = context.agentName;

    try {
      switch (action) {
        case "list":
          return this.list(agentName);
        case "read":
          return await this.read(args, agentName);
        case "post":
          return await this.post(args, context, agentName);
        case "pass":
          return this.pass(args, context);
        case "create":
          return await this.create(args, agentName);
        case "invite":
          return await this.invite(args);
        case "remove":
          return await this.remove(args);
        case "purpose":
          return await this.purpose(args, agentName);
        case "members":
          return await this.members(args);
        case "subscribe":
          return this.subscribe(args, agentName);
        case "unsubscribe":
          return this.unsubscribe(args, agentName);
        default:
          return fail(
            `Unknown action "${action}". Use list, read, post, create, invite, members, subscribe or unsubscribe.`,
          );
      }
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  // ---------------------------------------------------------------- helpers

  private requireRoom(args: Record<string, unknown>): Room {
    const raw = String(args.room ?? "").trim();
    if (!raw) throw new Error("room is required (a room name or ref).");
    const room = this.opts.store.resolve(raw);
    if (room) return room;

    const known = this.opts.store.listRooms().map((r) => r.name);
    throw new Error(
      known.length > 0
        ? `No room "${raw}". Known rooms: ${known.join(", ")}.`
        : `No room "${raw}", and no rooms have been created yet. Use action "create" first.`,
    );
  }

  private windowFor(urgency: RoomUrgency): number {
    const configured = this.opts.urgencyWindowHours?.() ?? {};
    return configured[urgency] ?? DEFAULT_URGENCY_WINDOW_HOURS[urgency];
  }

  // ---------------------------------------------------------------- actions

  private list(agentName?: string): ToolResult {
    const rooms = this.opts.store.listRooms();
    if (rooms.length === 0) {
      const backends = listRoomBackends().map((b) => b.id);
      return ok(
        backends.length > 0
          ? `No rooms yet. Available transports: ${backends.join(", ")}. Use action "create".`
          : "No rooms, and no room transports are connected.",
      );
    }

    const subs = agentName ? this.opts.store.listSubscriptionsForAgent(agentName) : [];
    const byRef = new Map(subs.map((s) => [s.roomRef, s]));

    const lines = rooms.map((r) => {
      const ref = formatRoomRef(r.ref);
      const sub = byRef.get(ref);
      const status = sub ? `subscribed (${sub.deliver}/${sub.wakeOn})` : "not subscribed";
      return `${r.name} [${ref}] — ${status}${r.purpose ? ` — ${r.purpose}` : ""}`;
    });
    return ok(lines.join("\n"));
  }

  /**
   * Read one room, or — with no `room` given — everything unread across every
   * room the agent subscribes to. The second form is what a poll-driven agent
   * wants on wake: one call, one picture, instead of N calls it has to
   * remember to make.
   */
  private async read(args: Record<string, unknown>, agentName?: string): Promise<ToolResult> {
    if (!String(args.room ?? "").trim()) {
      return await this.readAll(args, agentName);
    }
    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);
    const backend = requireRoomBackend(room.ref.backend);
    const limit = clampLimit(args.limit, 20);

    const sub = agentName ? this.opts.store.getSubscription(agentName, ref) : null;
    const messages = await backend.fetchSince(room.ref.id, sub?.cursor ?? null, limit);

    if (messages.length === 0) return ok(`No new messages in "${room.name}".`);

    const identities = this.opts.identities();
    const lines = messages.map((raw) => {
      // Same identity-aware re-parse the watcher does, so the tool and the
      // wake path never disagree about who said what.
      const m = enrichRoomMessage(raw, identities);
      const who = m.speaker ?? identities.byNativeId(room.ref.backend, m.authorId)?.label ?? m.authorLabel;
      return renderTranscriptLine(who, m.to, m.body);
    });

    // Reading is seeing: advance so the same traffic is not served twice.
    if (agentName && sub) {
      this.opts.store.advanceCursor(agentName, ref, messages[messages.length - 1].cursor);
    }
    return ok(lines.join("\n"));
  }

  private async readAll(args: Record<string, unknown>, agentName?: string): Promise<ToolResult> {
    if (!agentName) return fail("room is required (this session has no agent identity to read subscriptions for).");

    const subs = this.opts.store.listSubscriptionsForAgent(agentName);
    if (subs.length === 0) return ok("You are not subscribed to any rooms.");

    const limit = clampLimit(args.limit, 20);
    const identities = this.opts.identities();
    const sections: string[] = [];

    for (const sub of subs) {
      const room = this.opts.store.getRoomByRef(sub.roomRef);
      if (!room) continue;
      // One unreachable backend must not blank out every other room.
      const backend = getRoomBackend(room.ref.backend);
      if (!backend) {
        sections.push(`## ${room.name} — transport "${room.ref.backend}" is not connected`);
        continue;
      }

      let messages: Awaited<ReturnType<typeof backend.fetchSince>>;
      try {
        messages = await backend.fetchSince(room.ref.id, sub.cursor, limit);
      } catch (err) {
        sections.push(`## ${room.name} — could not read: ${(err as Error).message}`);
        continue;
      }
      if (messages.length === 0) continue;

      const lines = messages.map((raw) => {
        const m = enrichRoomMessage(raw, identities);
        const who = m.speaker ?? identities.byNativeId(room.ref.backend, m.authorId)?.label ?? m.authorLabel;
        return renderTranscriptLine(who, m.to, m.body);
      });
      sections.push(`## ${room.name}\n${lines.join("\n")}`);
      this.opts.store.advanceCursor(agentName, sub.roomRef, messages[messages.length - 1].cursor);
    }

    if (sections.length === 0) return ok("No new messages in any of your rooms.");
    return ok(sections.join("\n\n"));
  }

  private async post(args: Record<string, unknown>, context: ToolContext, agentName?: string): Promise<ToolResult> {
    if (!agentName) {
      return fail("This session has no agent identity, so it cannot post to a room.");
    }
    const body = String(args.body ?? "").trim();
    if (!body) return fail("body is required for post.");

    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);
    const backend = requireRoomBackend(room.ref.backend);

    const identities = this.opts.identities();
    const speaker = identities.labelForAgent(agentName);

    // Resolve to the canonical label, so the value we validated is the exact
    // value we emit. Validating a trimmed copy while writing the raw string
    // meant `to: ["supervisor "]` — routine in tool-call JSON — passed the
    // check and was then silently dropped by the envelope formatter.
    const requested = Array.isArray(args.to) ? args.to.map((t) => String(t)).filter(Boolean) : [];
    const unknown = requested.filter((t) => !identities.get(t));
    if (unknown.length > 0) {
      return fail(`Unknown participant(s): ${unknown.join(", ")}. Known: ${identities.labels().join(", ")}.`);
    }
    const to = requested.map((t) => identities.get(t)?.label ?? t);

    // A model that passes `to: ["coder"]` often opens the body with the name as
    // well. The envelope already carries it, so lift it out rather than ship
    // "[planner] <coder> coder, on it".
    const lifted = extractLeadingAddressees(body, (l) => identities.isKnown(l), to);
    const finalTo = [...to];
    for (const t of lifted.to) {
      const canonical = identities.get(t)?.label ?? t;
      if (!finalTo.some((x) => x.toLowerCase() === canonical.toLowerCase())) finalTo.push(canonical);
    }
    const spoken = lifted.body || body;

    const urgency = URGENCIES.includes(args.urgency as RoomUrgency) ? (args.urgency as RoomUrgency) : "high";
    const gate = resolveGate(this.opts.getNotificationGate);

    let sent = false;
    let suppression = "";
    await gate.deliver(
      {
        source: `room:${agentName}`,
        channel: room.ref.backend,
        target: room.ref.id,
        content: spoken,
        key: typeof args.key === "string" && args.key.trim() ? args.key.trim() : undefined,
        windowHours: this.windowFor(urgency),
      },
      async () => {
        const posted = await backend.post(room.ref.id, { body: spoken, speaker, to: finalTo });
        sent = true;
        // Never wake ourselves on our own message.
        if (posted) this.opts.store.advanceCursor(agentName, ref, posted.cursor);
      },
      (line) => {
        suppression = line;
      },
    );

    if (!sent) {
      return ok(
        `Held back — the same point was already made in "${room.name}" within the ${urgency}-urgency window (${this.windowFor(urgency)}h). ${suppression}`.trim(),
      );
    }

    // Tell the watcher not to append the loop's closing text as a second
    // message: the agent has already said its piece.
    context.workingMemory?.set(`room:posted:${ref}`, "true");
    return ok(`Posted to "${room.name}"${finalTo.length > 0 ? ` (to ${finalTo.join(", ")})` : ""}.`);
  }

  /**
   * Decline to speak this turn.
   *
   * Without this an agent has no way to have nothing to say: the watcher posts
   * whatever its loop ended with, so being woken guarantees a message, and a
   * room fills up with "Acknowledged." and "Standing by." Passing is a real
   * tool call rather than a magic phrase in the reply — this codebase has been
   * bitten repeatedly by control flow inferred from model-facing strings.
   */
  private pass(args: Record<string, unknown>, context: ToolContext): ToolResult {
    const raw = String(args.room ?? "").trim();
    const room = raw ? this.opts.store.resolve(raw) : null;

    // Mark every room the agent might have been woken for when it didn't name
    // one — a small model that omits the argument still gets silence, which is
    // what it asked for.
    const refs = room ? [formatRoomRef(room.ref)] : this.opts.store.listRooms().map((r) => formatRoomRef(r.ref));
    for (const ref of refs) context.workingMemory?.set(`room:passed:${ref}`, "true");

    return ok("Saying nothing this turn.");
  }

  private async create(args: Record<string, unknown>, agentName?: string): Promise<ToolResult> {
    const name = String(args.name ?? args.room ?? "").trim();
    if (!name) return fail("name is required for create.");

    const backendId = String(args.backend ?? "").trim() || this.opts.defaultBackend?.() || listRoomBackends()[0]?.id;
    if (!backendId) return fail("No room transport is connected, so a room cannot be created.");

    const backend = requireRoomBackend(backendId);
    if (!backend.capabilities.create || !backend.createRoom) {
      return fail(`The "${backendId}" transport cannot create rooms.`);
    }

    const existing = this.opts.store.getRoomByName(name);
    if (existing) return ok(`Room "${name}" already exists [${formatRoomRef(existing.ref)}].`);

    const room = await backend.createRoom({
      name,
      purpose: typeof args.purpose === "string" ? args.purpose : undefined,
      createdBy: agentName,
    });
    const stored = this.opts.store.upsertRoom(room, agentName);
    const ref = formatRoomRef(stored.ref);

    // The creator hosts: it is the one that fields anything said to the room
    // in general. Everyone invited later gets "named", so exactly one agent
    // answers a loose question instead of all of them at once.
    if (agentName) {
      this.opts.store.subscribe({ agent: agentName, roomRef: ref, wakeOn: "addressed", source: "agent" });
    }
    return ok(`Created room "${stored.name}" [${ref}]. You are subscribed.`);
  }

  private async invite(args: Record<string, unknown>): Promise<ToolResult> {
    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);
    const memberLabel = String(args.member ?? "").trim();
    if (!memberLabel) return fail("member is required for invite.");

    const identities = this.opts.identities();
    const identity = identities.get(memberLabel);
    if (!identity) {
      return fail(`Unknown participant "${memberLabel}". Known: ${identities.labels().join(", ")}.`);
    }

    // An agent joins a room by subscribing; a human joins by being granted
    // access on the transport. Same verb, two different mechanisms.
    if (identity.kind === "agent" && identity.agent) {
      // "named" by default: an invited agent speaks when spoken to. Only the
      // room's host answers messages addressed to nobody in particular —
      // otherwise every agent in the room replies to every message.
      const wakeOn = WAKE_MODES.includes(String(args.wake_on) as WakeOn) ? (String(args.wake_on) as WakeOn) : "named";
      this.opts.store.subscribe({ agent: identity.agent, roomRef: ref, wakeOn, source: "agent" });
      this.opts.store.putMember(ref, { id: identity.agent, label: identity.label, kind: "agent" });
      return ok(`${identity.label} now watches "${room.name}" (${wakeOn}).`);
    }

    const nativeId = identity.nativeIds?.[room.ref.backend];
    if (!nativeId) {
      return fail(`${identity.label} has no known account on the "${room.ref.backend}" transport.`);
    }
    const backend = requireRoomBackend(room.ref.backend);
    if (!backend.addMember) {
      return fail(`The "${room.ref.backend}" transport cannot manage membership.`);
    }
    await backend.addMember(room.ref.id, nativeId);
    this.opts.store.putMember(ref, { id: nativeId, label: identity.label, kind: "human" });
    return ok(`Invited ${identity.label} to "${room.name}".`);
  }

  /**
   * Read the room's purpose, or set it when `purpose` is supplied.
   *
   * Setting also pushes it to the transport where there is somewhere to show
   * it, so people reading along see the same standing instructions the agents
   * were given rather than having to take their word for it.
   */
  private async purpose(args: Record<string, unknown>, agentName?: string): Promise<ToolResult> {
    const room = this.requireRoom(args);
    const next = typeof args.purpose === "string" ? args.purpose.trim() : "";

    if (!next) {
      return ok(room.purpose ? `"${room.name}": ${room.purpose}` : `"${room.name}" has no purpose set.`);
    }
    if (!agentName) return fail("This session has no agent identity, so it cannot set a purpose.");

    this.opts.store.upsertRoom({ ...room, purpose: next });

    let mirrored = "";
    const backend = getRoomBackend(room.ref.backend);
    if (backend?.setPurpose) {
      try {
        await backend.setPurpose(room.ref.id, next);
        mirrored = " It is now the channel topic too.";
      } catch (err) {
        // The purpose is set either way — agents read it from the database.
        mirrored = ` (Could not update the channel topic: ${(err as Error).message})`;
      }
    }
    return ok(`Purpose of "${room.name}" set.${mirrored}`);
  }

  /** Drop a participant. Agents stop being woken; humans lose room access. */
  private async remove(args: Record<string, unknown>): Promise<ToolResult> {
    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);
    const memberLabel = String(args.member ?? "").trim();
    if (!memberLabel) return fail("member is required for remove.");

    const identities = this.opts.identities();
    const identity = identities.get(memberLabel);
    if (!identity) {
      return fail(`Unknown participant "${memberLabel}". Known: ${identities.labels().join(", ")}.`);
    }

    if (identity.kind === "agent" && identity.agent) {
      const dropped = this.opts.store.unsubscribe(identity.agent, ref);
      this.opts.store.removeMember(ref, identity.agent);
      return ok(
        dropped
          ? `${identity.label} no longer watches "${room.name}".`
          : `${identity.label} was not watching "${room.name}".`,
      );
    }

    const nativeId = identity.nativeIds?.[room.ref.backend];
    if (!nativeId) {
      return fail(`${identity.label} has no known account on the "${room.ref.backend}" transport.`);
    }
    const backend = getRoomBackend(room.ref.backend);
    if (!backend?.removeMember) {
      return fail(`The "${room.ref.backend}" transport cannot manage membership.`);
    }
    await backend.removeMember(room.ref.id, nativeId);
    this.opts.store.removeMember(ref, nativeId);
    return ok(`Removed ${identity.label} from "${room.name}".`);
  }

  private async members(args: Record<string, unknown>): Promise<ToolResult> {
    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);

    const backend = getRoomBackend(room.ref.backend);
    const fromBackend = backend?.listMembers ? await backend.listMembers(room.ref.id) : [];
    const stored = this.opts.store.listMembers(ref);
    const subs = this.opts.store.listSubscriptionsForRoom(ref);

    const merged = new Map<string, string>();
    for (const m of [...stored, ...fromBackend]) merged.set(m.id, `${m.label} (${m.kind})`);
    for (const s of subs) merged.set(s.agent, `${s.agent} (agent, ${s.deliver}/${s.wakeOn})`);

    if (merged.size === 0) return ok(`No known members in "${room.name}".`);
    return ok([...merged.values()].sort().join("\n"));
  }

  private subscribe(args: Record<string, unknown>, agentName?: string): ToolResult {
    if (!agentName) return fail("This session has no agent identity, so it cannot subscribe.");
    const room = this.requireRoom(args);
    const ref = formatRoomRef(room.ref);
    const wakeOn = WAKE_MODES.includes(String(args.wake_on) as WakeOn) ? (String(args.wake_on) as WakeOn) : "addressed";

    const rawCheckIn = Number(args.check_in_minutes);
    // A check-in more often than every 5 minutes is a busy-loop wearing a
    // schedule; the hourly wake ceiling would eat it anyway.
    const checkInMinutes = Number.isFinite(rawCheckIn) && rawCheckIn > 0 ? Math.max(5, rawCheckIn) : undefined;

    const sub = this.opts.store.subscribe({
      agent: agentName,
      roomRef: ref,
      wakeOn,
      checkInMinutes,
      source: "agent",
    });
    const cadence = sub.checkInMinutes ? `, checking in every ${sub.checkInMinutes} min` : "";
    return ok(
      `Subscribed to "${room.name}" (${sub.deliver}/${sub.wakeOn}${cadence}). Takes effect on the next reload.`,
    );
  }

  private unsubscribe(args: Record<string, unknown>, agentName?: string): ToolResult {
    if (!agentName) return fail("This session has no agent identity, so it cannot unsubscribe.");
    const room = this.requireRoom(args);
    const removed = this.opts.store.unsubscribe(agentName, formatRoomRef(room.ref));
    return ok(removed ? `Unsubscribed from "${room.name}".` : `You were not subscribed to "${room.name}".`);
  }
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100);
}
