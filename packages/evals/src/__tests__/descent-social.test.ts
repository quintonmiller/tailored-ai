/**
 * Instruments either side can go and get.
 *
 * Everything in `reveal.ts` is a verb the engine hands to the loyal party:
 * `vigil` is in your tool list because you are not a traitor, it answers
 * certainly, and everybody watches you use it. Over sixty seeds that works, in
 * the sense that the party finds the traitor — what it never produces is an
 * argument, because a certain answer everybody saw you obtain ends the
 * conversation in the round it is given.
 *
 * The social layer is built on one rule, and most of this file is that rule
 * spelled out as assertions:
 *
 * > **Nothing is certain, provable and public at the same time. Pick two.**
 *
 * So every instrument here is private to exactly two people — the one who used
 * it and the one it was used on — and nobody else ever learns it happened. The
 * tests that matter are therefore mostly *negative*: what `announce()` must not
 * contain, what the other three characters must not be told, and what a metric
 * must not reveal. A leak here is invisible in play, because a run where
 * everybody knows reads as a well-coordinated party rather than a broken one.
 */

import { describe, expect, it } from "vitest";
import { rollStock } from "../sim/descent/content.js";
import type { ClassId } from "../sim/descent/model.js";
import { socialInstruments } from "../sim/descent/reveal.js";
import { DRAUGHT_ITEM, readVerdict, VENOM_ITEM } from "../sim/descent/social.js";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";
import { makeRng } from "../sim/rng.js";

const CLASSES: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

interface Social {
  announce(): string;
  describeFor(who: string): string;
  traitorRoles(): ReadonlySet<ClassId>;
  metrics(): Record<string, number>;
  view(): { party: Record<ClassId, { inventory: Array<{ baseId: string }>; statuses: unknown[] }> };
}
type Sim = ReturnType<typeof createSimulation> & Social;

function make(seed: number, reveal: string, traitors: number | "roll" = 1): Sim {
  return createSimulation("descent", {
    seed,
    days: 40,
    ...simulationDefaults("descent"),
    traitors,
    reveal,
  }) as Sim;
}

function tool(s: Sim, name: string) {
  return s.sharedTools().find((t) => t.name === name);
}

async function call(s: Sim, name: string, args: Record<string, unknown>, agent: string): Promise<string> {
  const t = tool(s, name);
  if (!t) throw new Error(`${name} is not offered`);
  const result = (await t.execute(args, { agentName: agent })) as { output?: string };
  return String(result.output ?? "");
}

/** Put one in somebody's pack directly, so a test does not have to shop for it. */
function give(s: Sim, who: ClassId, baseId: string): void {
  const inner = s as unknown as {
    state: { party: Record<ClassId, { inventory: unknown[] }> };
    makeItem(id: string, source: string, floor: number, affixed?: boolean): unknown;
  };
  inner.state.party[who].inventory.push(inner.makeItem(baseId, "starting-kit", 1, false));
}

function traitorAndLoyal(s: Sim): { traitor: ClassId; loyal: ClassId } {
  const traitors = s.traitorRoles();
  const traitor = [...traitors][0];
  const loyal = CLASSES.find((c) => !traitors.has(c));
  if (!traitor || !loyal) throw new Error("this seed has no traitor to test with");
  return { traitor, loyal };
}

