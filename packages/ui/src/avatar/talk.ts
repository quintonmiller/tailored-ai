/**
 * Agents talking, as the world shows it: face to face when their bodies are
 * in the same place, on the phone when they aren't. The places plugin keeps a
 * `talk` record per agent saying who it is talking with and whether by phone,
 * so every page agrees; a person's own talk with an agent is written by the
 * page they talk on, naming them `you`. Here is what that makes of an agent's
 * activity ("on the phone with writer"), who faces whom in a place and which
 * of two steps over to the other, where one stands to talk, and whose phone a
 * voice from somewhere else comes out of. Pure, so it is tested without a GPU.
 */
import { nameOf } from "../lib/conversations";
import type { AgentActivity } from "./doing";
import { standsClear } from "./doors";
import type { Obstacle } from "./locomotion";
import type { Room } from "./scene";

/** A person in a talk: the page's own body goes by this name too. */
export const YOU = "you";

/** The places plugin's `talk` record: who an agent is talking with, on the phone or face to face, until when. */
export interface Talk {
  with: string;
  phone?: boolean;
  /** This side spoke first: in a big room, the one who steps over. */
  started?: boolean;
  until: string;
}

/** How long a person's talk with an agent lasts after the last thing said: as long as two agents' (`TALK_AFTER_MS` on the server). */
export const TALK_AFTER_MS = 40_000;

/** Further apart than this, two talking face to face are too far to talk: the one who spoke first walks over. */
export const TALK_APART = 3;
/** Nearer than this, one sitting about gets up to talk to whoever came over. */
export const GET_UP_AT = 1.8;
/** How far from the other a body stands to talk: near enough to talk, out of the way of its arms. */
export const STAND_OFF = 0.95;
/** How far apart two bodies standing round the same agent keep. */
export const SPACING = 0.8;
/** Directions round the agent tried, evenly spaced. */
const ROUND = 16;
/** A body's half-width: how far inside the walls a spot has to be. */
const BODY = 0.3;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A talk still going at `now`; nothing once it has run out, or for a record that isn't one. */
export function talkNow(t: Partial<Talk> | undefined, now: number): Talk | undefined {
  if (!t || typeof t.with !== "string" || !t.with) return undefined;
  const until = typeof t.until === "string" ? Date.parse(t.until) : Number.NaN;
  return Number.isFinite(until) && until > now ? (t as Talk) : undefined;
}

/** A talk in a few words, for a tag, the map and an agent's card: "on the phone with writer", "talking with you". */
export function talkWords(t: { with: string; phone?: boolean }): string {
  return `${t.phone ? "on the phone with" : "talking with"} ${nameOf(t.with)}`;
}

/** The doings a talk can go with: busy with nothing else, talking already, or thinking or working through it. */
const TALKS_THROUGH = new Set<AgentActivity["doing"]>(["idle", "talking", "thinking", "working"]);

/** A name with only its letters and digits, in lower case: how a label in rooms ("Writer", "code-reviewer") is matched. */
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether one talking to `called` (as the activity names it: the name or the
 * label the call used) is talking to `agent`: the same name in any case or
 * spelling a room label gives it, or a name that is no agent's at all, an
 * alias only the rooms know, which the talk has already worked out.
 */
function sameAgent(called: string, agent: string, agents: Iterable<string>): boolean {
  if (plain(called) === plain(agent)) return true;
  for (const a of agents) if (plain(a) === plain(called)) return false;
  return true;
}

/**
 * Every agent's activity as the world shows it, with the talks going on at
 * `now`. One idle, or talking with the one its talk names, is talking in the
 * talk's words; one thinking or working keeps its own words, with the talk
 * alongside, so a body that thinks on the phone holds the phone as it thinks.
 * One talking to somebody else (handing off work), waiting on you, stuck or
 * asleep is left as it is; one calling the other by its label in rooms is
 * talking to the same one. An agent with a talk and no activity yet is
 * talking too.
 */
export function withTalks(
  activities: Record<string, AgentActivity>,
  talks: Record<string, Partial<Talk>>,
  now: number,
): Record<string, AgentActivity> {
  let out = activities;
  for (const [agent, record] of Object.entries(talks)) {
    const t = talkNow(record, now);
    if (!t) continue;
    const own = activities[agent];
    const doing = own?.doing ?? "idle";
    if (!TALKS_THROUGH.has(doing)) continue;
    if (doing === "talking" && own?.with && !sameAgent(own.with, t.with, Object.keys(activities))) continue;
    const talk = { with: t.with, ...(t.phone ? { phone: true } : {}), ...(t.started ? { started: true } : {}) };
    if (out === activities) out = { ...activities };
    out[agent] =
      own && (doing === "thinking" || doing === "working")
        ? { ...own, talk }
        : { agent, doing: "talking", what: talkWords(t), with: t.with, talk };
  }
  return out;
}

