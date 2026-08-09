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
import { registerContextSlot, unregisterContextSlot } from "../agent/context-slots.js";
import { estimateTokens, runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import type { Subscription } from "../events.js";
import { PASSTHROUGH_GATE } from "../notifications/dedup.js";
import type { AgentRuntime } from "../runtime.js";
import { describeBooking, lateLine, recurringLine, type WakeContext } from "../schedules/wake-context.js";
import { addresses, extractLeadingAddressees, renderTranscriptLine } from "./envelope.js";
import { enrichRoomMessage, IdentityResolver } from "./identities.js";
import { getRoomBackend, listRoomBackends, onRoomBackendChange } from "./registry.js";
import type { RoomStore, RoomSubscription } from "./store.js";
import { formatRoomRef, parseRoomRef, type Room, type RoomMessage } from "./types.js";
import { type WakeEntry, WakeQueue, type WakeTrigger } from "./wake-queue.js";

/**
 * Working-memory key naming the rooms a turn was woken for, comma-separated.
 * Read by the `room` tool so `pass` with no argument can scope itself.
 */
export const WAKE_ROOMS_KEY = "room:wake-rooms";

/**
 * Prefix for the per-room marker meaning "the agent already posted here through
 * the `room` tool this turn". Written by the tool once the backend call
 * returns, read by the watcher to suppress a duplicate delivery and to decide
 * whether the turn spoke.
 *
 * Shared rather than spelled out at each site because the wake accounting reads
 * it by prefix: a writer and a reader that disagreed by one character would
 * make every tool post look silent again, which is the bug this constant exists
 * to keep fixed.
 */
export const ROOM_POSTED_PREFIX = "room:posted:";

/** Working-memory key recording that the agent posted to `roomRef`. */
export function roomPostedKey(roomRef: string): string {
  return `${ROOM_POSTED_PREFIX}${roomRef}`;
}

/** Why an agent was woken. Surfaced in the activity record. */
export type WakeReason = "named" | "loose-question" | "all" | "check-in" | "asked" | "scheduled";

/**
 * What became of a wake the agent booked for itself.
 *
 * `at-ceiling` is retryable and `gone` is not, which is the whole reason this
 * is three values rather than a boolean: the scheduler defers the first and
 * retires the schedule on the second.
 */
export type ScheduledWakeOutcome = "ran" | "at-ceiling" | "gone";

export interface RoomWatcherLimits {
  maxWakesPerHour: number;
  /** Consecutive agent-only turns allowed before a room goes quiet. */
  maxAgentTurns: number;
  maxBacklog: number;
  batchSeconds: number;
  defaultPollSeconds: number;
  /** How much of an agent's tool use to attach under its message. */
  toolActivity: "none" | "mutations" | "all";
  /**
   * Whether agents woken by the same room take turns.
   *
   * `serial` runs them one at a time, in the order they were triggered, so the
   * second agent's prompt contains the first agent's reply. `concurrent` is the
   * old behaviour: everyone woken by one message answers it at the same time,
   * in parallel, none of them aware the others were asked.
   */
  turnTaking: "concurrent" | "serial";
  /**
   * Shortest gap between one agent's wakes, in minutes, across every room it
   * watches. Triggers arriving inside the gap accumulate rather than starting a
   * turn. 0 (the default) leaves an agent as responsive as its traffic.
   */
  minWakeIntervalMinutes: number;
}

/** Consecutive backend failures before a room is given a rest. */
const ROOM_FAILURE_LIMIT = 3;
/** How long a room is left alone after that, before one attempt is retried. */
const ROOM_QUARANTINE_MS = 30 * 60_000;
/**
 * How long to wait for membership changes to settle before re-arming. Long
 * enough to collapse a config reconcile (one event per subscription) and an
 * agent inviting several peers in one turn; short enough that a human running
 * `/room add` sees it take effect while still looking at the screen.
 */
const REARM_DEBOUNCE_MS = 250;

export const ROOM_WATCHER_DEFAULTS: RoomWatcherLimits = {
  maxWakesPerHour: 12,
  maxAgentTurns: 6,
  maxBacklog: 30,
  batchSeconds: 3,
  defaultPollSeconds: 900,
  toolActivity: "none",
  turnTaking: "serial",
  minWakeIntervalMinutes: 0,
};

export interface RoomWatcherOptions {
  runtime: AgentRuntime;
  store: RoomStore;
  limits?: Partial<RoomWatcherLimits>;
}

/**
 * Is this line the agent's own voice? Resolved through the identity layer, so
 * a declared alias counts as the same agent as the name it points at.
 */
export function speaksAs(
  speaker: string | undefined,
  agent: string,
  label: string,
  identities: IdentityResolver,
): boolean {
  if (!speaker) return false;
  const speakerAgent = identities.agentForLabel(speaker);
  if (speakerAgent) return speakerAgent === agent;
  return speaker.toLowerCase() === label.toLowerCase();
}

/**
 * Did a person say this?
 *
 * One definition, two readers: the wake policy uses it to decide whether an
 * unaddressed line is a loose question or agent chatter, and the global pause
 * uses it to decide whether a wake is autonomous. Those two must agree — a
 * second, subtly different copy of this rule is how you end up with a pause
 * that swallows the owner's own messages in some rooms and not others.
 *
 * An unresolvable speaker counts as human. Backends are third-party and a
 * message we cannot attribute is more likely a person on a transport we do
 * not model than an agent, and the failure modes are asymmetric: waking on a
 * human wrongly costs one run, ignoring one loses the conversation.
 */
export function isFromHuman(msg: RoomMessage, identities: IdentityResolver): boolean {
  const identity = msg.speaker ? identities.get(msg.speaker) : undefined;
  return identity ? identity.kind === "human" : !msg.speaker;
}

/**
 * How to hold several conversations at once.
 *
 * An agent in six rooms had no sanctioned way to speak in any but the one that
 * woke it: the wake prompt names one room, lists only that room's participants,
 * and offers reply-or-pass. Asked in one room to tell someone in another
 * something, a 27B model invented `[message to dana]` as a reply prefix and
 * sent it to the wrong room — three times in one evening. The capability was
 * there the whole time; nothing said so.
 *
 * Phrased as positive instructions with concrete calls, not as prohibitions.
 * The one negative is last and names the actual consequence, because "it goes
 * to the wrong people" is the part that was not obvious.
 */
const MULTI_ROOM_HOWTO = [
  "You are in more than one room. You can see them all, but only the room you are answering in hears your reply.",
  "",
  "- Reply where you are: write your message plainly.",
  '- Say something in another room: room(action="post", room="<room>", body="<message>").',
  '- Reach one person or agent wherever they are: room(action="dm", to=["<name>"], body="<message>").',
  '- Nothing to add here: room(action="pass").',
  "",
  "A message meant for another room has to be sent with the tool. Writing it as your reply here delivers it to the",
  "people in this room instead.",
].join("\n");

/** How much of its own message an agent is shown when it is quoted back to it. */
const OWN_ECHO_CHARS = 150;

/**
 * Shorten a line the agent wrote itself.
 *
 * An agent's post comes back through the room and lands in the next wake's
 * transcript, but it is already in that agent's session as the reply it just
 * made — so a 4,000-character handoff was paying for itself twice in a context
 * window that a 27B model has to read carefully. Observed: a 6.4 KB wake prompt
 * of which two thirds was the agent quoting itself, answered with `pass`.
 *
 * Not dropped outright. The session can have been reset between the post and
 * the wake, and a stub is enough to re-anchor "I already sent the list" without
 * re-sending the list.
 */
export function condenseOwnLine(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= OWN_ECHO_CHARS) return flat;
  return `${flat.slice(0, OWN_ECHO_CHARS).trimEnd()}… (your own message, in full above)`;
}

/**
 * How a timed wake describes the room to itself.
 *
 * Timed wakes — check-ins and self-booked schedules — used to re-render the
 * room's last ten messages from a null cursor on every firing, and the rendered
 * prompt is persisted to the session. In a quiet room that stored the same
 * block over and over: one 1,115-token check-in prompt appeared 23 times in a
 * single session, and nothing told the agent that the 23 renderings described
 * one moment rather than 23 events.
 *
 * They now read from the cursor like every other wake path, so this says what
 * arrived since the agent last looked. When nothing did, it says that instead
 * of repeating what the agent has already read — which is both cheaper and
 * more informative, since "nothing changed" is exactly the fact a check-in
 * exists to establish and was the one thing it could not previously express.
 *
 * Older context is not lost: prior wakes left it in the agent's own session,
 * and a first-ever wake has a null cursor, so it still receives the backlog.
 */