describe("which instruments a mode turns on", () => {
  it("keeps the granted family and the social family apart", () => {
    expect(socialInstruments("vigil")).toEqual({ draught: false, read: false, venom: false });
    expect(socialInstruments("off")).toEqual({ draught: false, read: false, venom: false });
    expect(socialInstruments("social")).toEqual({ draught: true, read: true, venom: true });
    expect(socialInstruments("read")).toEqual({ draught: false, read: true, venom: false });
  });

  it("offers no social tool at all when the betrayal layer is off", () => {
    // A merchant selling a draught in a run where nobody can be against the
    // party is the merchant announcing a mechanic that does not exist.
    const off = createSimulation("descent", {
      seed: 1000,
      days: 40,
      ...simulationDefaults("descent"),
      reveal: "social",
    });
    const names = off.sharedTools().map((t) => t.name);
    expect(names).not.toContain("size_up");
    expect(names).not.toContain("drink_draught");
    expect(names).not.toContain("poison");
  });

  it("offers exactly the tools its mode names", () => {
    const names = (mode: string) =>
      make(1000, mode)
        .sharedTools()
        .map((t) => t.name);
    expect(names("read")).toContain("size_up");
    expect(names("read")).not.toContain("drink_draught");
    expect(names("draught")).toContain("drink_draught");
    expect(names("draught")).not.toContain("poison");
    expect(names("social")).toEqual(expect.arrayContaining(["size_up", "drink_draught", "poison"]));
  });
});

describe("what a merchant will sell you", () => {
  it("keeps the social stock off the shelf unless its mode is on", () => {
    const shelf = (s: Sim) =>
      ((s.snapshot() as { scene: { stock?: Array<{ id?: string }> } }).scene.stock ?? []).map((x) => x.id ?? "");
    // Not the same as "never appears": the outfitter rolls six of ~30 items, so
    // a single seed proves nothing. The assertion is over the whole item table.
    const ids = (mode: string) => {
      const seen = new Set<string>();
      for (let seed = 1000; seed < 1060; seed++) for (const id of shelf(make(seed, mode))) seen.add(id.split("@")[0]);
      return seen;
    };
    expect([...ids("read")]).not.toContain(DRAUGHT_ITEM);
    expect([...ids("read")]).not.toContain(VENOM_ITEM);
  });
});

describe("what turning the layer on costs the dungeon", () => {
  it("changes the shop and one starting pack, and nothing else", () => {
    // The confound, stated precisely so nobody has to guess at its size. Two
    // things differ and both are deliberate: the social items are guaranteed
    // stock, so two random picks are pushed off every shelf, and one member
    // starts holding a Draught of Truth. The dungeon itself — floor graph,
    // monsters, identities, every stat — is drawn from its own forks and is
    // untouched, which is the property that matters and the one asserted here.
    //
    // Which is why the control for a social arm is `investigator` **in the same
    // mode**, never `off` — comparing across modes measures the shelf as well
    // as the mechanic.
    const deep = (mode: string) =>
      createSimulation("descent", {
        seed: 2200,
        days: 40,
        ...simulationDefaults("descent"),
        startFloor: 4,
        traitors: 0,
        reveal: mode,
      }) as Sim;

    const world = (mode: string) => {
      const scene = (deep(mode).snapshot() as { scene: Record<string, unknown> }).scene;
      // Packs excluded, and only packs: the starting draught lives in one of
      // them by design, so comparing them would assert the absence of a
      // feature. Everything else about the five is still compared — including
      // `worn`, whose item ids only stay identical between modes because the
      // grants happen after the state literal rather than before it.
      const party = (scene.party as Array<Record<string, unknown>>).map((p) => ({ ...p, pack: undefined }));
      return JSON.stringify({ floorMap: scene.floorMap, enemies: scene.enemies, party });
    };
    expect(world("social")).toBe(world("off"));

    // And the pack difference is exactly one draught, held by exactly one of
    // them — not a draught each, which would put five certain answers in a
    // party of five and end the game on round one.
    const packs = (mode: string) =>
      Object.values((deep(mode).view() as { party: Record<string, { inventory: Array<{ baseId: string }> }> }).party)
        .flatMap((f) => f.inventory)
        .filter((i) => i.baseId === DRAUGHT_ITEM).length;
    expect(packs("social")).toBe(1);
    expect(packs("off")).toBe(0);

    // The shelf half goes through `rollStock` directly rather than a snapshot.
    // Two earlier versions of this assertion passed for the wrong reason: at
    // floor 1 the items have not unlocked so the shelves match, and a sim built
    // at floor 4 has no merchant standing in front of it at tick zero, so the
    // stock array is empty in both modes.
    const shelf = (social: ReadonlySet<string>) =>
      rollStock(4, makeRng(2200), [], social)
        .map((x) => x.item)
        .sort();
    const withSocial = shelf(new Set([DRAUGHT_ITEM, VENOM_ITEM]));
    const without = shelf(new Set());
    expect(withSocial).toEqual(expect.arrayContaining([DRAUGHT_ITEM, VENOM_ITEM]));
    expect(without).not.toEqual(expect.arrayContaining([DRAUGHT_ITEM]));
    // Same shelf size, so two ordinary picks were displaced rather than added to.
    expect(withSocial.length).toBe(without.length);
    expect(withSocial).not.toEqual(without);
  });
});