/**
 * Who faces whom here, of the bodies `here`, and whether each is the one to
 * walk over when they are too far apart to talk: each agent talking face to
 * face with another here, by its talk. The one who spoke first goes over;
 * talking with you, the agent always does, as your body is yours to move.
 * Your own body is never in it.
 */
export function talkingHere(
  activities: Record<string, AgentActivity>,
  here: ReadonlySet<string>,
): Map<string, { partner: string; goes: boolean }> {
  const out = new Map<string, { partner: string; goes: boolean }>();
  for (const agent of here) {
    const t = activities[agent]?.talk;
    if (agent === YOU || !t || t.phone || t.with === agent || !here.has(t.with)) continue;
    // Both saying they spoke first (two messages crossing) is settled by name, so only one walks.
    const back = activities[t.with]?.talk;
    const crossed = !!back?.started && back.with === agent && agent > t.with;
    out.set(agent, { partner: t.with, goes: t.with === YOU || (!!t.started && !crossed) });
  }
  return out;
}

/** Whether a line was said down the phone: not in a room, by one on the phone with whoever it was said to. */
export function byPhone(line: { to?: string[]; room?: string }, talk: AgentActivity["talk"]): boolean {
  if (line.room || !talk?.phone) return false;
  return !line.to?.length || line.to.includes(talk.with);
}

/**
 * Whose phone a line said by `speaker`, who isn't here, comes out of: a body
 * here on the phone with it that the line was said to, if there is one. That
 * is where the far side of a call is heard, and where its words show. What
 * the speaker says in a room, or to somebody else, isn't said down this call,
 * though the call is still on.
 */
export function heardThrough(
  speaker: string,
  line: { to?: string[]; room?: string },
  activities: Record<string, AgentActivity>,
  here: Iterable<string>,
): string | undefined {
  for (const agent of here) {
    const t = activities[agent]?.talk;
    if (agent !== speaker && t?.phone && t.with === speaker && byPhone(line, { with: agent, phone: true }))
      return agent;
  }
  return undefined;
}

/**
 * Where a body stands to talk to someone at `target`, and the way it faces
 * (radians, as the walker keeps them): on the side it comes from (`from`; the
 * middle of the room when not given), or failing that the nearest way round
 * that is clear of the furniture, the walls and everyone in `others`, a step
 * further out once the near ring is full. So several talking to one agent
 * stand round it rather than on top of each other. Somewhere is always found:
 * when no spot is clear of the others, the nearest one clear of the
 * furniture, and when even that fails, the one on the side it comes from.
 */
export function standBy(
  room: Pick<Room, "width" | "depth">,
  obstacles: Obstacle[],
  target: [number, number],
  opts: { from?: [number, number]; others?: [number, number][] } = {},
): { at: [number, number]; facing: number } {
  const [tx, tz] = target;
  const [fx, fz] = opts.from ?? [0, 0];
  // Standing on the middle of the room, there is no side to come from: beside it, then.
  const toward = Math.hypot(fx - tx, fz - tz) > 0.05 ? Math.atan2(fx - tx, fz - tz) : Math.PI / 2;
  const step = (2 * Math.PI) / ROUND;
  // The way it comes first, then either side of that, further and further round.
  const turns = [0, ...Array.from({ length: ROUND / 2 }, (_, i) => [i + 1, -(i + 1)]).flat()].slice(0, ROUND);
  const ring = (r: number) =>
    turns.map((k): [number, number] => {
      const a = toward + k * step;
      return [round(tx + Math.sin(a) * r), round(tz + Math.cos(a) * r)];
    });
  const clear = [...ring(STAND_OFF), ...ring(STAND_OFF + 0.45)].filter((p) => standsClear(room, obstacles, p));
  const others = opts.others ?? [];
  const spaced = clear.find((p) => others.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) >= SPACING));
  const [x, z] = spaced ?? clear[0] ?? ring(STAND_OFF)[0];
  const at: [number, number] = [
    Math.max(-room.width / 2 + BODY, Math.min(room.width / 2 - BODY, x)),
    Math.max(-room.depth / 2 + BODY, Math.min(room.depth / 2 - BODY, z)),
  ];
  return { at, facing: Math.atan2(tx - at[0], tz - at[1]) };
}
