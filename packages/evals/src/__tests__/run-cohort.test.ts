/**
 * Which past runs a run is allowed to be compared against.
 *
 * The defect this file exists to pin is not a crash, it is a plausible wrong
 * number: the record board used to rank every trace in the directory against
 * every other one, so a run that began on floor 31 of a corridor dungeon held
 * the record over a run that begins on floor 1 of a room graph, and the panel
 * told a viewer the second one was seven thousand experience behind. It was not
 * behind. It was playing a different game.
 *
 * So the tests below are mostly about *refusing* to compare. Every one of them
 * fails if the fingerprint stops distinguishing something it currently
 * distinguishes, which is the only way this kind of code stays honest — a
 * lenient comparison never throws, it just quietly answers the wrong question.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setAsideLine, worldsLine } from "../../viewer/broadcast/src/records.js";
import { type RunRecord, readHistory, summariseTrace } from "../history.js";
import {
  buildCohort,
  type CohortRun,
  compareRuns,
  count,
  deltasAt,
  describeCohort,
  fingerprintKey,
  leadSource,
  markersFor,
  medianRun,
  pacePhrase,
  phrase,
  type RunPoint,
  sampleAt,
} from "../run-cohort.js";

const scratch = () => mkdtempSync(join(tmpdir(), "tai-cohort-"));

/** How one round of a fixture run went. */
interface FakeRound {
  xp: number;
  floor: number;
  rooms?: number;
  bosses?: number;
  deaths?: number;
}

interface FakeRun {
  at?: number;
  scenario?: string;
  model?: string;
  horizon?: number;
  /** Omitted entirely for a trace that never published a snapshot. */
  startFloor?: number;
  /** `undefined` writes no `floorMap` key at all — a trace from before room graphs existed. */
  maze?: boolean;
  prepared?: boolean;
  ladder?: string[];
  cast?: string[];
  rounds?: FakeRound[];
  finished?: boolean;
  survivors?: number;
  /** Snapshots per round, to reproduce the five-agents-one-round case. */
  snapshotsPerRound?: number;
  /**
   * What the run declared it was built with.
   *
   * Absent writes no `simulation` field, which is what every trace on disk from
   * before it existed looks like — and the case most of these tests are about.
   */
  declared?: { name?: string; seed?: number; days?: number; options?: Record<string, unknown> };
}

/**
 * A descent trace, written the way a run writes one.
 *
 * Built from a description rather than copied from a real trace because the
 * point of every test here is one facet being different, and a fixture you have
 * to hand-edit a megabyte of JSON to vary is a fixture nobody varies.
 */
