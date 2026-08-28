/**
 * What the commentator is handed.
 *
 * A narrator can only be as accurate as its digest, and for a long time the
 * digest was a scene plus a combat log. Everything else a run counts — kills,
 * hidden ways, tolls, gold moved, locks picked — sat one field away on the same
 * snapshot and never reached the prompt.
 *
 * Two failures came out of that in one run of 2026-08-14. An elite died in
 * round 15 and neither round 15 nor round 16 mentioned it, because a defeated
 * enemy simply stops appearing in `enemies` and nothing said it had been there.
 * And in round 3 the commentator, handed a toll payment with no cause attached,
 * supplied one — reporting that a character paid "trusting the rogue's scout
 * report" on a round where the rogue had not scouted at all.
 *
 * Party deaths were always narrated well, every time, in every run. They are
 * also the one thing the digest already computed into an explicit line. These
 * tests hold the rest of the world to that standard.
 */

import { describe, expect, it } from "vitest";
import { digest } from "../narrate.js";
import type { TraceEvent } from "../trace.js";

/** A resolved round, with whatever counters and enemies the test needs. */
function round(
  n: number,
  snapshot: Record<string, unknown>,
  enemies: Array<{ ref: string; name: string; dead?: boolean }> = [],
): TraceEvent[] {
  return [
    { kind: "round", at: n * 1000, round: n } as TraceEvent,
    {
      kind: "state",
      at: n * 1000 + 1,
      turn: n * 5,
      round: n,
      resolved: true,
      snapshot: {
        ...snapshot,
        scene: { floor: 1, phase: "combat", party: [], enemies, announce: "Blows are exchanged." },
      },
    } as unknown as TraceEvent,
  ];
}

describe("facts the commentator would otherwise never see", () => {
  it("names an enemy that stopped existing between rounds", () => {
    const events = [
      ...round(0, { enemiesDefeated: 0 }, [
        { ref: "hound-1", name: "Elite Ash Hound" },
        { ref: "husk-1", name: "Ash Husk" },
      ]),
      ...round(1, { enemiesDefeated: 1, elitesDefeated: 1 }, [{ ref: "husk-1", name: "Ash Husk" }]),
    ];
    const text = digest(events, 1) ?? "";
    // Without this the only evidence a kill happened is whatever the combat
    // prose chose to say, which is exactly the channel that lost one.
    expect(text).toContain("Killed this round: Elite Ash Hound.");
    expect(text).toContain("an elite went down");
  });

  it("does not report a kill for an enemy that is merely still standing", () => {
    const events = [
      ...round(0, { enemiesDefeated: 0 }, [{ ref: "husk-1", name: "Ash Husk" }]),
      ...round(1, { enemiesDefeated: 0 }, [{ ref: "husk-1", name: "Ash Husk" }]),
    ];
    expect(digest(events, 1) ?? "").not.toContain("Killed this round");
  });

  it("surfaces the quiet achievements nothing in the prose announces", () => {
    const events = [
      ...round(0, { secretRoutesFound: 0, tollsPaid: 0, goldTransfers: 0 }),
      ...round(1, { secretRoutesFound: 1, tollsPaid: 1, goldTransfers: 4 }),
    ];
    const text = digest(events, 1) ?? "";
    expect(text).toContain("a hidden way was found");
    expect(text).toContain("a toll gate was paid open");
    expect(text).toContain("4 gold changed hands");
  });

  it("says nothing extra about a round where nothing moved", () => {
    const events = [...round(0, { secretRoutesFound: 2 }), ...round(1, { secretRoutesFound: 2 })];
    const text = digest(events, 1) ?? "";
    expect(text).not.toContain("Also this round");
    expect(text).not.toContain("Killed this round");
  });

  it("never reports a counter going backwards", () => {
    // A metric that resets between floors must not read as an achievement.
    const events = [...round(0, { trapsTriggered: 3 }), ...round(1, { trapsTriggered: 1 })];
    expect(digest(events, 1) ?? "").not.toContain("Also this round");
  });
});

describe("the instruction not to invent a reason", () => {
  it("is stated separately from the general instruction not to invent", () => {
    // The blanket "never invent anything you were not told" was already there
    // when a narrator reported a character acting on a scout report that did
    // not exist. Every event in that sentence was real; the causal join was
    // not, and a commentator reaches for cause because cause is what makes a
    // sentence sound like commentary.
    const system = digestSystemPrompt();
    expect(system).toContain("never why they did it");
    expect(system).toMatch(/leave it out rather than supplying a plausible one/);
  });
});

/** The narrator's system prompt, read back out of the module that owns it. */
function digestSystemPrompt(): string {
  // Deliberately read through the public surface rather than exporting the
  // constant: the test should fail if the guidance stops reaching the model,
  // not merely if a string is renamed.
  const source = readNarrateSource();
  const match = source.match(/const SYSTEM =([\s\S]*?);\n/);
  if (!match) throw new Error("narrate.ts no longer declares a SYSTEM prompt");
  return match[1];
}

function readNarrateSource(): string {
  // biome-ignore lint/correctness/noNodejsModules: a test may read its own tree.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "narrate.ts"), "utf8");
}
