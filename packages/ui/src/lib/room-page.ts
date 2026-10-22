/**
 * What a room's page shows, worked out from the directory's records: its
 * headings, where its lead came from in words, and what it's for.
 *
 * The sections mirror the directory plugin's (`describeRoomPage` in
 * `directory-tools.ts`), which tells a room's members how people see its
 * page. This package takes no TAI dependency, so they are copied.
 */
import type { DirectoryRoom, RoomLead } from "../api";

/** A room's sections, in order, and their headings. */
export const ROOM_SECTIONS: Record<string, string> = {
  about: "What it's for",
  people: "Lead and members",
  working: "Working on",
  waiting: "Waiting on you",
  results: "Recent results",
  docs: "Docs",
  misses: "Questions nobody could answer",
};

/** Where a lead came from, in a person's words. */
const LEAD_FROM: Record<string, string> = {
  person: "you chose",
  config: "named in config",
  creator: "made the room",
};

/** "named in config", "you chose (config names trip-planner)", or nothing for a room with no lead. */
export function leadFrom(lead: RoomLead): string | undefined {
  if (!lead.agent || !lead.source) return undefined;
  const from = LEAD_FROM[lead.source] ?? lead.source;
  return lead.configured ? `${from}; config names ${lead.configured}` : from;
}

/** What a room is for: its profile's purpose, or the purpose it was given, marked as such. */
export function roomPurpose(room: DirectoryRoom): { text: string; given: boolean } | undefined {
  const own = room.profile?.data.purpose;
  if (typeof own === "string" && own.trim()) return { text: own.trim(), given: false };
  return room.purpose?.trim() ? { text: room.purpose.trim(), given: true } : undefined;
}

/** The fields a person set on a record, which agents leave as they are. */
export function heldOf(room: DirectoryRoom, id: string): Set<string> {
  return new Set(room.held[id] ?? []);
}