export function describeSinceLastTurn(transcript: string[]): string[] {
  if (transcript.length === 0) return ["Nothing new here since your last turn.", ""];
  return ["New since your last turn:", ...transcript, ""];
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
 * A reply that is the model's tool-call syntax, emitted as prose.
 *
 * Observed in the wild from a 27B local model asked for a status update:
 *
 *     <tool_call>
 *     function=room>
 *     <parameter=action> post </parameter>
 *     <parameter=body> Working on two tasks… </parameter>
 *
 * The message it meant to send was sitting right there in the markup, and the
 * tempting fix is to dig it out. That means teaching core to parse one model
 * family's tool dialect and guessing when the parse is ambiguous — and a wrong
 * guess posts words the agent did not choose, under its name. Telling it the
 * output was malformed costs one round and leaves the wording its own.
 *
 * Matched on markers rather than structure, because the markup is often
 * truncated or malformed — that is why it failed to parse in the first place.
 * These strings do not occur in ordinary prose.
 */
export function looksLikeRawToolCall(body: string): boolean {
  return /<\/?tool_call>|<\|?(tool_call|python_tag)\|?>|<function=|<parameter=/i.test(body);
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

/**
 * Today's date, for the wake prompt.
 *
 * A room is a place where time passes: check-ins fire on a clock, purposes
 * carry dates, and agents are asked how long until something. An agent only
 * knows the date if it happens to carry a clock tool, and most do not — so it
 * infers, and gets it wrong. Ten tokens spent here beats a wrong deadline.
 */
export function todayLine(now = new Date()): string {
  return `Today is ${now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })}.`;
}

/** Plain-language wake reason for the activity record. */
export function describeWakeReason(reason: WakeReason): string {
  switch (reason) {
    case "named":
      return "named directly";
    case "loose-question":
      return "a person asked the room";
    case "all":
      return "watching everything in this room";
    case "check-in":
      return "scheduled check-in";
    case "asked":
      return "asked for a status update";
    case "scheduled":
      return "a wake it scheduled for itself";
  }
}

/**
 * Session key for a room conversation.
 *
 * Per-room by default (`room:<backend>.<id>:<agent>`), so what an agent does in
 * one place cannot leak into another. `shared` collapses every room into one
 * session (`room:all:<agent>`) for an agent that should carry a thread between
 * places — at the cost of mixing unrelated context and growing history with the
 * number of rooms.
 */
export function makeRoomSessionKey(roomRef: string, agent: string, scope: "room" | "shared" = "room"): string {
  if (scope === "shared") return `room:all:${agent}`;
  return `room:${roomRef.replace(/:/g, ".")}:${agent}`;
}

/**
 * Most messages shown from any one room in a combined wake.
 *
 * Low on purpose. The point of reading nine rooms at once is to see what is
 * going on in all of them, not to read any one of them thoroughly — the agent
 * still has `room(action="read")` when a room turns out to need attention.
 */
const BATCH_ROOM_MESSAGES = 5;

/**
 * Rough ceiling on the whole transcript of a combined wake, in estimated
 * tokens.
 *
 * A *single*-room wake prompt has been measured at 6.4 KB. Ten of those is not
 * a prompt, it is a context window with an agent buried in it, and a 27B local
 * model reading it will answer the loudest room rather than the one that asked.
 * One hard total, allocated newest-first, is the only version of this that
 * survives a deployment adding a tenth room.
 */
const BATCH_TRANSCRIPT_TOKENS = 1200;

/**
 * When the newest message in a room landed. Used to pick which room a combined
 * wake is really about.
 *
 * Timestamps rather than cursors, because a cursor only orders messages within
 * one backend — a Discord snowflake and a local rowid do not compare. Parsing
 * accepts whatever the backend wrote and treats anything unreadable as ancient,
 * so a backend with an odd date format loses the tie-break rather than the
 * whole wake.
 */
export function newestMessageAt(messages: RoomMessage[]): number {
  let newest = 0;
  for (const m of messages) {
    const at = Date.parse(m.createdAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/**
 * Choose what a combined wake shows, newest traffic first.
 *
 * The obvious allocation — an equal quota per room — is the wrong one. Nine
 * idle rooms would each spend their share on last week's chatter and crowd out
 * the room that asked a question ten seconds ago, which is the only room the
 * wake existed for. So slots go to whoever holds the most recent unshown
 * message, until the per-room cap or the total budget runs out.
 *
 * With one exception, and it matters: `mustInclude` names the rooms the wake
 * policy actually said yes to, and each of those gets its newest message before
 * the newest-first pass spends anything. Without that, the room that was the
 * sole reason the turn ran could lose every slot to a chattier neighbour, keep
 * its cursor, and be squeezed out again on the next wake — a charged turn in
 * which the triggering room is never read, repeating forever.
 *
 * `framing` is what a room's heading, purpose and role lines cost. Charged the
 * first time a room takes a message, because they are printed only for rooms
 * that appear — purposes are free-text config, and nine of them are real prompt
 * that has to come out of the same budget as the transcript.
 *
 * A room that gets no slot at all is not in the result, and the caller leaves
 * its cursor alone: it was never shown, so it has not been read.
 */
export function selectBatchTranscript(
  rooms: Array<{ roomRef: string; messages: RoomMessage[]; framing?: number }>,
  opts: {
    budgetTokens?: number;
    perRoom?: number;
    cost?: (msg: RoomMessage) => number;
    /** Rooms guaranteed at least their newest message. */
    mustInclude?: Iterable<string>;
  } = {},
): Map<string, RoomMessage[]> {
  const perRoom = opts.perRoom ?? BATCH_ROOM_MESSAGES;
  const cost = opts.cost ?? ((msg: RoomMessage) => estimateTokens({ role: "user", content: msg.body }));
  let budget = opts.budgetTokens ?? BATCH_TRANSCRIPT_TOKENS;

  // Backends answer oldest-first, so the tail is the newest and popping takes
  // messages in the order this wants to spend on them.
  const pools = rooms.map((r) => ({
    roomRef: r.roomRef,
    framing: r.framing ?? 0,
    rest: [...r.messages],
    taken: [] as RoomMessage[],
  }));

  const take = (pool: (typeof pools)[number]): boolean => {
    const msg = pool.rest.pop();
    if (!msg) return false;
    // Charged after the message is taken, so the single most recent message is
    // always shown even when it is larger than the whole budget. A prompt that
    // overshoots by one message beats one that omits the message that woke the
    // agent.
    if (pool.taken.length === 0) budget -= pool.framing;
    pool.taken.unshift(msg);
    budget -= cost(msg);
    return true;
  };

  const required = new Set(opts.mustInclude ?? []);
  for (const pool of pools) {
    if (required.has(pool.roomRef)) take(pool);
  }

  while (budget > 0) {
    let pick: (typeof pools)[number] | undefined;
    let pickedAt = Number.NEGATIVE_INFINITY;
    for (const pool of pools) {
      if (pool.rest.length === 0 || pool.taken.length >= perRoom) continue;
      const at = Date.parse(pool.rest[pool.rest.length - 1].createdAt);
      const when = Number.isFinite(at) ? at : 0;
      if (when > pickedAt) {
        pickedAt = when;
        pick = pool;
      }
    }
    if (!pick) break;
    if (!take(pick)) break;
  }

  const shown = new Map<string, RoomMessage[]>();
  for (const pool of pools) {
    if (pool.taken.length > 0) shown.set(pool.roomRef, pool.taken);
  }
  return shown;
}

/**
 * The order room locks are taken in, and the only definition of it.
 *
 * Plain code-unit order rather than `localeCompare`: what the deadlock argument
 * needs is a total order every caller agrees on, and locale collation is not
 * one — it can call two distinct refs equal, which leaves their relative order
 * up to the sort and puts two agents back on opposite paths.
 */
export function compareRoomRefs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One room's contribution to a combined wake. */
interface BatchSection {
  sub: RoomSubscription;
  room: Room | null;
  messages: RoomMessage[];
}

/**
 * The rooms one turn covers, when several were collapsed into it.
 *
 * Present only on a batched turn. Everything that reads it has a single-room
 * branch right beside it, because a wake for one room must behave exactly as it
 * did before batching existed.
 */
interface BatchedTurn {
  /** The subscriptions actually shown, in the order they appear in the prompt. */
  subs: RoomSubscription[];
  /** What each room contributed, so each cursor advances to what it showed. */
  shown: Map<string, RoomMessage[]>;
  /** Room names as the agent saw them, for the correction round. */
  names: string[];
}

export class RoomWatcher {
  private readonly runtime: AgentRuntime;
  private readonly store: RoomStore;
  private limits: RoomWatcherLimits;

  private unsubscribers: Array<() => void> = [];
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Who is due to run, and why. Owns the timing and the coalescing for every
   * path that starts a room turn; what actually runs is decided in `onDue`.
   */
  private readonly wakeQueue = new WakeQueue({
    // Only the message path waits: a burst of five messages in two seconds
    // should be one turn that sees all five. A poll tick and a check-in are
    // already the product of their own interval and are due immediately.
    delayMs: (trigger) => (trigger === "message" ? this.limits.batchSeconds * 1000 : 0),
    // Read per call: config is hot-reloadable, and a cooldown the operator has
    // just relaxed should take effect on the next trigger, not the next restart.
    minIntervalMs: () => (this.readLimits().minWakeIntervalMinutes ?? 0) * 60_000,
    onDue: (entry) => this.onWakeDue(entry),
  });
  /** In-flight runs, so one agent never processes a room twice at once. */
  private running = new Set<string>();
  /** Triggers that arrived mid-run and must be re-armed when it finishes. */
  private pending = new Set<string>();
  /**
   * One FIFO chain per room, so agents woken by the same message take turns.
   * Keyed by roomRef; the value is the tail of that room's queue.
   */
  private roomChains = new Map<string, Promise<void>>();
  /**
   * Wakes already sitting on a chain, keyed `${agent} ${roomRef}`. A second
   * trigger for an agent that is still queued is dropped rather than enqueued
   * twice — the queued run re-fetches the backlog when it starts, so it will
   * see the newer message anyway. This is also what stops `wakeOn: "all"`
   * double-waking an agent on a reply that arrived while it was waiting.
   */
  private queued = new Set<string>();
  /** One-shot retries armed when a subscription hits its hourly ceiling. */
  private hourRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Agents already told that batching needs a per-agent floor. See batchingAllowed. */
  private batchWarned = new Set<string>();
  /**
   * The cross-room view for the turn each agent is currently taking.
   *
   * Written immediately before the turn and cleared when it ends. One entry per
   * agent is enough because `running` already serialises an agent's turns, so
   * the value can never belong to a turn other than the one reading it — the
   * same guarantee `skippedAhead` relies on.
   */
  private crossRoomView = new Map<string, string>();
  /**
   * Recent lines per room, so building the view does not cost one backend round
   * trip per watched room per turn. Keyed by roomRef.
   */
  private roomSliceCache = new Map<string, { at: number; lines: string[] }>();
  /**
   * Distinguishes one batch attempt from the next.
   *
   * The per-room queue drops a second trigger that arrives under a key already
   * waiting, which is right for a repeat wake of the same room and wrong for a
   * batch: two attempts for one agent can name different rooms, so collapsing
   * them loses whichever rooms the in-flight one does not cover — and the drop
   * path marks nothing pending, so nothing ever comes back for them.
   */
  private batchSeq = 0;
  private checkInTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Why each pending wake fired, so the activity record can say. */
  private wakeReasons = new Map<string, WakeReason>();
  private offBackendChange: (() => void) | undefined;
  private membershipSubscription: Subscription | undefined;
  /** Re-arm on `room.archived` / `room.unarchived`, disposed with the rest. */
  private archiveSubscriptions: Subscription[] = [];
  /** Coalesces a burst of membership changes into one re-arm. */
  private rearmTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(opts: RoomWatcherOptions) {
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.limits = { ...ROOM_WATCHER_DEFAULTS, ...opts.limits };
    // Registered here rather than in start(): both slots decide for themselves
    // whether they have anything to say — config off, or fewer than two rooms,
    // renders nothing — so an unstarted watcher contributes nothing anyway, and
    // a caller that drives turns directly still gets them.
    this.registerRoomSlots();
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

  /**
   * The brakes in force, optionally for one room.
   *
   * Rooms differ enough that one global pair of numbers has to be wrong
   * somewhere: an engineering room where three agents hand work back and forth
   * needs more headroom than a channel that sees one message a week. Passing a
   * ref lets that room's entry in `rooms.rooms[]` override the deployment-wide
   * value; everything else stays global, because nothing else here has turned
   * out to be room-specific.
   */
  private readLimits(roomRef?: string): RoomWatcherLimits {
    const cfg = this.runtime.getConfig().rooms;
    const room = roomRef
      ? cfg?.rooms?.find((r) => r.ref === roomRef || r.name === this.store.getRoomByRef(roomRef)?.name)
      : undefined;
    return {
      maxWakesPerHour: room?.maxWakesPerHour ?? cfg?.maxWakesPerHour ?? this.limits.maxWakesPerHour,
      maxAgentTurns: room?.maxAgentTurns ?? cfg?.maxAgentTurns ?? this.limits.maxAgentTurns,
      maxBacklog: cfg?.maxBacklog ?? this.limits.maxBacklog,
      batchSeconds: cfg?.batchSeconds ?? this.limits.batchSeconds,
      defaultPollSeconds: cfg?.defaultPollSeconds ?? this.limits.defaultPollSeconds,
      toolActivity: cfg?.toolActivity ?? this.limits.toolActivity,
      turnTaking: room?.turnTaking ?? cfg?.turnTaking ?? this.limits.turnTaking,
      // Per agent, so no per-room override: a room cannot decide how often an
      // agent runs everywhere else.
      minWakeIntervalMinutes: cfg?.minWakeIntervalMinutes ?? this.limits.minWakeIntervalMinutes,
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
    this.registerRoomSlots();

    // Backends connect asynchronously and after this point (Discord registers
    // on ClientReady, well after login resolves), so re-arm whenever the set
    // changes. Without this every push subscription binds to an empty registry
    // at boot and never fires.
    this.offBackendChange = onRoomBackendChange(() => {
      if (this.started) this.rearm();
    });

    // Subscriptions are armed here, once, from the set that existed at this
    // moment. Anything added later — `/room add`, the room tool's invite, a
    // config reconcile — was written to the database and then never armed: a
    // new `deliver: poll` subscription had no timer, `checkInMinutes` had no
    // interval, and the first push subscription for a backend had no listener.
    // The write succeeded and reported success, so from the outside the agent
    // simply never spoke again.
    // Optional only for the runtime doubles in tests and embeds that construct
    // a watcher without a bus; the real runtime always has one.
    this.membershipSubscription = this.runtime.events?.on("room.membership_changed", () => {
      if (this.started) this.scheduleRearm();
    });

    // Archiving is a re-arm for the same reason a membership change is: timers
    // are created here and nowhere else, so a room retired at runtime would go
    // on polling and checking in until the next restart.
    //
    // It is also where the transport is told, alongside publishPurposes below:
    // both are "make the channel match what TAI thinks", both are best-effort,
    // and both belong to whoever already talks to backends. The consequence
    // worth knowing is that `rooms.enabled: false` stops the watcher, so an
    // archive made with rooms off is recorded but not reflected on Discord.
    for (const event of ["room.archived", "room.unarchived"] as const) {
      const sub = this.runtime.events?.on(event, (e) => {
        if (!this.started) return;
        this.scheduleRearm();
        void this.reflectArchiveOnTransport(e.roomRef, event === "room.archived");
      });
      if (sub) this.archiveSubscriptions.push(sub);
    }

    // Archived rooms are excluded here, which is what stops their poll timers,
    // check-in timers and push fan-out from ever being created.
    const subs = this.store.listActiveSubscriptions();
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

    this.warnAboutRoomlessSubscribers(subs);

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
   * Tell the transport a room was retired, or brought back.
   *
   * Strictly best-effort. The archive is already recorded and already in force
   * by the time this runs, so a transport that cannot oblige — no Manage
   * Channels, no such concept, gateway down — costs a log line and nothing
   * else. Letting this throw would surface a cosmetic failure as if the archive
   * itself had failed.
   */
  private async reflectArchiveOnTransport(roomRef: string, archived: boolean): Promise<void> {
    const ref = parseRoomRef(roomRef);
    if (!ref) return;
    const backend = getRoomBackend(ref.backend);
    // `archive: false` covers both "cannot" and "not configured to", so an
    // unconfigured deployment is silent rather than logging on every archive.
    if (!backend?.capabilities.archive || !backend.archiveRoom) return;
    try {
      await backend.archiveRoom(ref.id, archived);
    } catch (err) {
      console.warn(
        `[rooms] Could not ${archived ? "file" : "restore"} "${roomRef}" on its transport: ${(err as Error).message}. ` +
          `The room is still ${archived ? "archived" : "live"} in TAI.`,
      );
    }
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

  /**
   * Re-arm after a membership change, coalescing a burst into one pass.
   *
   * A config reconcile emits one event per subscription it adds or prunes, and
   * an agent can invite several peers in a single turn. Re-arming per event
   * would tear down and rebuild every timer in the deployment N times.
   *
   * The tradeoff this accepts: `rearm()` rebuilds *all* timers, so any poll or
   * check-in clock in flight restarts. A subscription changing every few
   * minutes could therefore keep starving a long poll interval. Arming
   * incrementally — touching only the subscription that changed — avoids that
   * and is the better end state; this is the small version that makes the
   * documented feature work at all. Subscriptions change rarely in practice,
   * and never firing is worse than firing late.
   */
  private scheduleRearm(): void {
    if (this.rearmTimer) clearTimeout(this.rearmTimer);
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = undefined;
      if (this.started) this.rearm();
    }, REARM_DEBOUNCE_MS);
    // Do not hold the process open just to re-arm.
    this.rearmTimer.unref?.();
  }

  /** Re-bind listeners and timers without tearing down the backend watch. */
  private rearm(): void {
    const wasStarted = this.started;
    this.start();
    this.started = wasStarted;
  }

  /**
   * Two context slots, split by what they are.
   *
   * The view is state: it changes every turn, so it rides behind the history
   * where it is replaced wholesale and never cached. The how-to is standing
   * knowledge: identical on every turn, so it rides in the system prompt, in
   * the cacheable prefix, and is paid for once rather than per turn.
   *
   * Neither is written into the wake prompt. The wake prompt is persisted as
   * the record of what the agent was asked, and a re-rendered view stored as a
   * record is what puts the same block in a session twenty times.
   */
  private registerRoomSlots(): void {
    registerContextSlot({
      id: "rooms.view",
      refresh: "turn",
      title: "Your rooms right now",
      render: (ctx) => (ctx.agent ? (this.crossRoomView.get(ctx.agent) ?? null) : null),
    });

    registerContextSlot({
      id: "rooms.multi_room_howto",
      refresh: "reload",
      render: (ctx) => {
        if (!ctx.agent) return null;
        if (!this.crossRoomSettings().enabled) return null;
        const live = this.store
          .listSubscriptionsForAgent(ctx.agent)
          .filter((s) => !this.store.getRoomByRef(s.roomRef)?.archivedAt);
        // An agent in one room does not need to be told about the others, and
        // the paragraph would only invite it to address a room it cannot see.
        if (live.length < 2) return null;
        return MULTI_ROOM_HOWTO;
      },
    });
  }

  stop(): void {
    this.started = false;
    unregisterContextSlot("rooms.view");
    unregisterContextSlot("rooms.multi_room_howto");
    this.crossRoomView.clear();
    this.roomSliceCache.clear();
    this.offBackendChange?.();
    this.offBackendChange = undefined;
    this.membershipSubscription?.dispose();
    this.membershipSubscription = undefined;
    for (const sub of this.archiveSubscriptions) sub.dispose();
    this.archiveSubscriptions = [];
    if (this.rearmTimer) clearTimeout(this.rearmTimer);
    this.rearmTimer = undefined;
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
    this.wakeQueue.clear();
    for (const timer of this.hourRetries.values()) clearTimeout(timer);
    this.hourRetries.clear();
    for (const timer of this.checkInTimers.values()) clearInterval(timer);
    this.checkInTimers.clear();
    this.pending.clear();
    // In-flight runs finish on their own; dropping the chains just stops
    // anything new queueing behind them.
    this.roomChains.clear();
    this.queued.clear();
  }

  /**
   * Wake an agent on a timer even when nobody has said anything.
   *
   * Messages are not the only reason to act — a deadline gets closer, a
   * promised follow-up comes due, a booking window closes. Without this an
   * agent can only ever react, so anything time-based waits for a human to
   * remember to ask.
   */
  /**
   * Say so when an agent is in a room it cannot speak in.
   *
   * Every wake prompt ends with `call room(action="pass")` if you have nothing
   * to add. An agent whose `tools:` allowlist omits `room` cannot do that, so
   * it types the instruction as prose instead — and from the outside that looks
   * like a model too weak to make a tool call, which is the wrong diagnosis and
   * leads to the wrong fix. Four agents here were in that state, including the
   * busiest one in the deployment.
   *
   * A warning rather than an auto-grant. Handing an agent a tool its
   * configuration withholds is a decision for whoever wrote the config; being
   * unable to see why it is behaving strangely is not.
   */
  /**
   * Called with the ACTIVE subscription set, so an agent whose only rooms are
   * archived is not named on every boot for a tool it no longer needs.
   */
  private warnAboutRoomlessSubscribers(subs: RoomSubscription[]): void {
    const agents = this.runtime.getConfig().agents ?? {};
    const roomless = [...new Set(subs.filter((s) => s.wakeOn !== "none").map((s) => s.agent))].filter((name) => {
      const tools = agents[name]?.tools;
      // No allowlist means every tool, which includes this one.
      return Array.isArray(tools) && !tools.includes("room");
    });
    if (roomless.length === 0) return;
    console.warn(
      `[rooms] These agents are subscribed to rooms but their "tools:" list omits "room", so they cannot post or pass: ${roomless.join(", ")}. ` +
        `They will answer wake prompts with text, including the literal words 'room(action="pass")'.`,
    );
  }

  private armCheckIn(sub: RoomSubscription): void {
    const minutes = sub.checkInMinutes ?? 0;
    if (minutes <= 0) return;
    const key = `${sub.agent} ${sub.roomRef}`;
    const timer = setInterval(
      () => {
        this.wakeQueue.enqueue({ agent: sub.agent, roomRef: sub.roomRef, trigger: "check-in" });
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
    // A clock fired and nobody said anything — the purest autonomous run there
    // is, and no scope distinction to make: there is no human turn to protect.
    if (this.runtime.isAgentsPaused("autonomous")) return;

    const sub = this.store.getSubscription(agent, roomRef);
    if (!sub?.checkInMinutes) return;

    const room = this.store.getRoomByRef(roomRef);
    if (!room) return;
    // The interval may outlive the archive by one tick — it is cleared on
    // re-arm, and the re-arm is debounced.
    if (room.archivedAt) return;

    // The wake is charged once, by `runPrompted`, which is the shared gate every
    // prompted turn goes through. There used to be a second `tryConsumeWake`
    // here as a cheap pre-flight — but a check that spends the thing it is
    // checking is not a pre-flight, and it made every check-in cost two.
    //
    // That silently halved the allowance, and the arithmetic an operator does
    // when setting `maxWakesPerHour` was wrong by however many of the wakes
    // were check-ins. A config comment reading "an hourly check-in needs 1"
    // was describing something that needed 2.
    this.store.recordCheckIn(agent, roomRef);

    const identities = this.identities();
    const label = identities.labelForAgent(agent);
    const fresh = await this.fetchBacklog(sub);
    const transcript = this.renderTranscript(fresh, agent, label, identities);

    this.wakeReasons.set(`${agent} ${roomRef}`, "check-in");
    const prompt = [
      `Room "${room.name}". You are ${label}. ${todayLine()}`,
      "This is a scheduled check-in — nobody has asked you anything.",
      ...(room.purpose ? [`Purpose: ${room.purpose}`] : []),
      ...(sub.role ? [`Your role here: ${sub.role}`] : []),
      "",
      ...describeSinceLastTurn(transcript),
      "Look at whether anything here needs attention now: a deadline approaching, something you said you would do, something waiting on someone.",
      'Speak only if there is something worth saying. If there is not, call room(action="pass") — a check-in that reports nothing is noise.',
    ].join("\n");

    await this.onRoomTurn(roomRef, `check-in:${agent} ${roomRef}`, async () => {
      await this.runPrompted(sub, prompt, label, "check-in", fresh);
    });
  }

  /**
   * A wake the agent booked for itself, delivered into a room.
   *
   * Shares `runCheckIn`'s tail — `onRoomTurn` → `runPrompted` — so it inherits
   * the per-room turn chain, the in-flight guard, the hourly wake ceiling,
   * `pass` handling and repeat suppression. What differs is the prompt: a
   * check-in asks "is anything worth saying", and this hands back the note the
   * agent wrote when it decided this moment mattered.
   *
   * Deliberately not routed through the `WakeQueue`, unlike every
   * traffic-driven wake. The queue collapses an agent's triggers into one entry
   * and holds them behind `minWakeIntervalMinutes`; both are wrong here.
   * Collapsing would drop the note, and the note is the wake. A cooldown meant
   * to damp a busy room should not move a time the agent picked on purpose.
   */
  async runScheduledWake(agent: string, roomRef: string, ctx: WakeContext): Promise<ScheduledWakeOutcome> {
    if (this.runtime.isAgentsPaused("autonomous")) return "at-ceiling";

    // Every reason the wake has nowhere to land: the agent left the room, the
    // room was archived, or it never existed. All permanent, so the scheduler
    // retires the schedule rather than retrying into the void.
    const sub = this.store.getSubscription(agent, roomRef);
    if (!sub) return "gone";
    const room = this.store.getRoomByRef(roomRef);
    if (!room || room.archivedAt) return "gone";

    const identities = this.identities();
    const label = identities.labelForAgent(agent);
    const fresh = await this.fetchBacklog(sub);
    const transcript = this.renderTranscript(fresh, agent, label, identities);

    this.wakeReasons.set(`${agent} ${roomRef}`, "scheduled");
    const prompt = [
      `Room "${room.name}". You are ${label}. ${todayLine()}`,
      `This is a wake you scheduled${describeBooking(ctx, new Date())}. Nobody has asked you anything.`,
      `Your note to yourself: "${ctx.note}"`,
      ...lateLine(ctx.lateBy),
      ...recurringLine(ctx),
      ...(room.purpose ? [`Purpose: ${room.purpose}`] : []),
      ...(sub.role ? [`Your role here: ${sub.role}`] : []),
      "",
      ...describeSinceLastTurn(transcript),
      "Act on the note.",
      'If acting on it turns out to need nothing said here, call room(action="pass") — the wake still did its job.',
    ].join("\n");

    console.log(`[schedules] ${ctx.scheduleId} waking ${agent} in ${roomRef}`);
    let outcome: ScheduledWakeOutcome = "ran";
    await this.onRoomTurn(roomRef, `scheduled:${agent} ${roomRef}`, async () => {
      outcome = await this.runPrompted(sub, prompt, label, "scheduled", fresh);
    });
    return outcome;
  }

  private armPoll(sub: RoomSubscription): void {
    const seconds = sub.pollSeconds ?? this.limits.defaultPollSeconds;
    const key = `${sub.agent} ${sub.roomRef}`;
    const timer = setInterval(() => {
      this.wakeQueue.enqueue({ agent: sub.agent, roomRef: sub.roomRef, trigger: "poll" });
    }, seconds * 1000);
    timer.unref?.();
    this.pollTimers.set(key, timer);
  }

  // -------------------------------------------------------------- dispatch

  /** Push path: a backend reported a new message. */
  async onMessage(msg: RoomMessage): Promise<void> {
    const roomRef = formatRoomRef(msg.room);
    // The push listener is per BACKEND, not per room — one Discord handler
    // receives every channel — so an archived room's traffic still arrives here
    // and has to be dropped explicitly. Before `noteRoomTurn`, so chatter in a
    // retired room does not push a counter that nothing will ever reset.
    if (this.store.isArchived(roomRef)) return;
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
    if (agentTurns === this.readLimits(roomRef).maxAgentTurns + 1) {
      console.log(
        `[rooms] ${roomRef} has run ${agentTurns} agent turns without a human — pausing automatic replies until someone speaks.`,
      );
    }

    for (const sub of subs) {
      const reason = this.wakeReason(sub, enriched, identities, agentTurns);
      if (!reason) {
        // Deliberately NOT advancing the cursor. An agent that did not wake has
        // not SEEN this message, and skipping it here is why an agent could be
        // asked about a conversation it was sitting in and know nothing about
        // it. The cursor is a record of what was shown, not of what went past.
        // Backlog growth is bounded by maxBacklog instead — see fetchBacklog.
        continue;
      }
      this.wakeReasons.set(`${sub.agent} ${sub.roomRef}`, reason);
      this.scheduleWake(sub);
    }
  }

  /** Poll path: check one subscription for anything new. */
  async pollOnce(agent: string, roomRef: string): Promise<void> {
    // Public, and reachable from the startup drain as well as a poll timer, so
    // it carries its own guard rather than trusting every caller to hold one.
    if (this.store.isArchived(roomRef)) return;
    const sub = this.store.getSubscription(agent, roomRef);
    if (!sub || sub.wakeOn === "none") return;

    const messages = await this.fetchBacklog(sub);
    if (messages.length === 0) return;

    const identities = this.identities();
    // The poll timer is autonomous, but what it finds may not be. Deciding on
    // the batch rather than on the timer is what keeps a poll-delivered room
    // answering the owner while paused — gating the timer itself would make
    // `deliver: poll` rooms go silent for humans too, which is the "looks
    // broken rather than paused" failure this design exists to avoid.
    if (this.pausedForMessages(messages, identities)) return;

    const agentTurns = this.store.agentTurns(roomRef);
    const wakeworthy = messages.some((m) => this.shouldWake(sub, m, identities, agentTurns));
    if (!wakeworthy) {
      // Same reasoning as the push path: unread is not the same as unwanted,
      // and this traffic is the context for whatever finally does wake it.
      // Re-reading it each tick is cheap; losing it is not.
      return;
    }
    await this.onRoomTurn(roomRef, `poll:${agent} ${roomRef}`, () => this.runWake(sub));
  }

  /**
   * Collapse a burst into one run. Five messages arriving in two seconds
   * should produce one agent turn that sees all five, not five turns racing
   * each other into the same room.
   */
  private scheduleWake(sub: RoomSubscription): void {
    this.wakeQueue.enqueue({ agent: sub.agent, roomRef: sub.roomRef, trigger: "message" });
  }

  /**
   * An entry came due. The queue decided *when*; this decides *what*.
   *
   * One entry can name several rooms, and they do not all want the same
   * treatment: rooms that opted into batching are collapsed into one turn that
   * reads all of them, and everything else keeps a turn of its own.
   *
   * The subscription is re-read rather than carried on the queue entry: it may
   * have been changed or removed while the entry waited, and acting on a stale
   * copy is how an unsubscribed agent gets one more turn.
   */
  private onWakeDue(entry: WakeEntry): void {
    const targets: Array<{ sub: RoomSubscription; triggers: Set<WakeTrigger> }> = [];
    for (const [roomRef, triggers] of entry.targets) {
      const sub = this.store.getSubscription(entry.agent, roomRef);
      // Re-read rather than carry the subscription on the entry: it may have
      // been changed or removed while the entry waited, and acting on a stale
      // copy is how an unsubscribed agent gets one more turn.
      if (!sub) continue;
      targets.push({ sub, triggers });
    }

    // Rooms whose subscription opted into batching are read together, in one
    // turn. Two is the floor: one room batched with nothing is an ordinary
    // wake wearing a stranger prompt and a worse reply path, so it stays where
    // it was. That is also what makes turning the flag on somewhere harmless —
    // a deployment with a single `batch: true` behaves exactly as before.
    //
    // A room due only for a scheduled check-in is left out on purpose. A
    // check-in is a different kind of turn — nobody said anything, and the
    // prompt is about time passing — and a digest that only runs when something
    // is new would swallow it in exactly the quiet rooms it exists for.
    const batchable = targets.filter((t) => t.sub.batch && (t.triggers.has("message") || t.triggers.has("poll")));
    // Asked whenever any room wanted batching rather than only when two did, so
    // a deployment that set the flag and is not getting batching hears why.
    const allowed = batchable.length > 0 && this.batchingAllowed(entry.agent);
    const combined = allowed && batchable.length >= 2;
    if (combined) {
      const rooms = batchable.map((t) => t.sub.roomRef).join(", ");
      void this.runBatchedWake(
        entry.agent,
        batchable.map((t) => t.sub),
      ).catch((err) => {
        console.error(`[rooms] Batched wake failed for ${entry.agent} over ${rooms}: ${(err as Error).message}`);
      });
    }

    // Everything else still gets a turn per room.
    const batched = new Set(combined ? batchable.map((t) => t.sub.roomRef) : []);
    for (const { sub, triggers } of targets.filter((t) => !batched.has(t.sub.roomRef))) {
      const roomRef = sub.roomRef;
      const key = `${entry.agent} ${roomRef}`;
      // A room that both received a message and came due for a check-in is one
      // turn, not two. Message wins: it has something concrete to answer.
      if (triggers.has("message")) {
        this.dispatchWake(sub, key);
      } else if (triggers.has("poll")) {
        void this.pollOnce(entry.agent, roomRef).catch((err) => {
          console.error(`[rooms] Poll failed for ${key}: ${(err as Error).message}`);
        });
      } else {
        void this.runCheckIn(entry.agent, roomRef).catch((err) => {
          console.error(`[rooms] Check-in failed for ${key}: ${(err as Error).message}`);
        });
      }
    }
  }

  /**
   * May this agent's rooms be read together at all?
   *
   * Only with a per-agent floor under it. The hourly ceiling is a counter on an
   * `(agent, room)` row, and a combined turn is charged to whichever room holds
   * the newest message — so the charged room *rotates*, and an agent batching
   * nine rooms with round-robin traffic gets 12 × 9 = 108 combined turns an hour
   * before any counter refuses. That is a ninefold increase in the runaway
   * ceiling produced by a feature whose entire purpose is lowering wake volume.
   *
   * `minWakeIntervalMinutes` is the only brake that counts an agent rather than
   * a room, and it defaults to 0. So batching without it is refused rather than
   * quietly granted: an operator who wanted fewer wakes and got a higher ceiling
   * instead has been failed silently, which is the worse outcome. The rooms keep
   * their own turns and their own per-room ceilings, exactly as before the flag
   * existed.
   */
  private batchingAllowed(agent: string): boolean {
    if ((this.readLimits().minWakeIntervalMinutes ?? 0) > 0) return true;
    // Once per agent for the life of the process. Repeating it on every wake
    // would bury the log, and re-warning after each config reload would mean
    // re-warning on every membership change, since that re-arms the watcher.
    if (!this.batchWarned.has(agent)) {
      this.batchWarned.add(agent);
      console.warn(
        `[rooms] ${agent} has rooms with "batch: true" but rooms.minWakeIntervalMinutes is 0, so they keep their own turns. ` +
          `A combined turn spans rooms and the hourly ceiling counts one room at a time, so it cannot bound one — ` +
          `set rooms.minWakeIntervalMinutes to enable batching.`,
      );
    }
    return false;
  }

  /**
   * Hand a due wake to the room, taking turns or not.
   *
   * One message naming two agents wakes both. Dispatched concurrently they
   * answer the same question in parallel and neither sees the other, because
   * each prompt is built from the backlog as it stood when the message landed.
   * Chained, the second agent's `fetchBacklog` runs *after* the first has
   * posted, so the reply is ordinary room traffic by the time it is read — the
   * prompt builder needs no changes at all.
   *
   * The chain is per room, not global: two rooms still run in parallel, and an
   * agent slow in one room does not hold up another.
   */
  private dispatchWake(sub: RoomSubscription, key: string): void {
    void this.onRoomTurn(sub.roomRef, `push:${key}`, () =>
      this.runWake(sub).catch((err) => {
        console.error(`[rooms] Wake failed for ${key}: ${(err as Error).message}`);
      }),
    );
  }

  /**
   * Run something on this room's queue.
   *
   * Every path that starts an agent turn for a room goes through here — the
   * push debounce, a poll tick, a scheduled check-in — because turn-taking
   * that covered only one of them would leave the others racing exactly as
   * before. `/room status` is the deliberate exception and calls its runner
   * directly: it is a person asking every agent at once and should answer
   * immediately rather than queue behind whatever the room is doing.
   *
   * `key` is scoped by caller so a poll tick and a push wake for the same
   * agent and room are not mistaken for each other; each path keeps its own
   * coalescing behaviour.
   */
  private onRoomTurn(roomRef: string, key: string, fn: () => Promise<void>): Promise<void> {
    if (this.readLimits(roomRef).turnTaking !== "serial") return fn();

    // Already waiting its turn: drop this trigger rather than queue a second
    // run. The queued one re-fetches the backlog when it starts, so it will
    // pick up whatever arrived in the meantime.
    if (this.queued.has(key)) return Promise.resolve();
    this.queued.add(key);

    const tail = this.roomChains.get(roomRef) ?? Promise.resolve();
    const next = tail.then(() => {
      this.queued.delete(key);
      return fn();
    });
    this.roomChains.set(roomRef, next);
    // Let the map forget a room once its queue drains, so a long-lived
    // deployment does not accumulate a settled promise per room it ever saw.
    void next.finally(() => {
      if (this.roomChains.get(roomRef) === next) this.roomChains.delete(roomRef);
    });
    return next;
  }

  /**
   * Run something on several rooms' queues at once.
   *
   * Each per-room chain is a lock on that room, and a turn spanning N rooms has
   * to hold all N. Acquiring them in a globally agreed order is what stops two
   * agents with overlapping batches deadlocking — one taking eng then ops while
   * the other takes ops then eng, each waiting on a chain the other owns and
   * neither ever finishing.
   *
   * This is the only place that order is decided, and `compareRoomRefs` is the
   * only definition of it. There used to be a second sort in the caller with a
   * different comparator and a comment claiming the two agreed; they did not
   * for mixed-case refs, and either one alone was enough to make the deadlock
   * tests pass, so neither was actually pinned by anything.
   *
   * Nested rather than awaited in parallel, so the rooms are genuinely held for
   * the duration of the turn rather than each released as it is acquired.
   */
  private onRoomTurns(roomRefs: string[], key: string, fn: () => Promise<void>): Promise<void> {
    const ordered = [...new Set(roomRefs)].sort(compareRoomRefs);
    const acquire = (i: number): Promise<void> =>
      i >= ordered.length ? fn() : this.onRoomTurn(ordered[i], key, () => acquire(i + 1));
    return acquire(0);
  }

  /**
   * The wake decision. Kept pure and separate so it can be tested without a
   * database, a backend, or a model.
   */
  shouldWake(sub: RoomSubscription, msg: RoomMessage, identities: IdentityResolver, agentTurns = 0): boolean {
    return this.wakeReason(sub, msg, identities, agentTurns) !== null;
  }

  /**
   * Why this message wakes this agent, or null for "it does not".
   *
   * The reason was always computed and then thrown away, which made wake policy
   * guesswork to debug — an agent woke and you could not tell whether it was
   * named, answering a loose question, or on a timer. Wake policy is where most
   * room misbehaviour starts, so the reason is worth keeping.
   */
  wakeReason(sub: RoomSubscription, msg: RoomMessage, identities: IdentityResolver, agentTurns = 0): WakeReason | null {
    if (sub.wakeOn === "none") return null;

    // Our own account with no resolvable speaker is not a human turn: it is a
    // continuation chunk of a split message, or a plain notifier post. Reading
    // it as human is how one long agent message woke every agent in the room,
    // including its author.
    if (msg.fromSelf && !msg.speaker) return null;

    const label = identities.labelForAgent(sub.agent);

    // Never wake an agent on its own words — the shortest possible loop.
    // Compared through the resolver so an alias counts as the same agent.
    if (speaksAs(msg.speaker, sub.agent, label, identities)) return null;

    // Two agents being polite at each other is not something any single-message
    // rule can catch — every turn is a legitimate reply to a real question. Cap
    // the depth instead: after enough agent-only turns, stop waking until a
    // human says something. Their words still land in the room and are read as
    // context on the next real wake; only the automatic reply stops.
    const speakerIsAgent = msg.speaker ? identities.get(msg.speaker)?.kind === "agent" : false;
    if (speakerIsAgent && agentTurns > this.readLimits(sub.roomRef).maxAgentTurns) {
      return null;
    }

    if (sub.wakeOn === "all") return "all";

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
    if (namedMe) return "named";

    // "named" stops here: nothing but an explicit mention starts a run. This is
    // what keeps a room with three agents in it from producing three answers to
    // one unaddressed question — give the agent that should field loose
    // questions "addressed", and everyone else "named".
    if (sub.wakeOn === "named") return null;

    // An unaddressed message from a human is for whoever is listening; an
    // unaddressed message from another agent is chatter, and answering it is
    // how two agents talk forever.
    return isFromHuman(msg, identities) && msg.to.length === 0 ? "loose-question" : null;
  }

  /**
   * The room's messages as this agent should read them — its own posts
   * condensed, since those are already in its session as the reply it made.
   *
   * Shared by the check-in and scheduled-wake paths, which built the same lines
   * twice and could drift apart.
   */
  private renderTranscript(
    messages: RoomMessage[],
    agent: string,
    label: string,
    identities: IdentityResolver,
  ): string[] {
    return messages.map((m) => {
      const speaker = m.speaker ?? m.authorLabel;
      const body = speaksAs(m.speaker, agent, label, identities) ? condenseOwnLine(m.body) : m.body;
      // An unresolved label is not "no information" — it is the most
      // important case there is. Leaving the marker off there would make
      // its absence meaningful, which is the failure this is fixing.
      return renderTranscriptLine(speaker, m.to, body, identities.get(speaker)?.kind ?? "unknown");
    });
  }

  private async fetchBacklog(sub: RoomSubscription): Promise<RoomMessage[]> {
    const ref = parseRoomRef(sub.roomRef);
    if (!ref) return [];
    const backend = getRoomBackend(ref.backend);
    if (!backend) return [];
    if (this.isQuarantined(sub.roomRef)) return [];

    const limits = this.readLimits(sub.roomRef);
    try {
      let raw = await backend.fetchSince(ref.id, sub.cursor, limits.maxBacklog);

      // A full page means there is probably more after it, and backends answer
      // "since this cursor" with the OLDEST messages first — so in a busy room
      // the very message that woke us could sit past the end of the page. Fall
      // back to the most recent page, which always contains it.
      //
      // The cost of that jump is real and was invisible: everything between the
      // cursor and the newest page is skipped, the cursor then advances past
      // it, and the agent was handed the result under the heading "New
      // messages:" as though it were the whole story. Recorded here so the
      // prompt can say what happened. Keyed by room, written immediately before
      // the prompt that reads it, and per-room turns are chained — so the value
      // cannot be another room's.
      if (raw.length >= limits.maxBacklog) {
        raw = await backend.fetchSince(ref.id, null, limits.maxBacklog);
        this.skippedAhead.add(sub.roomRef);
      } else {
        this.skippedAhead.delete(sub.roomRef);
      }

      this.noteRoomReachable(sub.roomRef);
      const identities = this.identities();
      return raw.map((m) => enrichRoomMessage(m, identities));
    } catch (err) {
      this.noteRoomUnreachable(sub.roomRef, err as Error);
      throw err;
    }
  }

  // ----------------------------------------------------------- unreachable

  /**
   * Stop hammering a room that is not there.
   *
   * A ref pointing at a deleted channel fails on every poll, every push and
   * every catch-up, forever — observed as the same "Discord channel … not
   * found" for three agents, once per pass, with nothing that would ever make
   * it stop. Each attempt is a wasted round trip and another identical line in
   * the log.
   *
   * Counted rather than pattern-matched, because "is this error permanent?" is
   * not answerable from an error message and guessing it wrong is how a
   * five-minute outage becomes a room nobody is watching. Repeated failure is
   * the signal; the response is to back off, not to unsubscribe anyone. If the
   * channel comes back, the next attempt after the quiet period picks it up
   * and says so.
   */
  private roomFailures = new Map<string, { count: number; quietUntil: number }>();

  /**
   * Rooms whose last read had to jump to the newest page, skipping messages.
   * Read by the wake prompt so the heading can be honest about it.
   */
  private skippedAhead = new Set<string>();

  /** Whether the last read of this room skipped ahead, for the prompt builder. */
  private didSkipAhead(roomRef: string): boolean {
    return this.skippedAhead.has(roomRef);
  }

  /** Resolved cross-room-view settings, read per call because config hot-reloads. */
  private crossRoomSettings(): { enabled: boolean; messages: number; floorPerRoom: number; cacheMs: number } {
    const cfg = this.runtime.getConfig().rooms?.crossRoomView;
    return {
      enabled: cfg?.enabled === true,
      messages: Math.max(1, cfg?.messages ?? 24),
      floorPerRoom: Math.max(1, cfg?.floorPerRoom ?? 2),
      cacheMs: Math.max(0, cfg?.cacheSeconds ?? 60) * 1000,
    };
  }

  /**
   * The most recent lines in one room, cached.
   *
   * `fresh` skips the cache, which the room being answered always wants. The
   * others tolerate a slice up to `cacheSeconds` old: they exist to remind the
   * agent that a conversation is open, and a slightly stale reminder is worth
   * far more than a round trip per room per turn.
   */
  private async roomSlice(roomRef: string, limit: number, fresh: boolean): Promise<string[]> {
    const { cacheMs } = this.crossRoomSettings();
    const hit = this.roomSliceCache.get(roomRef);
    if (!fresh && hit && Date.now() - hit.at < cacheMs) return hit.lines.slice(-limit);

    const ref = parseRoomRef(roomRef);
    if (!ref) return [];
    const backend = getRoomBackend(ref.backend);
    if (!backend || this.isQuarantined(roomRef)) return hit?.lines.slice(-limit) ?? [];

    try {
      // Deliberately from a null cursor, not the subscription's: this is a
      // view of what is there, not a claim about what is unread, and it must
      // never advance a cursor — that is the read path's job alone.
      const raw = await backend.fetchSince(ref.id, null, Math.max(limit, this.crossRoomSettings().floorPerRoom));
      const identities = this.identities();
      const lines = raw.map((m) => {
        const e = enrichRoomMessage(m, identities);
        const who = e.speaker ?? e.authorLabel;
        return renderTranscriptLine(who, e.to, e.body, identities.get(who)?.kind ?? "unknown");
      });
      this.roomSliceCache.set(roomRef, { at: Date.now(), lines });
      return lines.slice(-limit);
    } catch {
      // One unreachable room must not blank the whole view.
      return hit?.lines.slice(-limit) ?? [];
    }
  }

  /**
   * Every room this agent watches, as one block, with the room it is answering
   * in marked and placed first.
   *
   * Floors are paid before the remainder so a busy room cannot crowd out a
   * quiet one, and the current room takes what is left rather than a fixed
   * share — it is the conversation actually in progress.
   */
  private async buildCrossRoomView(agent: string, currentRoomRef: string): Promise<string | null> {
    const { enabled, messages, floorPerRoom } = this.crossRoomSettings();
    if (!enabled) return null;

    const subs = this.store
      .listSubscriptionsForAgent(agent)
      .filter((s) => !this.store.getRoomByRef(s.roomRef)?.archivedAt);
    if (subs.length < 2) return null; // one room is not a "cross-room" view

    const others = subs.filter((s) => s.roomRef !== currentRoomRef);
    const spentOnFloors = others.length * floorPerRoom;
    const hereLimit = Math.max(floorPerRoom, messages - spentOnFloors);

    const sections: string[] = [];
    const hereName = this.store.getRoomByRef(currentRoomRef)?.name ?? currentRoomRef;
    const here = await this.roomSlice(currentRoomRef, hereLimit, true);
    if (here.length) sections.push(`## ${hereName} — you are here\n${here.join("\n")}`);

    for (const sub of others) {
      const room = this.store.getRoomByRef(sub.roomRef);
      if (!room) continue;
      const lines = await this.roomSlice(sub.roomRef, floorPerRoom, false);
      if (!lines.length) continue;
      sections.push(`## ${room.name}\n${lines.join("\n")}`);
    }

    if (sections.length < 2) return null; // nothing the wake prompt does not already say
    return sections.join("\n\n");
  }

  private isQuarantined(roomRef: string): boolean {
    const entry = this.roomFailures.get(roomRef);
    return entry !== undefined && entry.quietUntil > Date.now();
  }

  private noteRoomUnreachable(roomRef: string, err: Error): void {
    const entry = this.roomFailures.get(roomRef) ?? { count: 0, quietUntil: 0 };
    entry.count += 1;
    if (entry.count >= ROOM_FAILURE_LIMIT) {
      entry.quietUntil = Date.now() + ROOM_QUARANTINE_MS;
      console.error(
        `[rooms] ${roomRef} has failed ${entry.count} times in a row (${err.message}). ` +
          `Pausing reads for ${Math.round(ROOM_QUARANTINE_MS / 60_000)} minutes. ` +
          `If the channel is gone, remove the room; subscriptions are left alone.`,
      );
      entry.count = 0;
    }
    this.roomFailures.set(roomRef, entry);
  }

  private noteRoomReachable(roomRef: string): void {
    const entry = this.roomFailures.get(roomRef);
    if (!entry) return;
    if (entry.quietUntil > 0) console.log(`[rooms] ${roomRef} is reachable again.`);
    this.roomFailures.delete(roomRef);
  }

  // ------------------------------------------------------------------- run

  /**
   * Should this batch of room traffic be refused because agents are paused?
   *
   * The discriminator is who spoke, not what woke us. Under the default scope
   * a human in the batch means someone is waiting on an answer and the run
   * goes ahead; an all-agent batch is the chatter loop and stops. Under
   * `scope: all` nothing wakes.
   */
  private pausedForMessages(messages: RoomMessage[], identities: IdentityResolver): boolean {
    if (this.runtime.isAgentsPaused("human")) return true;
    if (!this.runtime.isAgentsPaused("autonomous")) return false;
    return !messages.some((m) => isFromHuman(m, identities));
  }

  /**
   * Which of these rooms a combined turn may still read while agents are
   * paused.
   *
   * The same rule as `pausedForMessages`, applied per room rather than to the
   * batch as a whole — and that difference is the whole point. Asked once over
   * every message in the batch, "is anyone human here?" answers yes if a person
   * is waiting in *any* room, which un-pauses all the others: room B, whose
   * traffic is nothing but two agents talking to each other, gets rendered into
   * the prompt as a section and the agent is explicitly invited to post there.
   * That is the runaway the switch exists to stop, arriving through the feature
   * meant to reduce wake volume.
   *
   * A human waiting in one room licenses a turn about that room. The rooms that
   * lose their section keep their cursors and are read whenever the pause lifts
   * or a person says something in them.
   */
  private roomsAllowedWhilePaused(sections: BatchSection[], identities: IdentityResolver): BatchSection[] {
    if (this.runtime.isAgentsPaused("human")) return [];
    if (!this.runtime.isAgentsPaused("autonomous")) return sections;
    return sections.filter((s) => s.messages.some((m) => isFromHuman(m, identities)));
  }

  private async runWake(sub: RoomSubscription): Promise<void> {
    // The queue holds one entry per agent naming several rooms, and an entry
    // can outlive an archive that happened after it was enqueued. Checked at
    // fire time as well as at arm time, so nothing already in flight slips
    // through and charges a wake against a retired room.
    if (this.store.isArchived(sub.roomRef)) return;

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

      // The backstop for every wake path — push, poll, debounce, and the
      // hourly-ceiling retry all land here. A batch with a human in it is a
      // person waiting for an answer; a batch of only agents is two agents
      // talking to each other, which is the run that cost $4 in twenty
      // minutes and the reason this switch exists.
      if (this.pausedForMessages(messages, this.identities())) return;

      // Budget is charged only once there is real work. Charging before the
      // backlog check let an empty wake burn one of twelve hourly slots.
      const limits = this.readLimits(fresh.roomRef);
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
      const prompt = this.buildPrompt(
        fresh,
        messages,
        room?.name ?? fresh.roomRef,
        label,
        identities,
        room?.purpose,
        fresh.role ?? undefined,
      );

      const reason = this.wakeReasons.get(key) ?? (fresh.wakeOn === "all" ? "all" : "named");
      this.wakeReasons.delete(key);
      await this.runTurn(fresh, prompt, label, { messages, reason });
    } finally {
      this.running.delete(key);
      if (this.pending.delete(key)) this.scheduleWake(sub);
    }
  }

  /**
   * One turn for several rooms at once.
   *
   * The per-room path answers each room in isolation, which is right for an
   * agent watching one busy room and wrong for one watching nine quiet ones: it
   * runs nine model turns, each blind to the other eight, and each costing a
   * wake. A person with nine channels open does not get interrupted nine times;
   * they look at what accumulated and decide what to do.
   *
   * What it costs, said plainly: the agent no longer gets a reply destination
   * for free. Anything it wants to say has to name a room through the tool, and
   * text that names none is dropped rather than guessed at.
   */
  private runBatchedWake(agent: string, subs: RoomSubscription[]): Promise<void> {
    // Drop archived rooms before anything locks or reads them, the same way the
    // pause switch drops rooms holding only agent traffic. Their cursors stay
    // put, so unarchiving hands the agent what it missed rather than nothing.
    subs = subs.filter((s) => !this.store.isArchived(s.roomRef));
    if (subs.length === 0) return Promise.resolve();

    // Lock order belongs to onRoomTurns and is decided there; the rooms are
    // handed over in the order they were named, and the prompt's sections
    // follow that.
    //
    // The key is unique per attempt on purpose. A shared `batch:<agent>` key
    // meant a second batch arriving while the first was between locks hit the
    // queue's dedupe at the first room and vanished whole — no turn, nothing
    // marked pending, and quite possibly rooms the in-flight batch never
    // covered. Two attempts overlapping is handled where it can be handled
    // correctly: runBatchedTurn holds the per-room in-flight guard, and the
    // second attempt re-reads the backlog and returns before charging anything
    // if the first already read it.
    const key = `batch:${agent}#${++this.batchSeq}`;
    return this.onRoomTurns(
      subs.map((s) => s.roomRef),
      key,
      () => this.runBatchedTurn(agent, subs),
    );
  }

  /** The body of a combined wake, once every room it covers is held. */
  private async runBatchedTurn(agent: string, subs: RoomSubscription[]): Promise<void> {
    const keys = subs.map((s) => `${agent} ${s.roomRef}`);
    // The same in-flight guard the per-room path uses, over every room in the
    // batch, so a combined turn and a solo one can never work the same room at
    // once. Triggers are held rather than dropped: whichever run finishes first
    // re-schedules them, and a re-armed wake that finds nothing new returns
    // before it charges anything.
    if (keys.some((k) => this.running.has(k))) {
      for (const k of keys) this.pending.add(k);
      return;
    }
    for (const k of keys) this.running.add(k);

    try {
      const identities = this.identities();
      const sections: BatchSection[] = [];
      for (const stale of subs) {
        // Re-read: a cursor may have moved while the entry waited.
        const sub = this.store.getSubscription(agent, stale.roomRef) ?? stale;
        try {
          const messages = await this.fetchBacklog(sub);
          if (messages.length === 0) continue;
          sections.push({ sub, room: this.store.getRoomByRef(sub.roomRef), messages });
        } catch (err) {
          // One unreachable transport must not blank out the other rooms. The
          // same call `readAll` makes, for the same reason.
          console.warn(`[rooms] Could not read ${sub.roomRef} for ${agent}: ${(err as Error).message}`);
        }
      }
      if (sections.length === 0) return;

      // The pause switch, applied room by room rather than to the batch as a
      // whole — and this order matters, because everything below reads `live`.
      const live = this.roomsAllowedWhilePaused(sections, identities);
      if (live.length === 0) return;

      // At least one room has to hold something the wake policy would have
      // woken this agent for. Otherwise a poll tick — which enqueues on its
      // timer, unconditionally — would turn any unread chatter anywhere in the
      // batch into a model turn, and batching would *raise* wake volume, which
      // is the opposite of the point. This is the check `pollOnce` already
      // makes, applied across the batch rather than to one room.
      //
      // Kept as the set of rooms rather than a yes/no, because the transcript
      // budget needs to know which rooms are the reason this turn is running.
      // The rest of the traffic still gets shown: what does not deserve a wake
      // on its own is exactly the context that makes the room that does
      // deserve one legible.
      const triggering = new Set(
        live
          .filter((s) => {
            const agentTurns = this.store.agentTurns(s.sub.roomRef);
            return s.messages.some((m) => this.shouldWake(s.sub, m, identities, agentTurns));
          })
          .map((s) => s.sub.roomRef),
      );
      // Cursors stay where they are, so nothing is lost — this traffic is
      // re-read on the next wake, and is the context for it.
      if (triggering.size === 0) return;

      // One wake for one model turn, charged to the room with the newest
      // message — the one that most plausibly triggered this. Charging every
      // room would spend N slots on a single turn and starve the quiet rooms
      // fastest, which is exactly backwards.
      //
      const label = identities.labelForAgent(agent);
      const { prompt, shown } = this.buildBatchedPrompt(agent, label, live, identities, triggering);
      const covered = live.filter((s) => shown.has(s.sub.roomRef));

      // The ceiling is one atomic UPDATE on an (agent, room) row, so it cannot
      // express "this agent ran once" at all. The real ceiling for a batching
      // deployment is the per-agent `rooms.minWakeIntervalMinutes`, which is why
      // batching refuses to run without one — see batchingAllowed. This stays a
      // backstop, and an honest one only for the room it charges.
      //
      // Charged *after* the prompt is built, and only against a room the prompt
      // actually covers. Choosing it beforehand meant the newest-message room
      // won — and once a triggering room is guaranteed a slot, the newest room
      // need not be in the prompt at all. A quiet room would then spend its
      // hourly budget on turns that never read it, which is the opposite of
      // what the counter is for.
      const primary = covered.reduce((a, b) => (newestMessageAt(b.messages) > newestMessageAt(a.messages) ? b : a));
      const limits = this.readLimits(primary.sub.roomRef);
      if (!this.store.tryConsumeWake(agent, primary.sub.roomRef, limits.maxWakesPerHour)) {
        console.warn(
          `[rooms] ${agent} hit its wake ceiling for ${primary.sub.roomRef} (${limits.maxWakesPerHour}/hour), holding its combined wake over ${live.map((s) => s.sub.roomRef).join(", ")}. Traffic accumulates and is read on the next allowed wake.`,
        );
        // Every room, not just the primary: one retry would re-arm a single
        // room, and a batch of one falls back to the per-room path. Their
        // timers all fire in the same tick, so the queue merges them back into
        // one entry.
        for (const section of live) this.retryAfterHour(section.sub);
        return;
      }

      // One event per room, not one for the batch: a subscriber asking "was
      // this room read?" wants the same answer whether or not the deployment
      // batches.
      //
      // Emitted over what was *shown*, and after the prompt is built, because
      // that is the only point at which the answer is known. Announcing every
      // section would report a room as woken — with a full message count — while
      // the transcript budget had squeezed it out of the prompt entirely and its
      // cursor was deliberately left alone. Same rule as the cursor: shown is
      // read, and nothing else is.
      for (const section of covered) {
        this.runtime.events?.emit("room.woke", {
          roomRef: section.sub.roomRef,
          agent,
          messageCount: shown.get(section.sub.roomRef)?.length ?? 0,
        });
      }

      // The activity record can only name one reason, so it names the primary
      // room's — the same room the wake was charged to.
      const primaryKey = `${agent} ${primary.sub.roomRef}`;
      const reason = this.wakeReasons.get(primaryKey) ?? (primary.sub.wakeOn === "all" ? "all" : "named");
      for (const sub of subs) this.wakeReasons.delete(`${agent} ${sub.roomRef}`);

      await this.runTurn(primary.sub, prompt, label, {
        reason,
        batch: {
          subs: covered.map((s) => s.sub),
          shown,
          names: covered.map((s) => s.room?.name ?? s.sub.roomRef),
        },
      });
    } finally {
      for (const key of keys) this.running.delete(key);
      for (const sub of subs) {
        if (this.pending.delete(`${agent} ${sub.roomRef}`)) this.scheduleWake(sub);
      }
    }
  }

  /**
   * Run one agent against one prompt and put whatever it says into the room.
   *
   * Every way an agent can be woken ends up here — a message that named it, a
   * scheduled check-in, someone running `/room status`. They used to end up in
   * two places: the wake path grew the malformed-`pass` correction and the tool
   * activity record, and the prompted path silently did not, so the same reply
   * behaved differently depending on what had triggered it. Nobody would ever
   * choose that; it is just what happens when a second caller is added by copy.
   */
  private async runTurn(
    sub: RoomSubscription,
    prompt: string,
    label: string,
    opts: { messages?: RoomMessage[]; reason?: WakeReason; batch?: BatchedTurn } = {},
  ): Promise<void> {
    const { messages, reason, batch } = opts;
    // Every room this turn covers. One for an ordinary wake; the whole batch
    // for a combined one, and `sub` is then only the room it was charged to.
    const rooms = batch ? batch.subs.map((s) => s.roomRef) : [sub.roomRef];
    // Built here, the one choke point every wake path shares — the poll, push,
    // check-in, scheduled and batched paths all end up in this method, and
    // hooking any subset of them is how a feature ends up working for check-ins
    // and not for messages. Built rather than rendered because a slot renders
    // synchronously and this reads the backends; stashed for the slot to pick
    // up, so it lands behind the history and never enters the record.
    const view = await this.buildCrossRoomView(sub.agent, sub.roomRef);
    if (view) this.crossRoomView.set(sub.agent, view);
    const config = this.runtime.getConfig();
    const resolved = resolveAgent(
      sub.agent,
      config,
      this.runtime.getResolvableTools(),
      undefined,
      this.runtime.contextDir,
    );
    const session = findOrCreateSession(
      this.runtime.db,
      // A combined turn has no single room, so a per-room session key would
      // file a cross-room conversation under whichever room happened to be
      // primary — and the next wake, with a different primary, would not find
      // it. Shared is the only key that describes what this turn is.
      makeRoomSessionKey(sub.roomRef, sub.agent, batch ? "shared" : resolved.roomSessionScope),
      resolved.model,
      resolved.provider,
    );

    const base = this.runtime.buildLoopOptions({ agentName: sub.agent, session });
    // Spread rather than replace: buildLoopOptions puts agentName in here,
    // and dropping it is how task-watcher lost tool attribution.
    const workingMemory = new Map<string, string>();
    // Which rooms this turn is about. `room(action="pass")` with no argument
    // reads it, so declining to speak silences exactly the rooms the agent was
    // woken for rather than every room in the deployment.
    workingMemory.set(WAKE_ROOMS_KEY, rooms.join(","));
    let reply = "";
    // Whether this turn did anything, as opposed to only talking. Decides
    // whether it counts toward the conversation-depth cap.
    let usedTools = false;
    const changed: string[] = [];
    const activity: string[] = [];
    if (reason && this.readLimits().toolActivity !== "none") {
      activity.push(`woke: ${describeWakeReason(reason)}`);
    }
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
      const skipped = batch ? [...batch.shown.values()].reduce((n, seen) => n + seen.length, 0) : messages?.length;
      console.error(
        `[rooms] ${sub.agent} failed on ${rooms.join(", ")}: ${(err as Error).message}` +
          (skipped ? ` — skipping past ${skipped} message(s).` : "."),
      );
      this.advanceShownCursors(sub, messages, batch);
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
    //
    // A combined turn adds a third: text with no room named. There is no
    // destination to fall back on, so the same round that recovers malformed
    // output is spent asking which room it was for.
    const passed = rooms.some((ref) => workingMemory.get(`room:passed:${ref}`) === "true");
    const spokeThroughTool = rooms.some((ref) => workingMemory.get(roomPostedKey(ref)) === "true");
    const correction = looksLikeUninvokedPass(reply)
      ? batch
        ? this.batchCorrection(batch, "Your last message was posted as text rather than made as a tool call.")
        : 'Your last message was not a valid tool call — it was posted as text. If you meant to stay quiet, call the room tool with action "pass". Otherwise reply normally with what you want to say.'
      : looksLikeRawToolCall(reply)
        ? batch
          ? this.batchCorrection(
              batch,
              "Your last message came out as raw tool-call markup rather than a tool call, so nothing was sent.",
            )
          : "Your last message came out as raw tool-call markup rather than a tool call, so nothing was sent. Say what you wanted to say as plain text — you are already in the room, and a reply does not need a tool call."
        : batch && reply.trim().length > 0 && !spokeThroughTool && !passed
          ? this.batchCorrection(batch, "A message needs one of them, so nothing has been sent yet.")
          : passed && changed.length > 0
            ? `You changed ${changed.join(", ")} since your last message but chose to say nothing. Are you sure? Reply with a short update if it is worth reporting, or pass again if it genuinely is not.`
            : undefined;

    if (correction) {
      for (const ref of rooms) workingMemory.delete(`room:passed:${ref}`);
      try {
        reply = await runAgentLoop(correction, {
          ...base,
          toolContextExtras: { ...base.toolContextExtras, workingMemory },
        });
      } catch (err) {
        console.warn(`[rooms] Correction round failed for ${sub.agent}: ${(err as Error).message}`);
      }
    }

    // Both model calls are done. Dropped here rather than left to the next turn
    // to overwrite: an agent whose next wake builds no view (config turned off,
    // a room archived down to one) would otherwise keep rendering this one.
    this.crossRoomView.delete(sub.agent);

    // A turn that did real work is progress, not chatter, so it must not
    // push the room toward the depth cap. Without this, agents collaborating
    // on a task — researching, writing files, handing off — get silenced
    // mid-task exactly like two agents saying "thanks" at each other.
    //
    // Only the rooms this turn actually spoke in, though. `agent_turns` counts
    // one room's conversation, so clearing it across a batch would let a tool
    // call in room A wipe the anti-chatter brake in room B where two agents are
    // looping — a brake released by a turn that room never saw. The
    // `room:posted:` markers are the record of where it spoke. The single-room
    // path posts after this point, so it keeps its one room unconditionally,
    // exactly as before.
    if (usedTools) {
      const spokeIn = batch ? rooms.filter((ref) => workingMemory.get(roomPostedKey(ref)) === "true") : rooms;
      for (const ref of spokeIn) this.store.resetAgentTurns(ref);
    }

    this.advanceShownCursors(sub, messages, batch);

    // A combined turn has no single destination, so text that named no room is
    // not posted anywhere — and with no message of ours to hang it under, the
    // tool-activity record has nowhere to go either. Worth knowing before
    // turning `toolActivity` on alongside batching.
    let posted: RoomMessage | null = null;
    if (batch) {
      this.dropUnroutedReply(sub.agent, batch, reply, workingMemory);
    } else {
      posted = await this.deliverReply(sub, reply, label, workingMemory, messages ?? []);
    }
    // Attached underneath the reply, so the room reads as conversation and
    // the record of what was actually done is one click away. Without this
    // you can only infer an agent's actions from its own account of them,
    // which is exactly the account that can be wrong.
    if (posted && activity.length > 0) await this.attachActivity(sub, posted, label, activity);

    // Nothing said and nothing done: the wake cost the room nothing, so it
    // should not cost the agent its place in the room for the next hour.
    //
    // "Said" has to cover both routes into a room, and for a long time it did
    // not. `deliverReply` returns null when the agent posted through the `room`
    // tool — it stands down precisely *because* the message is already there —
    // and `usedTools` deliberately excludes the whole `room` tool so that
    // `pass` reads as silence. A turn whose only call was `room(action="post")`
    // therefore looked silent on both counts and was handed its wake back: it
    // spoke, it armed the next agent's wake, and it paid nothing. That made the
    // documented way to speak — the only way to address someone, set `notify`,
    // or post to a room you did not wake in — the one way that was free, and
    // left `maxWakesPerHour` disengaged for exactly the agent-to-agent traffic
    // it exists to bound.
    //
    // Any successful post counts, not just one in `rooms`: the refund's safety
    // argument is that a silent agent produces no incoming message and so
    // cannot feed itself another wake. An agent that posted anywhere is not
    // silent. The marker is only set once the backend call returns, so a
    // notification-gate suppression still reads as silence, correctly.
    //
    // Re-read here rather than reusing `spokeThroughTool` above, because the
    // correction round may have produced a post since.
    const said =
      posted !== null ||
      [...workingMemory].some(([key, value]) => key.startsWith(ROOM_POSTED_PREFIX) && value === "true");
    if (!said && !usedTools) this.store.refundWake(sub.agent, sub.roomRef);
  }

  /**
   * The one correction a combined turn can give, whatever went wrong.
   *
   * Every route out of a batched turn is the same route: name a room or pass.
   * The single-room branches correct toward plain text — "you are already in the
   * room, a reply does not need a tool call" — which is true there and actively
   * wrong here, because plain text in a combined turn names no room and is
   * dropped. An agent told to reply as text and then ignored for doing so has
   * been given a round to fail in.
   */
  private batchCorrection(batch: BatchedTurn, problem: string): string {
    const n = batch.names.length;
    return (
      `This turn covers ${n} ${n === 1 ? "room" : "rooms"}: ${batch.names.join(", ")}. ${problem} ` +
      `Send it with room(action="post", room="<one of those names>", body="…"), once per room you want to answer, ` +
      `or call room(action="pass") to stay quiet in all of them.`
    );
  }

  /**
   * Move each covered room's cursor to the last message it was shown.
   *
   * The rule is the same one the per-room path has always followed: the cursor
   * records what was *shown*, not what was acted on, so an agent is never asked
   * about a conversation it was never given. Deliberately NOT advanced past its
   * own reply — anything that arrived mid-run sits between the two, and jumping
   * to the reply's cursor would skip it permanently.
   *
   * A room the transcript budget squeezed out entirely is absent from `shown`,
   * keeps its cursor, and is read on the next wake.
   */
  private advanceShownCursors(sub: RoomSubscription, messages?: RoomMessage[], batch?: BatchedTurn): void {
    if (batch) {
      for (const [roomRef, seen] of batch.shown) {
        this.store.advanceCursor(sub.agent, roomRef, seen[seen.length - 1].cursor);
      }
      return;
    }
    if (messages?.length) {
      this.store.advanceCursor(sub.agent, sub.roomRef, messages[messages.length - 1].cursor);
    }
  }

  /**
   * What becomes of a combined turn's closing text.
   *
   * A single-room wake posts it: there is exactly one place it could be for. A
   * combined turn has several, and picking one would put words in a channel the
   * agent did not choose — the failure that is hardest to spot from the outside
   * and worst to explain afterwards. The agent has already had its correction
   * round naming the rooms, so text arriving here is the second miss: say so in
   * the log and drop it. Honest failure beats a plausible message in the wrong
   * channel.
   */
  private dropUnroutedReply(
    agent: string,
    batch: BatchedTurn,
    reply: string,
    workingMemory: Map<string, string>,
  ): void {
    const body = (reply ?? "").trim();
    if (!body) return;
    // The agent said its piece through the tool, or chose silence. Either way
    // the closing text is commentary on a decision already made.
    if (batch.subs.some((s) => workingMemory.get(roomPostedKey(s.roomRef)) === "true")) return;
    if (batch.subs.some((s) => workingMemory.get(`room:passed:${s.roomRef}`) === "true")) return;
    if (looksLikeUninvokedPass(body)) return;
    console.warn(
      `[rooms] ${agent} answered a combined wake over ${batch.names.join(", ")} with text naming no room, twice. Not posted: ${body.slice(0, 160)}`,
    );
  }

  /**
   * Ask every agent in a room what it is working on.
   *
   * Each agent is woken directly rather than by posting a synthetic "alex
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
        todayLine(),
        `${askedBy} asked everyone here for a status update.`,
        "",
        "Reply with what you are working on right now, in one or two sentences.",
        'If you have nothing in flight, say so plainly — do not invent work. Use room(action="pass") only if someone else has already answered for you.',
      ].join("\n");

      // Deliberately not awaited: a status round-up runs several models, and
      // the slash command should answer immediately rather than hold the
      // interaction open for a minute.
      void this.runPrompted(sub, prompt, label, "asked").catch((err) => {
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
  private async runPrompted(
    sub: RoomSubscription,
    prompt: string,
    label: string,
    reason: WakeReason,
    messages?: RoomMessage[],
  ): Promise<ScheduledWakeOutcome> {
    const key = `${sub.agent} ${sub.roomRef}`;
    // Both refusals are temporary — the turn in flight will end, and the hourly
    // allowance resets — so they report `at-ceiling`, which the scheduler
    // retries. Only the caller that can act on that distinction reads it; the
    // status-update path ignores the return as before.
    if (this.running.has(key)) return "at-ceiling";

    const limits = this.readLimits(sub.roomRef);
    if (!this.store.tryConsumeWake(sub.agent, sub.roomRef, limits.maxWakesPerHour)) {
      console.warn(`[rooms] ${sub.agent} is at its wake ceiling; skipping this turn (${describeWakeReason(reason)}).`);
      return "at-ceiling";
    }

    this.running.add(key);
    try {
      // Handing the messages down is what advances the cursor. Without it a
      // timed wake read the room and left it looking unread, so the next one
      // re-read the same messages — for ever, into the same session.
      await this.runTurn(sub, prompt, label, { reason, messages });
    } finally {
      this.running.delete(key);
    }
    return "ran";
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
    // Raw tool-call markup that survived its correction round. Suppressed
    // rather than posted — `<parameter=body>` in a channel is noise a person
    // has to decode — but logged, not swallowed: the agent tried to say
    // something and failed, and that is worth being able to find out about.
    if (looksLikeRawToolCall(body)) {
      console.warn(
        `[rooms] ${sub.agent} produced tool-call markup instead of a message in ${sub.roomRef}, twice. Not posted: ${body.slice(0, 160)}`,
      );
      return null;
    }
    if (workingMemory.get(roomPostedKey(sub.roomRef)) === "true") return null;
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
        // An automatic reply never pings. It is a turn in a conversation the
        // person will read when they look; if an agent actually needs them it
        // says so through `room(action="post", notify=true)`.
        posted = await backend.post(ref.id, { body: spoken, speaker: label, to, notify: false });
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
    role?: string,
  ): string {
    const lines = messages.map((m) => {
      const speaker = m.speaker ?? m.authorLabel;
      const body = speaksAs(m.speaker, sub.agent, label, identities) ? condenseOwnLine(m.body) : m.body;
      // An unresolved label is not "no information" — it is the most
      // important case there is. Leaving the marker off there would make
      // its absence meaningful, which is the failure this is fixing.
      return renderTranscriptLine(speaker, m.to, body, identities.get(speaker)?.kind ?? "unknown");
    });

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
      `Room "${roomName}". You are ${label}. ${todayLine()}`,
      // The room's standing instructions. First line, before the transcript,
      // because it frames everything below it.
      ...(purpose ? [`Purpose: ${purpose}`] : []),
      // What this agent is for HERE, under what the room is for. An agent that
      // coordinates a trip and reviews code is not the same agent in both
      // rooms, and only its global instructions existed before.
      ...(role ? [`Your role here: ${role}`] : []),
      "",
      ...(this.didSkipAhead(sub.roomRef)
        ? [
            // Honest about the jump rather than presenting the newest page as
            // the whole story. No count: the number skipped is not known
            // without another round trip, and inventing one would be worse
            // than saying plainly that there is a gap.
            `This room moved faster than the last ${this.readLimits(sub.roomRef).maxBacklog} messages, so some between your last turn and these were skipped.`,
            "Most recent messages:",
          ]
        : ["New messages:"]),
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
      //
      // The fourth case was added after a scenario benchmark caught the
      // enumeration being read as exhaustive. Given "coffee machine's broken
      // again" from one person to nobody in particular, both models tested
      // replied, because an interested follow-up is not acknowledging, agreeing
      // or thanking — by the letter of the old wording they were right.
      //
      // Deliberately still a list of cases and not "reply only when relevant".
      // The general permission is the phrasing that gets over-taken, and the
      // benchmark's two controls — a direct question, and a loose question from
      // a person — are there to catch it if this drifts that way.
      //
      // Measured at n=8 per cell, one model, same provider, wording the only
      // variable:
      //
      //                                       before   after
      //   passes on social chatter              0/8     4/8
      //   ditto, room purpose silent            0/8     3/8
      //   ditto, room purpose says to pass      1/8     8/8   <- the real find
      //   answers a loose question (control)    8/8     5/8   <- the real cost
      //   answers a direct question (control)   8/8     8/8
      //
      // The third row is the argument: a room whose `purpose` explicitly said to
      // stay out of chatter was overridden seven times in eight, so this sentence
      // was not merely under-specified, it was beating the room's own stated norm.
      //
      // The fourth row is the price, and it is not nothing — an unanswered
      // question from a person costs more than one unnecessary reply about a
      // coffee machine. A second wording that dropped "nor addressed to you" was
      // tried to recover it and came out worse on every chatter row without
      // moving the control, so this is the better of two known options and not a
      // settled one.
      'If you have nothing to add — you would only be acknowledging, agreeing, or thanking someone, or the message is chatter that is neither about your work nor addressed to you — call room(action="pass") instead of replying.',
    ].join("\n");
  }

  /**
   * The wake prompt for several rooms at once.
   *
   * Shaped like the `readAll` digest the room tool already produces, because
   * that is the shape an agent has seen before: a `## room` section per room
   * with something in it, and nothing at all for the rest. An empty heading is
   * not neutral — it is a line inviting an answer to a room that asked nothing.
   *
   * Returns what it actually showed alongside the text. The budget decides
   * which rooms make it in, and the cursor rule is "advance what was shown", so
   * the caller cannot work that out for itself without repeating the
   * allocation.
   */
  private buildBatchedPrompt(
    agent: string,
    label: string,
    sections: BatchSection[],
    identities: IdentityResolver,
    mustInclude: Iterable<string> = [],
  ): { prompt: string; shown: Map<string, RoomMessage[]> } {
    const render = (m: RoomMessage): string => {
      const speaker = m.speaker ?? m.authorLabel;
      const body = speaksAs(m.speaker, agent, label, identities) ? condenseOwnLine(m.body) : m.body;
      // An unresolved label is not "no information" — it is the most
      // important case there is. Leaving the marker off there would make
      // its absence meaningful, which is the failure this is fixing.
      return renderTranscriptLine(speaker, m.to, body, identities.get(speaker)?.kind ?? "unknown");
    };

    // Built before the allocation rather than after it, so the budget can be
    // charged for them. The heading, purpose and role are as real as the
    // transcript they frame — purposes are free-text config, and nine rooms of
    // them used to arrive outside the budget entirely, which made the one hard
    // total this design turns on a total over only part of the prompt.
    const framing = new Map<string, string[]>();
    for (const section of sections) {
      framing.set(section.sub.roomRef, [
        // The registered name, because that is the string `room="…"` takes.
        `## ${section.room?.name ?? section.sub.roomRef}`,
        // Same two framing lines as a single-room wake, for the same reason:
        // the purpose says what the room is for, the role says what this
        // agent is for in it, and both belong above the transcript they
        // frame. Participants are left out — nine rooms' rosters is a lot of
        // prompt, and naming someone who is not there is answered by the
        // tool, which lists the room's participants when it rejects a name.
        ...(section.room?.purpose ? [`Purpose: ${section.room.purpose}`] : []),
        ...(section.sub.role ? [`Your role here: ${section.sub.role}`] : []),
      ]);
    }

    const shown = selectBatchTranscript(
      sections.map((s) => ({
        roomRef: s.sub.roomRef,
        messages: s.messages,
        framing: estimateTokens({ role: "user", content: (framing.get(s.sub.roomRef) ?? []).join("\n") }),
      })),
      {
        // Charged against the line as it will appear, so an agent's own 4 KB
        // post — condensed to a stub before it is shown — cannot squeeze
        // another room's question out of the prompt.
        cost: (m) => estimateTokens({ role: "user", content: render(m) }),
        mustInclude,
      },
    );

    const names: string[] = [];
    const blocks: string[] = [];
    for (const section of sections) {
      const picked = shown.get(section.sub.roomRef);
      if (!picked?.length) continue;
      names.push(section.room?.name ?? section.sub.roomRef);
      blocks.push([...(framing.get(section.sub.roomRef) ?? []), ...picked.map(render)].join("\n"));
    }

    const prompt = [
      `You are ${label}. ${todayLine()}`,
      `New messages in ${names.length} of the rooms you watch: ${names.join(", ")}.`,
      "",
      blocks.join("\n\n"),
      "",
      // Positive instructions with the exact call in them. A combined turn has
      // no default destination, so how to speak is the one thing this prompt
      // has to get across; "don't reply as text" is exactly the negative
      // phrasing a local model reads straight past.
      'Answer wherever there is something worth saying: room(action="post", room="<room name>", body="…"), once per room. Address someone by naming them in `to`.',
      'To stay quiet in all of these rooms, call room(action="pass") with no room.',
    ].join("\n");

    return { prompt, shown };
  }

  /** True once start() has armed listeners. Exposed for status output. */
  isRunning(): boolean {
    return this.started;
  }
}
