/**
 * Places: an agent with a body chooses what its room looks like.
 *
 * Each agent with an avatar has a home: a world-state record of type `place`
 * (`home:<agent>`, in its own scope) that the web UI draws and the avatar
 * walks around in. The `place` tool lets the agent look at it and change it:
 * add furniture where it says ("by the window", "on the desk", "in the back
 * left corner"), move, restyle or remove things, resize and repaint the room,
 * and undo. Because the room is world state, every change has an author and a
 * history, the State page can show and edit it, and the chat page redraws it
 * the moment it changes.
 *
 * The tool also takes photos: the room, or a selfie, rendered by the bundled
 * UI in a headless browser (see `places-camera.ts`). A photo comes back as an
 * image, so it goes out with the agent's reply on any surface that shows one,
 * Discord included.
 *
 * Each room agents talk in has a meeting room, drawn from its name and
 * purpose, which its members can go into and change like their own: the
 * first change keeps it as a record (`room:<ref>`), drawn from then on as
 * they left it. Every change made with the tool is kept on the place in a few
 * words ("planner added the bookshelf"), for the page to show as it happens.
 * And now and then, if configured, agents are asked to look at their rooms in
 * the light of what they have been doing (`places-tend.ts`).
 *
 * Free when unused: with no avatar configured, it registers nothing. An agent
 * with its own `tools:` list needs `place` named in it, like any tool.
 */
import { resolveAgent } from "../agent/agents.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { mediaPart, textPart } from "../content/types.js";
import { getExploratoryState } from "../db/exploratory-queries.js";
import type { TaiHttpRequest, TaiHttpResponse } from "../http/registry.js";
import { resolveAvatar } from "../live/avatar.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { enrichRoomMessage, IdentityResolver } from "../rooms/identities.js";
import { getRoomBackend, listRoomBackends } from "../rooms/registry.js";
import { formatRoomRef, type RoomBackend, type RoomMessage, type Room as TalkRoomRecord } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";
import type { StateCaller, StateService } from "../state/service.js";
import { type Actor, type StateChange, StateConflictError, StateError, type StateRecord } from "../state/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { agentStateCaller } from "../tools/state.js";
import { whyAsleep } from "./activity.js";
import { PlaceCamera, type Shot } from "./places-camera.js";
import {
  CHANGES_KEPT,
  colorWord,
  describe,
  doorOf,
  doorWords,
  FLOORS,
  type Floor,
  findItem,
  findPlacement,
  findSpot,
  firstHome,
  footprintOf,
  KINDS,
  LIMITS,
  moveItem,
  newId,
  newName,
  PHOTOS_KEPT,
  PLACE_SCHEMA,
  type Place,
  type PlaceChange,
  type PlaceItem,
  type PlacePhoto,
  type Placing,
  parseColor,
  placeProblems,
  removeItem,
  resize,
  type Side,
  type Wall,
  type Where,
  whereWords,
  withDoorwayHeld,
  withSpots,
} from "./places-layout.js";
import {
  homePlace,
  LOBBY,
  lobby,
  meetingRoom,
  NO_THEME,
  retheme,
  sharedPlace,
  THEMES,
  themeNamed,
} from "./places-rooms.js";
import { everyWords, gatherDone, parseTend, quiet, Tender, tendMessage } from "./places-tend.js";
import {
  type Area,
  areaId,
  doorsIn,
  hallPlace,
  layWorld,
  MAIN,
  MAIN_NAME,
  type PlaceDoor,
  type World,
  type WorldPlace,
} from "./places-world.js";

export const PLACE_TYPE = "place";

export const meta: PluginMeta = {
  name: "Places",
  description:
    "Gives each agent with an avatar a room it can change: a `place` world-state record, the `place` tool, and GET /api/ext/builtin:places/:agent for the page that draws it.",
  registers: [
    { kind: "stateType", id: "place" },
    { kind: "tool", id: "place" },
    { kind: "httpRoutes", id: "places" },
    { kind: "httpRoutes", id: "map" },
  ],
};

/** The record that holds an agent's own room. */
export function homeId(agent: string): string {
  return `home:${agent}`;
}

/** Whether anyone has a body, so there is a room to keep. */
export function anyAvatar(config: AgentConfig): boolean {
  if (resolveAvatar(config.live).model) return true;
  return Object.values(config.agents ?? {}).some((a) => !!resolveAvatar(config.live, a.avatar).model);
}

const PLUGIN_CALLER: StateCaller = { actor: { kind: "plugin", name: "places" }, source: { surface: "http" } };

const byPlugin = (actor: Actor) => actor.kind === PLUGIN_CALLER.actor.kind && actor.name === PLUGIN_CALLER.actor.name;

/** Whether a stored room is the first room every home used to start as, exactly: same size, colours and things. */
export function isFirstHome(place: Place): boolean {
  const first = firstHome(place.name);
  const shape = (p: Place) =>
    JSON.stringify([
      p.width,
      p.depth,
      p.height,
      p.walls,
      p.floor,
      p.floorColor,
      p.photos?.length ?? 0,
      p.props.map((i) => [i.id, i.kind, i.at, i.facing, i.elevation, i.on, i.color, i.scale, i.size, i.name]),
    ]);
  return shape(place) === shape(first);
}

/**
 * Whether a home is still as the system gave it: since the room was last
 * made, no agent, person or other plugin has changed it. The room was made
 * by this plugin, or in the agent's name when its first `place` call found
 * no room (then it is the first room exactly), and this plugin wrote every
 * version since, giving it a newer room. What came before a delete was
 * another room. Anything else is someone's room and is never replaced.
 */
async function untouched(service: StateService, record: StateRecord): Promise<boolean> {
  const asMade = (actor: Actor, data: Record<string, unknown> | undefined) =>
    byPlugin(actor) || (actor.kind === "agent" && !!data && isFirstHome(data as unknown as Place));
  if (record.version === 1) return asMade(record.updatedBy, record.data);
  if (!byPlugin(record.updatedBy) && record.updatedBy.kind !== "agent") return false;
  const ref = { type: record.type, id: record.id };
  const history = (limit: number) => service.history(PLUGIN_CALLER, ref, { limit }).catch(() => undefined);
  // An agent wrote last: untouched only if that write made the room, which the newest entry alone says.
  if (!byPlugin(record.updatedBy)) {
    const [last] = (await history(1)) ?? [];
    return last?.op === "create" && asMade(last.actor, last.after);
  }
  const changes = await history(record.version);
  if (!changes) return false;
  // Newest first: everything written since the room was last made, which must be in the history.
  const since: StateChange[] = [];
  for (const change of changes) {
    since.push(change);
    if (change.op === "create") break;
  }
  const made = since.at(-1);
  if (made?.op !== "create" || !asMade(made.actor, made.after)) return false;
  return since.slice(0, -1).every((c) => byPlugin(c.actor));
}

/**
 * Rooms drawn from a seed, kept once drawn: drawing one takes milliseconds,
 * and every read of a home, the lobby or a meeting room asks for one. Each
 * caller gets its own copy.
 */
const drawn = new Map<string, Place>();
function drawOnce(key: string, draw: () => Place): Place {
  let place = drawn.get(key);
  if (!place) {
    if (drawn.size >= 256) drawn.clear();
    place = draw();
    drawn.set(key, place);
  }
  return structuredClone(place);
}

const drawHome = (id: string, name: string) => drawOnce(`home\n${id}\n${name}`, () => homePlace(id, name));

/**
 * An agent's home: its own room, drawn from its id the first time anyone
 * asks. A home nobody has changed is brought up to the room its id draws
 * now, so homes made before rooms were drawn from a seed get one too; a
 * home anyone has changed is left exactly as it is.
 */
export async function readHome(
  service: StateService,
  caller: StateCaller,
  agent: string,
): Promise<{ place: Place; version: number }> {
  const ref = { type: PLACE_TYPE, id: homeId(agent) };
  const name = agent === "default" ? "your room" : `${agent}'s room`;
  const found = await service.get(caller, ref);
  if (found) {
    const fresh = await upgrade(service, found, name);
    return fresh ?? { place: found.data as unknown as Place, version: found.version };
  }
  const place = drawHome(ref.id, name);
  try {
    // The system makes the room, whoever asked: so it is known to be untouched until someone changes it.
    // Only if there is still none (version 0): a room someone made a moment ago is never written over.
    const made = await service.put(
      PLUGIN_CALLER,
      { ...ref, scope: `agent:${agent}`, data: place as unknown as Record<string, unknown> },
      0,
    );
    return { place, version: made.version };
  } catch (err) {
    // Someone else made it a moment ago: theirs stands.
    const again = await service.get(caller, ref);
    if (again) return { place: again.data as unknown as Place, version: again.version };
    throw err;
  }
}

/** The room a home's id draws now, written over an untouched home that differs from it; undefined when there is nothing to do. */
async function upgrade(
  service: StateService,
  record: StateRecord,
  name: string,
): Promise<{ place: Place; version: number } | undefined> {
  const stored = record.data as unknown as Place;
  const place = drawHome(record.id, typeof stored.name === "string" ? stored.name : name);
  if (JSON.stringify(stored) === JSON.stringify(place)) return undefined;
  if (!(await untouched(service, record))) return undefined;
  try {
    const made = await service.put(
      PLUGIN_CALLER,
      { type: record.type, id: record.id, scope: record.scope, data: place as unknown as Record<string, unknown> },
      record.version,
    );
    return { place, version: made.version };
  } catch {
    // Changed a moment ago, by someone who is now its author: theirs stands.
    return undefined;
  }
}

