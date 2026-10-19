/**
 * What a click in the room lands on: the nearest clickable thing under the
 * pointer, and what it leads to. Only the nearest counts, so a door standing
 * behind a chair never takes a click meant for the chair. Pure over anything
 * shaped like a three.js object, so it is tested without a GPU.
 */
import type { RoomDoor } from "./scene";

/** Enough of a three.js object to read what it is for. */
export interface Pickable {
  userData: Record<string, unknown>;
  parent: Pickable | null;
}

/** What a clickable thing does: go through a door, be used (a kiosk, a board), or send someone to a spot. */
export interface Use {
  door?: RoomDoor;
  action?: string;
  spot?: string;
}

/** The nearest of the hits (nearest first, as a raycaster gives them), and what it or anything it is part of is for. */
export function nearestUse<H extends { object: Pickable }>(hits: H[]): { hit: H; use: Use } | undefined {
  const hit = hits[0];
  if (!hit) return undefined;
  const use: Use = {};
  for (let o: Pickable | null = hit.object; o; o = o.parent) {
    if (!use.door && o.userData.door) use.door = o.userData.door as RoomDoor;
    if (use.action === undefined && typeof o.userData.action === "string") use.action = o.userData.action;
    if (use.spot === undefined && typeof o.userData.spot === "string") use.spot = o.userData.spot;
  }
  return { hit, use };
}
