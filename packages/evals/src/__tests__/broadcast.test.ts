/**
 * The two pieces of the broadcast that run on the server.
 *
 * The page itself is not tested here — it is a browser, and a headless check of
 * canvas output would assert on pixels nobody agreed on. What *is* worth
 * pinning is the data underneath it: a scoreboard that reads runs off disk, and
 * a commentator that must never be able to touch the run it is commentating on.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { culprits } from "../../viewer/broadcast/src/ribbon.js";
import { readHistory, summariseTrace } from "../history.js";
import { digest, narrate } from "../narrate.js";
import type { TraceEvent } from "../trace.js";
import { newestTrace } from "../watch.js";

const scratch = () => mkdtempSync(join(tmpdir(), "tai-broadcast-"));

/** A trace the way a run writes one: NDJSON, one event per line. */
function writeTrace(dir: string, name: string, events: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

const run = (at: number, scenario = "the-endless-descent") => ({
  kind: "run",
  at,
  scenario,
  model: "test-model",
  agents: ["guardian"],
  rooms: ["party"],
  rounds: 40,
});

const state = (at: number, earnedXp: number, floor: number) => ({
  kind: "state",
  at,
  turn: 1,
  round: 1,
  snapshot: { earnedXp, floorReached: floor, bossesDefeated: 1, survivors: 3, scene: { floor, phase: "combat" } },
});

describe("reading a run back off its trace", () => {
  it("summarises what a scoreboard needs", () => {
    const dir = scratch();
    const path = writeTrace(dir, "a.ndjson", [
      run(1_000),
      { kind: "round", at: 1_100, round: 0 },
      { kind: "turn", at: 1_150, turn: 0, round: 0, agent: "guardian", room: "party" },
      state(1_200, 4_200, 33),
      { kind: "end", at: 1_300, reason: "the party was wiped out on floor 33", turns: 1 },
    ]);
    const record = summariseTrace(path);
    expect(record).toMatchObject({
      scenario: "the-endless-descent",
      model: "test-model",
      score: 4_200,
      floor: 33,
      rounds: 1,
      turns: 1,
      finished: true,
      endedBecause: "the party was wiped out on floor 33",
    });
  });

  it("keeps a run that was cut off, and marks it unfinished", () => {
    // A scoreboard that silently dropped abandoned runs would flatter the
    // history it is drawn from — the interrupted ones are usually the bad ones.
    const dir = scratch();
    const path = writeTrace(dir, "b.ndjson", [run(1_000), state(1_100, 90, 31)]);
    expect(summariseTrace(path)).toMatchObject({ finished: false, score: 90 });
  });

  it("survives a half-written last line, because it reads live files", () => {
    const dir = scratch();
    const path = join(dir, "c.ndjson");
    writeFileSync(path, `${JSON.stringify(run(1_000))}\n${JSON.stringify(state(1_100, 7, 31))}\n{"kind":"sta`);
    expect(summariseTrace(path)?.score).toBe(7);
  });

  it("ignores a file that is not a run", () => {
    const dir = scratch();
    expect(summariseTrace(writeTrace(dir, "d.ndjson", [{ kind: "round", at: 1, round: 0 }]))).toBeNull();
  });
});

describe("the scoreboard", () => {
  const now = 1_000_000_000_000;
  const hours = (n: number) => n * 60 * 60 * 1000;

  function history() {
    const dir = scratch();
    writeTrace(dir, "old.ndjson", [
      run(now - hours(24 * 9)),
      state(now - hours(24 * 9), 9_000, 40),
      { kind: "end", at: now - hours(24 * 9), turns: 1 },
    ]);
    writeTrace(dir, "week.ndjson", [
      run(now - hours(50)),
      state(now - hours(50), 5_000, 35),
      { kind: "end", at: now - hours(50), turns: 1 },
    ]);
    writeTrace(dir, "today.ndjson", [
      run(now - hours(3)),
      state(now - hours(3), 6_000, 36),
      { kind: "end", at: now - hours(3), turns: 1 },
    ]);
    writeTrace(dir, "other.ndjson", [
      run(now - hours(1), "the-lock"),
      state(now - hours(1), 99_999, 1),
      { kind: "end", at: now - hours(1), turns: 1 },
    ]);
    return readHistory(dir, "the-endless-descent", now);
  }

  it("finds the best run ever, whenever it happened", () => {
    expect(history().best?.score).toBe(9_000);
  });

  it("buckets today and this week without counting older runs", () => {
    const h = history();
    expect(h.today).toEqual({ runs: 1, best: 6_000 });
    // Fifty hours ago is inside the week and outside the day; nine days is
    // outside both.
    expect(h.week).toEqual({ runs: 2, best: 6_000 });
  });

  it("only counts the scenario it was asked about", () => {
    // The lock run scored 99,999 in a different game entirely. A scoreboard
    // that mixed scenarios would crown it forever.
    expect(history().runs.every((r) => r.scenario === "the-endless-descent")).toBe(true);
    expect(history().best?.score).not.toBe(99_999);
  });

  it("orders newest first and names the previous finished run", () => {
    const h = history();
    expect(h.runs[0].file).toBe("today.ndjson");
    expect(h.previous?.file).toBe("today.ndjson");
  });

  it("says nothing rather than throwing when there is no history", () => {
    expect(readHistory(join(scratch(), "nope"))).toMatchObject({ runs: [], best: null, previous: null });
  });
});

describe("finding the newest run", () => {
  it("never mistakes a commentator's sidecar for a run", () => {
    // The sidecar is written *after* the trace it describes, so a bare
    // `.ndjson` filter makes it the newest file — and `watch` then opens a run
    // consisting entirely of narration, with no scene, no party and no stage.
    const dir = scratch();
    writeTrace(dir, "a-run.ndjson", [run(1_000), state(1_100, 10, 31)]);
    writeTrace(dir, "a-run.narration.ndjson", [{ kind: "narration", at: 2_000, round: 0, text: "..." }]);
    expect(newestTrace(dir)?.endsWith("a-run.ndjson")).toBe(true);
  });

  it("has nothing to say about a directory with no runs", () => {
    expect(newestTrace(join(scratch(), "nowhere"))).toBeUndefined();
  });
});

describe("the readied ribbon", () => {
  it("finds every class named in a clash, whatever the sentence looks like", () => {
    // The strings come from `antiSynergies`, which writes prose because the
    // same text is stored by the diagnostic and read in the report. Matching
    // names inside it must survive a reworded verb.
    expect([...culprits(["mage's area attack will wake whatever rogue puts to sleep"])].sort()).toEqual([
      "mage",
      "rogue",
    ]);
    expect([...culprits(["the whole party is on one target while Elite Elder Husk is untouched"])]).toEqual([]);
    expect(culprits([]).size).toBe(0);
  });

  it("does not care about case, because the prose does not either", () => {
    expect([...culprits(["GUARDIAN and Cleric are both healing"])].sort()).toEqual(["cleric", "guardian"]);
  });
});

describe("the page's shell", () => {
  /**
   * Every mount point `main.ts` demands has to exist in the markup.
   *
   * `need()` throws on a missing id, and it runs before the render loop starts
   * — so one renamed div does not degrade the page, it blanks it. The two files
   * are edited independently and nothing else connects them, which is exactly
   * the seam that rots. Checked as text rather than in a browser because that
   * is all this needs: no DOM, no build, no dependency.
   */
  it("has a div for everything main.ts asks for", () => {
    const root = join(import.meta.dirname, "..", "..", "viewer", "broadcast");
    const main = readFileSync(join(root, "src", "main.ts"), "utf8");
    const html = readFileSync(join(root, "index.html"), "utf8");

    const wanted = [...main.matchAll(/need\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(wanted.length, "main.ts should mount something").toBeGreaterThan(4);
    for (const id of wanted) {
      expect(html, `index.html is missing #${id}, which would blank the page`).toContain(`id="${id}"`);
    }
  });

  it("keeps the party channel out of the rotation", () => {
    // The chat panel is the show — a viewer following an argument about who
    // takes the second thing out of a cache must not be cut away from it. A
    // `data-panel` attribute is what enrols a panel in the director's
    // rotation, so chat must not carry one.
    const root = join(import.meta.dirname, "..", "..", "viewer", "broadcast");
    const html = readFileSync(join(root, "index.html"), "utf8");
    const chatBlock = html.slice(Math.max(0, html.indexOf('id="chat"') - 300), html.indexOf('id="chat"'));
    expect(chatBlock).not.toMatch(/data-panel="chat"/);
  });
});

describe("the commentator", () => {
  it("is given what a spectator can see and nothing else", () => {
    const events: TraceEvent[] = [
      { kind: "round", at: 1, round: 3, announce: "Floor 31 — combat.\nrogue hits The Hollow Choir for 89." },
      {
        kind: "state",
        at: 2,
        turn: 1,
        round: 3,
        snapshot: {
          scene: {
            floor: 31,
            phase: "combat",
            party: [{ id: "guardian", hp: 400, maxHp: 600, dead: false }],
            enemies: [{ name: "The Hollow Choir", hp: 900, maxHp: 2277, telegraph: "drawing breath to toll" }],
          },
        },
      },
      { kind: "post", at: 3, turn: 1, agent: "mage", room: "party", to: [], body: "It resists shadow." },
      // A tool result is the agents' private working, and a commentator that
      // could read it would be explaining the game rather than describing it.
      {
        kind: "call",
        at: 4,
        turn: 1,
        agent: "rogue",
        tool: "inspect_enemy",
        args: {},
        result: "SECRET",
        refused: false,
      },
    ];
    const text = digest(events, 3) ?? "";
    expect(text).toContain("Floor 31");
    expect(text).toContain("The Hollow Choir");
    expect(text).toContain("drawing breath to toll");
    expect(text).toContain("It resists shadow.");
    expect(text).not.toContain("SECRET");
  });

  it("still has something to say about a trace with no scene", () => {
    // Traces written before the scene existed, and any future simulation that
    // does not publish one, must not produce a silent commentator.
    const text = digest([{ kind: "round", at: 1, round: 0, announce: "The party lingers." }], 0);
    expect(text).toContain("The party lingers.");
  });

  it("writes only its own sidecar, and never touches the trace", async () => {
    // The property the whole design exists for: a run has to be byte-identical
    // whether or not anybody was commentating on it.
    const dir = scratch();
    const path = writeTrace(dir, "live.ndjson", [
      run(1),
      { kind: "round", at: 2, round: 0, announce: "Floor 31 — combat." },
      { kind: "round", at: 3, round: 1, announce: "rogue hits it for 89." },
      { kind: "end", at: 4, turns: 2 },
    ]);
    const before = readFileSync(path, "utf8");

    // No model is reachable in a unit test, so every call fails — which is
    // itself worth asserting: a commentator that cannot speak must not crash,
    // and must not leave the run in a different state than it found it.
    const spoken = await narrate({
      tracePath: path,
      baseUrl: "http://127.0.0.1:1/v1",
      model: "nothing",
      pollMs: 1,
    });

    expect(spoken).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
