/**
 * That a simulation's options bag says what it accepts.
 *
 * The bag is opaque by design — `createSimulation` takes a
 * `Record<string, unknown>` so the runner never has to learn a world's
 * vocabulary. The cost is that an unrecognised key is not an error, it is
 * simply never read.
 *
 * On 2026-08-18 a betrayal run was launched with `--sim-option
 * brief-style=none`. The simulation reads `briefStyle`. The key was stored
 * verbatim in the trace, `parseBriefStyle(undefined)` returned its default, and
 * 26 minutes of GPU measured the `plain` arm while the trace recorded
 * `"brief-style":"none"` as though the control had run. The report tool even
 * printed `unset / unset` and said the run was not comparable; that warning was
 * about the typo, and it was read as being about something else.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulationKnobs, unknownSimOptions } from "../sim/index.js";
import "../sim/index.js";

describe("the knobs a simulation declares", () => {
  it("covers every option key the descent actually reads", () => {
    // The anti-drift check. A declared list that nobody checks is a list that
    // goes stale the first time somebody adds `options.newThing`, and the
    // failure mode is the silent one this whole file is about.
    // Comments stripped first: the note explaining this check lives next to the
    // code it guards and says `options.x`, which the scan would otherwise read
    // as a knob called `x`. A guard that trips over its own explanation is a
    // guard somebody deletes.
    const source = readFileSync(new URL("../sim/descent/index.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const read = [...new Set([...source.matchAll(/\boptions\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]))];
    expect(read.length).toBeGreaterThan(5);
    const declared = simulationKnobs("descent-betrayed");
    expect(read.filter((k) => !declared.includes(k))).toEqual([]);
  });

  it("declares the same vocabulary for both descent variants", () => {
    // `descent` and `descent-betrayed` are the same class behind one option.
    // A word one accepts and the other refuses would be a trap rather than a
    // distinction.
    const plain = simulationKnobs("descent");
    for (const knob of ["traitors", "briefStyle", "partyBrief"]) {
      expect(plain).toContain(knob);
      expect(simulationKnobs("descent-betrayed")).toContain(knob);
    }
  });
});

describe("catching an option the simulation will never read", () => {
  it("names the fix for the exact typo that cost a run", () => {
    expect(unknownSimOptions("descent-betrayed", ["brief-style"])).toEqual([
      { key: "brief-style", suggestion: "briefStyle" },
    ]);
  });

  it("catches the other ways of writing the same mistake", () => {
    for (const spelling of ["brief_style", "briefstyle", "BriefStyle", "Brief-Style"]) {
      expect(unknownSimOptions("descent-betrayed", [spelling])[0]?.suggestion).toBe("briefStyle");
    }
  });

  it("reports a key with no near match without inventing a suggestion", () => {
    const [bad] = unknownSimOptions("descent-betrayed", ["hitPoints"]);
    expect(bad.key).toBe("hitPoints");
    expect(bad.suggestion).toBeUndefined();
  });

  it("passes a real knob, and the universal ones the runner sets", () => {
    expect(unknownSimOptions("descent-betrayed", ["briefStyle", "traitors", "seed", "days"])).toEqual([]);
  });

  it("says nothing about a simulation that declares no knobs", () => {
    // Silence beats a false accusation: a simulation that has not declared its
    // vocabulary cannot be used to prove a key is wrong.
    expect(unknownSimOptions("no-such-simulation", ["anything"])).toEqual([]);
  });
});