describe("what a traitor comes down with", () => {
  it("carries one vial, in a pack nobody else can see into", () => {
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    const packs = s.view().party;
    expect(packs[traitor].inventory.map((i) => i.baseId)).toContain(VENOM_ITEM);
    expect(packs[loyal].inventory.map((i) => i.baseId)).not.toContain(VENOM_ITEM);
  });

  it("carries none when venom is not in play", () => {
    const s = make(1000, "read", 1);
    const { traitor } = traitorAndLoyal(s);
    expect(s.view().party[traitor].inventory.map((i) => i.baseId)).not.toContain(VENOM_ITEM);
  });

  it("is told about it in the same paragraph that sets the objective", () => {
    // The sentence this replaced said "you have no tools the others do not
    // have", which stopped being true the moment a vial was in the pack. A
    // brief that contradicts the mechanic beats the mechanic — measured, twice.
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    expect(s.describeFor(traitor)).toMatch(/Vial of Grey Venom/);
    expect(s.describeFor(loyal)).not.toMatch(/You came down with one thing they did not/);
  });
});

describe("the bought answer", () => {
  it("refuses without a draught, and names where they are sold", async () => {
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    const out = await call(s, "drink_draught", { who: traitor }, loyal);
    expect(out).toMatch(/^Refused:/);
    expect(out).toMatch(/merchant/i);
  });

  it("never lies, and spends the draught doing it", async () => {
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    give(s, loyal, DRAUGHT_ITEM);
    expect(await call(s, "drink_draught", { who: traitor }, loyal)).toMatch(/ARE against this party/);
    expect(s.view().party[loyal].inventory.map((i) => i.baseId)).not.toContain(DRAUGHT_ITEM);
    // Gone means gone: a second call has nothing to drink.
    expect(await call(s, "drink_draught", { who: traitor }, loyal)).toMatch(/^Refused:/);
  });

  it("tells the subject who asked, and tells nobody else anything", async () => {
    // The cost that replaced dread and health. A loyal subject learns they were
    // cleared and cannot prove it; a traitor learns the net has closed and gets
    // one round of warning. The other three never learn a draught was drunk,
    // which is what leaves both of them free to lie about it afterwards.
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    give(s, loyal, DRAUGHT_ITEM);
    await call(s, "drink_draught", { who: traitor }, loyal);

    expect(await call(s, "look", {}, traitor)).toMatch(/Draught of Truth on you/);
    // The round block names the instrument on purpose — an unnamed tool is an
    // unused tool — so the assertion is about the *use*, not the word. Nobody
    // may learn that one was drunk, by whom, or on whom.
    expect(s.announce()).not.toMatch(/Draught of Truth on you|used a draught/i);
    for (const bystander of CLASSES.filter((c) => c !== traitor && c !== loyal)) {
      expect(await call(s, "look", {}, bystander)).not.toMatch(/[Dd]raught of Truth on you/);
    }
  });

  it("counts what it was aimed at rather than whether it was right", async () => {
    // A draught is never wrong, so "draughts correct" would be a synonym for
    // "draughts". `draughtsOnTraitors` measures the party's aim: three bought
    // and three pointed at loyal characters is nine hundred gold spent learning
    // nothing, and that is the failure worth being able to see.
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    const other = CLASSES.find((c) => c !== traitor && c !== loyal) as ClassId;
    give(s, loyal, DRAUGHT_ITEM);
    give(s, loyal, DRAUGHT_ITEM);
    await call(s, "drink_draught", { who: traitor }, loyal);
    await call(s, "drink_draught", { who: other }, loyal);
    expect(s.metrics().draughts).toBe(2);
    expect(s.metrics().draughtsOnTraitors).toBe(1);
  });
});