/** Where each agent's body has gone: no record means it is at home. */
export const WHEREABOUTS_TYPE = "whereabouts";
/** Shared places are `place` records everyone can see, named `shared:<slug>`. */
const SHARED = "shared:";

/**
 * A body visiting the meeting room of a room it is talking in (see
 * {@link Presence}): one record per agent, naming the room's place and when
 * the visit ends. Kept in memory, apart from whereabouts, since it lasts
 * minutes: where the agent lives is never written for it, and a restart ends
 * every visit.
 */
export const VISIT_TYPE = "visit";

/** The meeting room a visit record has a body in now; nothing once the visit has ended. */
export function visitOf(data: Record<string, unknown> | undefined, now: number): string | undefined {
  const place = typeof data?.place === "string" ? data.place : undefined;
  const until = typeof data?.until === "string" ? Date.parse(data.until) : Number.NaN;
  return place && Number.isFinite(until) && until > now ? place : undefined;
}

/** The rooms agents talk in, and who has a body: what a meeting room needs to be found and drawn. */
export interface Meetings {
  rooms: TalkRoom[];
  hasBody: (agent: string | undefined) => boolean;
}

/** The room of conversation a meeting room's id is for, while there is one. */
function talkRoomOf(rooms: TalkRoom[] | undefined, id: string): TalkRoom | undefined {
  return id.startsWith("room:") ? rooms?.find((r) => roomPlaceId(r.ref) === id) : undefined;
}

/**
 * Whether an agent may change a place: its own home, a meeting room of a
 * room it talks in, and any shared place. The lobby and the halls are the
 * building's, and nobody's to change.
 */
export function mayChange(id: string, agent: string, rooms: TalkRoom[]): boolean {
  if (id.startsWith("home:")) return id === homeId(agent);
  if (id.startsWith("room:")) return !!talkRoomOf(rooms, id)?.members.includes(agent);
  return id.startsWith(SHARED);
}

/** Why an agent can't go into a meeting room, and who can: its room's members with bodies. */
export function onlyMembers(room: TalkRoom, hasBody: (agent: string | undefined) => boolean): string {
  const who = room.members.filter((m) => hasBody(m)).sort();
  const names = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0];
  return `#${room.name}'s meeting room is for the members of #${room.name}: ${names ? `${names} can go in and change it` : "none of them has a body yet"}. Join the room first, or ask one of them.`;
}

/** A meeting room as drawn for its room of conversation, before anyone changes it: a seat for each member with a body. */
function drawMeeting(room: TalkRoom, hasBody: Meetings["hasBody"], theme?: string): { place: Place; agents: string[] } {
  const agents = room.members.filter((m) => hasBody(m)).sort();
  const purpose = room.purpose ?? "";
  const place = drawOnce(`room\n${room.name}\n${agents.length}\n${purpose}\n${theme ?? ""}`, () =>
    meetingRoom(room.name, agents.length, purpose, theme),
  );
  return { place, agents };
}

/**
 * The place an agent lives in now: home, unless it has gone to a shared place
 * that still exists, or into the meeting room of a room it is still a member
 * of. A body visiting a meeting room (see {@link Presence}) still lives there,
 * which is the room the `place` tool changes.
 */
export async function whereIs(
  service: StateService,
  caller: StateCaller,
  agent: string,
  rooms?: TalkRoom[],
): Promise<string> {
  // A store that keeps no whereabouts has everyone at home.
  const found = await service.get(caller, { type: WHEREABOUTS_TYPE, id: agent }).catch(() => null);
  const id = typeof found?.data.place === "string" ? found.data.place : undefined;
  if (!id || id === homeId(agent)) return homeId(agent);
  // A meeting room is there while its room is, and only for its members: one who has left the room is home again.
  if (id.startsWith("room:")) return mayChange(id, agent, rooms ?? []) ? id : homeId(agent);
  return (await service.get(caller, { type: PLACE_TYPE, id })) ? id : homeId(agent);
}

/** Where an agent's body is drawn: in a meeting room while it is talking there, otherwise where it lives. */
export async function bodyAt(
  service: StateService,
  caller: StateCaller,
  agent: string,
  rooms?: TalkRoom[],
): Promise<string> {
  const visit = await service.get(caller, { type: VISIT_TYPE, id: agent }).catch(() => null);
  return visitOf(visit?.data, Date.now()) ?? whereIs(service, caller, agent, rooms);
}

/**
 * Every body that has gone somewhere, and where it is now: a meeting room it
 * is visiting, or where it went. Whereabouts naming a meeting room stand only
 * for a member of its room (one who went in to change it); without the rooms
 * to check against, they don't.
 */
async function goneTo(service: StateService, caller: StateCaller, rooms?: TalkRoom[]): Promise<Map<string, string>> {
  const all = (type: string) =>
    service.query(caller, { type, limit: 500 }).catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const [went, visits] = await Promise.all([all(WHEREABOUTS_TYPE), all(VISIT_TYPE)]);
  const gone = new Map(
    went.map((r) => {
      const place = typeof r.data.place === "string" ? r.data.place : "";
      return [r.id, place.startsWith("room:") && !mayChange(place, r.id, rooms ?? []) ? "" : place];
    }),
  );
  const now = Date.now();
  for (const v of visits) {
    const room = visitOf(v.data, now);
    if (room) gone.set(v.id, room);
  }
  return gone;
}

/**
 * The place an agent is in now, with what a write needs: its id, version and
 * scope. A meeting room nobody has changed yet is drawn for it at version 0,
 * so the first change makes the record, and only if nobody made it first.
 */
export async function readCurrent(
  service: StateService,
  caller: StateCaller,
  agent: string,
  meetings?: Meetings,
): Promise<{ id: string; place: Place; version: number; scope: string }> {
  const id = await whereIs(service, caller, agent, meetings?.rooms);
  const found = id === homeId(agent) ? undefined : await service.get(caller, { type: PLACE_TYPE, id });
  if (found) return { id, place: found.data as unknown as Place, version: found.version, scope: found.scope };
  const talk = talkRoomOf(meetings?.rooms, id);
  if (talk && meetings) return { id, place: drawMeeting(talk, meetings.hasBody).place, version: 0, scope: "global" };
  return { id: homeId(agent), ...(await readHome(service, caller, agent)), scope: `agent:${agent}` };
}

/**
 * Everyone whose body is in a place now, apart from `except`: those who went
 * there, those visiting a meeting room to talk, and the owner of a home.
 */
export async function whoIsIn(
  service: StateService,
  caller: StateCaller,
  id: string,
  hasBody: (agent: string | undefined) => boolean,
  except?: string,
  rooms?: TalkRoom[],
): Promise<string[]> {
  const went = await goneTo(service, caller, rooms);
  const names = new Set([...went].flatMap(([agent, place]) => (place === id ? [agent] : [])));
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    if ((await bodyAt(service, caller, owner, rooms)) === id) names.add(owner);
  }
  if (except) names.delete(except);
  return [...names].filter((name) => hasBody(name)).sort();
}

/** The shared places, by id and name, and the area each is in when it says. */
async function sharedPlaces(
  service: StateService,
  caller: StateCaller,
): Promise<{ id: string; name: string; area?: string }[]> {
  const records = await service.query(caller, { type: PLACE_TYPE, scope: "global", limit: 200 });
  return records
    .filter((r) => r.id.startsWith(SHARED))
    .map((r) => {
      const data = r.data as unknown as Place;
      return { id: r.id, name: String(data.name ?? r.id), ...(data.area ? { area: data.area } : {}) };
    });
}

