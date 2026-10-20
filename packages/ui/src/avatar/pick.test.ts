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

  it("passes over a thing that isn't drawn, or is part of something that isn't, to what is behind it", () => {
    // A door in the town too far off to show, on the front of its building: a click on it is a click on the building.
    const far = thing({ door });
    far.group.visible = false;
    const building = thing({ approach: [4, 2] });
    expect(nearestUse([{ object: far.mesh }, { object: building.mesh }])?.use).toEqual({ approach: [4, 2] });
    expect(nearestUse([{ object: far.mesh }])).toBeUndefined();
    far.group.visible = true;
    expect(nearestUse([{ object: far.mesh }, { object: building.mesh }])?.use).toEqual({ door });
  });

  it("reads what the thing is for from it or anything it is part of", () => {
    const kiosk = thing({ action: "new-task", spot: "kiosk" });
    const deep: Pickable = { userData: {}, parent: kiosk.mesh };
    expect(nearestUse([{ object: deep }])?.use).toEqual({ action: "new-task", spot: "kiosk" });
  });
});
