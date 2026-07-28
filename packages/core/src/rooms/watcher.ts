/**
 * The room watcher: turns room traffic into agent runs, and keeps that from
 * becoming a firehose.
 *
 * Two independent axes decide whether a message starts an agent loop, because
 * they answer different questions:
 *
 *   deliver  — WHEN do I look?     push (transport event) | poll (interval)
 *   wakeOn   — WHAT makes me run?  addressed | all | none
 *
 * Every combination is legal. push+addressed is an agent that answers the
 * moment it is named. poll+all is a digest: read everything that accumulated,
 * respond once. anything+none is a read-only seat — the agent can read the
 * room with the `room` tool but nothing there ever wakes it.
 *
 * Three brakes, because two agents that can wake each other are a loop:
 *   1. an agent never wakes on its own message
 *   2. a per-(agent, room) hourly wake ceiling, enforced in SQL
 *   3. debouncing, so a burst of five messages is one run and not five
 */

import { resolveAgent } from "../agent/agents.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import { PASSTHROUGH_GATE } from "../notifications/dedup.js";
import type { AgentRuntime } from "../runtime.js";
import { addresses, extractLeadingAddressees, renderTranscriptLine } from "./envelope.js";
import { enrichRoomMessage, IdentityResolver } from "./identities.js";
import { getRoomBackend, listRoomBackends, onRoomBackendChange } from "./registry.js";
import type { RoomStore, RoomSubscription } from "./store.js";
import { formatRoomRef, parseRoomRef, type Room, type RoomMessage } from "./types.js";

export interface RoomWatcherLimits {
  maxWakesPerHour: number;
  /** Consecutive agent-only turns allowed before a room goes quiet. */
  maxAgentTurns: number;
  maxBacklog: number;
  batchSeconds: number;
  defaultPollSeconds: number;
  /** How much of an agent's tool use to attach under its message. */
  toolActivity: "none" | "mutations" | "all";
}

export const ROOM_WATCHER_DEFAULTS: RoomWatcherLimits = {
  maxWakesPerHour: 12,
  maxAgentTurns: 6,
  maxBacklog: 30,
  batchSeconds: 3,
  defaultPollSeconds: 900,
  toolActivity: "none",
};

export interface RoomWatcherOptions {
  runtime: AgentRuntime;
  store: RoomStore;
  limits?: Partial<RoomWatcherLimits>;
}

/**
 * A reply that is nothing but an unmade `room(action="pass")` call.
 *
 * Deliberately narrow: the whole message has to be the call and nothing else,
 * so a sentence that merely mentions passing still gets posted. This is
 * forgiving a known model failure, not building protocol out of prose — the
 * decision is still "the agent chose not to speak", it just arrived in the
 * wrong channel.
 */
export function looksLikeUninvokedPass(body: string): boolean {
  const stripped = body
    .replace(/^@[A-Za-z0-9_.:-]{1,64}\s*/, "")
    .replace(/[`*\s]/g, "")
    .toLowerCase();
  return /^room\(action=?["']?pass["']?\)?$/.test(stripped);
}

/**
 * One line describing a tool call, for the activity record.
 *
 * Shows the argument that identifies WHAT was acted on — a path, a query — and
 * nothing else. Full arguments would leak file contents and search bodies into
 * a channel; the name and target are enough to see what an agent did and go
 * look for yourself.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  for (const key of ["path", "file", "query", "url", "room", "id"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return `\`${name}\` ${value.trim().slice(0, 120)}`;
    }
  }
  return `\`${name}\``;
}

/** Session key family for room conversations: `room:<backend>.<id>:<agent>`. */
export function makeRoomSessionKey(roomRef: string, agent: string): string {
  return `room:${roomRef.replace(/:/g, ".")}:${agent}`;
}

export class RoomWatcher {
  private readonly runtime: AgentRuntime;
  private readonly store: RoomStore;
  private limits: RoomWatcherLimits;

  private unsubscribers: Array<() => void> = [];
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private debounces = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight runs, so one agent never processes a room twice at once. */
  private running = new Set<string>();
  /** Triggers that arrived mid-run and must be re-armed when it finishes. */
  private pending = new Set<string>();
  /** One-shot retries armed when a subscription hits its hourly ceiling. */
  private hourRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private checkInTimers = new Map<string, ReturnType<typeof setInterval>>();
  private offBackendChange: (() => void) | undefined;
  private started = false;

  constructor(opts: RoomWatcherOptions) {
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.limits = { ...ROOM_WATCHER_DEFAULTS, ...opts.limits };
  }