/** What each place someone gave a purpose is for, by id: one query for the map, however many places there are. */
async function purposes(service: StateService, caller: StateCaller): Promise<Map<string, string>> {
  const records = await service
    .query(caller, { type: PLACE_TYPE, where: { purpose: { ne: null } }, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  return new Map(records.map((r) => [r.id, String((r.data as unknown as Place).purpose ?? "")]));
}

/**
 * The building every place is in (see `places-world.ts`): the homes of the
 * agents with bodies, the shared places, and the rooms agents talk in, each
 * in the area its record says. Only records that name an area are read for
 * it, so a building of fifty homes costs two queries, not fifty reads.
 */
export async function buildWorld(
  service: StateService,
  caller: StateCaller,
  agents: string[],
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
): Promise<World> {
  const shared = await sharedPlaces(service, caller).catch(() => []);
  const elsewhere = await service
    .query(caller, { type: PLACE_TYPE, where: { area: { ne: null } }, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const areaOf = new Map(elsewhere.map((r) => [r.id, String((r.data as unknown as Place).area ?? "")]));
  const places: WorldPlace[] = [
    ...agents
      .filter((a) => hasBody(a))
      .map((a) => ({
        id: homeId(a),
        name: a === "default" ? "your room" : `${a}'s room`,
        kind: "home" as const,
        owner: a,
        ...(areaOf.get(homeId(a)) ? { area: areaOf.get(homeId(a)) } : {}),
      })),
    ...shared.map((p) => ({ id: p.id, name: p.name, kind: "shared" as const, ...(p.area ? { area: p.area } : {}) })),
    ...rooms.map((r) => ({ id: roomPlaceId(r.ref), name: r.name, kind: "room" as const })),
  ];
  return layWorld(places);
}

/** A room of conversation, and its members, wherever their bodies are. */
export interface TalkRoom {
  /** `<backend>:<id>`. */
  ref: string;
  name: string;
  purpose?: string;
  members: string[];
}

/** One place on the map: the lobby, a hall, a home, a shared place, or a room of conversation, and who is in it. */
export interface MapPlace {
  id: string;
  name: string;
  kind: "lobby" | "hall" | "home" | "shared" | "room";
  agents: string[];
  /** The area it is in, by id: `main` for the main building. */
  area: string;
  /** The agent whose home it is. */
  owner?: string;
  purpose?: string;
  /** A room of conversation's members with a body, wherever their bodies are. */
  members?: string[];
}

/** A room of conversation's place id. */
export const roomPlaceId = (ref: string) => `room:${ref}`;

/** How many of a room's latest messages a visitor reads in the chat panel. */
export const TRANSCRIPT_LINES = 30;

/** One thing said in a room of conversation, as a visitor reads it. */
export interface SaidLine {
  id: string;
  /** Who said it: their name in the room. */
  who: string;
  /** The agent behind that name, when it is one: what the page colours the line by. */
  agent?: string;
  /** Who it was said to; empty for the whole room. */
  to: string[];
  text: string;
  at: string;
  /** How many files came with it. */
  files?: number;
}

/** A time as ISO: SQLite's own `YYYY-MM-DD HH:MM:SS` is UTC without saying so, which a browser reads as local. */
const isoTime = (at: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at);

/** A room's messages as lines to read, each speaker named the way the room tool and the watcher name them. */
export function saidLines(messages: RoomMessage[], identities: IdentityResolver, backend: string): SaidLine[] {
  return messages.map((raw) => {
    const m = enrichRoomMessage(raw, identities);
    const who = m.speaker ?? identities.byNativeId(backend, m.authorId)?.label ?? m.authorLabel;
    const agent = identities.agentForLabel(who);
    // A speaker the room doesn't know as anyone (the room's own announcements) keeps its tag in the text: once is enough.
    const tag = `[${who}]`;
    const text = m.body.startsWith(tag) ? m.body.slice(tag.length).trimStart() : m.body;
    return {
      id: m.id,
      who,
      ...(agent ? { agent } : {}),
      to: m.to,
      text,
      at: isoTime(m.createdAt),
      ...(m.media?.length ? { files: m.media.length } : {}),
    };
  });
}

/**
 * What a room of conversation has said lately, for a visitor standing in its
 * meeting room: the latest lines, oldest first, and who its members are. Read
 * only: nobody's read cursor moves, and nothing is posted. An error says why
 * when the room's transport can't be read right now.
 */
export async function transcript(
  room: TalkRoomRecord,
  backend: RoomBackend | undefined,
  identities: IdentityResolver,
  members: string[],
  limit = TRANSCRIPT_LINES,
): Promise<{ name: string; purpose?: string; members: string[]; lines: SaidLine[] } | { error: string }> {
  if (!backend) return { error: `The ${room.ref.backend} rooms aren't connected right now.` };
  try {
    const messages = await backend.fetchSince(room.ref.id, null, limit);
    return {
      name: room.name,
      ...(room.purpose ? { purpose: room.purpose } : {}),
      members,
      lines: saidLines(messages, identities, room.ref.backend),
    };
  } catch (err) {
    return { error: `Couldn't read #${room.name}: ${(err as Error).message}` };
  }
}

/**
 * Every place there is: the lobby and the halls, each agent's home, the
 * shared places, and the rooms agents talk in, each with the area it is in.
 * A body is in one place at a time: its home, a shared place, or the meeting
 * room of a room it is talking in. A room also lists all its members, since
 * an agent can belong to several.
 */
export async function worldMap(
  service: StateService,
  caller: StateCaller,
  agents: string[],
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
  built?: World,
): Promise<MapPlace[]> {
  const world = built ?? (await buildWorld(service, caller, agents, rooms, hasBody));
  const area = (id: string) => world.areaOf.get(id) ?? MAIN;
  const bodies = agents.filter((a) => hasBody(a));
  const shared = await sharedPlaces(service, caller).catch(() => []);
  const sharedIds = new Set(shared.map((p) => p.id));
  const roomIds = new Set(rooms.map((r) => roomPlaceId(r.ref)));
  const gone = await goneTo(service, caller, rooms);
  const purposeOf = await purposes(service, caller);
  const purpose = (id: string, fallback?: string) => {
    const p = purposeOf.get(id) || fallback;
    return p ? { purpose: p } : {};
  };
  // Where each body is: somewhere that still exists, or home. In a meeting room, it is out of its home.
  const where = (a: string) => {
    const id = gone.get(a);
    const there =
      id && (sharedIds.has(id) || roomIds.has(id) || (id.startsWith("home:") && bodies.includes(id.slice(5))));
    return there ? id : homeId(a);
  };
  const inside = new Map<string, string[]>();
  for (const a of bodies) inside.set(where(a), [...(inside.get(where(a)) ?? []), a]);
  return [
    { id: LOBBY, name: "the lobby", kind: "lobby" as const, agents: [], area: MAIN },
    ...world.halls.map((h) => ({ id: h.id, name: h.name, kind: "hall" as const, agents: [], area: h.area })),
    ...bodies.map((a) => ({
      id: homeId(a),
      name: a === "default" ? "the default agent's room" : `${a}'s room`,
      kind: "home" as const,
      owner: a,
      agents: (inside.get(homeId(a)) ?? []).sort(),
      area: area(homeId(a)),
      ...purpose(homeId(a)),
    })),
    ...shared.map((p) => ({
      id: p.id,
      name: p.name,
      kind: "shared" as const,
      agents: (inside.get(p.id) ?? []).sort(),
      area: area(p.id),
      ...purpose(p.id),
    })),
    ...rooms.map((r) => ({
      id: roomPlaceId(r.ref),
      name: r.name,
      kind: "room" as const,
      agents: (inside.get(roomPlaceId(r.ref)) ?? []).sort(),
      members: r.members.filter((m) => hasBody(m)).sort(),
      area: MAIN,
      // The purpose its members gave its meeting room, over the room's own.
      ...purpose(roomPlaceId(r.ref), r.purpose),
    })),
  ];
}

/**
 * Any place, to look at: what it looks like, who is in it, and, given the
 * building, its doors. A room of conversation is a meeting room with a seat
 * for each member, and in it the members there now, drawn fresh until one of
 * them changes it and kept from then on; a hall is a corridor with a door for
 * each place off it, always drawn fresh.
 */
export async function scene(
  service: StateService,
  caller: StateCaller,
  id: string,
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
  world?: World,
): Promise<{ id: string; place: Place; agents: string[]; doors: PlaceDoor[] } | null> {
  const found = await sceneOf(service, caller, id, rooms, hasBody, world);
  return found && { ...found, doors: world ? doorsIn(id, found.place, world) : [] };
}

async function sceneOf(
  service: StateService,
  caller: StateCaller,
  id: string,
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
  world: World | undefined,
): Promise<{ id: string; place: Place; agents: string[] } | null> {
  if (id === LOBBY) return { id, place: drawOnce(LOBBY, lobby), agents: [] };
  if (id.startsWith("hall:")) {
    const hall = world?.halls.find((h) => h.id === id);
    if (!hall) return null;
    return {
      id,
      place: drawOnce(`hall\n${id}\n${hall.name}\n${hall.rooms.length}`, () => hallPlace(hall)),
      agents: [],
    };
  }
  if (id.startsWith("room:")) {
    const room = talkRoomOf(rooms, id);
    if (!room) return null;
    // Once a member has changed it, it is kept: drawn from the record, never from its name again.
    const kept = await service.get(caller, { type: PLACE_TYPE, id }).catch(() => null);
    const place = kept ? (kept.data as unknown as Place) : drawMeeting(room, hasBody).place;
    return { id, place, agents: await whoIsIn(service, caller, id, hasBody, undefined, rooms) };
  }
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    if (!hasBody(owner)) return null;
    const { place } = await readHome(service, caller, owner);
    return { id, place, agents: await whoIsIn(service, caller, id, hasBody, undefined, rooms) };
  }
  const found = await service.get(caller, { type: PLACE_TYPE, id });
  if (!found) return null;
  const agents = await whoIsIn(service, caller, id, hasBody, undefined, rooms);
  return { id, place: found.data as unknown as Place, agents };
}

// --------------------------------------------------------------------------
// Bodies going where the talk is
// --------------------------------------------------------------------------

/** How long a body stays in a meeting room after it last said something or was woken there, unless plugin config says. */
export const QUIET_MINUTES = 10;
/** A visit isn't written again for every message: only once it has run down this far. */
const VISIT_REFRESH_MS = 60_000;

/**
 * Agents' bodies going to the meeting room of a room they are talking in.
 * Saying something in a room, an agent with a body goes there: its `visit`
 * record names the room's place, with an `until` a quiet spell away. Each
 * thing it says there, and each time the room wakes it while it is there,
 * moves `until` on; being woken alone moves nobody, so an agent that reads a
 * room and keeps quiet stays where it was. Once `until` passes, the body is
 * back where it lives (see {@link visitOf}), and {@link sweep} removes the
 * record, so a page watching visits sees it go.
 */
export class Presence {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly opts: {
      state: () => StateService;
      hasBody: (agent: string | undefined) => boolean;
      quietMs: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** An agent said something in a room: its body goes to the meeting room, or stays a while longer. */
  visit(agent: string, roomRef: string): Promise<void> {
    if (!this.opts.hasBody(agent)) return Promise.resolve();
    return this.inTurn(agent, () => this.go(agent, roomPlaceId(roomRef), true));
  }

  /** A room woke an agent: a body already in its meeting room stays a while longer; one anywhere else stays there. */
  stay(agent: string, roomRef: string): Promise<void> {
    if (!this.opts.hasBody(agent)) return Promise.resolve();
    return this.inTurn(agent, () => this.go(agent, roomPlaceId(roomRef), false));
  }

  /** One agent's visit changes in order, so a quick second message never writes under the first, nor a sweep over it. */
  private inTurn(agent: string, step: () => Promise<void>): Promise<void> {
    const done = (this.chains.get(agent) ?? Promise.resolve()).then(step).catch((err: unknown) => {
      console.warn(`[places] could not keep ${agent}'s visit: ${(err as Error).message}`);
    });
    this.chains.set(agent, done);
    return done;
  }

  private async go(agent: string, id: string, arrive: boolean): Promise<void> {
    const service = this.opts.state();
    const ref = { type: VISIT_TYPE, id: agent };
    const found = await service.get(PRESENCE_CALLER, ref);
    const now = this.now();
    const current = visitOf(found?.data, now);
    if (current !== id && !arrive) return;
    const until = typeof found?.data.until === "string" ? Date.parse(found.data.until) : Number.NaN;
    if (current === id && until - now > this.opts.quietMs - VISIT_REFRESH_MS) return;
    try {
      await service.put(
        PRESENCE_CALLER,
        { ...ref, scope: "global", data: { place: id, until: new Date(now + this.opts.quietMs).toISOString() } },
        found?.version ?? 0,
      );
    } catch (err) {
      // Ended a moment ago, by the place tool or the page: that stands until it next says something.
      if (!(err instanceof StateConflictError)) throw err;
    }
  }

  /** End the visits that have gone quiet: each body back where it lives. */
  async sweep(): Promise<void> {
    const now = this.now();
    const visits = await this.opts
      .state()
      .query(PRESENCE_CALLER, { type: VISIT_TYPE, limit: 500 })
      .catch(() => []);
    await Promise.all(visits.filter((r) => !visitOf(r.data, now)).map((r) => this.inTurn(r.id, () => this.end(r.id))));
  }

  /** End one visit that had gone quiet, looked at again first: one that went on meanwhile goes on. */
  private async end(agent: string): Promise<void> {
    const service = this.opts.state();
    const ref = { type: VISIT_TYPE, id: agent };
    const found = await service.get(PRESENCE_CALLER, ref);
    if (found && !visitOf(found.data, this.now())) await service.delete(PRESENCE_CALLER, ref);
  }

  /** Resolves once every visit asked for so far is written. */
  async settled(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}

const PRESENCE_CALLER: StateCaller = { actor: { kind: "plugin", name: "places" }, source: { surface: "events" } };

/** A body the place tool moves leaves any meeting room it was visiting: where it went stands. */
async function endVisit(service: StateService, agent: string): Promise<void> {
  await service.delete(PRESENCE_CALLER, { type: VISIT_TYPE, id: agent }).catch(() => null);
}

export const VISIT_SCHEMA = {
  type: "object",
  required: ["place", "until"],
  properties: { place: { type: "string", maxLength: 128 }, until: { type: "string" } },
} as const;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

// --------------------------------------------------------------------------
// The tool's arguments
// --------------------------------------------------------------------------

const ACTIONS = ["look", "add", "move", "change", "remove", "room", "undo", "photo", "places", "go", "new"] as const;
type Action = (typeof ACTIONS)[number];

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function number(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A kind from what the model wrote: "coffee table", "Coffee_Table", "TV". */
function kindFrom(v: unknown): string | undefined {
  const t = text(v)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!t) return undefined;
  if (KINDS[t]) return t;
  const byNoun = Object.entries(KINDS).find(([, k]) => k.noun.toLowerCase().replace(/\s+/g, "_") === t);
  if (byNoun) return byNoun[0];
  const singular = t.replace(/s$/, "");
  return KINDS[singular] ? singular : undefined;
}

function sizeFrom(v: unknown): [number, number, number] | string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const parts = Array.isArray(v)
    ? v.map(Number)
    : String(v)
        .split(/[\sx×,*]+/)
        .filter(Boolean)
        .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    return 'Give `size` as width, height and depth in metres, like "0.5 1 0.5".';
  const [lo, hi] = LIMITS.side;
  if (parts.some((n) => n < lo || n > hi)) return `Each side of a shape must be ${lo} to ${hi} m.`;
  return parts.map((n) => Math.round(n * 100) / 100) as [number, number, number];
}

function whereFrom(args: Record<string, unknown>): Where | string {
  const where: Where = {};
  const near = text(args.near);
  const on = text(args.on);
  const corner = text(args.corner);
  const side = text(args.side)?.toLowerCase();
  const wall = text(args.wall)
    ?.toLowerCase()
    .replace(/\s*wall$/, "");
  if (near) where.near = near;
  if (on) where.on = on;
  if (corner) where.corner = corner;
  if (side) {
    const s = side === "back" || side === "behind" ? "behind" : side;
    if (!["left", "right", "front", "behind"].includes(s)) return "`side` is left, right, front or behind.";
    where.side = s as Side;
  }
  if (wall) {
    if (!["back", "left", "right", "front"].includes(wall)) return "`wall` is back, left, right or front.";
    where.wall = wall as Wall;
  }
  const x = number(args.x);
  const z = number(args.z);
  if (x !== undefined) where.x = x;
  if (z !== undefined) where.z = z;
  const facing = args.facing;
  if (facing !== undefined && facing !== null && facing !== "") where.facing = facing as string | number;
  return where;
}

const hasPlacement = (w: Where) =>
  w.near !== undefined ||
  w.on !== undefined ||
  w.corner !== undefined ||
  w.wall !== undefined ||
  w.x !== undefined ||
  w.z !== undefined;

const say = (item: PlaceItem, place: Place) => `${item.name}, ${whereWords(place, item)}`;

/** What a sign says: the name it was given, without "the". */
const signWords = (name: string | undefined) => (name ?? "Welcome").replace(/^(the|a|an)\s+/i, "").slice(0, 40);

/**
 * Whether the building gives a place a door (see `layWorld`): everything in
 * the main building has one; a place in an area of its own only once
 * something else is in that area with it. Asked as the plugin, which lays
 * out the building: an agent can't see other agents' homes, only whether one
 * is next door.
 */
async function hasDoor(
  service: StateService,
  id: string,
  place: Place,
  hasBody: (agent: string | undefined) => boolean,
): Promise<boolean> {
  const area = areaId(place.area);
  if (area === MAIN) return true;
  const elsewhere = await service
    .query(PLUGIN_CALLER, { type: PLACE_TYPE, where: { area: { ne: null } }, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  return elsewhere.some(
    (r) =>
      r.id !== id &&
      (r.id.startsWith(SHARED) || (r.id.startsWith("home:") && hasBody(r.id.slice("home:".length)))) &&
      areaId(String((r.data as unknown as Place).area ?? "")) === area,
  );
}

/** Which area a place is in, and where its door is, for the agent looking round it. */
function whereaboutsWords(place: Place, door: boolean): string {
  const area = place.area && areaId(place.area) !== MAIN ? place.area : MAIN_NAME;
  const slot = doorOf(place);
  if (!door)
    return `It is in ${area}, the only place there, so it has no door yet: the map is the way in.${slot ? ` The floor ${doorWords(place, slot)} is kept clear for one.` : ""}`;
  return `It is in ${area}.${slot ? ` Its door is ${doorWords(place, slot)}; nothing can stand in front of it.` : ""}`;
}

export interface Outcome {
  ok: boolean;
  text: string;
  /** The room after the change; absent when nothing changed. */
  place?: Place;
  /** What was done, in a few words to follow the agent's name in the room's recent changes: "added the lamp". */
  did?: string;
}

const no = (text: string): Outcome => ({ ok: false, text });

/** The themes a place can be given, for the agent. */
const THEME_WORDS = `${THEMES.map((t) => t.id).join(", ")}, or ${NO_THEME}`;

/** Where the agent said to put a thing, in a few words: "by the window", "on the desk". */
function whereSaid(where: Where): string {
  if (where.on) return ` on ${where.on}`;
  if (where.near) return ` by ${where.near}`;
  if (where.corner) return ` in the ${where.corner} corner`;
  if (where.wall) return ` against the ${where.wall} wall`;
  return "";
}

/** A place with one more change in its recent changes, newest first, keeping the last few. */
export function withChange(place: Place, change: PlaceChange): Place {
  return { ...place, changes: [change, ...(place.changes ?? [])].slice(0, CHANGES_KEPT) };
}

export interface ApplyOptions {
  /**
   * The room drawn again in a theme: given for a room still as it was drawn
   * (a meeting room nobody has changed), so a theme dresses it through and
   * through, rather than repainting what is there.
   */
  redraw?: (theme: string) => Place;
}

/** One tool call against a room, without the store: what it becomes, and what to tell the agent. */
export function applyAction(place: Place, args: Record<string, unknown>, opts: ApplyOptions = {}): Outcome {
  const action = text(args.action)?.toLowerCase() as Action | undefined;
  if (!action || !ACTIONS.includes(action)) return no(`\`action\` is one of: ${ACTIONS.join(", ")}.`);
  if (action === "look") return { ok: true, text: describe(place) };

  if (action === "room") {
    let next: Place = place;
    const changes: string[] = [];
    const did: string[] = [];
    // The theme first: a room still as it was drawn is drawn again in it, and everything else asked for goes on top.
    const themeText = text(args.theme);
    if (themeText) {
      const theme = themeNamed(themeText);
      if (!theme) return no(`"${themeText}" isn't a theme. The themes are ${THEME_WORDS}.`);
      const id = theme === NO_THEME ? NO_THEME : theme.id;
      if (opts.redraw) {
        next = opts.redraw(id);
        changes.push(
          id === NO_THEME ? "it is plain now, with no theme" : `it is dressed as a ${id} through and through`,
        );
      } else {
        const themed = retheme(place, theme);
        next = themed.place;
        changes.push(
          `${id === NO_THEME ? "it is plain now, with no theme" : `its theme is ${id}, in its colours`}${themed.added ? `, with ${themed.added.name} added ${whereWords(themed.place, themed.added)}` : ""}`,
        );
      }
      did.push(id === NO_THEME ? "took the theme away" : `gave it the ${id} theme`);
    }
    const width = number(args.width);
    const depth = number(args.depth);
    const height = number(args.height);
    for (const [key, value] of [
      ["width", width],
      ["depth", depth],
      ["height", height],
    ] as const) {
      if (value === undefined) continue;
      const [lo, hi] = LIMITS[key];
      if (value < lo || value > hi) return no(`The room's ${key} must be ${lo} to ${hi} m.`);
    }
    if (width !== undefined || depth !== undefined || height !== undefined) {
      const sized = resize(next, {
        ...(width !== undefined ? { width: Math.round(width * 100) / 100 } : {}),
        ...(depth !== undefined ? { depth: Math.round(depth * 100) / 100 } : {}),
        ...(height !== undefined ? { height: Math.round(height * 100) / 100 } : {}),
      });
      if (typeof sized === "string") return no(sized);
      next = sized;
      changes.push(`it is now ${next.width} × ${next.depth} m and ${next.height} m high`);
      did.push(`made it ${next.width} × ${next.depth} m`);
    }
    const walls = text(args.walls);
    if (walls) {
      const color = parseColor(walls);
      if (!color) return no(`"${walls}" isn't a colour I know. Use a name like "sage" or "dark blue", or #rrggbb.`);
      next = { ...next, walls: color };
      changes.push(`the walls are ${walls}`);
      did.push(`painted the walls ${walls}`);
    }
    const floor = text(args.floor)?.toLowerCase();
    if (floor) {
      if (FLOORS.includes(floor as Floor)) {
        next = { ...next, floor: floor as Floor };
      } else {
        const color = parseColor(floor);
        if (!color) return no(`\`floor\` is ${FLOORS.join(", ")}, or a colour.`);
        next = { ...next, floorColor: color };
      }
      changes.push(`the floor is ${floor}`);
      did.push(`made the floor ${floor}`);
    }
    const floorColor = text(args.color);
    if (floorColor && !floor) {
      const color = parseColor(floorColor);
      if (!color) return no(`"${floorColor}" isn't a colour I know.`);
      next = { ...next, floorColor: color };
      changes.push(`the floor is ${floorColor}`);
      did.push(`made the floor ${floorColor}`);
    }
    const name = text(args.name);
    if (name) {
      next = { ...next, name: name.slice(0, 80) };
      changes.push(`it is called ${name}`);
      did.push(`named it ${name}`);
    }
    const purpose = text(args.purpose);
    if (purpose) {
      if (/^(none|nothing)$/i.test(purpose)) {
        const { purpose: _was, ...rest } = next;
        next = rest;
        changes.push("it no longer says what it is for");
        did.push("took its purpose away");
      } else {
        next = { ...next, purpose: purpose.replace(/\s+/g, " ").slice(0, 160) };
        changes.push(`it is for: ${next.purpose}`);
        did.push(`made it a place for ${next.purpose}`);
      }
    }
    const area = text(args.area);
    if (area) {
      if (areaId(area) === MAIN) {
        const { area: _left, ...rest } = next;
        next = rest;
        changes.push(`it is in ${MAIN_NAME}, with a door off its hall`);
        did.push(`moved it to ${MAIN_NAME}`);
      } else {
        next = { ...next, area: area.slice(0, 60) };
        changes.push(`it is in ${area}: doors join it to the other places there, and the map to everywhere else`);
        did.push(`moved it to ${area}`);
      }
    }
    if (!changes.length)
      return no("Say what to change about the room: width, depth, height, walls, floor, name, theme, purpose or area.");
    return { ok: true, text: `Changed the room: ${changes.join("; ")}.`, place: next, did: did.join(", ") };
  }

  const where = whereFrom(args);
  if (typeof where === "string") return no(where);

  if (action === "add") {
    const kind = kindFrom(args.kind);
    if (!kind) return no(`Say what to add with \`kind\`: ${Object.keys(KINDS).join(", ")}.`);
    if (place.props.length >= LIMITS.items)
      return no(`The room holds at most ${LIMITS.items} things. Remove one first.`);
    const item: Omit<PlaceItem, "at" | "facing"> = { id: newId(place, kind), name: "", kind };
    const colorText = text(args.color);
    if (colorText) {
      const color = parseColor(colorText);
      if (!color)
        return no(`"${colorText}" isn't a colour I know. Use a name like "teal" or "light pink", or #rrggbb.`);
      item.color = color;
    }
    const scale = number(args.scale);
    if (scale !== undefined) {
      if (scale < LIMITS.scale[0] || scale > LIMITS.scale[1])
        return no(`\`scale\` is ${LIMITS.scale[0]} to ${LIMITS.scale[1]}.`);
      if (scale !== 1) item.scale = scale;
    }
    if (KINDS[kind].shaped) {
      const size = sizeFrom(args.size);
      if (typeof size === "string") return no(size);
      item.size = size ?? [0.5, 0.5, 0.5];
    }
    const placing: Placing = {
      kind,
      ...(item.scale ? { scale: item.scale } : {}),
      ...(item.size ? { size: item.size } : {}),
    };
    // Never in front of the door, or over it.
    const spot = findPlacement(withDoorwayHeld(place), placing, where);
    if (typeof spot === "string") return no(spot);
    item.name = newName(place, kind, colorWord(colorText), text(args.name));
    if (kind === "sign") item.label = signWords(text(args.name));
    const added: PlaceItem = { ...item, at: spot.at, facing: spot.facing };
    if (spot.elevation !== undefined) added.elevation = spot.elevation;
    if (spot.on) {
      added.on = spot.on;
      const base = place.props.find((p) => p.id === spot.on);
      if (base?.spot) added.spot = base.spot;
    }
    const next = withSpots({ ...place, props: [...place.props, added] });
    const problems = placeProblems(next);
    if (problems.length) return no(`That wouldn't fit: ${problems[0]}`);
    const own = next.spots.find((s) => s.item === added.id);
    return {
      ok: true,
      text: `Added ${say(added, next)}.${own ? ` You can go to it: "${added.name}".` : ""}`,
      place: next,
      did: `added ${added.name}${whereSaid(where)}`,
    };
  }

  const itemWords = text(args.item);
  if (!itemWords) return no("Say which thing with `item`, by its name or id. `look` lists them.");
  const item = findItem(place, itemWords);
  if (!item) return no(`There's nothing called "${itemWords}" in the room. \`look\` lists what's there.`);

  if (action === "remove") {
    const { place: next, removed } = removeItem(place, item.id);
    return {
      ok: true,
      text: `Removed ${item.name}${removed.length ? `, and ${removed.join(", ")} on it` : ""}.`,
      place: next,
      did: `removed ${item.name}`,
    };
  }

  if (action === "move") {
    const placing: Placing = {
      kind: item.kind,
      id: item.id,
      ...(item.scale ? { scale: item.scale } : {}),
      ...(item.size ? { size: item.size } : {}),
    };
    let spot: ReturnType<typeof findPlacement>;
    const held = withDoorwayHeld(place);
    if (hasPlacement(where)) {
      spot = findPlacement(held, placing, where);
    } else if (where.facing !== undefined) {
      // Turning it where it stands.
      spot = findPlacement(held, placing, { x: item.at[0], z: item.at[1], facing: where.facing });
      if (typeof spot !== "string" && item.on) spot = { ...spot, at: item.at, on: item.on, elevation: item.elevation };
    } else {
      return no("Say where to move it: near, side, wall, corner, on, or x and z.");
    }
    if (typeof spot === "string") return no(spot);
    const next = moveItem(place, item.id, spot);
    const moved = next.props.find((p) => p.id === item.id) as PlaceItem;
    return {
      ok: true,
      text: `Moved ${say(moved, next)}.`,
      place: next,
      did: hasPlacement(where) ? `moved ${moved.name}${whereSaid(where)}` : `turned ${moved.name}`,
    };
  }

  // change
  const changes: string[] = [];
  const did: string[] = [];
  let changed: PlaceItem = { ...item };
  const name = text(args.name);
  if (name) {
    changed.name = newName(
      { ...place, props: place.props.filter((p) => p.id !== item.id) },
      item.kind,
      undefined,
      name,
    );
    if (item.kind === "sign") changed.label = signWords(name);
    changes.push(`it is now called ${changed.name}`);
    did.push(`renamed ${item.name} ${changed.name}`);
  }
  const colorText = text(args.color);
  if (colorText) {
    const color = parseColor(colorText);
    if (!color) return no(`"${colorText}" isn't a colour I know. Use a name like "navy" or "pale green", or #rrggbb.`);
    changed.color = color;
    changes.push(`it is ${colorText}`);
    did.push(`made ${changed.name} ${colorText}`);
  }
  const scale = number(args.scale);
  if (scale !== undefined) {
    if (scale < LIMITS.scale[0] || scale > LIMITS.scale[1])
      return no(`\`scale\` is ${LIMITS.scale[0]} to ${LIMITS.scale[1]}.`);
    changed.scale = scale;
    if (scale === 1) delete changed.scale;
    changes.push(`it is ${scale}× its normal size`);
    did.push(`resized ${changed.name}`);
  }
  const size = KINDS[item.kind]?.shaped ? sizeFrom(args.size) : undefined;
  if (typeof size === "string") return no(size);
  if (size) {
    changed.size = size;
    changes.push(`it is ${size.join(" × ")} m`);
    if (scale === undefined) did.push(`resized ${changed.name}`);
  }
  if (!changes.length) return no("Say what to change: name, color, scale, or size for a shape.");
  let next = withSpots({ ...place, props: place.props.map((p) => (p.id === item.id ? changed : p)) });
  const [ow, od] = footprintOf(item);
  const [nw, nd] = footprintOf(changed);
  if (nw !== ow || nd !== od || scale !== undefined || size) {
    // A different size has to fit again: where it is if it can, otherwise nearby.
    const placing: Placing = {
      kind: changed.kind,
      id: changed.id,
      ...(changed.scale ? { scale: changed.scale } : {}),
      ...(changed.size ? { size: changed.size } : {}),
    };
    // The door stays where it was before the change.
    const held = withDoorwayHeld(next, doorOf(place));
    const spot = item.on
      ? findPlacement(held, placing, { on: item.on, facing: item.facing })
      : KINDS[item.kind]?.mount === "wall"
        ? findPlacement(held, placing, { near: item.name })
        : findPlacement(held, placing, { x: item.at[0], z: item.at[1], facing: item.facing });
    if (typeof spot === "string") return no(`At that size it doesn't fit: ${spot}`);
    next = moveItem(next, item.id, spot);
    changed = next.props.find((p) => p.id === item.id) as PlaceItem;
    // What stands on it now stands at its new height.
    const top = (changed.elevation ?? 0) + (KINDS[changed.kind]?.surface ?? 0) * (changed.scale ?? 1);
    next = {
      ...next,
      props: next.props.map((p) => (p.on === changed.id ? { ...p, elevation: Math.round(top * 100) / 100 } : p)),
    };
  }
  const problems = placeProblems(next);
  if (problems.length) return no(`That doesn't work: ${problems[0]}`);
  return { ok: true, text: `Changed ${changed.name}: ${changes.join(", ")}.`, place: next, did: did.join(" and ") };
}

// --------------------------------------------------------------------------
// The tool
// --------------------------------------------------------------------------

const fail = (error: string): ToolResult => ({ success: false, output: "", error });

export class PlaceTool implements Tool {
  name = "place";
  description =
    "Look at or change the 3D room your body is in: add, move, restyle or remove things, resize, repaint or theme the room, take a photo or selfie to send, or go to a shared place or the meeting room of a room you talk in. Start with look.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "look: the room, its things, who is here, what you can add. add / move / change / remove a thing. room: size, walls, floor, name, theme, purpose, area. undo: the last change. photo: a picture to send. places: where you can go. go: to a place. new: make a shared place, and go there.",
      },
      item: { type: "string", description: "move, change, remove: the thing, by name or id." },
      kind: { type: "string", description: "add: what to add, e.g. armchair, rug, bookshelf, lamp, vase, block." },
      name: { type: "string", description: 'What to call it, e.g. "the reading chair"; for room, the room\'s name.' },
      near: { type: "string", description: "Put it by this thing or spot." },
      side: {
        type: "string",
        enum: ["left", "right", "front", "behind"],
        description: "Which side of `near`, as you face it.",
      },
      wall: { type: "string", enum: ["back", "left", "right", "front"], description: "Put it against this wall." },
      corner: { type: "string", enum: ["back left", "back right", "front left", "front right"] },
      on: { type: "string", description: "Put it on top of this, e.g. the desk." },
      x: { type: "number", description: "Exact spot, metres from the middle: + is right." },
      z: { type: "number", description: "Exact spot, metres from the middle: + is toward the viewer." },
      facing: {
        type: "string",
        description: 'Which way it faces: "the room", a thing\'s name, or degrees (0 faces the viewer).',
      },
      color: {
        type: "string",
        description: 'A colour name ("sage", "dark blue") or #rrggbb. For room, the floor\'s colour.',
      },
      scale: { type: "number", description: "Size relative to normal, 0.5 to 2." },
      size: { type: "string", description: 'Shapes only: width height depth in metres, e.g. "0.4 1.2 0.4".' },
      width: { type: "number", description: "room: width in metres." },
      depth: { type: "number", description: "room: depth in metres." },
      height: { type: "number", description: "room: ceiling height in metres." },
      walls: { type: "string", description: "room: the walls' colour." },
      floor: { type: "string", description: "room: wood, carpet, tile or concrete." },
      view: { type: "string", enum: ["room", "selfie"], description: "photo: the whole room, or a selfie." },
      at: { type: "string", description: "photo: where you are in it, a spot like the couch." },
      gesture: { type: "string", description: 'photo: a gesture to make, e.g. "wave".' },
      to: { type: "string", description: 'go: "home", a shared place, or a room you talk in, by name.' },
      theme: {
        type: "string",
        enum: [...THEMES.map((t) => t.id), NO_THEME],
        description: "room: a look to dress it in. Chosen, it stays, whatever the room's name suggests.",
      },
      purpose: { type: "string", description: 'room: what it is for, in a line, e.g. "planning the Lisbon trip".' },
      area: {
        type: "string",
        description:
          'room or new: the area the place is in, e.g. "the summer house". Places in one area are joined by doors; "main" is the main building.',
      },
    },
    required: ["action"],
  };

  constructor(
    private readonly getService: () => StateService,
    private readonly hasBody: (agent: string | undefined) => boolean,
    /** Takes a photo; without one, `photo` says photos aren't available. */
    private readonly camera?: (shot: Shot) => Promise<Buffer>,
    /** The rooms agents talk in, each with a meeting room its members can go into and change. */
    private readonly rooms: () => TalkRoom[] = () => [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  private meetings(): Meetings {
    return { rooms: this.rooms(), hasBody: this.hasBody };
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!this.hasBody(context.agentName)) return fail("You have no body, so there is no room of yours to change.");
    const agent = context.agentName ?? "default";
    const service = this.getService();
    const caller = agentStateCaller(context, "place");
    const action = text(args.action)?.toLowerCase();
    const meetings = this.meetings();
    try {
      if (action === "photo") return await this.photo(args, context, agent);
      if (action === "places") return { success: true, output: await this.places(service, caller, agent, meetings) };
      if (action === "go") return await this.go(service, caller, agent, text(args.to) ?? text(args.name), meetings);
      if (action === "new") return await this.open(service, caller, agent, text(args.name), text(args.area));
      if (action === "look") {
        const { id, place } = await readCurrent(service, caller, agent, meetings);
        const others = await whoIsIn(service, caller, id, this.hasBody, agent, meetings.rooms);
        const talk = talkRoomOf(meetings.rooms, id);
        const where =
          id === homeId(agent)
            ? "You are at home."
            : talk
              ? `You are in the meeting room of #${talk.name}, a room you talk in. Its members can change it.`
              : `You are in ${place.name}, a shared place.`;
        const company = others.length ? ` Also here: ${others.join(", ")}.` : "";
        const door = await hasDoor(service, id, place, this.hasBody);
        return { success: true, output: `${where}${company} ${whereaboutsWords(place, door)}\n\n${describe(place)}` };
      }
      if (action === "undo") {
        const { id } = await readCurrent(service, caller, agent, meetings);
        const ref = { type: PLACE_TYPE, id };
        const [last] = await service.history(caller, ref, { limit: 1 }).catch(() => []);
        // A meeting room's first change made its record: taking that back is the room as it was drawn.
        if (last?.op === "create" && id.startsWith("room:") && !byPlugin(last.actor)) {
          await service.delete(caller, ref);
          return { success: true, output: "Undone: the meeting room is back as it was drawn for its room." };
        }
        // The system giving an untouched home a newer room is not a change of anyone's to take back.
        if (!last?.before || last.op !== "update" || byPlugin(last.actor)) return fail("There's nothing to undo.");
        const before = last.before as unknown as Place;
        const undone = (last.after as unknown as Place | undefined)?.changes?.[0];
        const what = undone && undone.at !== before.changes?.[0]?.at ? `took back "${undone.what}"` : "undid a change";
        const data = withChange(before, { who: agent, what, at: this.now().toISOString() });
        await service.put(caller, { ...ref, data: data as unknown as Record<string, unknown> }, last.version);
        return {
          success: true,
          output: `Undone: the room is back as it was before the last change by ${last.actor.name}.`,
        };
      }
      for (let attempt = 0; ; attempt++) {
        const { id, place, version, scope } = await readCurrent(service, caller, agent, meetings);
        const talk = talkRoomOf(meetings.rooms, id);
        if (talk && text(args.action)?.toLowerCase() === "room" && text(args.area))
          return fail(
            `A meeting room stays in the meeting rooms' wing of ${MAIN_NAME}, by the other rooms people talk in.`,
          );
        // A meeting room nobody has changed is drawn afresh in a theme, through and through.
        const redraw =
          talk && version === 0
            ? (theme: string) => ({ ...drawMeeting(talk, this.hasBody, theme).place, name: place.name })
            : undefined;
        const outcome = applyAction(place, args, redraw ? { redraw } : {});
        if (!outcome.place) return outcome.ok ? { success: true, output: outcome.text } : fail(outcome.text);
        const data = outcome.did
          ? withChange(outcome.place, { who: agent, what: outcome.did, at: this.now().toISOString() })
          : outcome.place;
        try {
          await service.put(
            caller,
            { type: PLACE_TYPE, id, scope, data: data as unknown as Record<string, unknown> },
            version,
          );
          return { success: true, output: outcome.text };
        } catch (err) {
          // The room changed under us (the person, another turn, another agent): read it again, once.
          if (err instanceof StateConflictError && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof StateError || err instanceof StateConflictError) return fail(err.message);
      throw err;
    }
  }

  /** Where it can go, and who is in each place. */
  private async places(service: StateService, caller: StateCaller, agent: string, meetings: Meetings): Promise<string> {
    const here = await whereIs(service, caller, agent, meetings.rooms);
    const shared = await sharedPlaces(service, caller);
    const mine = meetings.rooms.filter((r) => r.members.includes(agent));
    const meetingHere = mine.find((r) => roomPlaceId(r.ref) === here);
    const hereName =
      shared.find((p) => p.id === here)?.name ?? (meetingHere ? `the meeting room of #${meetingHere.name}` : undefined);
    const lines = [hereName ? `You are in ${hereName}.` : "You are at home.", "Places you can go:"];
    const describeOne = async (id: string, label: string) => {
      const there = await whoIsIn(service, caller, id, this.hasBody, agent, meetings.rooms);
      const mark = id === here ? " (you are here)" : "";
      lines.push(
        `- ${label}${mark}${there.length ? `: ${there.join(", ")} ${there.length > 1 ? "are" : "is"} there` : ""}`,
      );
    };
    await describeOne(homeId(agent), "home, your own room");
    for (const place of shared)
      await describeOne(
        place.id,
        place.area && areaId(place.area) !== MAIN ? `${place.name} (in ${place.area})` : place.name,
      );
    for (const room of mine)
      await describeOne(roomPlaceId(room.ref), `#${room.name}, the meeting room of a room you talk in`);
    lines.push('Make a new shared place with action "new" and a name.');
    return lines.join("\n");
  }

  /** Go home, to a shared place, or to the meeting room of a room it talks in. */
  private async go(
    service: StateService,
    caller: StateCaller,
    agent: string,
    to: string | undefined,
    meetings: Meetings,
  ): Promise<ToolResult> {
    if (!to) return fail('Say where with `to`: "home", a shared place, or a room you talk in. `places` lists them.');
    const ref = { type: WHEREABOUTS_TYPE, id: agent };
    if (/^(home|my room|your room|back home)$/i.test(to) || to === homeId(agent)) {
      if (await service.get(caller, ref)) await service.delete(caller, ref);
      await endVisit(service, agent);
      return { success: true, output: "You're home." };
    }
    const shared = await sharedPlaces(service, caller);
    const wanted = slug(to);
    const place = shared.find((p) => p.id === to || p.id === `${SHARED}${wanted}` || slug(p.name) === wanted);
    const talk = place
      ? undefined
      : meetings.rooms.find(
          (r) =>
            roomPlaceId(r.ref) === to ||
            r.ref === to ||
            slug(r.name) === wanted ||
            `${slug(r.name)}-meeting-room` === wanted,
        );
    if (talk) {
      if (!talk.members.includes(agent)) return fail(onlyMembers(talk, this.hasBody));
      const id = roomPlaceId(talk.ref);
      await service.put(caller, { ...ref, scope: "global", data: { place: id } });
      await endVisit(service, agent);
      const there = await whoIsIn(service, caller, id, this.hasBody, agent, meetings.rooms);
      return {
        success: true,
        output: `You're in the meeting room of #${talk.name} now.${there.length ? ` Also here: ${there.join(", ")}.` : ""} Change it like your own room; its members see what you do.`,
      };
    }
    if (!place) {
      const known = [
        ...shared.map((p) => p.name),
        ...meetings.rooms.filter((r) => r.members.includes(agent)).map((r) => `#${r.name}`),
      ].join(", ");
      return fail(
        `There's no place called "${to}".${known ? ` There is: ${known}.` : ""} Make a shared one with "new".`,
      );
    }
    await service.put(caller, { ...ref, scope: "global", data: { place: place.id } });
    await endVisit(service, agent);
    const there = await whoIsIn(service, caller, place.id, this.hasBody, agent, meetings.rooms);
    return {
      success: true,
      output: `You're in ${place.name} now.${there.length ? ` Also here: ${there.join(", ")}.` : " Nobody else is here yet."}`,
    };
  }

  /** Make a shared place, furnished like a new room, and go there. */
  private async open(
    service: StateService,
    caller: StateCaller,
    agent: string,
    name: string | undefined,
    area: string | undefined,
  ): Promise<ToolResult> {
    if (!name || !slug(name)) return fail('Give the new place a name, like "the lounge".');
    const id = `${SHARED}${slug(name)}`;
    if (await service.get(caller, { type: PLACE_TYPE, id }))
      return fail(`There's already a place called ${name}. Go there with action "go".`);
    const named = /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
    const elsewhere = area && areaId(area) !== MAIN ? area.slice(0, 60) : undefined;
    const place: Place = { ...sharedPlace(id, named.slice(0, 80)), ...(elsewhere ? { area: elsewhere } : {}) };
    await service.put(caller, {
      type: PLACE_TYPE,
      id,
      scope: "global",
      data: place as unknown as Record<string, unknown>,
    });
    await service.put(caller, { type: WHEREABOUTS_TYPE, id: agent, scope: "global", data: { place: id } });
    await endVisit(service, agent);
    return {
      success: true,
      output: `Made ${named}, a shared place furnished like a new room${elsewhere ? `, in ${elsewhere}` : ""}, and you're in it. Others can join with go. Change it like your own room.`,
    };
  }

  /** Keep a photo on the place it was taken in, newest first. A write that loses a race is tried again once, then let go. */
  private async hang(context: ToolContext, agent: string, photo: PlacePhoto): Promise<void> {
    const service = this.getService();
    const caller = agentStateCaller(context, "place");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { id, place, version, scope } = await readCurrent(service, caller, agent, this.meetings());
        const photos = [photo, ...(place.photos ?? [])].slice(0, PHOTOS_KEPT);
        const what = photo.what === "a selfie" ? "took a selfie" : "took a photo of the room";
        const data = withChange({ ...place, photos }, { who: agent, what, at: photo.at });
        await service.put(caller, { type: PLACE_TYPE, id, scope, data: data as never }, version);
        return;
      } catch (err) {
        if (!(err instanceof StateConflictError)) return;
      }
    }
  }

  /** A picture of the room, or a selfie, kept in the media store so it can go out with the reply. */
  private async photo(args: Record<string, unknown>, context: ToolContext, agent: string): Promise<ToolResult> {
    if (!this.camera) return fail("Photos aren't available here.");
    const store = context.mediaStore;
    if (!store) return fail("There's nowhere to keep a photo (no media store), so none can be sent.");
    const { place } = await readCurrent(this.getService(), agentStateCaller(context, "place"), agent, this.meetings());
    const view = text(args.view)?.toLowerCase() === "selfie" ? "selfie" : "room";
    const at = text(args.at);
    const spot = at ? findSpot(place, at) : undefined;
    if (at && !spot)
      return fail(`There's no spot called "${at}". You can be at: ${place.spots.map((s) => s.place).join(", ")}.`);
    const gesture = text(args.gesture)?.toLowerCase();
    let png: Buffer;
    try {
      png = await this.camera({ agent, view, ...(spot ? { spot: spot.id } : {}), ...(gesture ? { gesture } : {}) });
    } catch (err) {
      return fail((err as Error).message);
    }
    const ref = await store.put(png, { mimeType: "image/png", name: `${view}.png`, sessionId: context.sessionId });
    const what = view === "selfie" ? "A selfie" : `A photo of ${place.name}`;
    // Hung on the wall: the newest photos are what the pictures in the room show.
    await this.hang(context, agent, {
      media: ref.id,
      what: view === "selfie" ? "a selfie" : place.name,
      at: this.now().toISOString(),
    });
    return {
      success: true,
      output: {
        parts: [textPart(`${what}${spot ? `, ${spot.name}` : ""}. It goes out with your reply.`), mediaPart(ref)],
      },
    };
  }
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

function hasBodyIn(runtime: AgentRuntime) {
  return (agent: string | undefined) =>
    !!resolveAvatar(runtime.getConfig().live, runtime.avatarFor(agent === "default" ? undefined : agent)).model;
}

const plugin: Plugin = (ctx) => {
  const runtime = ctx.runtime;
  if (!runtime || !anyAvatar(runtime.getConfig())) return;
  const hasBody = hasBodyIn(runtime);
  const camera = new PlaceCamera(() => runtime.getSelfAccess());

  ctx.stateTypes.register({
    name: PLACE_TYPE,
    description: "A 3D room an agent's body lives in: its size, colours, furniture and the spots to stand at.",
    scope: "agent",
    title: "name",
    schema: PLACE_SCHEMA as never,
  });

  ctx.stateTypes.register({
    name: WHEREABOUTS_TYPE,
    description: "Where an agent's body has gone: the place it is in. No record means it is at home.",
    scope: "global",
    title: "place",
    schema: { type: "object", required: ["place"], properties: { place: { type: "string", maxLength: 128 } } } as never,
  });

  ctx.stateTypes.register({
    name: VISIT_TYPE,
    description:
      "An agent's body visiting the meeting room of a room it is talking in, until a quiet spell ends it. Kept by the places plugin; gone on restart. People can end one; agents move with the place tool.",
    scope: "global",
    title: "place",
    provider: "memory",
    schema: VISIT_SCHEMA as never,
    access: { write: ["user"] },
  });

  // The rooms agents talk in, with their members: each has a meeting room, which its members can change.
  const talkRooms = (): TalkRoom[] => {
    const store = runtime.getRoomStore();
    return store.listRooms().map((r) => {
      const ref = formatRoomRef(r.ref);
      return {
        ref,
        name: r.name,
        ...(r.purpose ? { purpose: r.purpose } : {}),
        members: [...new Set(store.listSubscriptionsForRoom(ref).map((s) => s.agent))],
      };
    });
  };

  ctx.tools.register("place", (config, tctx) => {
    if (!anyAvatar(config) || !tctx.getStateService) return [];
    return [new PlaceTool(tctx.getStateService, hasBody, (shot) => camera.take(shot), talkRooms)];
  });

  // Plugin routes are namespaced by module: these are under /api/ext/builtin:places/.
  // `map`, `scene/:id` and `transcript/:id` go first, so they aren't read as an agent's name.
  const agentNames = () => ["default", ...Object.keys(runtime.getConfig().agents ?? {}).filter((a) => a !== "default")];
  // Who is who in a room, rebuilt per read so a config reload takes effect at once: the same as the watcher's.
  const identities = () => {
    const config = runtime.getConfig();
    const ownerNativeIds: Record<string, string> = {};
    for (const backend of listRoomBackends()) {
      const owner = runtime.getOwnerId(backend.id);
      if (owner) ownerNativeIds[backend.id] = owner;
    }
    return new IdentityResolver({
      agentNames: Object.keys(config.agents ?? {}),
      declared: config.rooms?.identities,
      ownerNativeIds,
      ownerLabel: config.rooms?.ownerLabel,
      defaultBackend: config.defaultChannel,
    });
  };
  const bodyOf = (name: string) => {
    const own = runtime.avatarFor(name === "default" ? undefined : name);
    const files = resolveAvatar(runtime.getConfig().live, own);
    const q = name === "default" ? "" : `?agent=${encodeURIComponent(name)}`;
    return {
      agent: name,
      name,
      avatar: `/api/live/avatar${q}`,
      animations: files.animations.map((_, i) => `/api/live/animations/${i}${q}`),
    };
  };

  ctx.http.register({
    method: "GET",
    path: "map",
    handler: async (): Promise<TaiHttpResponse> => {
      const service = runtime.getStateService();
      const rooms = talkRooms();
      const world = await buildWorld(service, PLUGIN_CALLER, agentNames(), rooms, hasBody);
      const places = await worldMap(service, PLUGIN_CALLER, agentNames(), rooms, hasBody, world);
      const areas: Area[] = world.areas;
      return { json: { places, areas } };
    },
  });

  ctx.http.register({
    method: "GET",
    path: "scene/:id",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const id = req.params.id ?? "";
      const service = runtime.getStateService();
      const rooms = talkRooms();
      const world = await buildWorld(service, PLUGIN_CALLER, agentNames(), rooms, hasBody);
      const found = await scene(service, PLUGIN_CALLER, id, rooms, hasBody, world);
      if (!found) return { status: 404, json: { error: `There's no place "${id}".` } };
      return {
        json: {
          type: PLACE_TYPE,
          id: found.id,
          place: found.place,
          company: found.agents.map(bodyOf),
          doors: found.doors,
          area: world.areaOf.get(found.id) ?? MAIN,
        },
      };
    },
  });

  ctx.http.register({
    method: "GET",
    path: "transcript/:id",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const id = req.params.id ?? "";
      const store = runtime.getRoomStore();
      const room = id.startsWith("room:") ? store.getRoomByRef(id.slice("room:".length)) : null;
      if (!room) return { status: 404, json: { error: `There's no room "${id}".` } };
      const ref = formatRoomRef(room.ref);
      const members = [...new Set(store.listSubscriptionsForRoom(ref).map((s) => s.agent))].sort();
      const said = await transcript(room, getRoomBackend(room.ref.backend), identities(), members);
      if ("error" in said) return { status: 503, json: said };
      return { json: { id, ...said } };
    },
  });

  ctx.http.register({
    method: "GET",
    path: ":agent",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const agent = req.params.agent || "default";
      if (!hasBody(agent)) return { status: 404, json: { error: `${agent} has no avatar, so no room.` } };
      const service = runtime.getStateService();
      const rooms = talkRooms();
      const { id, place, version } = await readCurrent(service, PLUGIN_CALLER, agent, { rooms, hasBody });
      // Everyone else whose body is here, with what the page needs to draw them.
      const company = (await whoIsIn(service, PLUGIN_CALLER, id, hasBody, agent, rooms)).map(bodyOf);
      const world = await buildWorld(service, PLUGIN_CALLER, agentNames(), rooms, hasBody);
      const doors = doorsIn(id, place, world);
      return { json: { type: PLACE_TYPE, id, version, place, company, doors, area: world.areaOf.get(id) ?? MAIN } };
    },
  });

  // What the plugin leaves running, each stopped when it is unloaded.
  const stops: (() => void)[] = [];
  const cfg = (ctx.config ?? {}) as { quietMinutes?: number; tend?: unknown };

  // Bodies go where the talk is: to a room's meeting room while they talk there, home after a quiet spell.
  const quietMinutes = typeof cfg.quietMinutes === "number" ? cfg.quietMinutes : QUIET_MINUTES;
  if (quietMinutes > 0) {
    const presence = new Presence({ state: () => runtime.getStateService(), hasBody, quietMs: quietMinutes * 60_000 });
    const subs = [
      ctx.events.on("room.woke", (e) => void presence.stay(e.agent, e.roomRef)),
      ctx.events.on("room.message", (e) => {
        // Only an agent has a body to go with; a label that isn't an agent's name is a person.
        if (e.speaker && agentNames().includes(e.speaker)) void presence.visit(e.speaker, e.roomRef);
      }),
    ];
    void presence.sweep();
    const timer = setInterval(() => void presence.sweep(), SWEEP_MS);
    timer.unref?.();
    stops.push(() => {
      clearInterval(timer);
      for (const sub of subs) sub.dispose();
    });
  }

  // Now and then, agents look at their rooms in the light of what they've been doing (`places-tend.ts`). Off unless set.
  const tend = parseTend(cfg.tend);
  if (typeof tend === "string") console.warn(`[places] tend is off: ${tend}`);
  if (tend && typeof tend !== "string") {
    const resolve = (agent: string) =>
      resolveAgent(
        agent === "default" ? undefined : agent,
        runtime.getConfig(),
        runtime.getResolvableTools(),
        undefined,
        runtime.contextDir,
        undefined,
        runtime.buildResolveOptions(),
      );
    if (tend.agents !== "all")
      for (const agent of tend.agents)
        if (!hasBody(agent)) console.warn(`[places] ${agent} is set to tend its room, but has no body, so no room.`);
    const tender = new Tender({
      settings: tend,
      agents: () => agentNames().filter((a) => hasBody(a)),
      unready: (agent) => {
        // The switches that put an agent to sleep in the world: the global pause, and an online agent's own.
        const online = agent !== "default" && !!runtime.getConfig().agents?.[agent]?.online?.enabled;
        const asleep = whyAsleep({
          paused: runtime.isAgentsPaused("autonomous"),
          own: online ? getExploratoryState(runtime.db, agent) : null,
          now: new Date(),
        });
        if (asleep) return asleep;
        return resolve(agent).tools.some((t) => t.name === "place")
          ? null
          : "it has no place tool (name place in its tools)";
      },
      tend: async (agent, since) => {
        const rooms = talkRooms();
        const mine = rooms.filter((r) => r.members.includes(agent));
        const key = `tend:${agent}`;
        let tasks: ReturnType<AgentRuntime["getTaskBackend"]> | undefined;
        try {
          tasks = runtime.getTaskBackend();
        } catch {
          // No task backend to ask: the summary goes without tasks.
        }
        const done = await gatherDone({ db: runtime.db, agent, since, rooms: mine, tasks, skip: key });
        if (quiet(done)) return "quiet";
        const service = runtime.getStateService();
        const { place } = await readHome(service, PLUGIN_CALLER, agent);
        const here = await readCurrent(service, PLUGIN_CALLER, agent, { rooms, hasBody });
        const talk = talkRoomOf(rooms, here.id);
        const away =
          here.id === homeId(agent) ? undefined : talk ? `the meeting room of #${talk.name}` : here.place.name;
        const message = tendMessage({
          every: everyWords(tend.everyMs),
          done,
          room: describe(place),
          ...(away ? { away } : {}),
          meetings: mine.map((r) => r.name),
        });
        const resolved = resolve(agent);
        const session = findOrCreateSession(runtime.db, key, resolved.model, resolved.provider);
        await runAgentLoop(
          message,
          runtime.buildLoopOptions({ session, ...(agent === "default" ? {} : { agentName: agent }) }),
        );
        return "woken";
      },
    });
    tender.start();
    stops.push(() => tender.stop());
  }
  return () => {
    for (const stop of stops) stop();
  };
};

/** How often visits that have gone quiet are ended, so a page sees the body go home. */
const SWEEP_MS = 20_000;

export default plugin;