describe("the free answer", () => {
  it("is wrong in both directions, which is what stops it being a vigil", () => {
    // A false *positive* is the load-bearing half. Without one, a single dirty
    // reading is proof, the party pools four of them, and the instrument
    // collapses into the certain public oracle it was built to replace.
    const rolls = (subjectIsTraitor: boolean, floorsCleared: number) => {
      let guilty = 0;
      for (let i = 0; i < 400; i++) {
        const v = readVerdict(makeRng(i + 1), {
          partyLevel: 1,
          trained: false,
          floorsCleared,
          subjectIsTraitor,
        });
        if (v.saysGuilty) guilty += 1;
      }
      return guilty / 400;
    };
    // A loyal character reads clean most of the time and not always.
    expect(rolls(false, 0)).toBeGreaterThan(0.05);
    expect(rolls(false, 0)).toBeLessThan(0.35);
    // A fresh traitor reads dirty more often than not; a deep one does not.
    expect(rolls(true, 0)).toBeGreaterThan(0.5);
    expect(rolls(true, 4)).toBeLessThan(rolls(true, 0));
  });

  it("gets harder to read the deeper the traitor has survived", () => {
    // Guile is the thing a traitor invests in by staying alive, and it is what
    // makes "she read clean on four and dirty on two" an argument rather than a
    // contradiction.
    const dirty = (floorsCleared: number) => {
      let n = 0;
      for (let i = 0; i < 300; i++) {
        if (
          readVerdict(makeRng(i + 1), {
            partyLevel: 1,
            trained: false,
            floorsCleared,
            subjectIsTraitor: true,
          }).saysGuilty
        )
          n += 1;
      }
      return n;
    };
    expect(dirty(0)).toBeGreaterThan(dirty(2));
    expect(dirty(2)).toBeGreaterThan(dirty(5));
  });

  it("answers the same way twice on one floor, so it cannot be averaged out", async () => {
    // A free check with a fresh roll per call is a free *average*, and an
    // average of an unreliable instrument is a reliable one. Cached per reader,
    // per subject, per floor.
    const s = make(1000, "read", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    const first = await call(s, "size_up", { who: traitor }, loyal);
    const second = await call(s, "size_up", { who: traitor }, loyal);
    const verdict = (t: string) => /hiding something/.test(t);
    expect(verdict(second)).toBe(verdict(first));
    expect(second).toMatch(/already taken/i);
    expect(s.metrics().reads).toBe(1);
  });

  it("tells the subject they were read, and never what it said", async () => {
    const s = make(1000, "read", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    await call(s, "size_up", { who: traitor }, loyal);
    const mail = await call(s, "look", {}, traitor);
    expect(mail).toMatch(/sizing you up for deception/);
    expect(mail).not.toMatch(/hiding something|straight with you/);
    expect(s.announce()).not.toMatch(/sizing you up|hiding something/);
  });

  it("refuses to read the one person whose answer you already have", async () => {
    const s = make(1000, "read", 1);
    const { loyal } = traitorAndLoyal(s);
    expect(await call(s, "size_up", { who: loyal }, loyal)).toMatch(/^Refused:/);
  });
});

describe("the vial", () => {
  it("refuses without one", async () => {
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    expect(await call(s, "poison", { who: traitor }, loyal)).toMatch(/^Refused:/);
  });

  it("poisons the victim and spends the vial", async () => {
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    const out = await call(s, "poison", { who: loyal }, traitor);
    expect(out).not.toMatch(/^Refused:/);
    const victim = s.view().party[loyal] as unknown as { statuses: Array<{ kind: string }> };
    expect(victim.statuses.map((x) => x.kind)).toContain("poison");
    expect(s.view().party[traitor].inventory.map((i) => i.baseId)).not.toContain(VENOM_ITEM);
    expect(s.metrics().poisonings).toBe(1);
  });

  it("tells the victim they are poisoned and never who did it", async () => {
    // The whole reason poison is the layer's stock. It is evidence that
    // *something* was done without being any evidence of who did it, and that
    // gap is the only place an investigation can live.
    const s = make(1000, "social", 1);
    const { traitor, loyal } = traitorAndLoyal(s);
    await call(s, "poison", { who: loyal }, traitor);
    const felt = await call(s, "look", {}, loyal);
    // Scoped to the private note. `look` also prints the reader's own pack and
    // the party sheet, so a bare search for the poisoner's class id matches the
    // roster and proves nothing either way.
    const note = felt.split("Only you know this:")[1]?.split("\n\n")[0] ?? "";
    expect(note).toMatch(/you have been\s+poisoned/i);
    expect(note).not.toMatch(new RegExp(traitor, "i"));
    expect(s.announce()).not.toMatch(/poisoned/i);
  });
});

describe("what the round block says out loud", () => {
  it("names each instrument, because an unnamed tool is an unused tool", () => {
    // The `retreat` lesson, and the reason `<murmurs>` carries its own
    // description: across three live runs with `vigil`, `bind` and `execute`
    // declared and unmentioned, they were reached for zero times.
    const said = make(1000, "social", 1).announce();
    expect(said).toMatch(/size_up=/);
    expect(said).toMatch(/draught=/);
    expect(said).toMatch(/venom=/);
  });

  it("says what each instrument is and never who is holding one", () => {
    const s = make(1000, "social", 1);
    const { loyal } = traitorAndLoyal(s);
    give(s, loyal, DRAUGHT_ITEM);
    give(s, loyal, VENOM_ITEM);
    // The tag itself, rather than the whole private view — the view legitimately
    // differs per character (own pack, own motive, own part). What must be
    // identical for all five is the line that describes the instruments, because
    // *what they are* is public and *who is carrying one* is not.
    const tags = new Set(
      CLASSES.map(
        (c) =>
          s
            .describeFor(c)
            .split("\n")
            .find((l) => l.includes("<suspicion ")) ?? "",
      ),
    );
    expect(tags.size).toBe(1);
    expect([...tags][0]).not.toMatch(new RegExp(loyal));
  });
});

describe("the flag reaches the thing it names", () => {
  it("carries `--sim-option` into a rehearsal", async () => {
    // The third instance in two days of a knob that parses and is never read,
    // and the most expensive kind: `descent.sh --rehearse investigator
    // --sim-option reveal=social` played thirty rounds, wrote a trace, printed
    // a score, and reported the social layer switched off. Nothing failed. The
    // arm in the filename was not the arm that ran.
    //
    // Asserted through the trace rather than the return value, because the
    // trace is what every downstream reader — the viewer, the scoreboard, the
    // next session — actually believes.
    const { rehearse } = await import("../rehearse.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = join(mkdtempSync(join(tmpdir(), "rehearse-")), "arm.ndjson");
    await rehearse({
      out,
      simulation: "descent-betrayed",
      policy: "investigator",
      seed: 3301,
      rounds: 12,
      simOptions: { reveal: "social", traitors: 1 },
    });
    const lines = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const metrics = lines
      .map((e) => e as { metrics?: Record<string, number>; snapshot?: Record<string, number> })
      .map((e) => e.metrics ?? e.snapshot)
      .filter(Boolean)
      .pop() as Record<string, number>;
    // `reads` only exists as a metric when the mode that offers it is on, so
    // its presence *is* the assertion that the option arrived.
    expect(metrics.reads, "the rehearsal ran with `reveal` unset").toBeGreaterThan(0);
    expect(metrics.traitors).toBe(1);
  });
});

describe("the price on the label is the price at the till", () => {
  /*
   * The guard for the class of defect that has now cost five separate findings
   * in two days: a tool description that names a cost the code does not take.
   *
   * `vigil` and `tally` told every model that read them they cost "the round"
   * and never took it — through the whole period in which they were measured as
   * used zero times across three live runs. The social instruments say the
   * opposite, that they cost no action, and that has to be true or the fix is
   * just a new lie pointing the other way.
   *
   * A readied intent is the observable: `ready()` is what spends a character's
   * round, and an instrument that does not touch `state.intents` has not spent
   * it. Cheap for a price, useless for a euphemism — which is exactly why the
   * euphemism went unnoticed longest.
   */
  /*
   * The *whole* intent, not a count of them.
   *
   * The first version of this helper counted a character's queued intents and
   * the control run passed against deliberately broken code, which is the
   * failure mode this repo keeps warning about. `ready()` **replaces** an
   * actor's intent rather than appending, so an instrument that quietly readied
   * a `defend` over a queued `attack` left the count at one and the assertion
   * green while doing precisely the thing it was written to forbid.
   */
  const readied = (s: Sim, who: ClassId) =>
    JSON.stringify(
      ((s as unknown as { state: { intents: Array<{ actor: string }> } }).state.intents ?? []).filter(
        (i) => i.actor === who,
      ),
    );

  it("leaves a readied action alone, as all three descriptions promise", async () => {
    // Played into a fight first, because `defend` is refused outside combat and
    // combat is the only place the promise matters: it is where a model is
    // actually weighing an instrument against its round.
    const s = make(1000, "social", 1);
    const pol = simulationPolicies("descent-betrayed")["loyal-party"]?.();
    if (!pol) throw new Error("no loyal-party baseline");
    for (let i = 0; i < 40 && !s.done; i++) {
      if ((s as unknown as { view(): { phase: string } }).view().phase === "combat") break;
      pol.act(s);
      s.advance();
    }
    const { traitor, loyal } = traitorAndLoyal(s);
    give(s, loyal, DRAUGHT_ITEM);
    give(s, loyal, VENOM_ITEM);
    await call(s, "defend", {}, loyal);
    const before = readied(s, loyal);
    expect(before, "the setup did not ready anything to protect").toContain("defend");

    for (const [tool, args] of [
      ["size_up", { who: traitor }],
      ["drink_draught", { who: traitor }],
      ["poison", { who: traitor }],
    ] as Array<[string, Record<string, unknown>]>) {
      const out = await call(s, tool, args, loyal);
      expect(out, `${tool} refused`).not.toMatch(/^Refused:/);
      expect(readied(s, loyal), `${tool} changed the round its description says it does not touch`).toBe(before);
    }
  });

  it("says so in the description, so a model can budget on it", () => {
    const tools = make(1000, "social", 1).sharedTools();
    for (const name of ["size_up", "drink_draught", "poison"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, `${name} is not offered`).toBeDefined();
      expect(tool?.description, `${name} does not say what it costs`).toMatch(/no action/i);
    }
  });

  it("no longer claims a vigil costs the round, because it never did", async () => {
    // The older lie. `reveal()` neither clears an intent nor blocks one, so the
    // only true costs are dread and publicity — both of which the text keeps.
    const s = make(1000, "vigil", 1);
    const tool = s.sharedTools().find((t) => t.name === "vigil");
    expect(tool?.description).not.toMatch(/costs you the round/i);
    expect(tool?.description).toMatch(/dread/i);
  });
});
