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
 * What an agent is for, read from its name, description, instructions and
 * tools (`places-roles.ts`), picks the kind of home it starts with and what it
 * wears. The `body` tool (`places-body.ts`) lets it choose how its body looks
 * and carries itself, what it wears among the rest, make a gesture, and go to
 * a spot and stay there; a person chooses the same on its card. The place
 * tool's `room` action still takes what to wear, as before.
 *
 * Agents can make things of their own for the world too (`places-models.ts`,
 * `places-build.ts`): models from simple parts, some with a face people use
 * in the room, kept as `model` records. The `build` tool that makes them is
 * opt-in (`build: true`); the `place` tool adds any model to a room by name,
 * and makes a ready-made one (a to-do board, a habit tracker, a notes card)
 * the agent's own the first time.
 *
 * Free when unused: with no avatar configured, it registers nothing. An agent
 * with its own `tools:` list needs `place` (and `body`) named in it, like any
 * tool.
 */
import { isDeepStrictEqual } from "node:util";
import { resolveAgent } from "../agent/agents.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { mediaPart, textPart } from "../content/types.js";
import { getExploratoryState } from "../db/exploratory-queries.js";
import type { EventBus, Subscription } from "../events.js";
import type { TaiHttpRequest, TaiHttpResponse } from "../http/registry.js";
import { interfaceStoreFor } from "../interfaces/index.js";
import { avatarModelNamed, avatarModels, resolveAvatar } from "../live/avatar.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { enrichRoomMessage, IdentityResolver } from "../rooms/identities.js";
import { getRoomBackend, listRoomBackends } from "../rooms/registry.js";
import { formatRoomRef, type RoomBackend, type RoomMessage, type Room as TalkRoomRecord } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";
import { stateTypeRegistry } from "../state/registry.js";
import type { StateCaller, StateService } from "../state/service.js";
import { type Actor, type StateChange, StateConflictError, StateError, type StateRecord } from "../state/types.js";
import { runtimeTimeProvider } from "../time/provider.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { agentStateCaller } from "../tools/state.js";
import { whyAsleep } from "./activity.js";
import {
  BODY_SCHEMA,
  BODY_TYPE,
  type BodyData,
  BodyTool,
  bodyWith,
  type Chosen,
  changeBody,
  EMOTE_SCHEMA,
  EMOTE_TYPE,
  looksOf,
  ranOut,
  WEAR_SCHEMA,
  WEAR_TYPE,
  wornBy,
} from "./places-body.js";
import { BuildTool, ModelShelf, modelsIn, turnHabits } from "./places-build.js";
import { PlaceCamera, type Shot } from "./places-camera.js";
import { applyEdit, editFrom } from "./places-edit.js";
import {
  CHANGE_LENGTH,
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
  SHOWS_KINDS,
  SHOWS_LENGTH,
  type Side,
  type Wall,
  type Where,
  whereWords,
  withDoorwayHeld,
  withSpots,
} from "./places-layout.js";
import {
  dayIn,
  FACE_TYPES,
  isModelKind,
  MODEL_SCHEMA,
  MODEL_TYPE,
  MOUNT_KIND,
  type Model,
  modelId,
  modelName,
  READY,
} from "./places-models.js";
import { type AgentAbout, aOrAn, homeFor, parseWear, type Role, readRole, WEAR, wearWords } from "./places-roles.js";
import {
  homePlace,
  LOBBY,
  lobby,
  meetingRoom,
  NO_THEME,
  retheme,
  sharedPlace,
  THEMES,
  themeFor,
  themeNamed,
} from "./places-rooms.js";
import { everyWords, gatherDone, parseTend, quiet, Tender, tendMessage } from "./places-tend.js";
import { TOWN, type Town, townPlace } from "./places-town.js";
import {
  type Area,
  areaId,
  doorsIn,
  floorPlace,
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
    { kind: "stateType", id: "body" },
    { kind: "stateType", id: "emote" },
    { kind: "stateType", id: "wear" },
    { kind: "stateType", id: "model" },
    { kind: "stateType", id: "todo" },
    { kind: "stateType", id: "habit" },
    { kind: "stateType", id: "note" },
    { kind: "tool", id: "place" },
    { kind: "tool", id: "body" },
    { kind: "tool", id: "build" },
    { kind: "httpRoutes", id: "places" },
    { kind: "httpRoutes", id: "map" },
  ],
};

/** Where the page loads one of the deployment's models from, by name (see `avatarModels`). */
export const modelUrl = (name: string) => `/api/live/avatar?model=${encodeURIComponent(name)}`;

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
 * The newest change to a place that wasn't a person's on the page, when
 * every change a person made since has been taken back: their change and
 * their undo of it leave the room exactly as it was, which is nobody's
 * change. Undefined when one of theirs still stands, or there is nothing but
 * theirs. `changes` is newest first, and `now` the record's data, none when
 * there is no record (a meeting room a person took back to being drawn).
 */
function pastPeople(changes: StateChange[], now: Record<string, unknown> | undefined): StateChange | undefined {
  const standing = changes.find((c) => c.actor.kind !== "user");
  if (!standing) return undefined;
  const same = now ? !!standing.after && isDeepStrictEqual(standing.after, now) : standing.op === "delete";
  return same ? standing : undefined;
}

/** How far back the place tool's undo looks past a person's changes that they took back. */
const PEOPLE_LOOK = 50;

/**
 * Whether a home is still as the system gave it: since the room was last
 * made, no agent, person or other plugin has changed it. The room was made
 * by this plugin, or in the agent's name when its first `place` call found
 * no room (then it is the first room exactly), and this plugin wrote every
 * version since, giving it a newer room. What came before a delete was
 * another room. A person's changes on the page that they took back count
 * for nothing, so trying Edit room doesn't keep a home from a newer room.
 * Anything else is someone's room and is never replaced.
 */