function descentTrace(dir: string, name: string, cfg: FakeRun = {}): string {
  const at = cfg.at ?? 1_000;
  const horizon = cfg.horizon ?? 40;
  const rounds = cfg.rounds ?? [{ xp: 100, floor: 1 }];
  const events: unknown[] = [
    {
      kind: "run",
      at,
      scenario: cfg.scenario ?? "the-endless-descent",
      model: cfg.model ?? "test-model",
      agents: ["guardian"],
      rooms: ["party"],
      rounds: horizon,
      milestones: (cfg.ladder ?? ["fought-at-all"]).map((id) => ({ id, points: 1 })),
      ...(cfg.declared ? { simulation: { name: "descent", seed: 1_000, ...cfg.declared } } : {}),
    },
  ];

  rounds.forEach((point, index) => {
    events.push({ kind: "round", at: at + index * 10, round: index });
    if (cfg.startFloor === undefined) return;
    const scene: Record<string, unknown> = {
      floor: point.floor,
      // Surface preparation is the only thing that ever puts the world in camp.
      phase: cfg.prepared && index === 0 ? "camp" : "explore",
      horizon,
      earnedXp: point.xp,
    };
    if (cfg.maze !== undefined) {
      scene.floorMap = cfg.maze ? { zone: "the upper vaults", currentRoom: "r1", rooms: [], routes: [] } : null;
    }
    if (cfg.cast) {
      scene.party = cfg.cast.map((generatedName, i) => ({ id: `c${i}`, identity: { generatedName } }));
    }
    // One snapshot per agent turn, all carrying the same round. A track that
    // appended rather than keyed by round would grow five points per round.
    for (let copy = 0; copy < (cfg.snapshotsPerRound ?? 1); copy += 1) {
      events.push({
        kind: "state",
        at: at + index * 10 + copy,
        turn: index,
        round: index,
        snapshot: {
          earnedXp: point.xp,
          startedAtFloor: cfg.startFloor,
          floorReached: point.floor,
          roomsExplored: point.rooms ?? 0,
          bossesDefeated: point.bosses ?? 0,
          deaths: point.deaths ?? 0,
          survivors: cfg.survivors ?? 5,
          scene,
        },
      });
    }
  });

  if (cfg.finished !== false) events.push({ kind: "end", at: at + rounds.length * 10, turns: rounds.length });

  writeFileSync(join(dir, name), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return join(dir, name);
}

const need = (record: RunRecord | null): RunRecord => {
  if (!record) throw new Error("the fixture should have summarised");
  return record;
};

/** A declared-configuration fixture, since most of these tests vary only the options bag. */
function summariseFixture(dir: string, name: string, options: Record<string, unknown>): string {
  return descentTrace(dir, name, { startFloor: 1, declared: { options } });
}

const summariseFixtureRecord = (dir: string, name: string, options: Record<string, unknown>) =>
  summariseTrace(summariseFixture(dir, name, options));

/* -------------------------------------------------------------------------- */

describe("the fingerprint a trace can be read for", () => {
  it("recovers the configuration facts that decide comparability", () => {
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          maze: true,
          prepared: true,
          horizon: 40,
          ladder: ["fought-at-all", "cleared-a-floor"],
          cast: ["Galen", "Perrin"],
        }),
      ),
    );
    expect(record.fingerprint).toMatchObject({
      scenario: "the-endless-descent",
      observed: true,
      horizon: 40,
      startFloor: 1,
      maze: true,
      preparation: true,
      ladder: "fought-at-all,cleared-a-floor",
      cast: "Galen/Perrin",
    });
  });

  it("separates a floor-31 corridor run from a floor-1 maze run", () => {
    // The exact pair on disk today, and the exact false comparison that
    // motivated the whole feature: a deep start scores thousands in its opening
    // rounds and a floor-1 start scores tens.
    const dir = scratch();
    const deep = need(summariseTrace(descentTrace(dir, "deep.ndjson", { startFloor: 31, maze: false })));
    const top = need(summariseTrace(descentTrace(dir, "top.ndjson", { startFloor: 1, maze: true, prepared: true })));
    const verdict = compareRuns(top.fingerprint, deep.fingerprint);
    expect(verdict.verdict).toBe("different");
    expect(verdict.differs).toContain("a different starting floor");
    expect(fingerprintKey(top.fingerprint)).not.toBe(fingerprintKey(deep.fingerprint));
  });

  it("calls a trace that never published a snapshot unverified, not compatible", () => {
    // The failure mode a lenient comparison produces: a run whose configuration
    // nobody can read is not evidence that it matches.
    const dir = scratch();
    const silent = need(summariseTrace(descentTrace(dir, "silent.ndjson", {})));
    const known = need(summariseTrace(descentTrace(dir, "known.ndjson", { startFloor: 1, maze: true })));
    expect(silent.fingerprint.observed).toBe(false);
    const verdict = compareRuns(known.fingerprint, silent.fingerprint);
    expect(verdict.verdict).toBe("unverified");
    expect(verdict.differs).toEqual([]);
  });

  it("does not let two runs that both recorded nothing pass as a matched pair", () => {
    // The other half of the rule below. Two silent traces agree on every facet
    // in the sense that neither said anything, and reading that as "the same
    // game" is how an unverified run gets averaged into a record.
    const dir = scratch();
    const a = need(summariseTrace(descentTrace(dir, "a.ndjson", {})));
    const b = need(summariseTrace(descentTrace(dir, "b.ndjson", {})));
    expect(a.fingerprint.observed).toBe(false);
    expect(compareRuns(a.fingerprint, b.fingerprint).verdict).toBe("unverified");
  });

  it("does not force a scenario with no floors into permanent uncertainty", () => {
    // The lock has no starting floor, no maze and no outfitter, so both of its
    // runs record `null` for all three. Two runs that both watched their
    // simulation and both found nothing are agreeing, not guessing.
    const dir = scratch();
    const a = need(summariseTrace(writeMinimal(dir, "lock-a.ndjson", "the-lock", { solved: 1 })));
    const b = need(summariseTrace(writeMinimal(dir, "lock-b.ndjson", "the-lock", { solved: 0 })));
    expect(a.fingerprint.observed).toBe(true);
    expect(compareRuns(a.fingerprint, b.fingerprint).verdict).toBe("same");
  });

  it("distinguishes a trace that says 'no maze' from one that never mentioned maps", () => {
    // A trace written before the room graph existed is silent about layout; one
    // written after says so by carrying the key with nothing in it. Collapsing
    // the two would let an old corridor run pass as a deliberate flat floor.
    const dir = scratch();
    const silent = need(summariseTrace(descentTrace(dir, "old.ndjson", { startFloor: 31 })));
    const flat = need(summariseTrace(descentTrace(dir, "flat.ndjson", { startFloor: 31, maze: false })));
    expect(silent.fingerprint.maze).toBeNull();
    expect(flat.fingerprint.maze).toBe(false);
    expect(compareRuns(flat.fingerprint, silent.fingerprint).verdict).toBe("unverified");
  });

  it("never claims to know a seed a trace did not record", () => {
    const dir = scratch();
    const record = need(summariseTrace(descentTrace(dir, "a.ndjson", { startFloor: 1, maze: true })));
    expect(record.fingerprint.seed).toBeNull();
    expect(record.fingerprint.options).toBeNull();
  });

  it("reads the configuration the run declared", () => {
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          declared: {
            seed: 2_201,
            days: 40,
            options: { startFloor: 1, maze: true, preparation: true, startingGold: 180, startingSkillPoints: 2 },
          },
        }),
      ),
    );
    expect(record.fingerprint).toMatchObject({
      seed: 2_201,
      horizon: 40,
      startFloor: 1,
      maze: true,
      preparation: true,
      options: { startingGold: "180", startingSkillPoints: "2" },
    });
  });

  it("believes what the run declared over what the run looked like", () => {
    // The two can disagree. A trace can be read for a maze it happens to be
    // standing in, or a camp phase it happens to open in; only the recorded
    // options say what the simulation was *built* with, and the day those two
    // part company the declaration is the one that reproduces the run.
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 31,
          maze: true,
          prepared: true,
          declared: { options: { startFloor: 7, maze: false } },
        }),
      ),
    );
    expect(record.fingerprint.startFloor).toBe(7);
    expect(record.fingerprint.maze).toBe(false);
    expect(record.fingerprint.preparation).toBe(false);
  });

  it("still reads an old trace by inference, because most of them are old", () => {
    const dir = scratch();
    const record = need(
      summariseTrace(descentTrace(dir, "a.ndjson", { startFloor: 1, maze: true, prepared: true, cast: ["Galen"] })),
    );
    expect(record.fingerprint).toMatchObject({ startFloor: 1, maze: true, preparation: true, cast: "Galen" });
  });

  it("keeps the cast as a second signal once the seed is recorded", () => {
    // Not superseded. The cast is generated from the seed and nothing else, so
    // it cross-checks the declaration rather than merely standing in for it.
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          cast: ["Galen", "Perrin"],
          declared: { seed: 2_201, options: { startFloor: 1 } },
        }),
      ),
    );
    expect(record.fingerprint.seed).toBe(2_201);
    expect(record.fingerprint.cast).toBe("Galen/Perrin");
  });

  it("reads a flag the same way the simulation does, however it was written", () => {
    // `--sim-option` cannot know a simulation's schema, so it hands `maze` over
    // as the string "true" where a scenario definition hands over the boolean.
    // The simulation accepts both; a fingerprint that accepted only one would
    // call two identically-launched runs incompatible.
    const dir = scratch();
    const record = need(
      summariseTrace(summariseFixture(dir, "stringly.ndjson", { startFloor: "1", maze: "true", preparation: "true" })),
    );
    expect(record.fingerprint).toMatchObject({ startFloor: 1, maze: true, preparation: true });
  });

  it("does not fold a flag the simulation would have rejected into one it accepts", () => {
    // `--sim-option maze=TRUE` does not switch the maze on — the simulation
    // tests for the exact string. A fingerprint that normalised the case would
    // report a run that played a corridor as having played the maze.
    const dir = scratch();
    const shouting = need(summariseFixtureRecord(dir, "shouting.ndjson", { startFloor: 1, maze: "TRUE" }));
    const real = need(summariseFixtureRecord(dir, "real.ndjson", { startFloor: 1, maze: true }));
    expect(shouting.fingerprint.maze).toBe(false);
    expect(compareRuns(shouting.fingerprint, real.fingerprint).verdict).toBe("different");
  });

  it("does not care what order the options were written in", () => {
    const dir = scratch();
    const a = need(summariseFixtureRecord(dir, "a.ndjson", { startFloor: 1, startingGold: 180, alpha: 1 }));
    const b = need(summariseFixtureRecord(dir, "b.ndjson", { alpha: 1, startFloor: 1, startingGold: 180 }));
    expect(compareRuns(a.fingerprint, b.fingerprint).verdict).toBe("same");
  });

  it("treats an option named but left empty as an option that was never named", () => {
    // `null` and not `undefined`: an undefined value never survives being
    // written to a trace, so the only empty an option can actually arrive with
    // is the one a config file leaves blank.
    const dir = scratch();
    const named = need(summariseFixtureRecord(dir, "a.ndjson", { startFloor: 1, startingGold: null }));
    const silent = need(summariseFixtureRecord(dir, "b.ndjson", { startFloor: 1 }));
    expect(named.fingerprint.options).toEqual({});
    expect(compareRuns(named.fingerprint, silent.fingerprint).verdict).toBe("same");
  });

  it("reports a differing starting floor once, not once as a facet and again as an option", () => {
    // `startFloor` has a field of its own, so it is removed from the bag. Left
    // in, every floor difference would be announced twice and the exclusion
    // tally would count one disagreement as two.
    const dir = scratch();
    const a = need(summariseFixtureRecord(dir, "a.ndjson", { startFloor: 1 }));
    const b = need(summariseFixtureRecord(dir, "b.ndjson", { startFloor: 31 }));
    expect(compareRuns(a.fingerprint, b.fingerprint).differs).toEqual(["a different starting floor"]);
  });

  it("treats a declared trace and an undeclared one as unverified against each other", () => {
    // The rule the whole feature turns on, at the seam where it changes hands:
    // an old trace cannot say what gold it started with, and reading its
    // silence as agreement is how an incomparable run gets into an average.
    const dir = scratch();
    const old = need(summariseTrace(descentTrace(dir, "old.ndjson", { startFloor: 1, maze: true, prepared: true })));
    const now = need(
      summariseTrace(
        descentTrace(dir, "new.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, maze: true, preparation: true, startingGold: 180 } },
        }),
      ),
    );
    expect(compareRuns(now.fingerprint, old.fingerprint).verdict).toBe("unverified");
  });

  it("sets aside a run whose starting gold differs, and names the option", () => {
    // The gap that motivated recording the options at all. Two runs on floor 1
    // with a maze and an outfitter used to be indistinguishable even when one
    // of them started with five times the money.
    const dir = scratch();
    const poor = need(
      summariseTrace(
        descentTrace(dir, "poor.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, maze: true, startingGold: 180 } },
        }),
      ),
    );
    const rich = need(
      summariseTrace(
        descentTrace(dir, "rich.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, maze: true, startingGold: 900 } },
        }),
      ),
    );
    const verdict = compareRuns(poor.fingerprint, rich.fingerprint);
    expect(verdict.verdict).toBe("different");
    expect(verdict.primary).toBe("a different startingGold");
  });

  it("names both options when two of them differ", () => {
    const dir = scratch();
    const a = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, startingGold: 180, startingSkillPoints: 2 } },
        }),
      ),
    );
    const b = need(
      summariseTrace(
        descentTrace(dir, "b.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, startingGold: 900, startingSkillPoints: 5 } },
        }),
      ),
    );
    expect(compareRuns(a.fingerprint, b.fingerprint).primary).toBe("a different startingGold and startingSkillPoints");
  });

  it("splits on an option nobody has thought about yet", () => {
    // The bag is compared whole rather than key by named key, so a simulation
    // option added tomorrow separates the cohorts tomorrow instead of waiting
    // for somebody to remember this file.
    const dir = scratch();
    const a = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", { startFloor: 1, declared: { options: { startFloor: 1, somethingNew: 1 } } }),
      ),
    );
    const b = need(
      summariseTrace(
        descentTrace(dir, "b.ndjson", { startFloor: 1, declared: { options: { startFloor: 1, somethingNew: 2 } } }),
      ),
    );
    expect(compareRuns(a.fingerprint, b.fingerprint).primary).toBe("a different somethingNew");
  });

  it("keeps the milestone ladder out of the cohort key", () => {
    // The ladder decides what scores as a milestone; it does not touch
    // experience, depth, rooms or deaths, which are the only things compared.
    // Splitting the cohort on it would leave every run alone with itself the
    // first time a milestone was renamed.
    const dir = scratch();
    const a = need(summariseTrace(descentTrace(dir, "a.ndjson", { startFloor: 1, maze: true, ladder: ["x"] })));
    const b = need(
      summariseTrace(descentTrace(dir, "b.ndjson", { startFloor: 1, maze: true, ladder: ["x", "y", "z"] })),
    );
    expect(a.fingerprint.ladder).not.toBe(b.fingerprint.ladder);
    expect(compareRuns(a.fingerprint, b.fingerprint).verdict).toBe("same");
  });

  it("describes a cohort in words a viewer can check against the run", () => {
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          declared: { options: { startFloor: 1, maze: true, preparation: true, startingGold: 180 } },
        }),
      ),
    );
    expect(describeCohort(record.fingerprint)).toBe(
      "the-endless-descent · 40 rounds · from floor 1 · maze floors · outfitted · startingGold 180",
    );
  });

  it("survives a half-written last line, because it reads live files", () => {
    const dir = scratch();
    const path = descentTrace(dir, "live.ndjson", { startFloor: 1, maze: true, rounds: [{ xp: 5, floor: 1 }] });
    appendFileSync(path, '{"kind":"sta');
    const record = need(summariseTrace(path));
    expect(record.fingerprint.startFloor).toBe(1);
    expect(record.track.length).toBe(1);
  });
});

