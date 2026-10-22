/**
 * Rooms in the directory: a room keeps its own profile, commitments and docs,
 * its members change them, a lead is accountable for them, and a person's
 * edit to one stays as they left it. See `docs/directory.md` (Rooms) and the
 * design in `docs/ownership-design.md`.
 *
 * This file holds what can be said without the store: how a room is named in
 * a record, who leads it, and which fields a person's edit holds. The reads
 * and writes are the {@link Directory}'s, in `directory-records.ts`.
 *
 * A room's own records say so in two fields: `owner` is `room:<ref>` and
 * `room` is the ref. A commitment its lead took on for it is the lead's, with
 * `room` naming the room it was for.
 */
import { isDeepStrictEqual } from "node:util";
import type { StateChange } from "../state/types.js";

/** A room as the directory sees it, read from the rooms store through the plugin. */
export interface RoomInfo {
  /** The room's ref, `<backend>:<id>`. */
  ref: string;
  name: string;
  /** The purpose the room was given, which seeds its profile. */
  purpose?: string;
  /** Who opened it through TAI, an agent or a person, when it was opened that way. */
  createdBy?: string;
  archived: boolean;
}

/** What the directory reads of rooms. The plugin builds one over the rooms store. */
export interface RoomSource {
  /** Live rooms, by name. */
  list(): RoomInfo[];
  /** A room by name or ref, the live one first. */
  find(nameOrRef: string): RoomInfo | undefined;
  /** The agents subscribed to a room. */
  subscribers(ref: string): string[];
}

const ROOM_OWNER = "room:";

/** The `owner` of a room's own records. */
export function roomOwner(ref: string): string {
  return `${ROOM_OWNER}${ref}`;
}

/** The room an `owner` names, or undefined when the owner is an agent. */
export function roomOfOwner(owner: string | undefined): string | undefined {
  return owner?.startsWith(ROOM_OWNER) ? owner.slice(ROOM_OWNER.length) : undefined;
}

/** Where a room's lead came from: a person chose it on the room's page, config names it, or it made the room. */
export type LeadSource = "person" | "config" | "creator";

export interface Lead {
  /** The agent that leads the room; undefined when nobody does. */
  agent?: string;
  source?: LeadSource;
  /** The agent config names, when a person's choice stands in front of it. */
  configured?: string;
}

/** The agent `leads` in config names for a room, by its ref first and then its name. */
export function configuredLead(room: RoomInfo, leads: Record<string, string>): string | undefined {
  return leads[room.ref] ?? leads[room.name];
}

/**
 * Who leads a room: the agent a person chose on its page, then the one config
 * names, then the agent that created it. Only an agent that exists counts, so
 * a lead since removed, or a room a person opened, falls through to the next.
 */
export function leadOf(room: RoomInfo, at: { chosen?: string; leads: Record<string, string>; agents: string[] }): Lead {
  const exists = (name: string | undefined): name is string => !!name && at.agents.includes(name);
  const configured = configuredLead(room, at.leads);
  if (exists(at.chosen)) {
    return {
      agent: at.chosen,
      source: "person",
      ...(exists(configured) && configured !== at.chosen ? { configured } : {}),
    };
  }
  if (exists(configured)) return { agent: configured, source: "config" };
  if (exists(room.createdBy)) return { agent: room.createdBy, source: "creator" };
  return {};
}

/**
 * Fields that never hold: who a record belongs to and which room, the dated
 * log members add to, the times kept alongside the fields they date, and the
 * lead, which no agent can set.
 */
export const UNHELD: ReadonlySet<string> = new Set(["owner", "room", "updates", "reviewedAt", "noteAt", "lead"]);

/**
 * The fields of a room's record that a person's edit holds, read from its
 * history, newest first: those whose latest change was a person's edit and
 * that still have a value. An edit is a change to a record that already
 * existed, so creating one holds nothing, and a person who clears a field
 * hands it back. Changes before the record was last created belong to an
 * earlier record of the same id and are not read.
 */
export function heldFields(history: StateChange[], data: Record<string, unknown>): string[] {
  const byPerson = new Map<string, boolean>();
  for (const change of history) {
    if (change.op === "create") break;
    if (change.op !== "update" || change.lifecycle) continue;
    const before = change.before ?? {};
    const after = change.after ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (UNHELD.has(key) || byPerson.has(key) || isDeepStrictEqual(before[key], after[key])) continue;
      byPerson.set(key, change.actor.kind === "user");
    }
  }
  const present = (v: unknown) => v !== undefined && v !== null && v !== "";
  return [...byPerson]
    .filter(([key, person]) => person && present(data[key]))
    .map(([key]) => key)
    .sort();
}

/** What an agent is told when it would change fields a person set. */
export function heldRefusal(id: string, fields: string[]): string {
  const named = fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0];
  return `A person set ${named} on ${id}, so it stays as they left it. Ask them if it should change.`;
}

/**
 * The changes in `changes` that would overwrite a field a person holds: set
 * to a value other than the one it has. A change that leaves a field as it is
 * overwrites nothing.
 */
export function overwrites(changes: Record<string, unknown>, data: Record<string, unknown>, held: string[]): string[] {
  return held.filter((key) => key in changes && !isDeepStrictEqual(changes[key] ?? undefined, data[key]));
}