async function untouched(service: StateService, record: StateRecord): Promise<boolean> {
  const asMade = (actor: Actor, data: Record<string, unknown> | undefined) =>
    byPlugin(actor) || (actor.kind === "agent" && !!data && isFirstHome(data as unknown as Place));
  if (record.version === 1) return asMade(record.updatedBy, record.data);
  const person = record.updatedBy.kind === "user";
  if (!person && !byPlugin(record.updatedBy) && record.updatedBy.kind !== "agent") return false;
  const ref = { type: record.type, id: record.id };
  const history = (limit: number) => service.history(PLUGIN_CALLER, ref, { limit }).catch(() => undefined);
  // An agent wrote last: untouched only if that write made the room, which the newest entry alone says.
  if (record.updatedBy.kind === "agent") {
    const [last] = (await history(1)) ?? [];
    return last?.op === "create" && asMade(last.actor, last.after);
  }
  const changes = await history(record.version);
  if (!changes) return false;
  // A person wrote last: untouched only if the room is just as it was before their changes, and was untouched then.
  let from = 0;
  if (person) {
    const standing = pastPeople(changes, record.data);
    if (!standing) return false;
    if (standing.actor.kind === "agent") return standing.op === "create" && asMade(standing.actor, standing.after);
    if (!byPlugin(standing.actor)) return false;
    from = changes.indexOf(standing);
  }
  // Newest first: everything written since the room was last made, which must be in the history.
  const since: StateChange[] = [];
  for (const change of changes.slice(from)) {
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

/** The kind of home that suits an agent, and what its work needs in it (see `places-roles.ts`). */
export type HomeKind = { kind?: string; dressing?: string };
/** What kind of home suits each agent, by name: nothing for one whose home is just the seed's. */
export type HomeFor = (agent: string) => HomeKind | undefined;

const drawHome = (id: string, name: string, home: HomeKind = {}) =>
  drawOnce(`home\n${id}\n${name}\n${home.kind ?? ""}\n${home.dressing ?? ""}`, () =>
    homePlace(id, name, home.kind, home.dressing),
  );

/**
 * An agent's home: its own room, drawn from its id the first time anyone
 * asks, as the kind of home that suits what it is for (`homeFor`). A home
 * nobody has changed is brought up to the room its id draws now, so homes
 * made before rooms were drawn from a seed, or before they suited their
 * agents, get one too; a home anyone has changed is left exactly as it is.
 */
export async function readHome(
  service: StateService,
  caller: StateCaller,
  agent: string,
  homes?: HomeFor,
): Promise<{ place: Place; version: number }> {
  const ref = { type: PLACE_TYPE, id: homeId(agent) };
  const name = agent === "default" ? "your room" : `${agent}'s room`;
  const home = homes?.(agent);
  const found = await service.get(caller, ref);
  if (found) {
    const fresh = await upgrade(service, found, name, home);
    return fresh ?? { place: found.data as unknown as Place, version: found.version };
  }
  const place = drawHome(ref.id, name, home);
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
  home?: HomeKind,
): Promise<{ place: Place; version: number } | undefined> {
  const stored = record.data as unknown as Place;
  const place = drawHome(record.id, typeof stored.name === "string" ? stored.name : name, home);
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

/** The bodies' `wear` record type and schema, from before what a body wears was its body record's. */
export { WEAR_SCHEMA, WEAR_TYPE } from "./places-body.js";

/**
 * Every body as chosen, by agent, with the old `wear` records: one query each
 * for a room full of bodies. A store that keeps none has none.
 */
export async function chosenBodies(service: StateService, caller: StateCaller): Promise<Chosen> {
  const all = (type: string) =>
    service.query(caller, { type, limit: 500 }).catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const [bodies, wear] = await Promise.all([all(BODY_TYPE), all(WEAR_TYPE)]);
  return {
    bodies: new Map(bodies.map((r) => [r.id, r.data as BodyData])),
    wear: new Map(wear.map((r) => [r.id, r.data.wear])),
  };
}

/**
 * What an agent's role is read from: the name it goes by, and its
 * definition's description, instructions and tool list. The default agent's
 * name is no word for anything, and an agent given every tool (no list) says
 * nothing by its tools.
 */
export function aboutAgent(
  agent: string,
  def: { description?: string; instructions?: string; tools?: string[] } | undefined,
): AgentAbout {
  return {
    name: agent === "default" ? "" : agent,
    ...(def?.description ? { description: def.description } : {}),
    ...(def?.instructions ? { instructions: def.instructions } : {}),
    ...(def?.tools ? { tools: def.tools } : {}),
  };
}

/** The map's places, each home saying what its owner is, wears and looks like, for the map's list of agents and each agent's card. */
export function withLooks<P extends { kind: string; owner?: string }>(
  places: P[],
  roleOf: (agent: string) => Role | undefined,
  chosen: Chosen,
) {
  return places.map((p) => (p.kind === "home" && p.owner ? { ...p, ...looksOf(p.owner, roleOf(p.owner), chosen) } : p));
}
/** Shared places are `place` records everyone can see, named `shared:<slug>`. */
const SHARED = "shared:";

/**
 * A body visiting somewhere for a while (see {@link Presence}): the meeting
 * room of a room it is talking in. One record per agent, naming the place and
 * when the visit ends. Kept in memory, apart from whereabouts, since it lasts
 * minutes: where the agent lives is never written for it, and a restart ends
 * every visit.
 */
export const VISIT_TYPE = "visit";

/** The place a visit record has a body in now; nothing once the visit has ended. */
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
 * A meeting room as people see it: what it is for is what its members said,
 * or else its room's own purpose. Only for showing: kept out of the record,
 * so a room whose purpose changes later isn't held to the old one.
 */
function shownPurpose(place: Place, room: TalkRoom | undefined): Place {
  return room?.purpose && !place.purpose ? { ...place, purpose: room.purpose } : place;
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
 * Every body that has gone somewhere, and where it is now: a place it is
 * visiting, or where it went. Whereabouts naming a meeting room stand only
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
  homes?: HomeFor,
): Promise<{ id: string; place: Place; version: number; scope: string }> {
  const id = await whereIs(service, caller, agent, meetings?.rooms);
  const found = id === homeId(agent) ? undefined : await service.get(caller, { type: PLACE_TYPE, id });
  if (found) return { id, place: found.data as unknown as Place, version: found.version, scope: found.scope };
  const talk = talkRoomOf(meetings?.rooms, id);
  if (talk && meetings) return { id, place: drawMeeting(talk, meetings.hasBody).place, version: 0, scope: "global" };
  return { id: homeId(agent), ...(await readHome(service, caller, agent, homes)), scope: `agent:${agent}` };
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

/** A photo on a wall somewhere, as the photo wall shows it: where it was taken, and by whom when that is known. */
export interface WallPhoto extends PlacePhoto {
  place: string;
  placeName: string;
  by?: string;
}

/** Photos the photo wall shows at most: the newest, from every place. */
export const WALL_PHOTOS = 40;

/**
 * Every photo kept on a place, newest first, with where it was taken and who
 * took it: the change the photo made to the place says who, and failing that
 * a home's photos are its owner's.
 */
export function wallPhotos(records: { id: string; data: unknown }[], limit = WALL_PHOTOS): WallPhoto[] {
  const out: WallPhoto[] = [];
  for (const r of records) {
    const place = r.data as Partial<Place>;
    for (const photo of place.photos ?? []) {
      if (!photo?.media || !photo.at) continue;
      const change = place.changes?.find((c) => c.at === photo.at && /^took a (selfie|photo)/.test(c.what));
      const by = change?.who ?? (r.id.startsWith("home:") ? r.id.slice("home:".length) : undefined);
      out.push({
        media: photo.media,
        what: photo.what,
        at: photo.at,
        place: r.id,
        placeName: String(place.name ?? r.id),
        ...(by ? { by } : {}),
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** What each place someone gave a purpose is for, by id: one query for the map, however many places there are. */
async function purposes(service: StateService, caller: StateCaller): Promise<Map<string, string>> {
  const records = await service
    .query(caller, { type: PLACE_TYPE, where: { purpose: { ne: null } }, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  return new Map(records.map((r) => [r.id, String((r.data as unknown as Place).purpose ?? "")]));
}

/**
 * The town every place is in (see `places-world.ts`): the homes of the agents
 * with bodies, the shared places, and the rooms agents talk in, each in the
 * area its record says, and each meeting room in the look its members chose
 * or its words call for, which may give it a building of its own. Only
 * records that name an area or a look are read, so a town of fifty homes costs
 * three queries, not fifty reads.
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
  const looks = await service
    .query(caller, { type: PLACE_TYPE, where: { theme: { ne: null } }, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const themeOf = new Map(looks.map((r) => [r.id, String((r.data as unknown as Place).theme ?? "")]));
  // A look chosen beats the one the words call for, and "none" is a choice: a plain room in the office.
  const look = (r: TalkRoom) => {
    const chosen = themeOf.get(roomPlaceId(r.ref));
    const theme = chosen ? (chosen === NO_THEME ? undefined : chosen) : themeFor(`${r.name} ${r.purpose ?? ""}`)?.id;
    return theme ? { theme } : {};
  };
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
    ...rooms.map((r) => ({ id: roomPlaceId(r.ref), name: r.name, kind: "room" as const, ...look(r) })),
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

/** One place on the map: the town, the town hall's lobby, a floor of the office, a home, a shared place, or a room of conversation, and who is in it. */
export interface MapPlace {
  id: string;
  name: string;
  kind: "town" | "lobby" | "office" | "home" | "shared" | "room";
  agents: string[];
  /** The area it is in, by id: `main` for the town. */
  area: string;
  /** The agent whose home it is. */
  owner?: string;
  /** The street its building's door is on: "Maple Lane". */
  street?: string;
  purpose?: string;
  /** A room of conversation's members with a body, wherever their bodies are. */
  members?: string[];
  /** The place its way in is through: the town for a building, the floor of the office for a room in it. None for the town. */
  via?: string;
  /** A home's owner, in a word, when what it is for can be read (see `places-roles.ts`). */
  role?: string;
  /** What a home's owner wears. */
  wear?: string[];
  /** Someone chose that, rather than it being what suits its role. */
  wearChosen?: boolean;
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
 * Every place there is: the town, the town hall's lobby, the floors of the
 * office, each agent's home, the shared places, and the rooms agents talk in,
 * each with the area it is in and the street its building is on.
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
  // Where each place is reached from, for "where am I": a floor from the one below, anything else from its door;
  // and the street a building's door is on.
  const via = (id: string) => {
    const from = world.floors.find((f) => f.id === id)?.entrance.to ?? world.doors.get(id)?.to;
    const street = world.town.buildings.find((b) => b.id === id)?.street;
    return { ...(from ? { via: from } : {}), ...(street ? { street } : {}) };
  };
  const inIt = (id: string) => ({ agents: (inside.get(id) ?? []).sort() });
  return [
    { id: TOWN, name: "the town", kind: "town" as const, agents: [], area: MAIN },
    { id: LOBBY, name: "the town hall", kind: "lobby" as const, agents: [], area: MAIN, ...via(LOBBY) },
    ...world.floors.map((f) => ({
      id: f.id,
      name: f.name,
      kind: "office" as const,
      agents: [],
      area: MAIN,
      ...via(f.id),
    })),
    ...bodies.map((a) => ({
      id: homeId(a),
      name: a === "default" ? "the default agent's room" : `${a}'s room`,
      kind: "home" as const,
      owner: a,
      ...inIt(homeId(a)),
      area: area(homeId(a)),
      ...purpose(homeId(a)),
      ...via(homeId(a)),
    })),
    ...shared.map((p) => ({
      id: p.id,
      name: p.name,
      kind: "shared" as const,
      ...inIt(p.id),
      area: area(p.id),
      ...purpose(p.id),
      ...via(p.id),
    })),
    ...rooms.map((r) => ({
      id: roomPlaceId(r.ref),
      name: r.name,
      kind: "room" as const,
      ...inIt(roomPlaceId(r.ref)),
      members: r.members.filter((m) => hasBody(m)).sort(),
      area: MAIN,
      // The purpose its members gave its meeting room, over the room's own.
      ...purpose(roomPlaceId(r.ref), r.purpose),
      ...via(roomPlaceId(r.ref)),
    })),
  ];
}

/**
 * Any place, to look at: what it looks like, who is in it, and, given the
 * building, its doors. A room of conversation is a meeting room with a seat
 * for each member, and in it the members there now, drawn fresh until one of
 * them changes it and kept from then on; the town and the office's floors
 * are laid out from what there is, always drawn fresh; the lobby is drawn fresh until a
 * person changes it. What a write to it needs comes too: its record's version
 * (0 while it is drawn fresh, so the first change makes the record), the
 * scope it is in, and `lent`, the fields shown that aren't the record's own.
 */
export async function scene(
  service: StateService,
  caller: StateCaller,
  id: string,
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
  world?: World,
  homes?: HomeFor,
): Promise<(SceneOf & { doors: PlaceDoor[] }) | null> {
  const found = await sceneOf(service, caller, id, rooms, hasBody, world, homes);
  if (!found) return null;
  return { ...found, doors: world ? doorsIn(id, found.place, world) : [] };
}

/**
 * The town as a place, made once for each town laid out. {@link layWorld} hands out the same town while nothing in it
 * changes, so the town itself is the key: any change to it, down to a building's kind or a plot's name, is a new one.
 */
const towns = new WeakMap<Town, Place>();
function townOf(town: Town): Place {
  let place = towns.get(town);
  if (!place) {
    place = townPlace(town);
    towns.set(town, place);
  }
  return place;
}

/** A place as {@link scene} finds it, before its doors. */
interface SceneOf {
  id: string;
  place: Place;
  agents: string[];
  version: number;
  scope: string;
  /** Fields shown that come from elsewhere, not the record: a meeting room's purpose, from its room. */
  lent?: string[];
}

async function sceneOf(
  service: StateService,
  caller: StateCaller,
  id: string,
  rooms: TalkRoom[],
  hasBody: (agent: string | undefined) => boolean,
  world: World | undefined,
  homes: HomeFor | undefined,
): Promise<SceneOf | null> {
  if (id === LOBBY) {
    // Drawn fresh until a person changes it, and kept as they left it from then on.
    const kept = await service.get(caller, { type: PLACE_TYPE, id }).catch(() => null);
    return kept
      ? { id, place: kept.data as unknown as Place, agents: [], version: kept.version, scope: kept.scope }
      : { id, place: drawOnce(LOBBY, lobby), agents: [], version: 0, scope: "global" };
  }
  if (id === TOWN) {
    if (!world) return null;
    return { id, place: townOf(world.town), agents: [], version: 0, scope: "global" };
  }
  const floor = world?.floors.find((f) => f.id === id);
  if (floor) {
    return {
      id,
      place: drawOnce(`floor\n${id}\n${floor.name}\n${floor.rooms.length}`, () => floorPlace(floor)),
      agents: [],
      version: 0,
      scope: "global",
    };
  }
  if (id.startsWith("room:")) {
    const room = talkRoomOf(rooms, id);
    if (!room) return null;
    // Once a member has changed it, it is kept: drawn from the record, never from its name again.
    const kept = await service.get(caller, { type: PLACE_TYPE, id }).catch(() => null);
    const own = kept ? (kept.data as unknown as Place) : drawMeeting(room, hasBody).place;
    const place = shownPurpose(own, room);
    return {
      id,
      place,
      agents: await whoIsIn(service, caller, id, hasBody, undefined, rooms),
      version: kept?.version ?? 0,
      scope: kept?.scope ?? "global",
      ...(place.purpose !== own.purpose ? { lent: ["purpose"] } : {}),
    };
  }
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    if (!hasBody(owner)) return null;
    const { place, version } = await readHome(service, caller, owner, homes);
    return {
      id,
      place,
      agents: await whoIsIn(service, caller, id, hasBody, undefined, rooms),
      version,
      scope: `agent:${owner}`,
    };
  }
  const found = await service.get(caller, { type: PLACE_TYPE, id });
  if (!found) return null;
  const agents = await whoIsIn(service, caller, id, hasBody, undefined, rooms);
  return { id, place: found.data as unknown as Place, agents, version: found.version, scope: found.scope };
}

// --------------------------------------------------------------------------
// Bodies going where the talk is
// --------------------------------------------------------------------------

/** How long a body stays in a meeting room after it last said something or was woken there, unless plugin config says. */
export const QUIET_MINUTES = 10;
/** A visit isn't written again for every message: only once it has run down this far. */
const VISIT_REFRESH_MS = 60_000;

/**
 * Agents' bodies going where the talk is. Saying something in a room, an
 * agent with a body goes to that room's meeting room: its `visit` record
 * names the room's place, with an `until` a quiet spell away. Each thing it
 * says there, and each time the room wakes it while it is there, moves
 * `until` on; being woken alone moves nobody, so an agent that reads a room
 * and keeps quiet stays where it was. Round the table, the members there are
 * near each other. A direct message moves nobody (see {@link Talks}).
 *
 * Once a visit ends, the body is back where it lives (see {@link visitOf}),
 * and {@link sweep} removes the record, so a page watching visits sees it go.
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

  /** Visit a place. Arriving, the body goes there, or stays a while longer if it is there already; otherwise only a visit there is kept on. */
  private async go(agent: string, id: string, arrive: boolean): Promise<void> {
    const service = this.opts.state();
    const ref = { type: VISIT_TYPE, id: agent };
    const found = await service.get(PRESENCE_CALLER, ref);
    const now = this.now();
    const same = visitOf(found?.data, now) === id;
    if (!same && !arrive) return;
    const until = typeof found?.data.until === "string" ? Date.parse(found.data.until) : Number.NaN;
    if (same && until - now > this.opts.quietMs - VISIT_REFRESH_MS) return;
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

  /** End the visits that have run out: each body back where it lives. */
  async sweep(): Promise<void> {
    const visits = await this.opts
      .state()
      .query(PRESENCE_CALLER, { type: VISIT_TYPE, limit: 500 })
      .catch(() => []);
    const now = this.now();
    const over = visits.filter((r) => !visitOf(r.data, now));
    await Promise.all(over.map((r) => this.inTurn(r.id, () => this.end(r.id))));
  }

  /** End one visit that was over, looked at again first: one that went on meanwhile goes on. */
  private async end(agent: string): Promise<void> {
    const service = this.opts.state();
    const ref = { type: VISIT_TYPE, id: agent };
    const found = await service.get(PRESENCE_CALLER, ref);
    if (found && !visitOf(found.data, this.now())) await service.delete(PRESENCE_CALLER, ref);
  }

  /** Resolves once every visit asked for so far is written. */
  async settled(): Promise<void> {
    for (;;) {
      const now = [...this.chains.values()];
      await Promise.all(now);
      const after = [...this.chains.values()];
      if (after.length === now.length && after.every((c, i) => c === now[i])) return;
    }
  }
}

const PRESENCE_CALLER: StateCaller = { actor: { kind: "plugin", name: "places" }, source: { surface: "events" } };

// --------------------------------------------------------------------------
// Talking: face to face nearby, on the phone from afar
// --------------------------------------------------------------------------

/**
 * Who an agent is talking with right now, and how (see {@link Talks}): face
 * to face when their bodies are in the same place, on the phone when they
 * aren't. One record per agent, naming the other (`with`; `you` for a person
 * talking to it from the page), whether it is on the `phone`, whether it
 * `started` the conversation, and `until` when it lasts if nothing more is
 * said. Kept in memory: it lasts an exchange and a little after, while what
 * was said shows in bubbles, and a restart ends it.
 */
export const TALK_TYPE = "talk";

export const TALK_SCHEMA = {
  type: "object",
  required: ["with", "until"],
  properties: {
    with: { type: "string", maxLength: 128 },
    phone: { type: "boolean" },
    started: { type: "boolean" },
    until: { type: "string" },
  },
} as const;

/**
 * How long two agents stay on the line, or face to face, after their last
 * exchange: the message and the answer show in bubbles only once the answer
 * is in, and take up to about twenty seconds to read.
 */
export const TALK_AFTER_MS = 40_000;
/** A talk isn't written again for every message: only once it has run down this far. */
const TALK_REFRESH_MS = 10_000;

/** One side of a conversation: who it is with, by phone or face to face, and whether this side spoke first. */
export interface TalkSide {
  with: string;
  phone?: true;
  started?: true;
}

/**
 * How two agents talk when one messages the other, from the place each body
 * is in (none for an agent without a body): face to face when both are in the
 * same place, on the phone otherwise. Each side with a body gets one, naming
 * the other; the sender's says it started. Nobody talks to itself.
 */
export function talkOf(from: string, to: string, where: { from?: string; to?: string }): Record<string, TalkSide> {
  if (from === to) return {};
  const near = !!where.from && where.from === where.to;
  const side = (other: string, started: boolean): TalkSide => ({
    with: other,
    ...(near ? {} : { phone: true as const }),
    ...(started ? { started: true as const } : {}),
  });
  return {
    ...(where.from ? { [from]: side(to, true) } : {}),
    ...(where.to ? { [to]: side(from, false) } : {}),
  };
}

/** The talk a record says is going on, while it still is; nothing once it has run out. */
export function talkNow(data: Record<string, unknown> | undefined, now: number): TalkSide | undefined {
  const partner = typeof data?.with === "string" && data.with ? data.with : undefined;
  const until = typeof data?.until === "string" ? Date.parse(data.until) : Number.NaN;
  if (!partner || !Number.isFinite(until) || until <= now) return undefined;
  return {
    with: partner,
    ...(data?.phone === true ? { phone: true as const } : {}),
    ...(data?.started === true ? { started: true as const } : {}),
  };
}

const sameSide = (a: TalkSide, b: TalkSide) =>
  a.with === b.with && !!a.phone === !!b.phone && !!a.started === !!b.started;

/**
 * Agents talking to each other where their bodies are: face to face in the
 * same place, on the phone anywhere else (see {@link talkOf}). Nobody walks
 * anywhere for it. Sent by a tool call, a message starts the talk as the call
 * is made ({@link calling}), so the two are on the line while the answer is
 * awaited, however long that takes; a call that fails, or is turned back
 * before it runs, hangs up. Each exchange answered keeps them talking a while
 * longer ({@link TALK_AFTER_MS}), and where their bodies are is looked at
 * again each time, so two who come to be in the same place are face to face
 * from then on. Once a talk runs out, the {@link sweep} ends it, so a page
 * watching sees the phones go down.
 */
export class Talks {
  /** Every talk changes in one order: the two sides of a conversation are written together. */
  private chain: Promise<void> = Promise.resolve();
  /** Direct messages on their way, by the call sending each, until it is through. */
  private readonly calls = new Map<string, { from: string; to: string; turn: string }>();

  constructor(
    private readonly opts: {
      state: () => StateService;
      hasBody: (agent: string | undefined) => boolean;
      /** The place an agent's body is in now (see {@link bodyAt}). */
      bodyAt: (agent: string) => Promise<string>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A tool call (`call`, in the turn `turn`) is sending one agent's direct message to another: they are talking from now. */
  calling(call: string, from: string, to: string, turn: string): Promise<void> {
    this.calls.set(call, { from, to, turn });
    return this.talk(from, to);
  }

  /** The call is through: one that failed sent nothing, so the two hang up. */
  sent(call: string, ok: boolean): Promise<void> {
    const found = this.calls.get(call);
    this.calls.delete(call);
    if (!found || ok) return Promise.resolve();
    return this.hangUp(found.from, found.to);
  }

  /**
   * A turn ended. A call of its still waiting to be through was turned back
   * before it ran (its arguments, an approval), which nothing reports: it
   * sent nothing, so the two hang up.
   */
  async turnEnded(turn: string): Promise<void> {
    const refused = [...this.calls].filter(([, c]) => c.turn === turn).map(([call]) => call);
    await Promise.all(refused.map((call) => this.sent(call, false)));
  }

  /** A direct message was answered: the two talk a while longer, from wherever their bodies are now. */
  answered(from: string, to: string): Promise<void> {
    return this.talk(from, to);
  }

  private inTurn(step: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(step).catch((err: unknown) => {
      console.warn(`[places] could not keep a talk: ${(err as Error).message}`);
    });
    return this.chain;
  }

  private talk(from: string, to: string): Promise<void> {
    return this.inTurn(async () => {
      const where = async (agent: string) => (this.opts.hasBody(agent) ? await this.opts.bodyAt(agent) : undefined);
      const sides = talkOf(from, to, { from: await where(from), to: await where(to) });
      for (const [agent, side] of Object.entries(sides)) await this.put(agent, side);
    });
  }

  private async put(agent: string, side: TalkSide): Promise<void> {
    const service = this.opts.state();
    const ref = { type: TALK_TYPE, id: agent };
    const found = await service.get(PRESENCE_CALLER, ref);
    const now = this.now();
    const was = talkNow(found?.data, now);
    const until = typeof found?.data.until === "string" ? Date.parse(found.data.until) : Number.NaN;
    if (was && sameSide(was, side) && until - now > TALK_AFTER_MS - TALK_REFRESH_MS) return;
    try {
      await service.put(
        PRESENCE_CALLER,
        { ...ref, scope: "global", data: { ...side, until: new Date(now + TALK_AFTER_MS).toISOString() } },
        found?.version ?? 0,
      );
    } catch (err) {
      // Written a moment ago by someone else (the page, for a person talking to it): theirs stands.
      if (!(err instanceof StateConflictError)) throw err;
    }
  }

  /** Two hang up: each side that still names the other ends. */
  private hangUp(from: string, to: string): Promise<void> {
    return this.inTurn(async () => {
      const service = this.opts.state();
      for (const [agent, other] of [
        [from, to],
        [to, from],
      ]) {
        const ref = { type: TALK_TYPE, id: agent };
        const found = await service.get(PRESENCE_CALLER, ref);
        if (found && found.data.with === other) await service.delete(PRESENCE_CALLER, ref);
      }
    });
  }

  /** End the talks that have run out. One waiting on an answer stays on the line until it comes. */
  async sweep(): Promise<void> {
    for (const c of this.calls.values()) void this.talk(c.from, c.to);
    const talks = await this.opts
      .state()
      .query(PRESENCE_CALLER, { type: TALK_TYPE, limit: 500 })
      .catch(() => []);
    const now = this.now();
    for (const r of talks.filter((t) => !talkNow(t.data, now)))
      void this.inTurn(async () => {
        // Looked at again first: one that went on meanwhile goes on.
        const service = this.opts.state();
        const ref = { type: TALK_TYPE, id: r.id };
        const found = await service.get(PRESENCE_CALLER, ref);
        if (found && !talkNow(found.data, this.now())) await service.delete(PRESENCE_CALLER, ref);
      });
    await this.settled();
  }

  /** Resolves once every talk asked for so far is written. */
  async settled(): Promise<void> {
    for (;;) {
      const now = this.chain;
      await now;
      if (this.chain === now) return;
    }
  }
}

/**
 * The agent a tool call messages directly, as the call is made: a `room` dm
 * to another agent, by its name or its label in rooms (`agentFor`). Not one
 * sent on to a desk, which is said in a room, where the body goes to say it
 * instead; nor one that would be refused: arguments of the wrong kind, which
 * the loop turns back before the tool runs (`to` is a list), or what the room
 * tool would refuse (no words, nobody, itself). Arguments are read as the
 * room tool reads them, so `to: ["editor"]` names editor.
 */
export function messageTo(
  tool: string,
  args: Record<string, unknown>,
  from: string,
  known: { agentFor: (label: string) => string | undefined; desks?: Record<string, string> },
): string | undefined {
  if (tool !== "room") return undefined;
  const { action, body, agent, to, member } = args;
  const given = (v: unknown) => v !== undefined && v !== null;
  if ([action, body, agent, member].some((v) => given(v) && typeof v !== "string")) return undefined;
  if (given(to) && !Array.isArray(to)) return undefined;
  if (String(action ?? "").toLowerCase() !== "dm" || !String(body ?? "").trim()) return undefined;
  const label = String(agent ?? to ?? member ?? "").trim();
  const name = label ? known.agentFor(label) : undefined;
  return name && name !== from && !(known.desks?.[name] ?? known.desks?.[label]) ? name : undefined;
}

/**
 * Agents talking, from the bus. A `room` dm starts a talk as the call is made
 * (`agent.pre_tool_use`), so the two are on the line for the answer; the
 * call's end settles it (`agent.post_tool_use`), and the turn's end hangs up
 * any call turned back before it ran, which reports nothing
 * (`agent.turn_ended`). Each exchange answered (`agent.messaged`, from a
 * plugin as much as the room tool) keeps the two talking a while longer.
 * Calls are told apart by turn as well as id, as a model may number its calls
 * the same way every time; and a turn is over once every turn running in its
 * session is, as an answer can run in the very session the message came from.
 */
export function followTalk(
  events: EventBus,
  talks: Talks,
  messages: (tool: string, args: Record<string, unknown>, from: string) => string | undefined,
): Subscription[] {
  const running = new Map<string, number>();
  return [
    events.onWaterfall("agent.pre_tool_use", async (p, next) => {
      const out = await next(p);
      const from = out.agent || "default";
      const to = out.deny ? undefined : messages(out.tool, out.args, from);
      if (to) void talks.calling(`${out.sessionId}:${out.toolUseId}`, from, to, out.sessionId);
      return out;
    }),
    events.on("agent.post_tool_use", (e) => void talks.sent(`${e.sessionId}:${e.toolUseId}`, e.success)),
    events.on("agent.turn_started", (e) => void running.set(e.sessionId, (running.get(e.sessionId) ?? 0) + 1)),
    events.on("agent.turn_ended", (e) => {
      const left = (running.get(e.sessionId) ?? 1) - 1;
      if (left > 0) return void running.set(e.sessionId, left);
      running.delete(e.sessionId);
      void talks.turnEnded(e.sessionId);
    }),
    events.on("agent.messaged", (e) => {
      if (e.via === "dm") void talks.answered(e.from, e.to);
    }),
  ];
}

/**
 * End the stays bodies chose that have run out (see `places-body.ts`): a
 * spot it said to stay at for a while is let go, and from a place it went to
 * for a while it goes home, if it is still there. Each body record is looked
 * at again before it is written, so one changed meanwhile stands.
 */
export async function endStays(service: StateService, now = Date.now()): Promise<void> {
  const bodies = await service
    .query(PRESENCE_CALLER, { type: BODY_TYPE, limit: 500 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const over = (body: BodyData) => ({ spot: ranOut(body.spot?.until, now), away: ranOut(body.away?.until, now) });
  for (const { id, data } of bodies) {
    if (!over(data as BodyData).spot && !over(data as BodyData).away) continue;
    const ref = { type: BODY_TYPE, id };
    try {
      const fresh = await service.get(PRESENCE_CALLER, ref);
      const body = (fresh?.data ?? {}) as BodyData;
      const ended = over(body);
      if (!fresh || (!ended.spot && !ended.away)) continue;
      if (ended.away && body.away) {
        const where = await service.get(PRESENCE_CALLER, { type: WHEREABOUTS_TYPE, id });
        if (where?.data.place === body.away.place) {
          await service.delete(PRESENCE_CALLER, { type: WHEREABOUTS_TYPE, id }, where.version);
          await endVisit(service, id);
        }
      }
      const next = bodyWith(body, { ...(ended.spot ? { spot: null } : {}), ...(ended.away ? { away: null } : {}) });
      if (Object.keys(next).length)
        await service.put(
          PRESENCE_CALLER,
          { ...ref, scope: fresh.scope, data: next as Record<string, unknown> },
          fresh.version,
        );
      else await service.delete(PRESENCE_CALLER, ref, fresh.version);
    } catch (err) {
      // Changed a moment ago: looked at again next time round. Anything else is said, and tried again then too: one
      // record that can't be written never stops the others, nor the sweep.
      if (!(err instanceof StateConflictError))
        console.warn(`[places] could not end ${id}'s stay: ${(err as Error).message}`);
    }
  }
}

/** A body the place tool moves leaves any place it was visiting: where it went stands. */
async function endVisit(service: StateService, agent: string): Promise<void> {
  await service.delete(PRESENCE_CALLER, { type: VISIT_TYPE, id: agent }).catch(() => null);
}

export const VISIT_SCHEMA = {
  type: "object",
  required: ["place", "until"],
  properties: {
    place: { type: "string", maxLength: 128 },
    until: { type: "string" },
  },
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

/** What the `room` action changes about the room itself, apart from what the body wears. */
const ROOM_FIELDS = ["width", "depth", "height", "walls", "floor", "color", "name", "theme", "purpose", "area"];
function number(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Words that clear what a widget shows, back to its kind's own. */
const SHOWS_CLEARED = new Set(["none", "default", "nothing", "clear"]);

/**
 * What a widget of `kind` is to show, from what the model wrote: the words,
 * null to clear it, undefined when none was given, or why it can't be.
 */
function showsFrom(kind: string, v: unknown): string | null | undefined | { why: string } {
  const t = text(v);
  if (t === undefined) return undefined;
  if (!SHOWS_KINDS.includes(kind))
    return {
      why: `A ${KINDS[kind]?.noun ?? kind} shows what it is. \`shows\` is for: ${SHOWS_KINDS.join(", ")}.`,
    };
  if (SHOWS_CLEARED.has(t.toLowerCase())) return null;
  if (t.length > SHOWS_LENGTH) return { why: `\`shows\` is ${SHOWS_LENGTH} characters at most.` };
  return t;
}

/** A kind from what the model wrote: "coffee table", "Coffee_Table", "TV". */
function kindFrom(v: unknown): string | undefined {
  const t = text(v)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!t) return undefined;
  // A model is added by its own name, never as "model".
  const known = (k: string) => !!KINDS[k] && !KINDS[k].model;
  if (known(t)) return t;
  const byNoun = Object.entries(KINDS).find(([, k]) => !k.model && k.noun.toLowerCase().replace(/\s+/g, "_") === t);
  if (byNoun) return byNoun[0];
  const singular = t.replace(/s$/, "");
  return known(singular) ? singular : undefined;
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

/** Where a place is in the world, and where its door is, for the agent looking round it. */
function whereaboutsWords(place: Place): string {
  const area =
    place.area && areaId(place.area) !== MAIN
      ? `${place.area}, a plot of its own at the edge of ${MAIN_NAME}`
      : MAIN_NAME;
  const slot = doorOf(place);
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

/**
 * A place with one more change in its recent changes, newest first, keeping
 * the last few. What it says is cut short to fit: it carries the agent's own
 * words (a purpose, a name, where it put something), and a change too long to
 * keep would fail the very change it records.
 */
export function withChange(place: Place, change: PlaceChange): Place {
  const what = change.what.length > CHANGE_LENGTH ? `${change.what.slice(0, CHANGE_LENGTH - 1)}…` : change.what;
  return { ...place, changes: [{ ...change, what }, ...(place.changes ?? [])].slice(0, CHANGES_KEPT) };
}

export interface ApplyOptions {
  /**
   * The room drawn again in a theme: given for a room still as it was drawn
   * (a meeting room nobody has changed), so a theme dresses it through and
   * through, rather than repainting what is there.
   */
  redraw?: (theme: string) => Place;
  /** The model an `add` names, found by the tool among the agent's own and the ready-made ones. */
  model?: Model;
}

/** Why a model can't be repainted from the room. */
const MODEL_COLORS = "A model keeps its parts' own colours: change them with the build tool.";

/** The box a model fills at a scale, to the centimetre. */
const scaledSize = (size: [number, number, number], scale = 1) =>
  size.map((s) => Math.round(s * scale * 100) / 100) as [number, number, number];

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
      changes.push(`it is called ${next.name}`);
      did.push(`named it ${next.name}`);
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
        changes.push(`it is in ${MAIN_NAME}, with its door on a street`);
        did.push(`moved it to ${MAIN_NAME}`);
      } else {
        next = { ...next, area: area.slice(0, 60) };
        changes.push(`it is in ${area}: a plot of its own at the edge of ${MAIN_NAME}, with the other places there`);
        did.push(`moved it to ${area}`);
      }
    }
    if (!changes.length)
      return no(
        "Say what to change about the room: width, depth, height, walls, floor, name, theme, purpose or area; or wear.",
      );
    return { ok: true, text: `Changed the room: ${changes.join("; ")}.`, place: next, did: did.join(", ") };
  }

  const where = whereFrom(args);
  if (typeof where === "string") return no(where);

  if (action === "add") {
    const model = opts.model;
    const kind = kindFrom(args.kind) ?? (model ? MOUNT_KIND[model.mount] : undefined);
    if (!kind)
      return no(
        `Say what to add with \`kind\`: ${Object.keys(KINDS)
          .filter((k) => !KINDS[k].model)
          .join(", ")}; or a model by its name: ${READY.map((r) => r.name).join(", ")}, or one you made.`,
      );
    if (place.props.length >= LIMITS.items)
      return no(`The room holds at most ${LIMITS.items} things. Remove one first.`);
    const item: Omit<PlaceItem, "at" | "facing"> = { id: newId(place, kind), name: "", kind };
    const colorText = text(args.color);
    if (colorText && isModelKind(kind)) return no(MODEL_COLORS);
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
    if (model) {
      // A model is laid out by the box it fills, as big as it was asked to be.
      item.model = modelId(model.owner, model.name);
      item.size = scaledSize(model.size, item.scale);
    } else if (KINDS[kind].shaped) {
      const size = sizeFrom(args.size);
      if (typeof size === "string") return no(size);
      item.size = size ?? [0.5, 0.5, 0.5];
    }
    const shows = showsFrom(kind, args.shows);
    if (shows && typeof shows === "object") return no(shows.why);
    if (shows) item.shows = shows;
    const placing: Placing = {
      kind,
      ...(item.scale ? { scale: item.scale } : {}),
      ...(item.size ? { size: item.size } : {}),
    };
    // Never in front of the door, or over it.
    const spot = findPlacement(withDoorwayHeld(place), placing, where);
    if (typeof spot === "string") return no(spot);
    item.name = newName(place, kind, colorWord(colorText), text(args.name) ?? model?.name.replace(/_/g, " "));
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
  if (colorText && item.model) return no(MODEL_COLORS);
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
    // A model is laid out by the box it fills: as much bigger as it is drawn.
    if (item.model && item.size)
      changed.size = scaledSize(item.size.map((s) => s / (item.scale ?? 1)) as [number, number, number], changed.scale);
    changes.push(`it is ${scale}× its normal size`);
    did.push(`resized ${changed.name}`);
  }
  if (item.model && args.size !== undefined && args.size !== null && args.size !== "")
    return no("A model is as big as its parts make it: change it with `scale`, or its parts with the build tool.");
  const size = KINDS[item.kind]?.shaped && !item.model ? sizeFrom(args.size) : undefined;
  if (typeof size === "string") return no(size);
  if (size) {
    changed.size = size;
    changes.push(`it is ${size.join(" × ")} m`);
    if (scale === undefined) did.push(`resized ${changed.name}`);
  }
  const shows = showsFrom(item.kind, args.shows);
  if (shows && typeof shows === "object") return no(shows.why);
  if (shows === null) {
    delete changed.shows;
    changes.push("it shows what it shows by itself");
    did.push(`set ${changed.name} back to its own`);
  } else if (shows) {
    changed.shows = shows;
    changes.push(`it shows ${shows}`);
    did.push(`set ${changed.name} to show ${shows}`);
  }
  if (!changes.length) return no("Say what to change: name, color, scale, shows, or size for a shape.");
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

/** Where an agent is, in a sentence: at home, in a meeting room, or in a shared place. */
function hereWords(id: string, agent: string, place: Place, talk: TalkRoom | undefined): string {
  if (id === homeId(agent)) return "You are at home.";
  return talk
    ? `You are in the meeting room of #${talk.name}, a room you talk in. Its members can change it.`
    : `You are in ${place.name}, a shared place.`;
}

/**
 * An agent's body goes home, to a shared place, or into the meeting room of
 * a room it talks in, by name: where it lives from now, leaving any place it
 * was visiting. Undefined when no place is called that; not ok, with why,
 * when it can't go in.
 */
export async function goTo(
  service: StateService,
  caller: StateCaller,
  agent: string,
  to: string,
  meetings: Meetings,
): Promise<{ ok: boolean; text: string; id?: string } | undefined> {
  const ref = { type: WHEREABOUTS_TYPE, id: agent };
  if (/^(home|my room|your room|back home)$/i.test(to) || to === homeId(agent)) {
    if (await service.get(caller, ref)) await service.delete(caller, ref);
    await endVisit(service, agent);
    return { ok: true, text: "You're home.", id: homeId(agent) };
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
    if (!talk.members.includes(agent)) return { ok: false, text: onlyMembers(talk, meetings.hasBody) };
    const id = roomPlaceId(talk.ref);
    await service.put(caller, { ...ref, scope: "global", data: { place: id } });
    await endVisit(service, agent);
    const there = await whoIsIn(service, caller, id, meetings.hasBody, agent, meetings.rooms);
    return {
      ok: true,
      id,
      text: `You're in the meeting room of #${talk.name} now.${there.length ? ` Also here: ${there.join(", ")}.` : ""} Change it like your own room; its members see what you do.`,
    };
  }
  if (!place) return undefined;
  await service.put(caller, { ...ref, scope: "global", data: { place: place.id } });
  await endVisit(service, agent);
  const there = await whoIsIn(service, caller, place.id, meetings.hasBody, agent, meetings.rooms);
  return {
    ok: true,
    id: place.id,
    text: `You're in ${place.name} now.${there.length ? ` Also here: ${there.join(", ")}.` : " Nobody else is here yet."}`,
  };
}

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
          "look: the room, its things, who is here, what you can add. add / move / change / remove a thing. room: size, walls, floor, name, theme, purpose, area, wear. undo: the last change. photo: a picture to send. places: where you can go. go: to a place. new: make a shared place, and go there.",
      },
      item: { type: "string", description: "move, change, remove: the thing, by name or id." },
      kind: {
        type: "string",
        description:
          "add: what to add, e.g. armchair, rug, bookshelf, lamp, vase, block, or a model by name (todo_board).",
      },
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
      shows: {
        type: "string",
        description:
          'add, change: what a widget shows: a chart\'s "tokens" or "tasks", a ticker\'s room, a screen\'s dashboard widget, a display stand\'s "feed". "default" clears it.',
      },
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
      wear: {
        type: "string",
        description: `room: what your body wears, from: ${Object.keys(WEAR).join(", ")}; or "none", or "default" for what suits you.`,
      },
      area: {
        type: "string",
        description:
          'room or new: the area the place is in, e.g. "the summer house": a plot of its own at the edge of town, with the other places in it. "main" puts it back on the streets.',
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
    /** What each agent is for (see `places-roles.ts`): the kind of home it starts with, and what it wears. */
    private readonly roles: (agent: string) => Role | undefined = () => undefined,
    /** The models agents make (`places-build.ts`): what an `add` by a model's name adds. */
    private readonly models?: ModelShelf,
  ) {}

  private meetings(): Meetings {
    return { rooms: this.rooms(), hasBody: this.hasBody };
  }

  /** The kind of home that suits each agent. */
  private readonly homes: HomeFor = (agent) => homeFor(this.roles(agent), homeId(agent));

  /** What an agent wears, and whether it chose that or its role did. */
  private async wearing(service: StateService, caller: StateCaller, agent: string): Promise<string> {
    const read = (type: string) => service.get(caller, { type, id: agent }).catch(() => null);
    const [body, old] = await Promise.all([read(BODY_TYPE), read(WEAR_TYPE)]);
    const role = this.roles(agent);
    const own = body?.data as BodyData | undefined;
    const worn = wearWords(wornBy(own, old?.data.wear, role));
    const chose = own?.wear !== undefined || !!old;
    return chose || !role ? `You wear ${worn}.` : `You wear ${worn}, as suits ${aOrAn(role.word)}.`;
  }

  /** The models the agent can add, for `look`. */
  private async modelWords(caller: StateCaller, agent: string): Promise<string> {
    if (!this.models) return "";
    const mine = (await this.models.mine(caller, agent)).map((m) => m.name);
    const ready = READY.map((r) => r.name).filter((n) => !mine.includes(n));
    return `\n- models, by name: ${[...mine, ...ready].join(", ")}${mine.length ? "" : " (ready-made)"}`;
  }

  /**
   * Put on what was asked, or go back to what suits its role: what to tell
   * the agent. Kept on its body record, as the body tool keeps it: the room's
   * `wear` is the same choice, made from here.
   */
  private async dress(service: StateService, caller: StateCaller, agent: string, asked: unknown): Promise<string> {
    const wanted = parseWear(asked);
    if ("problem" in wanted) throw new StateError(wanted.problem);
    if ("suited" in wanted) {
      await changeBody(service, caller, agent, { wear: null });
      return `You wear ${wearWords(this.roles(agent)?.wear ?? [])} now, what suits your role.`;
    }
    await changeBody(service, caller, agent, { wear: wanted.wear });
    return `You wear ${wearWords(wanted.wear)} now.`;
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
        const { id, place } = await readCurrent(service, caller, agent, meetings, this.homes);
        const others = await whoIsIn(service, caller, id, this.hasBody, agent, meetings.rooms);
        const talk = talkRoomOf(meetings.rooms, id);
        const where = hereWords(id, agent, place, talk);
        const company = others.length ? ` Also here: ${others.join(", ")}.` : "";
        const wear = await this.wearing(service, caller, agent);
        const shown = describe(shownPurpose(place, talk));
        // A home someone changed keeps what it has, so one changed before homes had calendars has none: the agent
        // is told how to hang one rather than having it hung for it.
        const calendar =
          id === homeId(agent) && !place.props.some((p) => p.kind === "calendar")
            ? `\n\nYour home has no calendar yet. Add one (kind "calendar") and it shows your day: your next wakes and what you got done today.`
            : "";
        return {
          success: true,
          output: `${where}${company} ${whereaboutsWords(place)} ${wear}\n\n${shown}${await this.modelWords(caller, agent)}${calendar}`,
        };
      }
      if (action === "undo") {
        const { id } = await readCurrent(service, caller, agent, meetings, this.homes);
        const ref = { type: PLACE_TYPE, id };
        const recent = await service.history(caller, ref, { limit: PEOPLE_LOOK }).catch(() => []);
        const [newest] = recent;
        let last: StateChange | undefined = newest;
        if (newest?.actor.kind === "user") {
          // A person who changed the room on the page and took it back left it as it was: what there is to take
          // back is the change before theirs. One of theirs that stands is theirs to take back, not the agent's.
          const now = await service.get(caller, ref).catch(() => null);
          last = pastPeople(recent, now?.data);
          if (!last && !now) return fail("There's nothing to undo.");
          if (!last) {
            const by = (newest.after as unknown as Place | undefined)?.changes?.[0];
            return fail(
              `The last change here was made on the page by ${by?.person ? by.who : "a person"}, so it's theirs to take back, not yours.`,
            );
          }
        }
        // A meeting room's first change made its record: taking that back is the room as it was drawn.
        if (last?.op === "create" && id.startsWith("room:") && !byPlugin(last.actor)) {
          await service.delete(caller, ref, newest?.version);
          return { success: true, output: "Undone: the meeting room is back as it was drawn for its room." };
        }
        // The system giving an untouched home a newer room is not a change of anyone's to take back.
        if (!last?.before || last.op !== "update" || byPlugin(last.actor)) return fail("There's nothing to undo.");
        const before = last.before as unknown as Place;
        const undone = (last.after as unknown as Place | undefined)?.changes?.[0];
        const what = undone && undone.at !== before.changes?.[0]?.at ? `took back "${undone.what}"` : "undid a change";
        const data = withChange(before, { who: agent, what, at: this.now().toISOString() });
        // Written over the record as it is now, which is as that change left it: a person's taken-back changes since
        // moved its version on, not what is in it.
        await service.put(caller, { ...ref, data: data as unknown as Record<string, unknown> }, newest?.version);
        return {
          success: true,
          output: `Undone: the room is back as it was before the last change by ${last.actor.name}.`,
        };
      }
      // What the body wears is its own record, not the room's (see `WEAR_TYPE`): checked before the room
      // changes, put on once they have.
      const { wear: wearAsked, ...roomArgs } = args;
      const wears = action === "room" && wearAsked !== undefined && wearAsked !== null && wearAsked !== "";
      if (wears) {
        const wanted = parseWear(wearAsked);
        if ("problem" in wanted) return fail(wanted.problem);
        if (!ROOM_FIELDS.some((k) => roomArgs[k] !== undefined && roomArgs[k] !== null && roomArgs[k] !== ""))
          return { success: true, output: await this.dress(service, caller, agent, wearAsked) };
      }
      // A model by its name: the agent's own, or a ready-made one, made its own once the room has a place for it.
      let model: Model | undefined;
      let own: (() => Promise<Model>) | undefined;
      if (action === "add" && this.models && !kindFrom(args.kind)) {
        const name = modelName(args.kind);
        const found = name ? await this.models.forPlacing(context, agent, name) : undefined;
        model = found?.model;
        own = found?.own;
      }
      for (let attempt = 0; ; attempt++) {
        const { id, place, version, scope } = await readCurrent(service, caller, agent, meetings, this.homes);
        const talk = talkRoomOf(meetings.rooms, id);
        if (talk && text(args.action)?.toLowerCase() === "room" && text(args.area))
          return fail(
            `A meeting room stays in ${MAIN_NAME}: in the office, or in a building of its own if its theme has one.`,
          );
        // A meeting room nobody has changed is drawn afresh in a theme, through and through.
        const redraw =
          talk && version === 0
            ? (theme: string) => ({ ...drawMeeting(talk, this.hasBody, theme).place, name: place.name })
            : undefined;
        const outcome = applyAction(place, roomArgs, { ...(redraw ? { redraw } : {}), ...(model ? { model } : {}) });
        if (!outcome.place) return outcome.ok ? { success: true, output: outcome.text } : fail(outcome.text);
        if (own) {
          await own();
          own = undefined;
        }
        const data = outcome.did
          ? withChange(outcome.place, { who: agent, what: outcome.did, at: this.now().toISOString() })
          : outcome.place;
        try {
          await service.put(
            caller,
            { type: PLACE_TYPE, id, scope, data: data as unknown as Record<string, unknown> },
            version,
          );
          if (!wears) return { success: true, output: outcome.text };
          return { success: true, output: `${outcome.text} ${await this.dress(service, caller, agent, wearAsked)}` };
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
    const went = await goTo(service, caller, agent, to, meetings);
    if (went) return went.ok ? { success: true, output: went.text } : fail(went.text);
    const shared = await sharedPlaces(service, caller);
    const known = [
      ...shared.map((p) => p.name),
      ...meetings.rooms.filter((r) => r.members.includes(agent)).map((r) => `#${r.name}`),
    ].join(", ");
    return fail(`There's no place called "${to}".${known ? ` There is: ${known}.` : ""} Make a shared one with "new".`);
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
        const { id, place, version, scope } = await readCurrent(service, caller, agent, this.meetings(), this.homes);
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
    const { place } = await readCurrent(
      this.getService(),
      agentStateCaller(context, "place"),
      agent,
      this.meetings(),
      this.homes,
    );
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
    name: BODY_TYPE,
    description:
      "How an agent's body looks and carries itself in the 3D world: its colour, model, size and what it wears; its idle style, posture, walk and favourite idle errands; a spot it chose to stay at. A part with nothing chosen is as it always was. Agents choose with the body tool; people on the agent's card.",
    scope: "agent",
    schema: BODY_SCHEMA as never,
  });

  ctx.stateTypes.register({
    name: EMOTE_TYPE,
    description:
      "A gesture an agent's body is making in the 3D world (wave, dance, bow…), since when, and until when if it keeps it going. Kept in memory; gone on restart.",
    scope: "global",
    title: "name",
    provider: "memory",
    schema: EMOTE_SCHEMA as never,
  });

  ctx.stateTypes.register({
    name: WEAR_TYPE,
    description:
      "What an agent's body wore before that was its body record's `wear`: read until the body record says what it wears, and taken away when it does. Nothing writes one now.",
    scope: "agent",
    schema: WEAR_SCHEMA as never,
  });

  ctx.stateTypes.register({
    name: VISIT_TYPE,
    description:
      "An agent's body visiting somewhere for a while: the meeting room of a room it is talking in, until a quiet spell ends it. Kept by the places plugin; gone on restart. People can end one; agents move with the place tool.",
    scope: "global",
    title: "place",
    provider: "memory",
    schema: VISIT_SCHEMA as never,
    access: { write: ["user"] },
  });

  ctx.stateTypes.register({
    name: TALK_TYPE,
    description:
      "Who an agent is talking with right now (`with`; `you` for a person on the page), face to face when their bodies are in the same place, on the `phone` when not, until a short quiet spell after the last exchange. Kept by the places plugin; gone on restart. The page writes a person's own.",
    scope: "global",
    title: "with",
    provider: "memory",
    schema: TALK_SCHEMA as never,
    access: { write: ["user"] },
  });

  ctx.stateTypes.register({
    name: MODEL_TYPE,
    description:
      "A model an agent made for the 3D world out of simple parts, some with a face people use there: `<agent>:<name>`, in its maker's scope. Agents make them with the build tool and add them to rooms with the place tool.",
    scope: "agent",
    title: "name",
    schema: MODEL_SCHEMA as never,
  });
  // What the ready-made models' faces show: to-dos, habits and a note. A type of the same name in config wins, and
  // so does another plugin's: these are declared only where nothing has declared the name already.
  for (const type of FACE_TYPES)
    if (!stateTypeRegistry.has(type.name)) ctx.stateTypes.register({ ...type, schema: type.schema as never });

  // The models agents make, shared by the build tool and the place tool, which adds them to rooms by name.
  const components = () => (runtime.db ? interfaceStoreFor(runtime.db) : undefined);
  const shelf = new ModelShelf(() => runtime.getStateService(), components);

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

  // What each agent is for, read again only when what it is read from changes: a map of fifty homes asks for every
  // one of them.
  const read = new Map<string, Role | undefined>();
  const roleOf = (agent: string): Role | undefined => {
    const about = aboutAgent(agent, runtime.getAgentDefinition(agent));
    const key = JSON.stringify(about);
    if (!read.has(key)) {
      if (read.size >= 256) read.clear();
      read.set(key, readRole(about));
    }
    return read.get(key);
  };
  const homes: HomeFor = (agent) => homeFor(roleOf(agent), homeId(agent));

  ctx.tools.register("place", (config, tctx) => {
    if (!anyAvatar(config) || !tctx.getStateService) return [];
    return [
      new PlaceTool(
        tctx.getStateService,
        hasBody,
        (shot) => camera.take(shot),
        talkRooms,
        () => new Date(),
        roleOf,
        shelf,
      ),
    ];
  });

  // Every model a body can be drawn in: those the config names, and every VRM in `<TAI_HOME>/avatars/`.
  const bodyModels = () => {
    const config = runtime.getConfig();
    return avatarModels(
      config.live,
      Object.keys(config.agents ?? {}).map((a) => runtime.getAgentDefinition(a)?.avatar),
    );
  };
  const ownModel = (agent: string) => {
    const path = resolveAvatar(
      runtime.getConfig().live,
      runtime.avatarFor(agent === "default" ? undefined : agent),
    ).model;
    return bodyModels().find((m) => m.path === path)?.name;
  };

  ctx.tools.register("body", (config, tctx) => {
    if (!anyAvatar(config) || !tctx.getStateService) return [];
    return [
      new BodyTool(tctx.getStateService, {
        hasBody,
        here: async (service, caller, agent) => {
          const meetings = { rooms: talkRooms(), hasBody };
          const { id, place } = await readCurrent(service, caller, agent, meetings, homes);
          return { id, place, words: hereWords(id, agent, place, talkRoomOf(meetings.rooms, id)) };
        },
        go: (service, caller, agent, to) => goTo(service, caller, agent, to, { rooms: talkRooms(), hasBody }),
        models: (agent) => ({ names: bodyModels().map((m) => m.name), own: ownModel(agent) }),
        role: roleOf,
      }),
    ];
  });

  // Making models is opt-in: only a deployment that asks for it (`build: true`) pays for the tool's schema.
  if ((ctx.config as { build?: unknown } | undefined)?.build === true)
    ctx.tools.register("build", (config, tctx) =>
      anyAvatar(config) && tctx.getStateService ? [new BuildTool(shelf)] : [],
    );

  // Plugin routes are namespaced by module: these are under /api/ext/builtin:places/.
  // `map`, `scene/:id`, `photos` and `transcript/:id` go first, so they aren't read as an agent's name.
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
  /**
   * What an agent's body is drawn with (see `looksOf`), and the file to draw
   * it from when it chose one of the deployment's models: one that has gone
   * since is its own again.
   */
  const looksFor = (name: string, chosen: Chosen, known = bodyModels()) => {
    const { model, ...looks } = looksOf(name, roleOf(name), chosen);
    const drawn = avatarModelNamed(known, model);
    return drawn ? { ...looks, model: drawn.name, avatar: modelUrl(drawn.name) } : looks;
  };
  const bodyOf = (name: string, chosen: Chosen, known = bodyModels()) => {
    const own = runtime.avatarFor(name === "default" ? undefined : name);
    const files = resolveAvatar(runtime.getConfig().live, own);
    const q = name === "default" ? "" : `?agent=${encodeURIComponent(name)}`;
    return {
      agent: name,
      name,
      avatar: `/api/live/avatar${q}`,
      animations: files.animations.map((_, i) => `/api/live/animations/${i}${q}`),
      ...looksFor(name, chosen, known),
    };
  };

  ctx.http.register({
    method: "GET",
    path: "map",
    handler: async (): Promise<TaiHttpResponse> => {
      const service = runtime.getStateService();
      const rooms = talkRooms();
      const world = await buildWorld(service, PLUGIN_CALLER, agentNames(), rooms, hasBody);
      const chosen = await chosenBodies(service, PLUGIN_CALLER);
      const places = withLooks(
        await worldMap(service, PLUGIN_CALLER, agentNames(), rooms, hasBody, world),
        roleOf,
        chosen,
      );
      const areas: Area[] = world.areas;
      return { json: { places, areas, town: world.town } };
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
      const found = await scene(service, PLUGIN_CALLER, id, rooms, hasBody, world, homes);
      if (!found) return { status: 404, json: { error: `There's no place "${id}".` } };
      const chosen = await chosenBodies(service, PLUGIN_CALLER);
      const known = bodyModels();
      // The town's houses say what their owners do, so what stands by each can show it.
      const town = (found.place as Place & { town?: Town }).town;
      const place = town
        ? {
            ...found.place,
            town: {
              ...town,
              buildings: town.buildings.map((b) => (b.owner ? { ...b, role: roleOf(b.owner)?.id } : b)),
            },
          }
        : found.place;
      const models = await modelsIn(service, PLUGIN_CALLER, components(), found.place.props);
      return {
        json: {
          type: PLACE_TYPE,
          id: found.id,
          place,
          models,
          company: found.agents.map((a) => bodyOf(a, chosen, known)),
          doors: found.doors,
          area: world.areaOf.get(found.id) ?? MAIN,
          // What a person changing it on the page writes with: the town and the office's floors are laid out from what
          // there is, drawn fresh every time.
          version: found.version,
          scope: found.scope,
          editable: found.id !== TOWN && !world.floors.some((f) => f.id === found.id),
          ...(found.lent ? { lent: found.lent } : {}),
        },
      };
    },
  });

  // A person rearranging a place on the page: every kind of thing there is, and what agents call the person, so
  // what they change reads right in the room's recent changes ("sam moved the couch").
  ctx.http.register({
    method: "GET",
    path: "edit/kinds",
    handler: async (): Promise<TaiHttpResponse> => {
      // And the models agents have made, newest first, for the catalogue's "Made by agents".
      const made = await runtime
        .getStateService()
        .query(PLUGIN_CALLER, { type: MODEL_TYPE, orderBy: { field: "createdAt", direction: "desc" }, limit: 200 })
        .catch(() => []);
      const models = made.map((r) => {
        const m = r.data as unknown as Model;
        return {
          id: r.id,
          name: m.name,
          owner: m.owner,
          kind: MOUNT_KIND[m.mount],
          size: m.size,
          faces: m.parts.filter((p) => p.face).length,
          ...(m.about ? { about: m.about } : {}),
        };
      });
      return { json: { kinds: KINDS, models, person: runtime.getConfig().rooms?.ownerLabel ?? "owner" } };
    },
  });

  // What a place becomes with a person's change, checked as the place tool checks its own (see `places-edit.ts`).
  // Nothing is written: the page writes what comes back through the world-state API, with the record's version.
  ctx.http.register({
    method: "POST",
    path: "edit",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const body = (await req.json().catch(() => null)) as { id?: unknown; place?: unknown; edit?: unknown } | null;
      const place = body?.place as Place | undefined;
      if (typeof body?.id !== "string" || !place || typeof place !== "object" || !Array.isArray(place.props))
        return { status: 400, json: { error: "Send `id`, `place` and `edit`." } };
      let edit = editFrom(body.edit);
      if (typeof edit === "string") return { status: 400, json: { error: edit } };
      // A model added from the catalogue: the box it fills and what it is called, from its record.
      if (edit.op === "add" && edit.model) {
        const found = await runtime
          .getStateService()
          .get(PLUGIN_CALLER, { type: MODEL_TYPE, id: edit.model })
          .catch(() => null);
        const m = found?.data as unknown as Model | undefined;
        if (!m) return { json: { why: "That model isn't there any more: its agent may have just deleted it." } };
        edit = { ...edit, kind: MOUNT_KIND[m.mount], size: m.size, name: m.name.replace(/_/g, " ") };
      }
      // A change that can't be made is an answer, not a failure: the page shows why, in the tool's own words.
      const done = applyEdit(body.id, place, edit);
      if (typeof done === "string") return { json: { why: done } };
      // A model added comes with what it is made of, so the page draws it at once.
      const added =
        edit.op === "add" && edit.model
          ? await modelsIn(runtime.getStateService(), PLUGIN_CALLER, components(), [{ model: edit.model }])
          : undefined;
      return { json: added ? { ...done, models: added } : done };
    },
  });

  // The photos agents took, from every place, for a photo wall: one query, newest first.
  ctx.http.register({
    method: "GET",
    path: "photos",
    handler: async (): Promise<TaiHttpResponse> => {
      const records = await runtime
        .getStateService()
        .query(PLUGIN_CALLER, { type: PLACE_TYPE, scope: "global", limit: 500 })
        .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
      return { json: { photos: wallPhotos(records) } };
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
      const { id, place, version, scope } = await readCurrent(service, PLUGIN_CALLER, agent, { rooms, hasBody }, homes);
      // Everyone else whose body is here, with what the page needs to draw them.
      const others = await whoIsIn(service, PLUGIN_CALLER, id, hasBody, agent, rooms);
      const chosen = await chosenBodies(service, PLUGIN_CALLER);
      const known = bodyModels();
      const company = others.map((a) => bodyOf(a, chosen, known));
      const world = await buildWorld(service, PLUGIN_CALLER, agentNames(), rooms, hasBody);
      const doors = doorsIn(id, place, world);
      const models = await modelsIn(service, PLUGIN_CALLER, components(), place.props);
      return {
        json: {
          type: PLACE_TYPE,
          id,
          version,
          scope,
          editable: true,
          place,
          models,
          company,
          doors,
          area: world.areaOf.get(id) ?? MAIN,
          // What the agent itself is, wears and looks like: its body is drawn from /api/live, which says nothing of
          // any of it, unless it chose another model to be drawn in.
          ...looksFor(agent, chosen, known),
        },
      };
    },
  });

  // What the plugin leaves running, each stopped when it is unloaded.
  const stops: (() => void)[] = [];
  const cfg = (ctx.config ?? {}) as { quietMinutes?: number; tend?: unknown };

  /** Why an agent is asleep in the world: the global pause, or an online agent's own switch; null when it is awake. */
  const asleep = (agent: string) => {
    const online = agent !== "default" && !!runtime.getConfig().agents?.[agent]?.online?.enabled;
    return whyAsleep({
      paused: runtime.isAgentsPaused("autonomous"),
      own: online ? getExploratoryState(runtime.db, agent) : null,
      now: new Date(),
    });
  };

  // Who a tool call messages directly. Asked of every call, so who is who is only worked out for a room dm.
  const messages = (tool: string, args: Record<string, unknown>, from: string) =>
    messageTo(tool, args, from, {
      agentFor: (label) => identities().agentForLabel(label) ?? (agentNames().includes(label) ? label : undefined),
      desks: runtime.getConfig().rooms?.desks,
    });

  // What is looked at again every little while: talks and visits that have run out end, so a page sees them go.
  const sweeps: (() => Promise<void>)[] = [];
  const subs: Subscription[] = [];
  // Agents talk where their bodies are: face to face in the same place, on the phone from anywhere else.
  const talks = new Talks({
    state: () => runtime.getStateService(),
    hasBody,
    bodyAt: (agent) => bodyAt(runtime.getStateService(), PLUGIN_CALLER, agent, talkRooms()),
  });
  subs.push(...followTalk(ctx.events, talks, messages));
  sweeps.push(() => talks.sweep());
  // A stay a body chose that has run out: its spot is let go, and from a place it went to for a while, it goes home.
  sweeps.push(() => endStays(runtime.getStateService()));
  // Bodies go where the talk is: to a room's meeting room while they talk there, and home after a quiet spell.
  const quietMinutes = typeof cfg.quietMinutes === "number" ? cfg.quietMinutes : QUIET_MINUTES;
  if (quietMinutes > 0) {
    const presence = new Presence({ state: () => runtime.getStateService(), hasBody, quietMs: quietMinutes * 60_000 });
    subs.push(
      ctx.events.on("room.woke", (e) => void presence.stay(e.agent, e.roomRef)),
      ctx.events.on("room.message", (e) => {
        // Only an agent has a body to go with; a label that isn't an agent's name is a person.
        if (e.speaker && agentNames().includes(e.speaker)) void presence.visit(e.speaker, e.roomRef);
      }),
    );
    sweeps.push(() => presence.sweep());
  }
  // Each morning, in the deployment's time zone, the habit trackers start the day unticked (`turnHabits`). Looked
  // at when TAI starts and whenever the day changes, so a day missed while it was off is still counted.
  let habitDay: string | undefined;
  sweeps.push(async () => {
    const timeZone = runtimeTimeProvider(runtime).timeZone();
    const today = dayIn(new Date(), timeZone);
    if (today === habitDay) return;
    await turnHabits(runtime.getStateService(), PLUGIN_CALLER, timeZone, new Date())
      .then(() => {
        habitDay = today;
      })
      .catch((err: Error) => console.warn(`[places] habits couldn't start the day: ${err.message}`));
  });
  const sweep = () => {
    // Each keeps its own troubles; one that slips through is said, never left to end the process.
    for (const s of sweeps)
      s().catch((err: unknown) => console.warn(`[places] a sweep failed: ${(err as Error).message}`));
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();
  stops.push(() => {
    clearInterval(timer);
    for (const sub of subs) sub.dispose();
  });

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
        const why = asleep(agent);
        if (why) return why;
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
        const { place } = await readHome(service, PLUGIN_CALLER, agent, homes);
        const here = await readCurrent(service, PLUGIN_CALLER, agent, { rooms, hasBody }, homes);
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

/** How often talks and visits that are over are ended, so a page sees the phone go down and the body go home. */
const SWEEP_MS = 20_000;

export default plugin;