/** A trace for a simulation with no floors at all, so every descent facet is legitimately absent. */
function writeMinimal(dir: string, name: string, scenario: string, snapshot: Record<string, unknown>): string {
  const events = [
    { kind: "run", at: 1_000, scenario, model: "test-model", agents: ["a"], rooms: ["r"], rounds: 12 },
    { kind: "round", at: 1_010, round: 0 },
    { kind: "state", at: 1_020, turn: 0, round: 0, snapshot },
    { kind: "end", at: 1_030, turns: 1 },
  ];
  writeFileSync(join(dir, name), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return join(dir, name);
}

/* -------------------------------------------------------------------------- */

describe("the per-round track", () => {
  it("collapses the five snapshots one round of five agents publishes", () => {
    // The trap `docs/broadcast-viewer.md` states plainly: the harness writes a
    // state event after every turn, so a track that appended would carry five
    // points per round and a ghost line would run five times too long.
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          maze: true,
          snapshotsPerRound: 5,
          rounds: [
            { xp: 10, floor: 1 },
            { xp: 20, floor: 2 },
          ],
        }),
      ),
    );
    expect(record.track.map((p) => p.round)).toEqual([0, 1]);
    expect(record.track.map((p) => p.xp)).toEqual([10, 20]);
  });

  it("carries the four axes a lead can be made of", () => {
    const dir = scratch();
    const record = need(
      summariseTrace(
        descentTrace(dir, "a.ndjson", {
          startFloor: 1,
          maze: true,
          rounds: [{ xp: 90, floor: 3, rooms: 7, bosses: 1, deaths: 2 }],
        }),
      ),
    );
    expect(record.track[0]).toEqual({ round: 0, xp: 90, floor: 3, rooms: 7, bosses: 1, deaths: 2 });
  });
});

