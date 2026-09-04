/**
 * What a party can actually read, and in what order.
 *
 * The baseline policies cannot catch a regression here. A bot reads
 * `snapshot()` — a typed object — so every one of them navigates a floor
 * perfectly no matter what the prose says, and the ladder stays monotonic while
 * a live party walks in circles. That gap is not hypothetical: a run on
 * 2026-08-14 spent sixty-six `choose_path` calls and ten combat actions across
 * twenty-two rounds, never leaving floor one, and finished with 66 experience
 * against a rule-based baseline of 660. Nothing in the suite went red.
 *
 * So these tests assert on the text itself. They are the only check in the
 * package that the game is legible to the thing that plays it.
 */

import type { Tool } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { generateFloorMap, knownRouteAcross } from "../sim/descent/content.js";
import type { DescentSimulation } from "../sim/descent/index.js";
import { DESCENT_POLICIES } from "../sim/descent/policies.js";
import { createSimulation } from "../sim/index.js";
import { makeRng } from "../sim/rng.js";

function tool(sim: DescentSimulation, name: string): Tool {
  const flat = [...Object.values(sim.tools()).flat(), ...sim.sharedTools()];
  const found = flat.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool called ${name}`);
  return found;
}

async function call(
  sim: DescentSimulation,
  agent: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await tool(sim, name).execute(args, { agentName: agent } as never);
  return String(result.output ?? "");
}

const scene = (sim: DescentSimulation) => (sim.snapshot() as { scene: Record<string, never> }).scene as never as Scene;

interface Scene {
  phase: string;
  paths: Array<{ id: string; label: string; hint: string }>;
  enemies: Array<{ ref: string; hp: number }>;
  floorMap: { currentRoom: string; rooms: Array<{ id: string; kind: string; label: string; visited: boolean }> } | null;
}

/** The scenario's own configuration. A floor-one sweep describes a different game. */
const maze = (seed: number) =>
  createSimulation("descent", {
    seed,
    days: 400,
    startFloor: 1,
    preparation: true,
    startingGold: 180,
    startingSkillPoints: 2,
    maze: true,
  }) as DescentSimulation;

/** Walk far enough in that the floor holds both entered and unentered rooms. */
async function intoTheMaze(sim: DescentSimulation, steps = 12): Promise<void> {
  await call(sim, "guardian", "enter_dungeon");
  for (let i = 0; i < steps; i++) {
    const s = scene(sim);
    if (s.phase === "explore" && s.paths.length > 0) {
      await call(sim, "guardian", "choose_path", { path: s.paths[0].id });
    } else if (s.phase === "combat") {
      const enemy = s.enemies.find((candidate) => candidate.hp > 0);
      if (enemy)
        for (const who of ["guardian", "rogue", "ranger"]) await call(sim, who, "attack", { target: enemy.ref });
    } else if (s.phase === "spoils") {
      await call(sim, "guardian", "continue_exploring");
    }
    sim.advance();
  }
}

describe("telling a room you have entered from one you have not", () => {
  it("says so in the first word of every way on", async () => {
    const sim = maze(2201);
    await intoTheMaze(sim);
    const s = scene(sim);
    expect(s.phase, "the walk should end somewhere with ways on").toBe("explore");
    expect(s.paths.length).toBeGreaterThan(0);

    const map = s.floorMap;
    if (!map) throw new Error("a maze run must publish a floor map");

    for (const path of s.paths) {
      const room = map.rooms.find((candidate) => candidate.id === path.id);
      if (!room) throw new Error(`path ${path.id} names a room that is not on the map`);
      // The claim is specifically about the *leading* token: a status buried
      // mid-sentence is what the party already had, and could not use.
      const lead = path.hint.split(";")[0].trim();
      expect(
        room.visited ? lead : `NEW${lead}`,
        `"${path.hint}" must open by saying whether the party has been to ${room.label}`,
      ).toMatch(room.visited ? /^BEEN THERE$/ : /^NEW/);
    }
  });

  it("has something to distinguish, or the test proves nothing", async () => {
    // A control on the fixture rather than on the code: if this walk happened
    // to leave every adjacent room in the same state, the assertion above would
    // pass against any implementation at all.
    const sim = maze(2201);
    await intoTheMaze(sim);
    const map = scene(sim).floorMap;
    if (!map) throw new Error("a maze run must publish a floor map");
    expect(map.rooms.some((room) => room.visited)).toBe(true);
    expect(map.rooms.some((room) => !room.visited)).toBe(true);
  });
});

describe("the standing of a floor", () => {
  it("says whether the stairs have been found, before anything about anybody's character", async () => {
    const sim = maze(2201);
    await intoTheMaze(sim);
    const text = await call(sim, "mage", "look");

    expect(text).toMatch(/This floor: \d+ of \d+ rooms entered/);
    expect(text).toMatch(/stairs down/);

    // Ordering is the whole point. Character is what makes the run worth
    // watching; it is not what the next tool call is about.
    const decision = Math.min(
      ...[/Ways on/, /Against you/].map((pattern) => {
        const at = text.search(pattern);
        return at === -1 ? Number.POSITIVE_INFINITY : at;
      }),
    );
    const character = text.search(/Who you are:/);
    expect(decision, "the party's decision must appear somewhere").toBeLessThan(Number.POSITIVE_INFINITY);
    expect(character, "the dossier must still be there").toBeGreaterThan(-1);
    expect(character, "the dossier must not come before the decision").toBeGreaterThan(decision);
  });

  it("names the room the stairs are in once the party has stood in it", async () => {
    // Driven by the shipped policy rather than a hand-rolled walk: a bot good
    // enough to find the stairs is exactly what this package already has, and a
    // worse one in the test would only be measuring itself.
    const sim = maze(2201);
    const bot = DESCENT_POLICIES["rule-based"]();
    for (let i = 0; i < 400 && !sim.done; i++) {
      const stairs = scene(sim).floorMap?.rooms.find((room) => room.kind === "stairs");
      if (stairs?.visited) {
        const text = await call(sim, "mage", "look");
        expect(text).toMatch(new RegExp(`stairs down are (in ${stairs.label}|in this room)`));
        return;
      }
      bot.act(sim);
      sim.advance();
    }
    throw new Error("the rule-based bot never stood on a staircase — the fixture, not the claim, is wrong");
  });
});

describe("what gets repeated", () => {
  it("introduces the party once, at camp, and not on every look after it", async () => {
    const sim = maze(2201);
    const atCamp = await call(sim, "mage", "look");
    // An aspiration is an introduction. It never changes, so a party that reads
    // it every round for forty rounds is paying for it forty times.
    expect(atCamp, "the party should meet properly before the first stair").toMatch(/Public aspiration:/);

    await intoTheMaze(sim);
    const underground = await call(sim, "mage", "look");
    expect(underground).not.toMatch(/Public aspiration:/);
    // The part that does change stays in both.
    expect(underground).toMatch(/Private motive:/);
    expect(underground.length, "the underground look should be the shorter one").toBeLessThan(atCamp.length);
  });
});

describe("crossing ground the party has already cleared", () => {
  /** A three-room line: r0 — r1 — r2, all open, with r1 finished. */
  const line = () => ({
    zone: "Test",
    currentRoom: "r0",
    keys: 0,
    rooms: [
      { id: "r0", links: ["r1"], visited: true, cleared: true },
      { id: "r1", links: ["r0", "r2"], visited: true, cleared: true },
      { id: "r2", links: ["r1"], visited: false, cleared: false },
    ].map((room) => ({
      label: room.id,
      kind: "empty",
      x: 0,
      y: 0,
      revealed: true,
      key: false,
      keyCollected: false,
      environment: null,
      encounter: undefined,
      ...room,
    })),
    routes: [
      { id: "a", from: "r0", to: "r1" },
      { id: "b", from: "r1", to: "r2" },
    ].map((route) => ({
      kind: "open",
      bidirectional: true,
      discovered: true,
      triggered: false,
      disarmed: false,
      openedBy: null,
      traversals: 0,
      ...route,
    })),
  });

  it("finds a way across finished rooms", () => {
    expect(knownRouteAcross(line() as never, "r0", "r2")).toEqual(["r1", "r2"]);
  });

  it("stops at a door nobody has opened", () => {
    const map = line();
    map.routes[0].kind = "locked";
    expect(knownRouteAcross(map as never, "r0", "r2")).toBeUndefined();
    // ...and crosses it once it has been opened, so the refusal is about the
    // lock rather than about the route being unusable in principle.
    (map.routes[0] as { openedBy: string | null }).openedBy = "key";
    expect(knownRouteAcross(map as never, "r0", "r2")).toEqual(["r1", "r2"]);
  });

  it("stops at a trap nobody has dealt with", () => {
    const map = line();
    map.routes[0].kind = "trap";
    expect(knownRouteAcross(map as never, "r0", "r2")).toBeUndefined();
    map.routes[0].disarmed = true;
    expect(knownRouteAcross(map as never, "r0", "r2")).toEqual(["r1", "r2"]);
  });

  it("will not walk through a room that still holds enemies", () => {
    const map = line();
    (map.rooms[1] as { encounter?: unknown }).encounter = { enemies: [{ hp: 40 }] };
    expect(knownRouteAcross(map as never, "r0", "r2")).toBeUndefined();
  });

  it("will not walk through a room nobody has entered", () => {
    const map = line();
    map.rooms[1].visited = false;
    expect(knownRouteAcross(map as never, "r0", "r2")).toBeUndefined();
  });

  it("moves the party the whole way in one round, and charges dread for the distance", async () => {
    const sim = maze(2201);
    const bot = DESCENT_POLICIES["rule-based"]();
    for (let i = 0; i < 400 && !sim.done; i++) {
      const s = scene(sim);
      const far = s.paths.find((path) => path.hint.startsWith("ACROSS KNOWN GROUND"));
      if (s.phase === "explore" && far) {
        const before = { room: s.floorMap?.currentRoom, dread: (sim.snapshot() as { dread: number }).dread };
        await call(sim, "guardian", "choose_path", { path: far.id });
        sim.advance();
        const after = sim.snapshot() as { dread: number; scene: Scene };
        expect(after.scene.floorMap?.currentRoom, "one round should have covered the whole distance").toBe(far.id);
        expect(after.scene.floorMap?.currentRoom).not.toBe(before.room);
        expect(after.dread, "a long way round should still cost something").toBeGreaterThan(before.dread);
        return;
      }
      bot.act(sim);
      sim.advance();
    }
    throw new Error("no travel offer ever appeared — the fixture, not the claim, is wrong");
  });
});

describe("a gate one purse cannot open", () => {
  it("never stands between the party and the stairs", () => {
    // The floor's whole design rests on the tree still reaching everything. An
    // optional barrier that turns out to be mandatory is a soft-lock, and a
    // soft-lock in a benchmark reads as a party that gave up.
    let tolls = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let floor = 1; floor <= 6; floor++) {
        const map = generateFloorMap(floor, makeRng(seed).fork(`floor-${floor}`));
        const gate = map.routes.find((route) => route.kind === "toll");
        if (!gate) continue;
        tolls += 1;
        const stairs = map.rooms.find((room) => room.kind === "stairs");
        if (!stairs) throw new Error("every floor has stairs");
        const seen = new Set(["r0"]);
        const queue = ["r0"];
        while (queue.length > 0) {
          const here = queue.shift();
          if (here === undefined) break;
          for (const route of map.routes) {
            if (route === gate || !route.discovered) continue;
            const next =
              route.from === here ? route.to : route.bidirectional && route.to === here ? route.from : undefined;
            if (next === undefined || seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
        }
        expect(seen.has(stairs.id), `seed ${seed} floor ${floor}: the toll gate is the only way down`).toBe(true);
      }
    }
    expect(tolls, "the sweep should have found gates to check").toBeGreaterThan(20);
  });

  it("asks for more than one purse usually holds, and says exactly how much more", async () => {
    const sim = maze(2201);
    const bot = DESCENT_POLICIES["basic-tactics"]();
    for (let i = 0; i < 400 && !sim.done; i++) {
      const s = scene(sim);
      const gate = s.phase === "explore" && s.paths.find((path) => path.hint.includes("A TOLL GATE"));
      if (gate) {
        const view = sim.view() as unknown as { party: Record<string, { gold: number }> };
        const poorest = Object.keys(view.party).reduce((best, id) =>
          view.party[id].gold < view.party[best].gold ? id : best,
        );
        const refusal = await call(sim, poorest, "pay_toll", { path: gate.id });
        // The refusal is the mechanism. A door that only says no leaves the
        // party with nothing to do about it.
        expect(refusal).toMatch(/short/);
        expect(refusal).toMatch(/The party holds \d+ between them/);
        expect(refusal).toMatch(/give_gold/);
        return;
      }
      bot.act(sim);
      sim.advance();
    }
    throw new Error("no toll gate was ever offered — the fixture, not the claim, is wrong");
  });

  it("opens once somebody has been given enough, and pays out more than an ungated room", async () => {
    /*
     * Seeds are searched for a gate standing in front of a *cache*, and the
     * search failing is a failure.
     *
     * The first draft of this test asserted the extra takes inside an
     * `if (phase === "cache")`, and seed 2201's gate happens to front a
     * merchant — so the assertion never ran and the test passed against an
     * implementation with the reward removed. A control run caught it. Nothing
     * about a conditional assertion announces that it never fired.
     */
    for (let seed = 2201; seed < 2260; seed++) {
      const sim = maze(seed);
      const bot = DESCENT_POLICIES["basic-tactics"]();
      for (let i = 0; i < 300 && !sim.done; i++) {
        const s = scene(sim);
        const gate =
          s.phase === "explore" &&
          s.paths.find(
            (path) =>
              path.hint.includes("A TOLL GATE") &&
              s.floorMap?.rooms.find((room) => room.id === path.id)?.kind === "cache",
          );
        if (gate) {
          const view = sim.view() as unknown as {
            party: Record<string, { gold: number }>;
            map: { routes: Array<{ kind: string; toll?: number }> } | null;
          };
          const price = view.map?.routes.find((route) => route.kind === "toll")?.toll ?? 0;
          expect(price, "a gate should have a price").toBeGreaterThan(0);

          // Hand the guardian everything, the way a party that talked would.
          for (const id of ["mage", "rogue", "cleric", "ranger"]) {
            if (view.party[id].gold > 0) {
              await call(sim, id, "give_gold", { to: "guardian", amount: view.party[id].gold });
            }
          }
          if (view.party.guardian.gold < price) break; // too poor this run; try another seed
          expect(await call(sim, "guardian", "pay_toll", { path: gate.id })).toMatch(/the gate opens/);

          await call(sim, "guardian", "choose_path", { path: gate.id });
          sim.advance();
          expect(scene(sim).phase, "paying should lead into the room that was gated").toBe("cache");
          // Two extra takes: the gate has to buy something, or paying it is a
          // straight loss and no party should ever choose it.
          expect((sim.snapshot() as { scene: { cacheTakesLeft: number } }).scene.cacheTakesLeft).toBeGreaterThan(2);
          return;
        }
        bot.act(sim);
        sim.advance();
      }
    }
    throw new Error("no seed put a toll gate in front of a cache — the fixture, not the claim, is wrong");
  });

  it("cannot be walked around by travelling across known ground", () => {
    const map = {
      zone: "Test",
      currentRoom: "r0",
      keys: 0,
      rooms: [
        { id: "r0", links: ["r1"], visited: true, cleared: true },
        { id: "r1", links: ["r0", "r2"], visited: true, cleared: true },
        { id: "r2", links: ["r1"], visited: false, cleared: false },
      ].map((room) => ({ label: room.id, kind: "empty", x: 0, y: 0, revealed: true, environment: null, ...room })),
      routes: [
        { id: "a", from: "r0", to: "r1", kind: "toll", toll: 200 },
        { id: "b", from: "r1", to: "r2", kind: "passage" },
      ].map((route) => ({
        bidirectional: true,
        discovered: true,
        triggered: false,
        disarmed: false,
        openedBy: null,
        traversals: 0,
        ...route,
      })),
    };
    expect(knownRouteAcross(map as never, "r0", "r2")).toBeUndefined();
    (map.routes[0] as { openedBy: string | null }).openedBy = "paid";
    expect(knownRouteAcross(map as never, "r0", "r2")).toEqual(["r1", "r2"]);
  });
});

describe("the surface is not a floor", () => {
  it("does not describe a floor the party is standing above", async () => {
    // The first floor's map is generated before anybody leaves the outfitter,
    // so a bare `state.map` check told a party at the surface which rooms of
    // floor one it had entered and that it had not found the stairs yet. Both
    // statements were true, and both were nonsense where they appeared.
    const sim = maze(3301);
    const camp = await call(sim, "mage", "look");
    expect(camp).toMatch(/^Above the first stair\./);
    expect(camp).not.toMatch(/This floor:/);
    expect(camp).not.toMatch(/stairs down/);

    await intoTheMaze(sim);
    const under = await call(sim, "mage", "look");
    expect(under).toMatch(/^Floor \d+, /);
    expect(under).toMatch(/This floor:/);
  });
});

describe("what five purses can reach and one cannot", () => {
  it("names the thing on the counter that needs more than one of them", async () => {
    /*
     * Arithmetic over the stock actually on the counter and the purses actually
     * in the room. It tells nobody what to do — the party may well decide the
     * item is not worth it — but it makes the one decision that requires five
     * people visible from a single `look`.
     *
     * The run that prompted it finished holding 612 gold with zero transfers
     * and zero trades. `give_gold` had been available the whole time and
     * nothing had ever pointed at something a single purse could not buy.
     */
    const sim = maze(3301);
    const camp = await call(sim, "mage", "look");
    expect(camp).toMatch(/Nobody here can afford \S+ alone — it is \d+ and the largest purse holds \d+/);
    expect(camp).toMatch(/The five purses together hold \d+/);
    // And the standing fact that makes hoarding a mistake.
    expect(camp).toMatch(/Gold left over when the run ends is worth nothing/);
  });

  it("says nothing when the richest purse can already cover the counter", async () => {
    // Otherwise the line is decoration: it has to be a fact about *this* stock
    // and *these* purses, or a party learns to skip it.
    const sim = maze(3301);
    const view = sim.view() as unknown as { party: Record<string, { gold: number }> };
    for (const id of ["guardian", "mage", "rogue", "cleric", "ranger"]) view.party[id].gold = 100_000;
    expect(await call(sim, "mage", "look")).not.toMatch(/Nobody here can afford/);
  });
});

describe("the shape of the ladder", () => {
  /*
   * Guards the one number this benchmark is built around.
   *
   * `tactics-only` is `rule-based` with the organisation removed: identical
   * combat, and nothing between fights. The distance between those two rows is
   * therefore the price of ignoring everything a party of five can do together,
   * and it is the figure every scenario result is read against.
   *
   * It is also disturbingly easy to destroy by accident. Adding a single
   * `rng.int()` to floor generation — for a field that had nothing to do with
   * balance — shifted every subsequent draw in that generator, reshuffled the
   * contents of every floor, and took the gap from 160 points to 33. The sweep
   * is deterministic and costs under a second, so this asserts the shape rather
   * than trusting anybody to re-run `bench` after an unrelated change.
   *
   * Deliberately a *shape* test, not a golden ladder: exact means are expected
   * to move whenever the game is tuned, and a test that had to be edited on
   * every balance pass would be edited without being read.
   */
  const ladder = (days = 40) => {
    const options = {
      startFloor: 1,
      preparation: true,
      startingGold: 180,
      startingSkillPoints: 2,
      maze: true,
    };
    const seeds = Array.from({ length: 24 }, (_, i) => 1000 + i);
    const mean = (name: string) =>
      seeds.reduce((sum, seed) => {
        const sim = createSimulation("descent", { seed, days, ...options }) as never as {
          done: boolean;
          advance: () => void;
          metrics: () => Record<string, number>;
        };
        const bot = DESCENT_POLICIES[name]();
        while (!sim.done) {
          bot.act(sim as never);
          sim.advance();
        }
        return sum + sim.metrics().earnedXp;
      }, 0) / seeds.length;
    return {
      random: mean("random"),
      basic: mean("basic-tactics"),
      tactical: mean("tactics-only"),
      ruled: mean("rule-based"),
      oracle: mean("oracle"),
    };
  };

  /*
   * Rewritten 2026-08-18, after this assertion had been red for two days and
   * carried as "known".
   *
   * It asserted `rule-based − tactics-only > 100` at forty rounds and was
   * reading 56, which looks exactly like the failure it was written to catch —
   * something flattened the one gap the benchmark exists to measure. It is not
   * that. Swept across horizons on the same 24 seeds:
   *
   * | rounds | tactics-only | rule-based | gap | oracle − rule-based |
   * |---|---|---|---|---|
   * | 40 | 458 | 514 | **56** | 14 |
   * | 60 | 837 | 1,032 | 196 | 135 |
   * | 80 | 1,382 | 1,855 | 474 | 328 |
   * | 120 | 3,586 | 4,061 | 475 | 971 |
   * | 200 | 8,283 | 9,472 | 1,189 | 2,632 |
   *
   * The gap is fine. It is *horizon-limited*: at forty rounds from floor one
   * every rung reaches about floor three and survives about 38 ticks, so
   * organisation has nowhere to express itself. The threshold of 100 was set
   * when the game was tuned differently and has been asserting something true
   * of the mechanic at a horizon where it cannot be true.
   *
   * Starting deeper does not rescue it — it makes the *relative* gap worse
   * (12% at floor 1, 3–4% from floor 6 down) because the absolute numbers
   * inflate faster than the difference does.
   *
   * So the guard now asserts the shape that is actually load-bearing and
   * actually robust: organisation pays, and it pays increasingly. A change that
   * genuinely flattened the mechanic would collapse the second assertion, which
   * is what the first one was reaching for.
   *
   * **What this does not fix, and what nobody should read it as fixing:** the
   * scenario is scored at forty rounds, and at forty rounds organisation is
   * worth 12% and perfect recall 2.5%. That is a live benchmark-design problem
   * — a benchmark about coordination whose scored horizon barely separates
   * coordinating parties from fighting ones — and it is tracked in
   * `docs/endless-descent-roadmap.md` rather than silenced here.
   */
  it("still pays for organisation, and pays more the longer the run", () => {
    const near = ladder(40);
    const far = ladder(80);
    const nearGap = near.ruled - near.tactical;
    const farGap = far.ruled - far.tactical;
    expect(
      nearGap,
      `organisation is worth ${Math.round(nearGap)} XP at the scored horizon ` +
        `(tactics-only ${Math.round(near.tactical)}, rule-based ${Math.round(near.ruled)}).`,
    ).toBeGreaterThan(0);
    expect(
      farGap,
      `organisation is worth ${Math.round(farGap)} XP over 80 rounds against ` +
        `${Math.round(nearGap)} over 40. It should grow with depth — a gap that does not is the ` +
        "one failure this file exists to catch.",
    ).toBeGreaterThan(nearGap * 3);
  });

  it("keeps competence ordered", () => {
    const l = ladder();
    expect(l.basic, `random ${l.random} should not beat basic-tactics ${l.basic}`).toBeGreaterThan(l.random);
    expect(l.tactical).toBeGreaterThan(l.basic);
    expect(l.ruled).toBeGreaterThan(l.tactical);
  });

  it("pays for perfect recall, where perfect recall has room to pay", () => {
    /*
     * Asserted at 400 rounds, not at 40, and the reason is the same one that
     * moved the spine test in `descent-sim.test.ts`: a guard measuring where
     * the signal does not exist fails for reasons that say nothing about the
     * game.
     *
     * The oracle's margin over `rule-based` at the scored 40-round horizon has
     * been about 1% all day — 519 vs 515, then 482 vs 480, then 538 vs 566.
     * Twenty-four seeds cannot resolve that, and the sign flips run to run. At
     * 400 the same pair is 1.24x, which is a real ordering.
     *
     * The reason it is small at 40 is not noise alone: three floors is not
     * enough depth for hidden mechanics to have been *met* often enough for
     * knowing them to compound. That is worth knowing on its own — the
     * scenario's memory claim is a claim about long runs.
     */
    const deep = ladder(400);
    expect(
      deep.oracle,
      `perfect recall is worth ${Math.round(deep.oracle - deep.ruled)} XP over 400 rounds ` +
        `(rule-based ${Math.round(deep.ruled)}, oracle ${Math.round(deep.oracle)}). ` +
        "The scenario's memory claim rests on this gap.",
    ).toBeGreaterThan(deep.ruled);
  });
});

describe("writing about a character", () => {
  it("agrees the verb with the pronoun, including singular they", () => {
    // "They is a wiry elf" appeared in every dossier and every ally line of
    // every run, which made it the most frequently repeated sentence on the
    // page. Seeds are swept rather than picked so this cannot pass by drawing
    // she/her five times.
    let sawThey = false;
    for (let seed = 1; seed <= 40; seed++) {
      const sim = maze(seed);
      const party = (
        sim.snapshot() as {
          scene: { party: Array<{ identity: { pronouns: { subject: string }; appearance: string } }> };
        }
      ).scene.party;
      for (const member of party) {
        const { pronouns, appearance } = member.identity;
        if (pronouns.subject === "they") {
          sawThey = true;
          expect(appearance, appearance).toMatch(/^They are /);
        } else {
          expect(appearance, appearance).toMatch(/^(She|He) is /);
        }
      }
    }
    expect(sawThey, "forty seeds should have rolled at least one they/them character").toBe(true);
  });
});

/**
 * What a character can read about a fight, and about who else is choosing.
 *
 * Every claim below came out of one live run of 2026-08-14 (seed 739530, 472
 * experience against a rule-based baseline of 666). The party acted on 162 of
 * its 200 turns, so none of this is about wasted turns — it is about acting
 * well with what the game bothered to say.
 */
describe("what a fight tells the character in it", () => {
  /** Drive far enough in to be standing in a fight. */
  async function intoAFight(sim: DescentSimulation, steps = 40): Promise<void> {
    await call(sim, "guardian", "enter_dungeon");
    for (let i = 0; i < steps; i++) {
      const s = scene(sim);
      if (s.phase === "combat") return;
      if (s.phase === "explore" && s.paths.length > 0) {
        await call(sim, "guardian", "choose_path", { path: s.paths[0].id });
      } else if (s.phase === "spoils") {
        await call(sim, "guardian", "continue_exploring");
      }
      sim.advance();
    }
  }

  it("names who is hurt, worst first, instead of making everyone remember", async () => {
    let found = false;
    for (let seed = 5100; seed < 5140 && !found; seed++) {
      const sim = maze(seed);
      await intoAFight(sim);
      if (scene(sim).phase !== "combat") continue;
      // Take some damage so there is a casualty report to give.
      for (let round = 0; round < 6 && scene(sim).phase === "combat"; round++) sim.advance();
      if (scene(sim).phase !== "combat") continue;
      const text = await call(sim, "cleric", "look");
      expect(text, "a fight has to state the party's own condition").toContain("Your side:");
      found = true;
    }
    expect(found, "forty seeds should produce at least one sustained fight").toBe(true);
  });

  it("tells a character which of its own abilities are ready right now", async () => {
    let found = false;
    for (let seed = 5200; seed < 5240 && !found; seed++) {
      const sim = maze(seed);
      await intoAFight(sim);
      if (scene(sim).phase !== "combat") continue;
      const text = await call(sim, "guardian", "look");
      // The guardian's whole kit went unused for two hundred turns in a live
      // run. It cannot choose `shield_slam` over `attack` without being told
      // that `shield_slam` is a thing it can do this round.
      expect(text).toMatch(/You can use right now:|Nothing of yours is ready/);
      found = true;
    }
    expect(found).toBe(true);
  });

  it("says that leaving is a move when the fight is going badly", async () => {
    let found = false;
    for (let seed = 5300; seed < 5400 && !found; seed++) {
      const sim = maze(seed);
      await intoAFight(sim);
      // Stand there and take it. Somewhere in here the party is losing.
      for (let round = 0; round < 25 && scene(sim).phase === "combat"; round++) {
        sim.advance();
        if (scene(sim).phase !== "combat") break;
        const text = await call(sim, "cleric", "look");
        if (text.includes("`retreat` is a move")) {
          found = true;
          break;
        }
      }
    }
    // `retreats` was 0 across 200 turns of the live run, with an ally at 8%.
    expect(found, "a losing fight has to name `retreat`").toBe(true);
  });
});

describe("choosing the way on, when five people can choose it", () => {
  it("names whoever actually made the choice being replaced", async () => {
    // Searched rather than assumed. The first draft of this test took the one
    // seed it was written against, bailed out when that seed offered a single
    // way on, and passed against the very bug it existed to catch.
    let checked = 0;
    for (let seed = 2201; seed < 2260 && checked === 0; seed++) {
      const sim = maze(seed);
      await intoTheMaze(sim);
      const s = scene(sim);
      if (s.phase !== "explore" || s.paths.length < 2) continue;

      // Locked doors, toll gates and unpaid routes all refuse, so the pair has
      // to be two ways this party can actually take — otherwise the test reads
      // a refusal and calls it an override message.
      const open: string[] = [];
      for (const path of s.paths) {
        const reply = await call(sim, "rogue", "choose_path", { path: path.id });
        if (!reply.startsWith("Refused:")) open.push(path.id);
        if (open.length === 2) break;
      }
      if (open.length < 2) continue;

      await call(sim, "rogue", "choose_path", { path: open[0] });
      const second = await call(sim, "ranger", "choose_path", { path: open[1] });

      // The bug this replaces reported the *caller*, so every override told
      // somebody they were replacing their own choice and the party never
      // learned who to argue with.
      expect(second).toContain("which rogue had already chosen");
      expect(second).not.toContain("which ranger had already chosen");
      checked++;
    }
    expect(checked, "sixty seeds should offer one room with two ways out").toBe(1);
  });

  it("says plainly when a choice changes nothing", async () => {
    const sim = maze(2201);
    await intoTheMaze(sim);
    const s = scene(sim);
    if (s.phase !== "explore" || s.paths.length === 0) return;

    await call(sim, "rogue", "choose_path", { path: s.paths[0].id });
    const again = await call(sim, "rogue", "choose_path", { path: s.paths[0].id });
    // One agent did this three times in a single turn of the live run.
    expect(again).toContain("already the plan");
  });
});

describe("refusals that redirect", () => {
  it("tells a character its skill point survives the fight", async () => {
    let found = false;
    for (let seed = 5500; seed < 5560 && !found; seed++) {
      const sim = maze(seed);
      await call(sim, "guardian", "enter_dungeon");
      for (let i = 0; i < 40; i++) {
        if (scene(sim).phase === "combat") break;
        const s = scene(sim);
        if (s.phase === "explore" && s.paths.length > 0)
          await call(sim, "guardian", "choose_path", { path: s.paths[0].id });
        else if (s.phase === "spoils") await call(sim, "guardian", "continue_exploring");
        sim.advance();
      }
      if (scene(sim).phase !== "combat") continue;
      const refusal = await call(sim, "guardian", "invest_skill", { talent: "bastion" });
      // Five agents burned five consecutive turns on this refusal in one run —
      // a third of every refusal in forty rounds — because nothing said the
      // point was still there afterwards.
      expect(refusal).toContain("Nothing is lost by waiting");
      expect(refusal).toContain("stays yours");
      found = true;
    }
    expect(found).toBe(true);
  });

  it("offers the living targets whether the swing was an ability or a plain attack", async () => {
    let found = false;
    for (let seed = 5600; seed < 5660 && !found; seed++) {
      const sim = maze(seed);
      await call(sim, "guardian", "enter_dungeon");
      for (let i = 0; i < 40; i++) {
        if (scene(sim).phase === "combat") break;
        const s = scene(sim);
        if (s.phase === "explore" && s.paths.length > 0)
          await call(sim, "guardian", "choose_path", { path: s.paths[0].id });
        else if (s.phase === "spoils") await call(sim, "guardian", "continue_exploring");
        sim.advance();
      }
      if (scene(sim).phase !== "combat") continue;
      const refusal = await call(sim, "guardian", "attack", { target: "no-such-thing" });
      // `useAbility` named the survivors and `attack` did not, so in one run a
      // guardian swinging at a corpse got no help and a ranger shooting the
      // same corpse four turns later got the list.
      expect(refusal).toMatch(/Try: |the fight is over/);
      found = true;
    }
    expect(found).toBe(true);
  });
});
