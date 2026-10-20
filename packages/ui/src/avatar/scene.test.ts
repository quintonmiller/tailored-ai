/**
 * The room as data: a sound default layout, problems named when a layout is
 * not, lighting that follows the hour, and a camera that backs off for a
 * narrow frame.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  bodyFor,
  centrepieces,
  changesShown,
  closeDistance,
  DEFAULT_ROOM,
  farFor,
  fitView,
  framedIn,
  GESTURES,
  lightingFor,
  lightsFor,
  lookTarget,
  MIN_ASPECT,
  nearestWithin,
  OPEN_SIDES,
  OWN_NEAREST,
  OWN_VIEW,
  ownDistance,
  ownZoom,
  ROOM_TARGET,
  ROOM_VIEW,
  type Room,
  roomChanges,
  roomDistance,
  roomFocus,
  roomProblems,
  spotById,
  spotFor,
  spreadLights,
} from "./scene";

describe("the default room", () => {
  it("has no problems, and the avatar starts at a real spot", () => {
    expect(roomProblems(DEFAULT_ROOM)).toEqual([]);
    expect(spotById(DEFAULT_ROOM, DEFAULT_ROOM.start)).toBeDefined();
  });

  it("names every prop and spot the way a person would say it", () => {
    for (const item of [...DEFAULT_ROOM.props, ...DEFAULT_ROOM.spots]) expect(item.name).toMatch(/^(the|by|at|on) /);
  });
});

describe("roomProblems", () => {
  it("names a repeated id, a thing outside the walls, and a missing start", () => {
    const room: Room = {
      ...DEFAULT_ROOM,
      props: [
        { id: "a", name: "the a", kind: "rug", at: [0, 0], facing: 0 },
        { id: "a", name: "the other a", kind: "plant", at: [9, 0], facing: 0 },
      ],
      start: "nowhere",
    };
    expect(roomProblems(room)).toEqual([
      '"a" is used twice.',
      '"a" is outside the room.',
      'The starting spot "nowhere" does not exist.',
    ]);
  });
});

describe("roomProblems, for spots and what leads to them", () => {
  it("names furniture that leads nowhere, and a seat-less place to sit", () => {
    const room: Room = {
      ...DEFAULT_ROOM,
      props: [{ id: "stool", name: "the stool", kind: "chair", at: [0, 0], facing: 0, spot: "perch" }],
      spots: [{ id: "middle", name: "the middle", place: "the middle", at: [0, 0], facing: 0, activity: "sit" }],
    };
    expect(roomProblems(room)).toEqual([
      '"stool" leads to a spot that does not exist.',
      '"middle" is for sitting but has no seat.',
    ]);
  });
});

describe("lightingFor", () => {
  it("lights the room through the window by day, with the lamp off", () => {
    const day = lightingFor(11);
    expect(day.lamp.on).toBe(false);
    expect(day.sun.intensity).toBeGreaterThan(2);
  });

  it("turns the lamp on in the evening and leans on it at night", () => {
    const evening = lightingFor(18);
    const night = lightingFor(23);
    expect(evening.lamp.on).toBe(true);
    expect(night.lamp.intensity).toBeGreaterThan(evening.lamp.intensity);
    expect(night.sun.intensity).toBeLessThan(evening.sun.intensity);
    expect(night.window.glow).toBeLessThan(lightingFor(11).window.glow);
  });

  it("treats the small hours as night", () => {
    expect(lightingFor(3)).toEqual(lightingFor(23));
  });

  it("lights a home at night well enough to tell bodies and furniture from the floor, and keeps it darker than evening", () => {
    const night = lightingFor(23);
    const evening = lightingFor(18);
    // The fill from everywhere: what keeps a body in a dark corner from melting into the floor.
    expect(night.sky.intensity).toBeGreaterThanOrEqual(0.85);
    // The lamps reach further than their room alone would have them, so their pools meet across a big room.
    expect(night.lamp.reach ?? 1).toBeGreaterThan(1.2);
    expect(evening.lamp.reach ?? 1).toBe(1);
    // Still night: dimmer all round than the evening, the windows dark.
    expect(night.sun.intensity + night.sky.intensity).toBeLessThan(evening.sun.intensity + evening.sky.intensity);
    expect(night.window.glow).toBeLessThan(evening.window.glow);
  });

  it("keeps a public place bright after dark, where a home stays cosy, and lights both alike by day", () => {
    const brightness = (l: ReturnType<typeof lightingFor>) => l.sun.intensity + l.sky.intensity;
    const hall = lightingFor(23, "public");
    const home = lightingFor(23, "home");
    expect(brightness(hall)).toBeGreaterThan(brightness(home) * 2);
    // Nearly as bright as day, in warm white rather than moonlight blue.
    expect(brightness(hall)).toBeGreaterThan(brightness(lightingFor(11)) * 0.85);
    expect(hall.sky.color & 0xff).toBeGreaterThan(0xd0);
    expect(hall.sky.color >> 16).toBeGreaterThan(0xf0);
    // The windows still say it is night.
    expect(hall.window).toEqual(home.window);
    expect(lightingFor(18, "public").window).toEqual(lightingFor(18).window);
    expect(lightingFor(18, "public").sun.intensity).toBeGreaterThan(lightingFor(18).sun.intensity);
    expect(lightingFor(11, "public")).toEqual(lightingFor(11));
    expect(lightingFor(23)).toEqual(home);
  });
});

describe("lightsFor", () => {
  it("lights the town by the sky, the lobby, the office and the meeting rooms as public places, and the rest as homes", () => {
    expect(lightsFor("town")).toBe("outdoor");
    expect(lightsFor("lobby")).toBe("public");
    expect(lightsFor("office")).toBe("public");
    expect(lightsFor("office:2")).toBe("public");
    expect(lightsFor("room:local:trip")).toBe("public");
    expect(lightsFor("home:planner")).toBe("home");
    expect(lightsFor("shared:lounge")).toBe("home");
    expect(lightsFor(undefined)).toBe("home");
  });
});

describe("the town's light", () => {
  it("is the sun by day, low and warm in the evening, and the moon and the street lamps at night", () => {
    const noon = lightingFor(12, "outdoor");
    const evening = lightingFor(18, "outdoor");
    const night = lightingFor(23, "outdoor");
    expect(noon.lamp.on).toBe(false);
    expect(evening.lamp.on && night.lamp.on).toBe(true);
    expect(noon.sun.intensity).toBeGreaterThan(evening.sun.intensity);
    expect(evening.sun.intensity).toBeGreaterThan(night.sun.intensity);
    // Out of doors at night the lamps reach further than a room's, so a street is lit between them.
    expect(night.lamp.reach ?? 1).toBeGreaterThan(lightingFor(23, "home").lamp.reach ?? 1);
  });

  it("sees out past the woods round the town to the horizon", () => {
    const town = { ...DEFAULT_ROOM, width: 160, depth: 150, town: {} as never };
    expect(farFor(town)).toBeGreaterThan(300);
    expect(farFor(DEFAULT_ROOM)).toBeLessThan(farFor(town));
  });
});

describe("roomDistance", () => {
  it("backs the camera off for a narrow frame, so a phone still sees the whole room", () => {
    expect(roomDistance(DEFAULT_ROOM, 0.5)).toBeGreaterThan(roomDistance(DEFAULT_ROOM, 1.8));
  });

  it("is never closer than the room's height needs", () => {
    expect(roomDistance(DEFAULT_ROOM, 10)).toBeCloseTo(roomDistance(DEFAULT_ROOM, 20), 5);
  });

  it("keeps every corner of a room in the frame, big or small, without leaving it lost in the middle", () => {
    const rooms = [
      DEFAULT_ROOM,
      { ...DEFAULT_ROOM, width: 8, depth: 8, height: 3 },
      { ...DEFAULT_ROOM, width: 10, depth: 6, height: 2.7 },
      { ...DEFAULT_ROOM, width: 10, depth: 8, height: 3 },
      { ...DEFAULT_ROOM, width: 14, depth: 10, height: 3.2 },
      { ...DEFAULT_ROOM, width: 16, depth: 12, height: 4 },
    ];
    for (const room of rooms)
      for (const aspect of [MIN_ASPECT, 0.35, 0.6, 1, 1.8]) {
        // The stage's own far plane: nothing of the room may lie past it, however narrow the frame.
        const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, aspect, 0.05, farFor(room));
        const target = new THREE.Vector3(...ROOM_TARGET);
        camera.position
          .setFromSphericalCoords(roomDistance(room, aspect), Math.PI / 2 - ROOM_VIEW.elevation, ROOM_VIEW.azimuth)
          .add(target);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        const { width: w, depth: d, height: h } = room;
        const corners = [
          [-w / 2, 0, -d / 2],
          [w / 2, 0, -d / 2],
          [-w / 2, 0, d / 2],
          [w / 2, 0, d / 2],
          [-w / 2, h, -d / 2],
          [w / 2, h, -d / 2],
          [-w / 2, h, d / 2],
        ].map(([x, y, z]) => new THREE.Vector3(x, y, z).project(camera));
        const label = `${w}x${d} at ${aspect}`;
        for (const c of corners) {
          expect(Math.abs(c.x), label).toBeLessThanOrEqual(1);
          expect(Math.abs(c.y), label).toBeLessThanOrEqual(1);
          expect(Math.abs(c.z), label).toBeLessThanOrEqual(1);
        }
        // Snug: some corner comes close to an edge of the frame.
        expect(Math.max(...corners.flatMap((c) => [Math.abs(c.x), Math.abs(c.y)])), label).toBeGreaterThan(0.85);
      }
  });

  it("backs off further for a bigger room", () => {
    expect(roomDistance({ ...DEFAULT_ROOM, width: 10, depth: 8 }, 1.5)).toBeGreaterThan(
      roomDistance(DEFAULT_ROOM, 1.5) * 1.5,
    );
  });
});

describe("ownDistance", () => {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360);

  it("takes in enough of the room's height that the agent stands about a quarter of the frame tall", () => {
    for (const aspect of [1, 1.6, 2.4]) expect(2 * ownDistance(aspect) * tanV).toBeCloseTo(OWN_VIEW.height, 6);
  });

  it("takes in as much above a phone's chat as on the whole stage, backing off by the share that is covered", () => {
    expect(ownDistance(1.3, 0.4)).toBeCloseTo(ownDistance(1.3) / 0.4, 9);
    // And the whole room, fitted into the strip above it.
    const home: Room = { ...DEFAULT_ROOM, width: 8, depth: 6.5, height: 2.8 };
    expect(roomDistance(home, 1.3, 0.5)).toBeGreaterThan(roomDistance(home, 1.3) * 1.8);
  });

  it("backs off on a phone held upright, so there is still something to see either side", () => {
    const upright = ownDistance(0.46);
    expect(2 * upright * tanV * 0.46).toBeCloseTo(OWN_VIEW.width, 6);
    expect(upright).toBeGreaterThan(ownDistance(1.6));
  });
});

describe("closeDistance", () => {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360);

  it("fits the head and shoulders to the height of a wide stage", () => {
    expect(2 * closeDistance(1, 1.6) * tanV).toBeCloseTo(1, 6);
  });

  it("fits them to the strip above a phone's chat, not to the whole stage, and backs off for a narrow one", () => {
    // A phone 390 by 844 with the chat open: 305 pixels of the stage show, 1.28 times as wide as they are tall.
    const strip = closeDistance(1, 1.28, 305 / 844);
    expect(2 * strip * tanV * (305 / 844)).toBeCloseTo(1, 6);
    expect(strip).toBeGreaterThan(2.7 * closeDistance(1, 1.28));
    // Upright with nothing over it, the width is what limits it.
    expect(2 * closeDistance(1, 0.46) * tanV * 0.46).toBeCloseTo(0.9, 6);
  });
});

describe("framedIn", () => {
  // A phone 390 by 844 with the chat open: the toolbar down to 90, the chat from 395.
  const strip = { left: 0, right: 390, top: 90, bottom: 395 };
  // The stage's own controls down its left side: the view toggle, the tools, and where you are.
  const phoneControls = [
    { left: 16, right: 150, top: 105, bottom: 131 },
    { left: 16, right: 180, top: 145, bottom: 169 },
    { left: 16, right: 205, top: 182, bottom: 245 },
  ];

  it("frames in all that the page leaves uncovered while the controls sit up in a corner", () => {
    // A wide stage with the chat panel down its right: the controls are over the far wall, not where the agent is.
    const open = { left: 0, right: 610, top: 91, bottom: 760 };
    const controls = [
      { left: 16, right: 170, top: 102, bottom: 128 },
      { left: 16, right: 260, top: 142, bottom: 166 },
      { left: 16, right: 360, top: 180, bottom: 207 },
    ];
    expect(framedIn(open, controls)).toEqual(open);
    expect(framedIn(strip, [])).toEqual(strip);
  });

  it("frames beside the controls where they reach into the middle of the strip above a phone's chat", () => {
    const part = framedIn(strip, phoneControls);
    // Clear of them, the whole height of the strip, where the agent comes out bigger than under them.
    expect(part.left).toBeGreaterThanOrEqual(205);
    expect(part).toMatchObject({ right: 390, top: 90, bottom: 395 });
  });

  it("frames under the controls when they run across the stage, where there is no room beside them", () => {
    const controls = [{ left: 16, right: 374, top: 100, bottom: 300 }];
    const part = framedIn({ left: 0, right: 390, top: 90, bottom: 700 }, controls);
    expect(part.top).toBeGreaterThanOrEqual(300);
    expect(part).toMatchObject({ left: 0, right: 390, bottom: 700 });
  });

  it("frames under a phone's one row of tools across the top, though it never reaches the middle", () => {
    const row = { left: 8, right: 382, top: 96, bottom: 134 };
    const part = framedIn(strip, [row]);
    expect(part).toEqual({ left: 0, right: 390, top: 142, bottom: 395 });
    // A button or two up in the corner is no bar: the scene is framed past it, as before.
    expect(framedIn(strip, [{ left: 8, right: 120, top: 96, bottom: 134 }])).toEqual(strip);
    // Nor is a row along the foot of the strip.
    expect(framedIn(strip, [{ ...row, top: 350, bottom: 388 }]).top).toBe(90);
  });
});

describe("roomFocus", () => {
  // A home as the server lays one out: 8 by 6.5.
  const home: Room = { ...DEFAULT_ROOM, width: 8, depth: 6.5, height: 2.8 };

  it("sees a room whole when it fits the view, centred on the room", () => {
    const small: Room = { ...DEFAULT_ROOM, width: 2.4, depth: 2, height: 2.2 };
    for (const aspect of [1.4, 1.8]) {
      expect(roomDistance(small, aspect)).toBeLessThan(ownDistance(aspect));
      expect(roomFocus(small, aspect, { x: 1, z: 0.5 })).toEqual({
        target: ROOM_TARGET,
        distance: roomDistance(small, aspect),
      });
    }
  });

  it("comes in close on a home, so the agent you talk to is comfortably big, and follows it round", () => {
    for (const aspect of [0.91, 1.57]) {
      const there = roomFocus(home, aspect, { x: 2.5, z: 1.5 });
      expect(there.distance).toBeCloseTo(ownDistance(aspect), 6);
      // About half as far back as seeing the whole room, so the agent is about twice the size.
      expect(there.distance).toBeLessThan(roomDistance(home, aspect) * 0.6);
      // The view slides toward where the agent is.
      expect(there.target[0]).toBeGreaterThan(ROOM_TARGET[0]);
      expect(there.target[2]).toBeGreaterThan(ROOM_TARGET[2]);
      expect(roomFocus(home, aspect, { x: -2.5, z: -1.5 }).target[0]).toBeLessThan(ROOM_TARGET[0]);
    }
  });

  it("zooms out as far as the whole room, and in only so far", () => {
    for (const aspect of [0.91, 1.57]) {
      expect(roomFocus(home, aspect, { x: 2, z: 1 }, 50)).toEqual({
        target: ROOM_TARGET,
        distance: roomDistance(home, aspect),
      });
      expect(roomFocus(home, aspect, { x: 2, z: 1 }, 0.1).distance).toBeCloseTo(ownDistance(aspect) * OWN_NEAREST, 6);
      const out = roomFocus(home, aspect, { x: 2, z: 1 }, 1.3).distance;
      expect(out).toBeGreaterThan(ownDistance(aspect));
      expect(out).toBeLessThan(roomDistance(home, aspect));
    }
  });

  it("keeps the agent in frame wherever it stands, near or zoomed out, and never slides off the room", () => {
    const rooms = [
      home,
      { ...DEFAULT_ROOM, width: 10, depth: 8, height: 3 },
      { ...DEFAULT_ROOM, width: 14, depth: 10, height: 3.2 },
      { ...DEFAULT_ROOM, width: 16, depth: 12, height: 4 },
    ];
    for (const room of rooms)
      for (const aspect of [0.46, 1.1, 1.8])
        for (const zoom of [OWN_NEAREST, 1, 1.6]) {
          const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, aspect, 0.05, farFor(room));
          for (let x = -room.width / 2 + 0.5; x <= room.width / 2 - 0.5; x += 1)
            for (let z = -room.depth / 2 + 0.5; z <= room.depth / 2 - 0.5; z += 1) {
              const { target, distance } = roomFocus(room, aspect, { x, z }, zoom);
              const aim = new THREE.Vector3(...target);
              camera.position
                .setFromSphericalCoords(distance, Math.PI / 2 - ROOM_VIEW.elevation, ROOM_VIEW.azimuth)
                .add(aim);
              camera.lookAt(aim);
              camera.updateMatrixWorld();
              const label = `${room.width}x${room.depth} at ${aspect} zoomed ${zoom}, agent at ${x}, ${z}`;
              // Its feet and its head.
              for (const y of [0, 1.6]) {
                const p = new THREE.Vector3(x, y, z).project(camera);
                expect(Math.abs(p.x), label).toBeLessThanOrEqual(1);
                expect(Math.abs(p.y), label).toBeLessThanOrEqual(1);
              }
              // The view never slides off the room: what it looks at is always on the floor.
              expect(Math.abs(target[0]), label).toBeLessThanOrEqual(room.width / 2);
              expect(Math.abs(target[2]), label).toBeLessThanOrEqual(room.depth / 2);
            }
        }
  });
});

describe("ownZoom", () => {
  const home: Room = { ...DEFAULT_ROOM, width: 8, depth: 6.5, height: 2.8 };

  it("stops at the nearest the view comes, and at the whole room", () => {
    expect(ownZoom(0.2, home, 1.57)).toBe(OWN_NEAREST);
    expect(ownZoom(1.2, home, 1.57)).toBe(1.2);
    const whole = roomDistance(home, 1.57) / ownDistance(1.57);
    expect(ownZoom(9, home, 1.57)).toBeCloseTo(whole, 9);
    // So the first notch back in comes in at once, rather than unwinding zoom past the whole room.
    expect(roomFocus(home, 1.57, { x: 0, z: 0 }, ownZoom(9, home, 1.57) / 1.2).distance).toBeLessThan(
      roomDistance(home, 1.57),
    );
  });

  it("lets a room smaller than the view zoom in but not out", () => {
    const small: Room = { ...DEFAULT_ROOM, width: 2.4, depth: 2, height: 2.2 };
    expect(ownZoom(3, small, 1.57)).toBe(1);
  });
});

describe("spreadLights", () => {
  const lamp = (x: number, z: number, fire = false) => ({ at: { x, z }, fire });

  it("keeps a fire, then lamps as far apart as they can be, so a big room is lit all over", () => {
    const lights = [
      lamp(-4, -3),
      lamp(-3.6, -3),
      lamp(-3.2, -2.8),
      lamp(4, 3),
      lamp(0, 0, true),
      lamp(4, -3),
      lamp(-4, 3),
    ];
    const kept = spreadLights(lights, 4);
    expect(kept).toHaveLength(4);
    expect(kept[0].fire).toBe(true);
    // One from each corner, not three from the crowded one.
    expect(kept.filter((l) => l.at.x < -3 && l.at.z < -2)).toHaveLength(1);
  });

  it("keeps them all when there are few enough", () => {
    expect(spreadLights([lamp(0, 0), lamp(1, 1)], 4)).toHaveLength(2);
  });
});

describe("nearestWithin", () => {
  it("keeps an angle that looks in through an open side", () => {
    expect(nearestWithin(0.3, OPEN_SIDES)).toBeCloseTo(0.3);
  });

  it("swings a view that would be behind a wall to the nearest open angle", () => {
    // Facing the desk on the back wall, or the shelf on the left wall.
    expect(nearestWithin((145 * Math.PI) / 180, OPEN_SIDES)).toBe(OPEN_SIDES[1]);
    expect(nearestWithin(-Math.PI / 2, OPEN_SIDES)).toBe(OPEN_SIDES[0]);
  });

  it("reads angles the long way round the same as the short way", () => {
    expect(nearestWithin(0.3 + 2 * Math.PI, OPEN_SIDES)).toBeCloseTo(0.3);
  });
});

describe("bodyFor", () => {
  const body = bodyFor(DEFAULT_ROOM);

  it("offers the avatar's gestures, the spots to walk to, and things to look or point at", () => {
    expect(body.gestures).toEqual([...GESTURES]);
    const [go, look, point] = body.aimed;
    expect(go).toMatchObject({ verb: "go", prep: "to", targets: DEFAULT_ROOM.spots.map((s) => s.place) });
    expect(look.targets).toContain("you");
    expect(look.targets).toContain("the window");
    expect(point.targets).not.toContain("you");
  });

  it("uses only names the server accepts into a prompt: short plain words", () => {
    const names = [body.looks, ...body.gestures, ...body.aimed.flatMap((m) => [m.does, ...m.targets])];
    for (const n of names) expect(n).toMatch(/^[\p{L}\p{N}][\p{L}\p{N} '’-]{0,47}$/u);
  });
});

describe("spotFor and lookTarget", () => {
  it("finds the spot a go means, however it is named", () => {
    expect(spotFor(DEFAULT_ROOM, "the couch")?.id).toBe("couch");
    expect(spotFor(DEFAULT_ROOM, "Couch")?.id).toBe("couch");
    expect(spotFor(DEFAULT_ROOM, "the laptop")?.id).toBe("desk");
    expect(spotFor(DEFAULT_ROOM, "the middle")?.id).toBe("middle");
    expect(spotFor(DEFAULT_ROOM, "the attic")).toBeUndefined();
  });

  it("knows the viewer and where things are, at the height of their middle", () => {
    expect(lookTarget(DEFAULT_ROOM, "the user")).toEqual({ viewer: true });
    expect(lookTarget(DEFAULT_ROOM, "you")).toEqual({ viewer: true });
    expect(lookTarget(DEFAULT_ROOM, "the window")).toEqual({ at: [-2.09, 1.5, -0.45] });
    expect(lookTarget(DEFAULT_ROOM, "the moon")).toBeUndefined();
  });
});

describe("bodyFor with company", () => {
  it("says who else is here, and lets the agent look and point at them", () => {
    const body = bodyFor(DEFAULT_ROOM, ["planner", "scout"]);
    expect(body.looks).toBe("a small figure in a cozy room with planner and scout");
    expect(body.aimed.find((a) => a.verb === "look")?.targets).toEqual(
      expect.arrayContaining(["you", "planner", "scout"]),
    );
    expect(body.aimed.find((a) => a.verb === "point")?.targets).toContain("scout");
  });

  it("keeps the description short when the room is crowded", () => {
    const many = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    expect(bodyFor(DEFAULT_ROOM, many).looks.length).toBeLessThanOrEqual(80);
  });
});

describe("what a change did to a room's things", () => {
  it("grows in what is new or made over, and glides what only moved or turned from where it stood", () => {
    const before = DEFAULT_ROOM;
    const [first, second, third, fourth] = before.props;
    const after: Room = {
      ...before,
      props: [
        { ...first, at: [first.at[0] + 0.5, first.at[1]] },
        { ...second, color: "#112233" },
        { ...third, facing: third.facing + 90 },
        fourth,
        { id: "new-lamp", name: "the new lamp", kind: "lamp", at: [0, 0], facing: 0 },
      ],
    };
    const { fresh, moved } = roomChanges(before, after);
    expect([...fresh].sort()).toEqual([second.id, "new-lamp"].sort());
    expect([...moved.keys()].sort()).toEqual([first.id, third.id].sort());
    // Where it was, to glide from.
    expect(moved.get(first.id)?.at).toEqual(first.at);
    expect(roomChanges(before, before)).toEqual({ fresh: new Set(), moved: new Map() });
  });

  it("grows in again a model made over since, wherever it stands", () => {
    const shelf = {
      id: "shelf",
      name: "the bookcase",
      kind: "model" as const,
      model: "planner:bookcase",
      at: [0, 0] as [number, number],
      facing: 0,
    };
    const def = {
      name: "bookcase",
      owner: "planner",
      mount: "floor" as const,
      size: [1, 2, 0.3] as [number, number, number],
      parts: [],
    };
    const before: Room = { ...DEFAULT_ROOM, props: [shelf], models: { "planner:bookcase": def } };
    const after: Room = { ...before, models: { "planner:bookcase": { ...def, size: [1, 2.2, 0.3] } } };
    expect([...roomChanges(before, after).fresh]).toEqual(["shelf"]);
    expect(roomChanges(before, { ...before }).fresh.size).toBe(0);
  });

  it("doesn't grow in again a model whose face only shows other records now", () => {
    const board = {
      id: "board",
      name: "the todo board",
      kind: "wall_model" as const,
      model: "planner:todo_board",
      at: [0, -2] as [number, number],
      facing: 0,
    };
    const face = (items: string[]) => ({
      kind: "list",
      spec: { id: "c-1", kind: "list", props: { title: "To do", items }, fallback: "" },
    });
    const def = (items: string[]) => ({
      name: "todo_board",
      owner: "planner",
      mount: "wall" as const,
      size: [1.1, 0.8, 0.09] as [number, number, number],
      parts: [
        {
          shape: "box" as const,
          size: [1, 0.7, 0.01] as [number, number, number],
          at: [0, 0.4, 0.05] as [number, number, number],
          color: "#f6f1e3",
          face: face(items),
        },
      ],
    });
    const before: Room = { ...DEFAULT_ROOM, props: [board], models: { "planner:todo_board": def([]) } };
    const after: Room = { ...before, models: { "planner:todo_board": def(["Book the ferry"]) } };
    expect(roomChanges(before, after).fresh.size).toBe(0);
  });

  it("shows nothing changing on going to another place, or on the first room after the stand-in", () => {
    // Two homes drawn from the same kit: a plant and a lamp in each, in different spots.
    const home = (x: number): Room => ({
      ...DEFAULT_ROOM,
      props: [
        { id: "plant", name: "the plant", kind: "plant", at: [x, -1], facing: 0 },
        { id: "lamp", name: "the lamp", kind: "lamp", at: [-x, 1], facing: 0 },
      ],
    });
    const mine = home(1);
    const theirs = home(-1.5);
    expect(changesShown(mine, theirs, false)).toBeUndefined();
    // The stand-in shares ids with real rooms too.
    expect(changesShown(DEFAULT_ROOM, mine, true)).toBeUndefined();
    // The same place changing: the plant moved, and glides.
    const moved = { ...mine, props: [{ ...mine.props[0], at: [2, -1] as [number, number] }, mine.props[1]] };
    expect([...(changesShown(mine, moved, true)?.moved.keys() ?? [])]).toEqual(["plant"]);
  });
});

describe("fitView", () => {
  // The camera's way of looking, as the room view has it, to put the points where the camera would see them.
  const { azimuth: a, elevation: e, fov } = ROOM_VIEW;
  const back = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  /** Each point's place across and up the frame, -1 to 1 at its edges, from a camera framed as `fitView` says. */
  const onFrame = (points: [number, number, number][], aspect: number, tall = 1) => {
    const { target, distance } = fitView(points, aspect, tall);
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
    camera.position.copy(new THREE.Vector3(...target).addScaledVector(back, distance));
    camera.lookAt(...target);
    camera.updateMatrixWorld();
    // With part of the stage covered, the frame is that much shorter: a point at the edge of the part is at `tall`.
    return points.map((p) => new THREE.Vector3(...p).project(camera)).map((v) => [v.x, v.y / tall]);
  };
  // You at the door of a meeting room, its table in the middle and its task board on the back wall.
  const you: [number, number, number][] = [
    [-3.5, 0, 2.5],
    [-3.5, 1.9, 2.5],
  ];
  const table: [number, number, number][] = [
    [-0.6, 0.75, -0.8],
    [0.6, 0.75, 0.4],
    [-0.6, 0, 0.4],
  ];
  const board: [number, number, number][] = [
    [-0.7, 1.95, -3.3],
    [0.7, 1.05, -3.3],
  ];
  const points = [...you, ...table, ...board];

  it("has you, the table and the board all in the frame, with a margin, however the frame is shaped", () => {
    for (const [aspect, tall] of [
      [1.6, 1],
      [0.9, 1],
      [2.6, 0.45],
    ]) {
      for (const [x, y] of onFrame(points, aspect, tall)) {
        expect(Math.abs(x), `${aspect} ${tall}`).toBeLessThanOrEqual(0.93);
        expect(Math.abs(y), `${aspect} ${tall}`).toBeLessThanOrEqual(0.93);
      }
    }
  });

  it("looks at the middle of them, not at you, and comes no further back than it has to", () => {
    const { target, distance } = fitView(points, 1.6);
    const looked = onFrame(points, 1.6);
    // Something is right at an edge: it backs off only as far as the furthest out needs.
    expect(Math.max(...looked.flat().map(Math.abs))).toBeGreaterThan(0.85);
    // Toward the table from where you stand.
    expect(target[0]).toBeGreaterThan(-3);
    expect(fitView(you, 1.6).distance).toBeLessThan(distance);
    // A narrower frame backs off further for the same things.
    expect(fitView(points, 0.9).distance).toBeGreaterThan(distance);
  });
});

describe("centrepieces", () => {
  const prop = (id: string, kind: string, at: [number, number]) => ({ id, name: id, kind, at, facing: 0 }) as never;

  it("is the table nearest the middle and the task board: what a room is gathered round", () => {
    const room = {
      props: [
        prop("side", "side_table", [0, 0]),
        prop("coffee", "coffee_table", [2.5, 1]),
        prop("table-1", "round_table", [0.2, -0.3]),
        prop("board", "board", [0, -3.3]),
        prop("lamp", "lamp", [0, 0.1]),
      ],
    };
    expect(centrepieces(room)).toEqual(["table-1", "board"]);
    // A room with neither has nothing the camera needs to show on the way in.
    expect(centrepieces({ props: [prop("side", "side_table", [0, 0]), prop("couch", "couch", [1, 1])] })).toEqual([]);
  });
});