/* -------------------------------------------------------------------------- */

const point = (round: number, xp: number, extra: Partial<RunPoint> = {}): RunPoint => ({
  round,
  xp,
  floor: 1,
  rooms: 0,
  bosses: 0,
  deaths: 0,
  ...extra,
});

const fakeRun = (file: string, over: Partial<CohortRun> = {}): CohortRun => ({
  file,
  scenario: "the-endless-descent",
  model: "test-model",
  startedAt: 1_000,
  rounds: 1,
  score: 100,
  floor: 1,
  bosses: 0,
  survivors: 5,
  finished: true,
  ...over,
});

describe("comparing at the same round", () => {
  const track = [point(0, 0), point(4, 400), point(9, 900)];

  it("reads a run where it stood, not where it ended", () => {
    // The heart of it. A live run at round four against a finished run's total
    // is not a comparison, it is a restatement that the run is not over.
    expect(sampleAt(track, 4)?.xp).toBe(400);
    expect(sampleAt(track, 9)?.xp).toBe(900);
  });

  it("holds the last known position through a round that published nothing", () => {
    expect(sampleAt(track, 6)?.xp).toBe(400);
  });

  it("has nothing to say about a round before the run started", () => {
    expect(sampleAt([point(3, 30)], 1)).toBeNull();
    expect(sampleAt(undefined, 4)).toBeNull();
  });

  it("counts fewer deaths as an advantage and more as a deficit", () => {
    // Deaths are the one axis where lower is better; an unflipped delta would
    // report a party that lost three members as three ahead on survival.
    const mine = [point(0, 0, { deaths: 1 })];
    const theirs = [point(0, 0, { deaths: 3 })];
    const deltas = deltasAt(mine, theirs, 0, ["deaths"]);
    expect(deltas[0].delta).toBe(2);
    expect(phrase("deaths", deltas[0].delta)).toBe("two deaths fewer");
  });
});