  /** Identities are rebuilt per call so a config reload takes effect at once. */
  private identities(): IdentityResolver {
    const config = this.runtime.getConfig();
    const rooms = config.rooms;
    const ownerNativeIds: Record<string, string> = {};
    for (const backend of listRoomBackends()) {
      const ownerId = this.runtime.getOwnerId?.(backend.id);
      if (ownerId) ownerNativeIds[backend.id] = ownerId;
    }
    return new IdentityResolver({
      agentNames: Object.keys(config.agents ?? {}),
      declared: rooms?.identities,
      ownerNativeIds,
      ownerLabel: rooms?.ownerLabel,
      defaultBackend: config.defaultChannel,
    });
  }

  private readLimits(): RoomWatcherLimits {
    const cfg = this.runtime.getConfig().rooms;
    return {
      maxWakesPerHour: cfg?.maxWakesPerHour ?? this.limits.maxWakesPerHour,
      maxAgentTurns: cfg?.maxAgentTurns ?? this.limits.maxAgentTurns,
      maxBacklog: cfg?.maxBacklog ?? this.limits.maxBacklog,
      batchSeconds: cfg?.batchSeconds ?? this.limits.batchSeconds,
      defaultPollSeconds: cfg?.defaultPollSeconds ?? this.limits.defaultPollSeconds,
      toolActivity: cfg?.toolActivity ?? this.limits.toolActivity,
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Arm the watcher against the current subscription set. Safe to call again
   * after a config reload — it tears down every listener and timer first, so
   * a reload cannot leave a second listener running (the bug #58 fixed for
   * channels).
   */
  start(): void {
    this.stop();
    this.started = true;
    this.limits = this.readLimits();

    // Backends connect asynchronously and after this point (Discord registers
    // on ClientReady, well after login resolves), so re-arm whenever the set
    // changes. Without this every push subscription binds to an empty registry
    // at boot and never fires.
    this.offBackendChange = onRoomBackendChange(() => {
      if (this.started) this.rearm();
    });

    const subs = this.store.listSubscriptions();
    if (subs.length === 0) return;

    // One push listener per backend, not per subscription: the backend emits
    // every message once and we fan out to subscribers ourselves.
    const pushBackends = new Set<string>();
    for (const sub of subs) {
      if (sub.wakeOn === "none") continue;
      const ref = parseRoomRef(sub.roomRef);
      if (!ref) continue;
      if (sub.deliver === "push") pushBackends.add(ref.backend);
      else this.armPoll(sub);
    }

    // Check-ins are independent of delivery: an agent can be push-driven for
    // messages AND still look in every hour on its own.
    for (const sub of subs) {
      if (sub.checkInMinutes && sub.checkInMinutes > 0) this.armCheckIn(sub);
    }

    for (const backendId of pushBackends) {
      const backend = getRoomBackend(backendId);
      if (!backend?.onMessage) {
        // Not necessarily a misconfiguration: backends register asynchronously,
        // and onRoomBackendChange re-arms us when this one shows up.
        continue;
      }
      const off = backend.onMessage((msg) => {
        void this.onMessage(msg).catch((err) => {
          console.error(`[rooms] Dispatch failed: ${(err as Error).message}`);
        });
      });
      this.unsubscribers.push(off);
    }

    // The push path is edge-triggered, so anything that arrived while the
    // process was down or reloading would sit unread until the next message
    // happened to land. Drain once on arming.
    void this.drain(subs);
    void this.publishPurposes();
  }

  /**
   * Push each room's purpose onto its transport, so what people read in the
   * channel header matches the standing instructions the agents were given.
   *
   * Done here rather than at reconcile time because backends register late —
   * Discord's only exists after ClientReady, well after config is read — and
   * start() re-runs whenever that set changes.
   */
  private async publishPurposes(): Promise<void> {
    for (const room of this.store.listRooms()) {
      if (!room.purpose) continue;
      const backend = getRoomBackend(room.ref.backend);
      if (!backend?.setPurpose) continue;
      try {
        await backend.setPurpose(room.ref.id, room.purpose);
      } catch (err) {
        console.warn(`[rooms] Could not publish the purpose of "${room.name}": ${(err as Error).message}`);
      }
    }
  }

  /**
   * One catch-up pass over every subscription's unread backlog. Failures are
   * per-subscription so one unreachable transport cannot stop the rest.
   */
  private async drain(subs: RoomSubscription[]): Promise<void> {
    for (const sub of subs) {
      if (sub.wakeOn === "none") continue;
      try {
        if (sub.cursor === null) {
          await this.seedCursor(sub);
          continue;
        }
        await this.pollOnce(sub.agent, sub.roomRef);
      } catch (err) {
        console.error(`[rooms] Catch-up failed for ${sub.agent} in ${sub.roomRef}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Park a brand-new subscription at the newest message in the room, so it
   * starts listening from now.
   *
   * A null cursor means "the most recent `maxBacklog` messages" to a backend,
   * which is right for reading a room but very wrong for waking: subscribing
   * an agent to an existing channel would hand it a page of old conversation
   * and it would answer questions that were settled last week.
   */
  private async seedCursor(sub: RoomSubscription): Promise<void> {
    const ref = parseRoomRef(sub.roomRef);
    if (!ref) return;
    const backend = getRoomBackend(ref.backend);
    if (!backend) return;

    const latest = await backend.fetchSince(ref.id, null, 1);
    if (latest.length === 0) return;
    this.store.advanceCursor(sub.agent, sub.roomRef, latest[latest.length - 1].cursor);
    console.log(`[rooms] ${sub.agent} joined ${sub.roomRef} — starting from the latest message.`);
  }

  /** Re-bind listeners and timers without tearing down the backend watch. */
  private rearm(): void {
    const wasStarted = this.started;
    this.start();
    this.started = wasStarted;
  }

  stop(): void {
    this.started = false;
    this.offBackendChange?.();
    this.offBackendChange = undefined;
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // Best-effort teardown — a backend that already went away is fine.
      }
    }
    this.unsubscribers = [];
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    for (const timer of this.debounces.values()) clearTimeout(timer);
    this.debounces.clear();
    for (const timer of this.hourRetries.values()) clearTimeout(timer);
    this.hourRetries.clear();
    for (const timer of this.checkInTimers.values()) clearInterval(timer);
    this.checkInTimers.clear();
    this.pending.clear();
  }

  /**
   * Wake an agent on a timer even when nobody has said anything.
   *
   * Messages are not the only reason to act — a deadline gets closer, a
   * promised follow-up comes due, a booking window closes. Without this an
   * agent can only ever react, so anything time-based waits for a human to
   * remember to ask.
   */
  private armCheckIn(sub: RoomSubscription): void {
    const minutes = sub.checkInMinutes ?? 0;
    if (minutes <= 0) return;
    const key = `${sub.agent} ${sub.roomRef}`;
    const timer = setInterval(
      () => {
        void this.runCheckIn(sub.agent, sub.roomRef).catch((err) => {
          console.error(`[rooms] Check-in failed for ${key}: ${(err as Error).message}`);
        });
      },
      minutes * 60 * 1000,
    );
    timer.unref?.();
    this.checkInTimers.set(key, timer);
  }

  /**
   * One scheduled look at a room.
   *
   * The prompt makes silence the easy path on purpose. An agent that reports
   * "nothing to add" every hour is the politeness loop with a clock attached —
   * exactly the noise rooms exist to avoid — so `pass` is offered first and the
   * bar for speaking is "something needs attention", not "I looked".
   */
  async runCheckIn(agent: string, roomRef: string): Promise<void> {
    const sub = this.store.getSubscription(agent, roomRef);
    if (!sub?.checkInMinutes) return;

    const room = this.store.getRoomByRef(roomRef);
    if (!room) return;

    const limits = this.readLimits();
    if (!this.store.tryConsumeWake(agent, roomRef, limits.maxWakesPerHour)) return;
    this.store.recordCheckIn(agent, roomRef);

    const identities = this.identities();
    const label = identities.labelForAgent(agent);
    const recent = await this.fetchBacklog({ ...sub, cursor: null });
    const transcript = recent.slice(-10).map((m) => renderTranscriptLine(m.speaker ?? m.authorLabel, m.to, m.body));

    const prompt = [
      `Room "${room.name}". You are ${label}. This is a scheduled check-in — nobody has asked you anything.`,
      ...(room.purpose ? [`Purpose: ${room.purpose}`] : []),
      "",
      ...(transcript.length > 0 ? ["Recent conversation:", ...transcript, ""] : []),
      "Look at whether anything here needs attention now: a deadline approaching, something you said you would do, something waiting on someone.",
      'Speak only if there is something worth saying. If there is not, call room(action="pass") — a check-in that reports nothing is noise.',
    ].join("\n");

    await this.runPrompted(sub, prompt, label);
  }

  private armPoll(sub: RoomSubscription): void {
    const seconds = sub.pollSeconds ?? this.limits.defaultPollSeconds;
    const key = `${sub.agent} ${sub.roomRef}`;
    const timer = setInterval(() => {
      void this.pollOnce(sub.agent, sub.roomRef).catch((err) => {
        console.error(`[rooms] Poll failed for ${key}: ${(err as Error).message}`);
      });
    }, seconds * 1000);
    timer.unref?.();
    this.pollTimers.set(key, timer);
  }

  // -------------------------------------------------------------- dispatch

  /** Push path: a backend reported a new message. */
  async onMessage(msg: RoomMessage): Promise<void> {
    const roomRef = formatRoomRef(msg.room);
    const subs = this.store.listSubscriptionsForRoom(roomRef).filter((s) => s.deliver === "push");
    if (subs.length === 0) return;

    const identities = this.identities();
    const enriched = enrichRoomMessage(msg, identities);

    // Announce before deciding: a plugin that wants to route, mirror or
    // escalate should see everything, including traffic no agent wakes on.
    this.runtime.events?.emit("room.message", {
      roomRef,
      messageId: enriched.id,
      speaker: enriched.speaker,
      to: enriched.to,
      body: enriched.body,
      fromSelf: enriched.fromSelf,
    });

    // Counted once per message here, not per subscriber — this is a property
    // of the conversation, not of any one watcher.
    const speakerKind = enriched.speaker ? identities.get(enriched.speaker)?.kind : undefined;
    const agentTurns = this.store.noteRoomTurn(roomRef, speakerKind === "human", enriched.speaker);
    if (agentTurns === this.readLimits().maxAgentTurns + 1) {
      console.log(
        `[rooms] ${roomRef} has run ${agentTurns} agent turns without a human — pausing automatic replies until someone speaks.`,
      );
    }

    for (const sub of subs) {
      if (!this.shouldWake(sub, enriched, identities, agentTurns)) {
        // Deliberately NOT advancing the cursor. An agent that did not wake has
        // not SEEN this message, and skipping it here is why an agent could be
        // asked about a conversation it was sitting in and know nothing about
        // it. The cursor is a record of what was shown, not of what went past.
        // Backlog growth is bounded by maxBacklog instead — see fetchBacklog.
        continue;
      }
      this.scheduleWake(sub);
    }
  }

  /** Poll path: check one subscription for anything new. */
  async pollOnce(agent: string, roomRef: string): Promise<void> {
    const sub = this.store.getSubscription(agent, roomRef);
    if (!sub || sub.wakeOn === "none") return;

    const messages = await this.fetchBacklog(sub);
    if (messages.length === 0) return;

    const identities = this.identities();
    const agentTurns = this.store.agentTurns(roomRef);
    const wakeworthy = messages.some((m) => this.shouldWake(sub, m, identities, agentTurns));
    if (!wakeworthy) {
      // Same reasoning as the push path: unread is not the same as unwanted,
      // and this traffic is the context for whatever finally does wake it.
      // Re-reading it each tick is cheap; losing it is not.
      return;
    }
    await this.runWake(sub);
  }

  /**
   * Collapse a burst into one run. Five messages arriving in two seconds
   * should produce one agent turn that sees all five, not five turns racing
   * each other into the same room.
   */
  private scheduleWake(sub: RoomSubscription): void {
    const key = `${sub.agent} ${sub.roomRef}`;
    const existing = this.debounces.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounces.delete(key);
      void this.runWake(sub).catch((err) => {
        console.error(`[rooms] Wake failed for ${key}: ${(err as Error).message}`);
      });
    }, this.limits.batchSeconds * 1000);
    timer.unref?.();
    this.debounces.set(key, timer);
  }

  /**
   * The wake decision. Kept pure and separate so it can be tested without a
   * database, a backend, or a model.
   */
  shouldWake(sub: RoomSubscription, msg: RoomMessage, identities: IdentityResolver, agentTurns = 0): boolean {
    if (sub.wakeOn === "none") return false;

    // Our own account with no resolvable speaker is not a human turn: it is a
    // continuation chunk of a split message, or a plain notifier post. Reading
    // it as human is how one long agent message woke every agent in the room,
    // including its author.
    if (msg.fromSelf && !msg.speaker) return false;

    const label = identities.labelForAgent(sub.agent);

    // Never wake an agent on its own words — the shortest possible loop.
    // Compared through the resolver so an alias counts as the same agent.
    if (msg.speaker) {
      const speakerAgent = identities.agentForLabel(msg.speaker);
      if (speakerAgent === sub.agent) return false;
      if (!speakerAgent && msg.speaker.toLowerCase() === label.toLowerCase()) return false;
    }

    // Two agents being polite at each other is not something any single-message
    // rule can catch — every turn is a legitimate reply to a real question. Cap
    // the depth instead: after enough agent-only turns, stop waking until a
    // human says something. Their words still land in the room and are read as
    // context on the next real wake; only the automatic reply stops.
    const speakerIsAgent = msg.speaker ? identities.get(msg.speaker)?.kind === "agent" : false;
    if (speakerIsAgent && agentTurns > this.readLimits().maxAgentTurns) {
      return false;
    }

    if (sub.wakeOn === "all") return true;

    // Resolve each addressee, so "<planner> ..." wakes the agent that
    // `planner: { agent: supervisor }` points at.
    // Both the formal addressees and anything named mid-sentence: "…done,
    // @coder you're up" is a real call-out, and reading only the leading
    // addressees meant it reached nobody.
    // `mentions` is tolerated as absent: backends are third-party, and one
    // written before this field existed should degrade to envelope-only
    // addressing rather than throw and take the wake path down with it.
    const named = [...msg.to, ...(msg.mentions ?? [])];
    const namedMe = named.some((t) => identities.agentForLabel(t) === sub.agent || addresses([t], label));
    if (namedMe) return true;

    // "named" stops here: nothing but an explicit mention starts a run. This is
    // what keeps a room with three agents in it from producing three answers to
    // one unaddressed question — give the agent that should field loose
    // questions "addressed", and everyone else "named".
    if (sub.wakeOn === "named") return false;

    // An unaddressed message from a human is for whoever is listening; an
    // unaddressed message from another agent is chatter, and answering it is
    // how two agents talk forever.
    const speakerIdentity = msg.speaker ? identities.get(msg.speaker) : undefined;
    const fromHuman = speakerIdentity ? speakerIdentity.kind === "human" : !msg.speaker;
    return fromHuman && msg.to.length === 0;
  }

  private async fetchBacklog(sub: RoomSubscription): Promise<RoomMessage[]> {
    const ref = parseRoomRef(sub.roomRef);
    if (!ref) return [];
    const backend = getRoomBackend(ref.backend);
    if (!backend) return [];

    const limits = this.readLimits();
    let raw = await backend.fetchSince(ref.id, sub.cursor, limits.maxBacklog);

    // A full page means there is probably more after it, and backends answer
    // "since this cursor" with the OLDEST messages first — so in a busy room
    // the very message that woke us could sit past the end of the page. Fall
    // back to the most recent page, which always contains it.
    if (raw.length >= limits.maxBacklog) {
      raw = await backend.fetchSince(ref.id, null, limits.maxBacklog);
    }

    const identities = this.identities();
    return raw.map((m) => enrichRoomMessage(m, identities));
  }

  // ------------------------------------------------------------------- run

  private async runWake(sub: RoomSubscription): Promise<void> {
    const key = `${sub.agent} ${sub.roomRef}`;
    if (this.running.has(key)) {
      // Don't drop the trigger. A message that lands while the agent is still
      // thinking must still be answered — the push path is edge-triggered, so
      // nothing else would ever come back for it.
      this.pending.add(key);
      return;
    }

    this.running.add(key);
    try {
      // Re-read: the cursor may have moved while the debounce was pending.
      const fresh = this.store.getSubscription(sub.agent, sub.roomRef) ?? sub;
      const messages = await this.fetchBacklog(fresh);
      if (messages.length === 0) return;

      // Budget is charged only once there is real work. Charging before the
      // backlog check let an empty wake burn one of twelve hourly slots.
      const limits = this.readLimits();
      if (!this.store.tryConsumeWake(fresh.agent, fresh.roomRef, limits.maxWakesPerHour)) {
        console.warn(
          `[rooms] ${fresh.agent} hit its wake ceiling for ${fresh.roomRef} (${limits.maxWakesPerHour}/hour). Traffic accumulates and is read on the next allowed wake.`,
        );
        this.retryAfterHour(fresh);
        return;
      }

      this.runtime.events?.emit("room.woke", {
        roomRef: fresh.roomRef,
        agent: fresh.agent,
        messageCount: messages.length,
      });

      const room = this.store.getRoomByRef(fresh.roomRef);
      const identities = this.identities();
      const label = identities.labelForAgent(fresh.agent);
      const prompt = this.buildPrompt(fresh, messages, room?.name ?? fresh.roomRef, label, identities, room?.purpose);

      const config = this.runtime.getConfig();
      const resolved = resolveAgent(fresh.agent, config, this.runtime.getTools(), undefined, this.runtime.contextDir);
      const session = findOrCreateSession(
        this.runtime.db,
        makeRoomSessionKey(fresh.roomRef, fresh.agent),
        resolved.model,
        resolved.provider,
      );

      const base = this.runtime.buildLoopOptions({ agentName: fresh.agent, session });
      // Spread rather than replace: buildLoopOptions puts agentName in here,
      // and dropping it is how task-watcher lost tool attribution.
      const workingMemory = new Map<string, string>();
      let reply = "";
      // Whether this turn did anything, as opposed to only talking. Decides
      // whether it counts toward the conversation-depth cap.
      let usedTools = false;
      const changed: string[] = [];
      const activity: string[] = [];
      try {
        reply = await runAgentLoop(prompt, {
          ...base,
          toolContextExtras: { ...base.toolContextExtras, workingMemory },
          onToolCall: (name, args) => {
            // `pass` is how an agent declines to speak — using it is not work.
            if (name !== "room") usedTools = true;
            if ((name === "write" || name === "edit") && typeof args.path === "string") {
              const file = args.path.split("/").pop();
              if (file && !changed.includes(file)) changed.push(file);
            }
            const record = this.readLimits().toolActivity;
            const mutates = name === "write" || name === "edit";
            if (record === "all" || (record === "mutations" && mutates)) {
              activity.push(describeToolCall(name, args));
            }
          },
        });
      } catch (err) {
        // Advance anyway. A message the agent cannot process — a provider
        // outage, a body that overflows its context — would otherwise be
        // re-read on every wake, burning the whole hourly budget forever.
        console.error(
          `[rooms] ${fresh.agent} failed on ${fresh.roomRef}: ${(err as Error).message} — skipping past ${messages.length} message(s).`,
        );
        this.store.advanceCursor(fresh.agent, fresh.roomRef, messages[messages.length - 1].cursor);
        return;
      }

      // One correction round, at most.
      //
      // Two things go wrong at the end of a turn, and both are better answered
      // than papered over. A model asked to "call room(action=pass)" sometimes
      // writes the call instead of making it — that is malformed output, and
      // the loop already knows how to recover from being told so. And an agent
      // that changed a file and then decides to say nothing has probably lost
      // track of what it did; asking beats overriding, because it might have
      // a good reason and it is still its call.
      //
      // Bounded to a single attempt on purpose: a weaker model that cannot
      // produce a clean tool call will not produce one on the fifth ask
      // either, and would spend its whole round budget being corrected.
      const correction = looksLikeUninvokedPass(reply)
        ? 'Your last message was not a valid tool call — it was posted as text. If you meant to stay quiet, call the room tool with action "pass". Otherwise reply normally with what you want to say.'
        : workingMemory.get(`room:passed:${fresh.roomRef}`) === "true" && changed.length > 0
          ? `You changed ${changed.join(", ")} since your last message but chose to say nothing. Are you sure? Reply with a short update if it is worth reporting, or pass again if it genuinely is not.`
          : undefined;

      if (correction) {
        workingMemory.delete(`room:passed:${fresh.roomRef}`);
        try {
          reply = await runAgentLoop(correction, {
            ...base,
            toolContextExtras: { ...base.toolContextExtras, workingMemory },
          });
        } catch (err) {
          console.warn(`[rooms] Correction round failed for ${fresh.agent}: ${(err as Error).message}`);
        }
      }

      // A turn that did real work is progress, not chatter, so it must not
      // push the room toward the depth cap. Without this, agents collaborating
      // on a task — researching, writing files, handing off — get silenced
      // mid-task exactly like two agents saying "thanks" at each other.
      if (usedTools) this.store.resetAgentTurns(fresh.roomRef);

      // Cursor advances whether or not the agent had anything to say — it has
      // now seen this traffic either way. Deliberately NOT advanced past its
      // own reply: anything that arrived mid-run sits between the two, and
      // jumping to the reply's cursor would skip it permanently.
      this.store.advanceCursor(fresh.agent, fresh.roomRef, messages[messages.length - 1].cursor);

      const posted = await this.deliverReply(fresh, reply, label, workingMemory, messages);
      // Attached underneath the reply, so the room reads as conversation and
      // the record of what was actually done is one click away. Without this
      // you can only infer an agent's actions from its own account of them,
      // which is exactly the account that can be wrong.
      if (posted && activity.length > 0) await this.attachActivity(fresh, posted, label, activity);
    } finally {
      this.running.delete(key);
      if (this.pending.delete(key)) this.scheduleWake(sub);
    }
  }

  /**
   * Ask every agent in a room what it is working on.
   *
   * Each agent is woken directly rather than by posting a synthetic "quinton
   * asks…" message into the room. Faking a human turn would put words in a
   * person's mouth in the transcript, and TAI posting under someone's display
   * name is a line worth not crossing. The request is visible anyway — the
   * slash command's own reply says it was asked, and each answer lands in the
   * channel under its own name.
   *
   * Returns how many agents were asked.
   */
  async requestStatusUpdate(room: Room, askedBy: string): Promise<number> {
    const ref = formatRoomRef(room.ref);
    const subs = this.store.listSubscriptionsForRoom(ref).filter((s) => s.wakeOn !== "none");
    if (subs.length === 0) return 0;

    // A person asked, so the room is demonstrably going somewhere: clear the
    // agent-only turn count that would otherwise keep everyone quiet.
    this.store.noteRoomTurn(ref, true);

    const identities = this.identities();
    for (const sub of subs) {
      const label = identities.labelForAgent(sub.agent);
      const prompt = [
        `Room "${room.name}". You are ${label}.`,
        ...(room.purpose ? [`Purpose: ${room.purpose}`] : []),
        "",
        `${askedBy} asked everyone here for a status update.`,
        "",
        "Reply with what you are working on right now, in one or two sentences.",
        'If you have nothing in flight, say so plainly — do not invent work. Use room(action="pass") only if someone else has already answered for you.',
      ].join("\n");

      // Deliberately not awaited: a status round-up runs several models, and
      // the slash command should answer immediately rather than hold the
      // interaction open for a minute.
      void this.runPrompted(sub, prompt, label).catch((err) => {
        console.error(`[rooms] Status update failed for ${sub.agent}: ${(err as Error).message}`);
      });
    }
    return subs.length;
  }

  /**
   * Run one agent against a prompt we built, and post whatever it says back to
   * the room. Shares the reply path with a normal wake, so `pass`, the
   * duplicate-addressee lift and repeat suppression all behave the same.
   */
  private async runPrompted(sub: RoomSubscription, prompt: string, label: string): Promise<void> {
    const key = `${sub.agent} ${sub.roomRef}`;
    if (this.running.has(key)) return;

    const limits = this.readLimits();
    if (!this.store.tryConsumeWake(sub.agent, sub.roomRef, limits.maxWakesPerHour)) {
      console.warn(`[rooms] ${sub.agent} is at its wake ceiling; skipping its status update.`);
      return;
    }

    this.running.add(key);
    try {
      const config = this.runtime.getConfig();
      const resolved = resolveAgent(sub.agent, config, this.runtime.getTools(), undefined, this.runtime.contextDir);
      const session = findOrCreateSession(
        this.runtime.db,
        makeRoomSessionKey(sub.roomRef, sub.agent),
        resolved.model,
        resolved.provider,
      );
      const base = this.runtime.buildLoopOptions({ agentName: sub.agent, session });
      const workingMemory = new Map<string, string>();
      let usedTools = false;
      const reply = await runAgentLoop(prompt, {
        ...base,
        toolContextExtras: { ...base.toolContextExtras, workingMemory },
        onToolCall: (name) => {
          if (name !== "room") usedTools = true;
        },
      });
      if (usedTools) this.store.resetAgentTurns(sub.roomRef);
      await this.deliverReply(sub, reply, label, workingMemory, []);
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * Re-check once the hourly allowance resets. Without it a subscription that
   * hits its ceiling waits for the *next* message to arrive before reading
   * what it already missed — and in a quiet room that message may never come.
   */
  private retryAfterHour(sub: RoomSubscription): void {
    const key = `${sub.agent} ${sub.roomRef}`;
    if (this.hourRetries.has(key)) return;
    const msToNextHour = 3_600_000 - (Date.now() % 3_600_000);
    const timer = setTimeout(() => {
      this.hourRetries.delete(key);
      this.scheduleWake(sub);
    }, msToNextHour + 1_000);
    timer.unref?.();
    this.hourRetries.set(key, timer);
  }

  /** Attach the turn's tool calls under the message it produced. */
  private async attachActivity(
    sub: RoomSubscription,
    parent: RoomMessage,
    label: string,
    activity: string[],
  ): Promise<void> {
    const ref = parseRoomRef(sub.roomRef);
    const backend = ref ? getRoomBackend(ref.backend) : undefined;
    if (!ref || !backend?.capabilities.threads) return;

    try {
      await backend.post(ref.id, {
        body: activity.map((line) => `• ${line}`).join("\n"),
        speaker: label,
        parentId: parent.id,
      });
    } catch (err) {
      // Never let bookkeeping cost the reply that already went out.
      console.warn(`[rooms] Could not attach tool activity: ${(err as Error).message}`);
    }
  }

  /**
   * Post the agent's answer back to the room.
   *
   * Skipped when the agent already posted through the `room` tool during the
   * run: the tool records what it sent in working memory, so "I called
   * room(post) and then summarized what I did" does not appear twice.
   *
   * Replies go through PASSTHROUGH_GATE deliberately. The dedup gate exists to
   * stop unprompted repetition; a reply to someone who addressed you is
   * solicited, and suppressing it would leave a question visibly unanswered.
   */
  private async deliverReply(
    sub: RoomSubscription,
    reply: string,
    label: string,
    workingMemory: Map<string, string>,
    seen: RoomMessage[],
  ): Promise<RoomMessage | null> {
    const body = (reply ?? "").trim();
    if (!body) return null;
    // A model asked to "call room(action=\"pass\")" sometimes writes the call
    // instead of making it. Posting that verbatim is noise, and it means the
    // agent's decision to stay quiet was inverted into a message. Read it as
    // the intent it plainly is — unless it changed something, handled above.
    if (looksLikeUninvokedPass(body)) return null;
    if (workingMemory.get(`room:posted:${sub.roomRef}`) === "true") return null;
    // The agent explicitly chose to stay quiet. Posting its closing thought
    // anyway would make `pass` decorative.
    if (workingMemory.get(`room:passed:${sub.roomRef}`) === "true") return null;

    const ref = parseRoomRef(sub.roomRef);
    if (!ref) return null;
    const backend = getRoomBackend(ref.backend);
    if (!backend) return null;

    // Whoever last spoke to us is the default recipient, so a thread reads as
    // a conversation rather than a series of announcements.
    const lastSpeaker = [...seen].reverse().find((m) => m.speaker && m.speaker !== label)?.speaker;

    // The model names its recipient too, so exactly one of us has to win or the
    // name lands twice: "[planner] @coder coder Copy that." Its choice beats
    // the heuristic — in a three-way room the last speaker often isn't who the
    // reply is for — and whatever it named is lifted out of the body.
    const identities = this.identities();
    const lifted = extractLeadingAddressees(body, (l) => identities.isKnown(l), lastSpeaker ? [lastSpeaker] : []);
    const to = lifted.to.length > 0 ? lifted.to : lastSpeaker ? [lastSpeaker] : [];
    const spoken = lifted.body || body;

    let posted: RoomMessage | null = null;
    await PASSTHROUGH_GATE.deliver(
      {
        source: `room:${sub.agent}`,
        channel: ref.backend,
        target: ref.id,
        content: spoken,
      },
      async () => {
        // Not advancing the cursor past our own post is deliberate: shouldWake
        // already refuses to wake an agent on its own words, and jumping the
        // cursor forward would silently swallow anything that arrived while
        // the agent was composing this reply.
        posted = await backend.post(ref.id, { body: spoken, speaker: label, to });
      },
    );
    return posted;
  }

  /**
   * The wake prompt. Kept deliberately short — local models degrade badly past
   * a few hundred tokens of preamble, and the agent's own instructions are
   * already in the system prompt.
   */
  private buildPrompt(
    sub: RoomSubscription,
    messages: RoomMessage[],
    roomName: string,
    label: string,
    identities: IdentityResolver,
    purpose?: string,
  ): string {
    const lines = messages.map((m) => renderTranscriptLine(m.speaker ?? m.authorLabel, m.to, m.body));

    const recipient = [...messages].reverse().find((m) => m.speaker && m.speaker !== label)?.speaker;

    // Only who is actually IN this room. Listing every agent in config put 18
    // names in front of the model, most of them not present — wasted tokens
    // and an invitation to address someone who will never see it.
    const subscribed = this.store.listSubscriptionsForRoom(sub.roomRef).map((s) => identities.labelForAgent(s.agent));
    const humans = identities
      .all()
      .filter((i) => i.kind === "human")
      .map((i) => i.label);
    const others = [...new Set([...subscribed, ...humans])]
      .filter((l) => l.toLowerCase() !== label.toLowerCase())
      .join(", ");

    return [
      `Room "${roomName}". You are ${label}.`,
      // The room's standing instructions. First line, before the transcript,
      // because it frames everything below it.
      ...(purpose ? [`Purpose: ${purpose}`] : []),
      "",
      "New messages:",
      ...lines,
      "",
      // Don't ask for a name it would then repeat: the envelope already carries
      // the recipient. Only mention @name as the way to redirect.
      recipient
        ? `Reply as ${label}. Your reply goes to ${recipient} — write only your message. To reach someone else instead, start with @name.`
        : `Reply as ${label}. To address someone, start with @name.`,
      `Known participants: ${others || "none"}.`,
      // Stated as a positive instruction with concrete cases. "Don't reply
      // unless..." is exactly the negative phrasing local models mishandle,
      // and the escape hatch is a tool call rather than a sentinel word.
      'If you have nothing to add — you would only be acknowledging, agreeing, or thanking someone — call room(action="pass") instead of replying.',
    ].join("\n");
  }

  /** True once start() has armed listeners. Exposed for status output. */
  isRunning(): boolean {
    return this.started;
  }
}
