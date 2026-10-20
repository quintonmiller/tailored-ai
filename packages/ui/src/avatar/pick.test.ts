import { describe, expect, it } from "vitest";
import { nearestUse, type Pickable } from "./pick";
import type { RoomDoor } from "./scene";

const door: RoomDoor = { wall: "back", along: 1, to: "town", label: "Maple Lane", kind: "town" };
/** A thing in the room: a group carrying what it is for, and a mesh of it, as the raycaster hits them. */
const thing = (data: Record<string, unknown>) => {
  const group: Pickable = { userData: data, parent: null };
  return { group, mesh: { userData: {}, parent: group } as Pickable };
};

describe("picking", () => {
  it("acts on the nearest thing under the pointer, not a door standing behind it", () => {
    const chair = thing({ spot: "armchair" });
    const doorway = thing({ door });
    // The chair is nearer; the door's mat behind it is hit too.
    expect(nearestUse([{ object: chair.mesh }, { object: doorway.mesh }])?.use).toEqual({ spot: "armchair" });
    expect(nearestUse([{ object: doorway.mesh }, { object: chair.mesh }])?.use).toEqual({ door });
    expect(nearestUse([])).toBeUndefined();
  });

  it("reads what the thing is for from it or anything it is part of", () => {
    const kiosk = thing({ action: "new-task", spot: "kiosk" });
    const deep: Pickable = { userData: {}, parent: kiosk.mesh };
    expect(nearestUse([{ object: deep }])?.use).toEqual({ action: "new-task", spot: "kiosk" });
  });
});