describe("saying the difference in words", () => {
  it("uses words for small counts and digits past ten", () => {
    expect(count(1)).toBe("one");
    expect(count(4)).toBe("four");
    expect(count(23)).toBe("23");
  });

  it("phrases each axis the way a person would", () => {
    expect(phrase("floor", 1)).toBe("one floor ahead");
    expect(phrase("rooms", -2)).toBe("two rooms behind");
    expect(phrase("bosses", 0)).toBe("level on bosses");
    expect(phrase("xp", 1_204)).toBe("+1,204 experience");
  });

  it("says how many rounds earlier a milestone was reached", () => {
    const mine = [point(0, 0), point(3, 10, { bosses: 1 })];
    const theirs = [point(0, 0), point(7, 10, { bosses: 1 })];
    expect(pacePhrase(mine, theirs, "bosses", 1, "first boss")).toBe("first boss four rounds earlier");
  });

  it("refuses a pace claim against a run that never got there", () => {
    // "Four rounds earlier" against a run with no boss at all is an infinite
    // lead written as a small number.
    const mine = [point(3, 10, { bosses: 1 })];
    const theirs = [point(9, 10, { bosses: 0 })];
    expect(pacePhrase(mine, theirs, "bosses", 1, "first boss")).toBe("");
  });

  it("names which of the four a lead is made of", () => {
    const mine = [point(5, 900, { floor: 4, rooms: 9, bosses: 2, deaths: 0 })];
    const theirs = [point(5, 400, { floor: 4, rooms: 9, bosses: 0, deaths: 0 })];
    const lead = leadSource(deltasAt(mine, theirs, 5));
    expect(lead).toMatchObject({ axis: "bosses", ahead: true });
  });

  it("names the deficit when the run is behind, rather than going quiet", () => {
    const mine = [point(5, 100, { floor: 2 })];
    const theirs = [point(5, 900, { floor: 5 })];
    const lead = leadSource(deltasAt(mine, theirs, 5));
    expect(lead).toMatchObject({ axis: "floor", ahead: false });
  });

  it("never blames the score for itself", () => {
    // Answering "why is it ahead" with "it is ahead" is the one attribution
    // that carries no information, so experience is not a candidate.
    const mine = [point(5, 900, { floor: 3 })];
    const theirs = [point(5, 100, { floor: 3 })];
    expect(leadSource(deltasAt(mine, theirs, 5))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("building the cohort", () => {
  const maze = {
    scenario: "the-endless-descent",
    observed: true,
    horizon: 40,
    startFloor: 1,
    maze: true,
    preparation: true,
    ladder: "x",
    cast: null,
    seed: null,
  };
  const deep = { ...maze, startFloor: 31, maze: false, preparation: false };
  const silent = { ...maze, observed: false, startFloor: null, maze: null, preparation: null };

  const runs: CohortRun[] = [
    fakeRun("mine.ndjson", { fingerprint: maze, score: 300, startedAt: 5_000 }),
    fakeRun("peer-a.ndjson", { fingerprint: maze, score: 200, startedAt: 4_000, track: [point(3, 200)] }),
    fakeRun("peer-b.ndjson", { fingerprint: maze, score: 400, startedAt: 3_000, track: [point(3, 400)] }),
    fakeRun("peer-c.ndjson", { fingerprint: maze, score: 100, startedAt: 2_000 }),
    fakeRun("corridor.ndjson", { fingerprint: deep, score: 7_800, startedAt: 1_500 }),
    fakeRun("unknown.ndjson", { fingerprint: silent, score: 9_000, startedAt: 1_000 }),
  ];

  const cohort = buildCohort(runs, "mine.ndjson", maze);

  it("keeps only the runs that played the same game", () => {
    expect(cohort.members.map((m) => m.file)).toEqual(["peer-a.ndjson", "peer-b.ndjson", "peer-c.ndjson"]);
  });

  it("does not let a different configuration hold the record", () => {
    // Without this the record is 7,800 forever and a floor-1 run is told it is
    // seven thousand behind a game it is not playing.
    expect(cohort.best?.score).toBe(400);
    expect(cohort.best?.file).toBe("peer-b.ndjson");
  });

  it("excludes the run on screen from its own cohort", () => {
    expect(cohort.members.some((m) => m.file === "mine.ndjson")).toBe(false);
  });

  it("names every run it set aside and why", () => {
    expect(cohort.setAside.map((s) => [s.run.file, s.verdict])).toEqual([
      ["corridor.ndjson", "different"],
      ["unknown.ndjson", "unverified"],
    ]);
    // Grouped on the headline difference, not on the full list of them. The
    // corridor run differs on floor, layout *and* start; grouping on the
    // combination puts every run in a group of one and the line stops being a
    // summary — which is exactly what it did on the seven runs on disk.
    expect(setAsideLine(cohort)).toBe("2 set aside — 1 a different starting floor; 1 unverified configuration");
  });

  it("tallies runs that were set aside for the same headline reason together", () => {
    const other = fakeRun("corridor-2.ndjson", { fingerprint: { ...deep, startFloor: 31 }, score: 6_000 });
    const tallied = buildCohort([...runs, other], "mine.ndjson", maze);
    expect(setAsideLine(tallied)).toBe("3 set aside — 2 a different starting floor; 1 unverified configuration");
  });

  it("picks a median that is a real run, so it can be drawn", () => {
    expect(medianRun(cohort.members.filter((m): m is CohortRun & { score: number } => m.score != null))?.file).toBe(
      "peer-a.ndjson",
    );
    expect(cohort.median?.track).toBeDefined();
  });

  it("says so plainly when not one of these traces recorded its seed", () => {
    expect(cohort.seeds).toEqual([]);
    // Four runs with no recorded seed: the three members and the one on screen.
    expect(cohort.seedsUnknown).toBe(4);
    expect(worldsLine(cohort)).toContain("no seed recorded in any of these traces");
  });

  it("does not let the seed split a cohort, because a cohort spans seeds", () => {
    // The one rule the seed must not break. Splitting on it would leave every
    // run alone with itself and turn the record board into a personal best.
    const seeded = buildCohort(
      [
        fakeRun("a.ndjson", { fingerprint: { ...maze, seed: 1_000 }, score: 200 }),
        fakeRun("b.ndjson", { fingerprint: { ...maze, seed: 1_001 }, score: 400 }),
      ],
      "mine.ndjson",
      { ...maze, seed: 2_201 },
    );
    expect(seeded.members.map((m) => m.file)).toEqual(["a.ndjson", "b.ndjson"]);
    expect(seeded.setAside).toEqual([]);
  });

  it("names the seeds it is comparing across, the run on screen included", () => {
    const seeded = buildCohort(
      [
        fakeRun("a.ndjson", { fingerprint: { ...maze, seed: 1_001 } }),
        fakeRun("b.ndjson", { fingerprint: { ...maze, seed: 1_000 } }),
      ],
      "mine.ndjson",
      { ...maze, seed: 2_201 },
    );
    expect(seeded.seeds).toEqual([1_000, 1_001, 2_201]);
    expect(seeded.seedsUnknown).toBe(0);
    // This run's own seed is named apart from the rest. "Which world am I
    // watching" and "which worlds is it measured against" are two questions,
    // and one undifferentiated list of three numbers answers neither.
    expect(worldsLine(seeded)).toContain("seed 2201 · against 1000, 1001");
  });

  it("counts a cohort that shares one seed as one world, not as several runs", () => {
    // A run ahead of two runs of the same dungeon has shown much less than a
    // run ahead of two different ones, and the line has to make that visible.
    const seeded = buildCohort(
      [
        fakeRun("a.ndjson", { fingerprint: { ...maze, seed: 1_000 } }),
        fakeRun("b.ndjson", { fingerprint: { ...maze, seed: 1_000 } }),
      ],
      "mine.ndjson",
      { ...maze, seed: 1_000 },
    );
    expect(seeded.worlds).toEqual({ distinct: 1, unknown: 0, sharedWithCurrent: 2 });
    expect(worldsLine(seeded)).toContain("2 share this world");
  });

  it("keeps counting the runs whose seed nobody wrote down", () => {
    const mixed = buildCohort(
      [fakeRun("a.ndjson", { fingerprint: { ...maze, seed: 1_000 } }), fakeRun("b.ndjson", { fingerprint: maze })],
      "mine.ndjson",
      { ...maze, seed: 2_201 },
    );
    expect(mixed.seeds).toEqual([1_000, 2_201]);
    expect(mixed.seedsUnknown).toBe(1);
    expect(worldsLine(mixed)).toContain("seed 2201 · against 1000 · 1 without a recorded seed");
  });

  it("counts distinct worlds by cast, and says how many never said", () => {
    // Two of the three named runs drew the same world, so the count of worlds
    // and the count of runs deliberately disagree — a cohort of six runs over
    // two dungeons is a much weaker claim than six over six.
    const named = buildCohort(
      [
        fakeRun("a.ndjson", { fingerprint: { ...maze, cast: "Galen/Perrin" } }),
        fakeRun("b.ndjson", { fingerprint: { ...maze, cast: "Ilse/Roth" } }),
        fakeRun("c.ndjson", { fingerprint: { ...maze, cast: "Ilse/Roth" } }),
        fakeRun("d.ndjson", { fingerprint: maze }),
      ],
      "mine.ndjson",
      { ...maze, cast: "Galen/Perrin" },
    );
    expect(named.worlds).toEqual({ distinct: 2, unknown: 1, sharedWithCurrent: 1 });
    expect(worldsLine(named)).toContain("2 seeded worlds");
    expect(worldsLine(named)).toContain("shares this world");
  });

  it("flags a cohort whose members scored against different milestone ladders", () => {
    const mixed = buildCohort([fakeRun("a.ndjson", { fingerprint: { ...maze, ladder: "x,y" } })], "mine.ndjson", maze);
    expect(mixed.ladderVaries).toBe(true);
  });

  it("never lets a rehearsal into the ranking, even when it played the same game", () => {
    // The rule `rehearse` protects by writing to a different directory, held
    // from the other end. A bot on the same configuration is a fair ladder rung
    // and is never the record an agent is told it is chasing.
    const bot = fakeRun("descent-oracle.ndjson", { fingerprint: maze, score: 9_000, baseline: true });
    const withBot = buildCohort([...runs, bot], "mine.ndjson", maze);
    expect(withBot.members.some((m) => m.baseline)).toBe(false);
    expect(withBot.best?.score).toBe(400);
    expect(withBot.setAside.some((s) => s.run.file === "descent-oracle.ndjson")).toBe(false);
    expect(withBot.baselines.map((b) => b.file)).toEqual(["descent-oracle.ndjson"]);
  });

  it("leaves out a rehearsal that played a different game", () => {
    const bot = fakeRun("descent-oracle.ndjson", { fingerprint: deep, score: 9_000, baseline: true });
    expect(buildCohort([...runs, bot], "mine.ndjson", maze).baselines).toEqual([]);
  });

  it("has no cohort at all when nothing on file played this game", () => {
    const alone = buildCohort([runs[4], runs[5]], "mine.ndjson", maze);
    expect(alone.members).toEqual([]);
    expect(alone.best).toBeNull();
    expect(alone.setAside).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe("markers on the ghost line", () => {
  it("marks the first boss, the first death and the end", () => {
    const run = fakeRun("a.ndjson", {
      survivors: 0,
      track: [
        point(0, 0),
        point(2, 100, { bosses: 1 }),
        point(4, 150, { bosses: 1, deaths: 1 }),
        point(6, 150, { bosses: 1, deaths: 2 }),
      ],
    });
    expect(markersFor(run)).toEqual([
      { round: 2, kind: "boss", label: "first boss" },
      { round: 4, kind: "death", label: "first death" },
      { round: 6, kind: "end", label: "wiped" },
    ]);
  });

  it("does not mark the end of a run that has not ended", () => {
    const run = fakeRun("a.ndjson", { finished: false, track: [point(0, 0), point(2, 100)] });
    expect(markersFor(run)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("baseline rehearsals", () => {
  it("reads them, and keeps them out of the record book", () => {
    // `rehearse` writes outside the traces directory precisely so a bot's score
    // can never become the record to beat. Reading them here has to preserve
    // that: they travel in their own list and nowhere near `best`.
    const traces = scratch();
    const bots = scratch();
    descentTrace(traces, "agent.ndjson", { startFloor: 1, maze: true, rounds: [{ xp: 300, floor: 2 }] });
    descentTrace(bots, "descent-oracle.ndjson", {
      startFloor: 31,
      model: "oracle (rehearsal)",
      rounds: [{ xp: 9_000, floor: 33 }],
    });

    const history = readHistory(traces, "the-endless-descent", 2_000, { baselineDir: bots });
    expect(history.runs.map((r) => r.file)).toEqual(["agent.ndjson"]);
    expect(history.best?.score).toBe(300);
    expect(history.baselines.map((r) => r.file)).toEqual(["descent-oracle.ndjson"]);
  });

  it("reports no baselines at all when nobody asked for them", () => {
    expect(readHistory(scratch(), "the-endless-descent", 1_000).baselines).toEqual([]);
  });
});
