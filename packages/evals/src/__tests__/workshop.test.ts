/**
 * The workshop's rules, and the ones that would fail silently without a test.
 *
 * Three groups here earn their place rather than restating the implementation:
 *
 *   **Containment.** A path rule that is only enforced on one of five entry
 *   points is not a path rule. Every mutating method is exercised, because that
 *   is exactly the shape the bug took the first time.
 *
 *   **Refusal counting.** `patchesRefused` is the most useful number this
 *   simulation produces and it is computed by matching the text of a refusal,
 *   which is the kind of coupling that rots the moment somebody improves a
 *   message. If these break, the counter has stopped counting — not the test.
 *
 *   **`review:` cannot become a score.** The schema forbids `expect` and
 *   `milestones` on a review row precisely because the pressure to add one
 *   arrives later, from somebody reasonable, on a Friday.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArcadeStore } from "@tailored-ai/arcade";
import { initDatabase, LocalRoomBackend, RoomStore } from "@tailored-ai/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateScenario } from "../schema.js";
import { createSimulation, simulationPolicies } from "../sim/index.js";
import { checkWorkspace } from "../sim/workshop/check.js";
import type { WorkshopSimulation } from "../sim/workshop/index.js";
import { framesToShow } from "../sim/workshop/playtest.js";
import { JUDGING } from "../sim/workshop/themes.js";
import { Workspace } from "../sim/workshop/workspace.js";

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "workshop-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/*
 * No test in this file may reach the real arcade.
 *
 * The simulation opens one whenever it is given a `run` context, which is
 * exactly what a test of that behaviour has to pass — and `~/.tai-arcade` is
 * where it lands by default. Seven rows appeared in the live database from a
 * single test doing precisely that, minutes after a *different* leak of
 * forty-eight was fixed by making the arcade opt-in.
 *
 * Twice is a pattern: the per-test `arcadeHome` is the right knob and the wrong
 * guard, because it protects only the tests that remember it. Redirecting the
 * default for the whole file protects the ones nobody has written yet.
 */
const realArcadeHome = process.env.ARCADE_HOME;
beforeAll(() => {
  process.env.ARCADE_HOME = mkdtempSync(join(tmpdir(), "workshop-test-arcade-"));
});
afterAll(() => {
  rmSync(process.env.ARCADE_HOME as string, { recursive: true, force: true });
  if (realArcadeHome === undefined) delete process.env.ARCADE_HOME;
  else process.env.ARCADE_HOME = realArcadeHome;
});

function sim(options: Record<string, unknown> = {}): WorkshopSimulation {
  return createSimulation("workshop", {
    seed: 1,
    days: 4,
    root: temp(),
    stamp: "test",
    ...options,
  }) as WorkshopSimulation;
}

/** Call a tool the way the harness does — by name, with an agent attached. */
async function call(
  s: WorkshopSimulation,
  name: string,
  args: Record<string, unknown>,
  agent: string,
): Promise<string> {
  const tool = [...s.sharedTools(), ...Object.values(s.tools()).flat()].find((t) => t.name === name);
  if (!tool) throw new Error(`no tool "${name}"`);
  const result = await tool.execute(args, { agentName: agent } as Parameters<typeof tool.execute>[1]);
  return String(result.output ?? result.error ?? "");
}

describe("the workspace refuses to leave its own directory", () => {
  const escapes = ["../outside.js", "a/../../outside.js", "/etc/passwd", "..\\\\outside.js", "sub/../../../outside.js"];

  it.each(escapes)("refuses %s on every method that takes a path", (path) => {
    const workspace = new Workspace(temp());
    expect(() => workspace.write(path, "x", "lead", 0)).toThrow();
    expect(() => workspace.read(path)).toThrow();
    expect(() => workspace.patch(path, "a", "b", "lead", 0)).toThrow();
    expect(() => workspace.remove(path, "lead", 0)).toThrow();
    expect(() => workspace.slice(path)).toThrow();
    expect(() => workspace.outline(path)).toThrow();
  });

  it("refuses an extension it does not hold, rather than writing it", () => {
    const workspace = new Workspace(temp());
    expect(() => workspace.write("payload.sh", "#!/bin/sh", "lead", 0)).toThrow(/extension/);
    expect(() => workspace.write("notes", "hello", "lead", 0)).toThrow(/extension/);
  });

  it("keeps its metadata under the same key the listing uses", () => {
    const workspace = new Workspace(temp());
    // A path that only needed trimming used to be stored under the untrimmed
    // key, so the file appeared in the listing with no author at all.
    workspace.write("  design.md  ", "# hi", "lead", 3);
    const found = workspace.list().find((f) => f.path === "design.md");
    expect(found?.lastWriter).toBe("lead");
    expect(found?.lastRound).toBe(3);
  });
});

describe("patching", () => {
  it("refuses a find string that is not there, and counts it", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    const out = await call(
      s,
      "patch_file",
      { path: "engine.js", find: "var a = 2;", replace: "var a = 3;" },
      "builder",
    );
    expect(out).toMatch(/Refused/);
    expect(s.metrics().patchesRefused).toBe(1);
  });

  it("refuses a find string that appears twice, rather than changing one of them", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "x();\ny();\nx();\n" }, "builder");
    const out = await call(s, "patch_file", { path: "engine.js", find: "x();", replace: "z();" }, "builder");
    expect(out).toMatch(/more than once/);
    expect(s.metrics().patchesRefused).toBe(1);
  });

  it("applies a unique patch and reports the line delta", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    const out = await call(
      s,
      "patch_file",
      { path: "engine.js", find: "var a = 1;", replace: "var a = 1;\nvar b = 2;" },
      "builder",
    );
    expect(out).toMatch(/\+1/);
    expect(s.metrics().patches).toBe(1);
    expect(s.metrics().patchesRefused).toBe(0);
  });
});

describe("patching a file you read back with line numbers", () => {
  /**
   * The defect this closes was caused by the tool, not the model.
   *
   * `read_file` numbers its output, so a model copying a multi-line passage has
   * to strip a prefix it never wrote and reproduce the leading whitespace of
   * every continuation line. Measured on the first jam run: single-line patches
   * landed, every multi-line one was refused, and the author gave up after
   * three tries and rewrote a 52-line file whole — exactly the context cost
   * `patch_file` exists to avoid.
   */
  it("matches ignoring indentation when that is unambiguous, and says so", async () => {
    const s = sim();
    await call(
      s,
      "write_file",
      { path: "engine.js", content: "function a() {\n    var x = 1;\n    var y = 2;\n}\n" },
      "builder",
    );
    // The indentation is wrong, as it would be after a numbered read.
    const out = await call(
      s,
      "patch_file",
      { path: "engine.js", find: "var x = 1;\nvar y = 2;", replace: "var x = 3;\nvar y = 4;" },
      "builder",
    );
    expect(out).toMatch(/Patched/);
    expect(out).toMatch(/matched ignoring indentation/);
    const body = await call(s, "read_file", { path: "engine.js" }, "builder");
    expect(body).toMatch(/var x = 3;/);
    expect(s.metrics().patchesRefused).toBe(0);
  });

  it("refuses rather than guessing when the loose match is ambiguous", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "  ping();\nother();\n    ping();\n" }, "builder");
    const out = await call(s, "patch_file", { path: "engine.js", find: "ping();", replace: "pong();" }, "builder");
    // Two candidates: a fuzzy match with two homes is how a patch silently
    // changes the wrong one.
    expect(out).toMatch(/Refused/);
    expect(s.metrics().patchesRefused).toBe(1);
  });

  it("shows the text that is actually there when nothing matches", async () => {
    const s = sim();
    await call(
      s,
      "write_file",
      { path: "engine.js", content: "var TRAIL_COOL_STEPS = 12;\nvar OTHER = 1;\n" },
      "builder",
    );
    const out = await call(
      s,
      "patch_file",
      { path: "engine.js", find: "var TRAIL_COOL_STEPS = 99;", replace: "var TRAIL_COOL_STEPS = 5;" },
      "builder",
    );
    expect(out).toMatch(/Refused/);
    // The correct text to copy is in the message that rejected the wrong one.
    expect(out).toMatch(/closest thing in the file/);
    expect(out).toMatch(/var TRAIL_COOL_STEPS = 12;/);
  });

  it("tells the reader the line numbers are not in the file", async () => {
    const s = sim();
    await call(s, "write_file", { path: "design.md", content: "# one\n# two\n" }, "lead");
    const out = await call(s, "read_file", { path: "design.md" }, "builder");
    expect(out).toMatch(/line numbers are added here and are not in the file/);
  });
});

describe("ownership", () => {
  it("refuses a write to somebody else's file and names who to ask", async () => {
    const s = sim({ direction: "prescribed" });
    const out = await call(s, "write_file", { path: "engine.js", content: "// mine" }, "author");
    expect(out).toMatch(/belongs to the builder/);
    expect(s.metrics().ownershipRefusals).toBe(1);
    expect(s.metrics().writes).toBe(0);
  });

  it("lets anybody read anything", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    const out = await call(s, "read_file", { path: "engine.js" }, "author");
    expect(out).toMatch(/var a = 1;/);
  });

  it("is off when ownership is shared", async () => {
    const s = sim({ ownership: "shared" });
    const out = await call(s, "write_file", { path: "engine.js", content: "// mine" }, "author");
    expect(out).toMatch(/Created/);
    expect(s.metrics().ownershipRefusals).toBe(0);
  });
});

describe("verification is somebody's job", () => {
  it("gives check_syntax to the tester alone by default", () => {
    const s = sim();
    expect(s.tools().tester.map((t) => t.name)).toContain("check_syntax");
    expect(s.sharedTools().map((t) => t.name)).not.toContain("check_syntax");
  });

  it("hands it to everybody when asked", () => {
    const s = sim({ checks: "anyone" });
    expect(s.sharedTools().map((t) => t.name)).toContain("check_syntax");
    expect(s.tools().tester).toHaveLength(0);
  });

  it("never claims a passing check means the thing works", async () => {
    const s = sim();
    await call(
      s,
      "write_file",
      { path: "index.html", content: "<!doctype html>\n<html><body></body></html>\n" },
      "interface",
    );
    const out = await call(s, "check_syntax", {}, "tester");
    // The honest sentence is the point: a clean parse must never read as a
    // working build, and now that `playtest` exists the tool has to point at it
    // rather than claim nothing can be run at all.
    expect(out).toMatch(/says nothing about whether it works/);
    expect(out).toMatch(/playtest/);
  });
});

describe("the syntax check", () => {
  function withFiles(files: Record<string, string>): Workspace {
    const workspace = new Workspace(temp());
    for (const [path, content] of Object.entries(files)) workspace.write(path, content, "test", 0);
    return workspace;
  }

  it("finds a broken script inside a page, with a line number offset into the page", () => {
    const report = checkWorkspace(
      withFiles({ "index.html": "<html>\n<body>\n<script>\nfunction a( {\n</script>\n</body>\n</html>\n" }),
    );
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].path).toBe("index.html");
    expect(report.problems[0].line).toBeGreaterThan(1);
  });

  it("finds a script tag pointing at a file nobody wrote", () => {
    const report = checkWorkspace(
      withFiles({ "index.html": '<html><body><script src="engine.js"></script></body></html>\n' }),
    );
    expect(report.problems.some((p) => /engine\.js.*does not exist/.test(p.message))).toBe(true);
  });

  it("is satisfied once that file exists", () => {
    const report = checkWorkspace(
      withFiles({
        "index.html": '<html><body><script src="engine.js"></script></body></html>\n',
        "engine.js": "var a = 1;\n",
      }),
    );
    expect(report.problems).toHaveLength(0);
  });

  it("finds an unclosed tag", () => {
    const report = checkWorkspace(withFiles({ "index.html": "<html><body><div></body></html>\n" }));
    expect(report.problems.some((p) => /<div> is never closed|closes out of order/.test(p.message))).toBe(true);
  });

  it("does not mistake a less-than in script for markup", () => {
    const report = checkWorkspace(
      withFiles({ "index.html": "<html><body><script>\nif (a < b) { c(); }\n</script></body></html>\n" }),
    );
    expect(report.problems).toHaveLength(0);
  });

  it("objects to anything fetched over the network", () => {
    const report = checkWorkspace(
      withFiles({
        "index.html":
          '<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body></body></html>\n',
      }),
    );
    expect(report.problems.some((p) => /self-contained/.test(p.message))).toBe(true);
  });

  it("finds an unbalanced stylesheet and a broken json file", () => {
    const report = checkWorkspace(withFiles({ "style.css": "body { color: red;\n", "data.json": "{ nope }\n" }));
    expect(report.problems).toHaveLength(2);
  });

  /**
   * The property the whole check depends on: compiling is not running. If this
   * ever fails, `check_syntax` has become an execution engine and the security
   * story in the docs is wrong.
   */
  it("does not execute what it parses", () => {
    const marker = join(temp(), "should-not-exist.txt");
    const workspace = new Workspace(temp());
    workspace.write(
      "engine.js",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "builder",
      0,
    );
    const report = checkWorkspace(workspace);
    expect(report.problems).toHaveLength(0);
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });
});

describe("the run as a whole", () => {
  it("produces an artifact, a brief and a manifest, and never a score", () => {
    const root = temp();
    const s = sim({ root, days: 6 });
    const policy = simulationPolicies("workshop").scripted();
    let guard = 0;
    while (!s.done && guard++ < 50) {
      policy.act(s);
      s.advance();
    }

    expect(s.objective()).toBe(0);
    expect(s.endedBecause).toMatch(/rounds ran out/);
    expect(readFileSync(join(root, "brief.md"), "utf8")).toMatch(/## Constraints/);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.entry).toBe("index.html");
    expect(manifest.snapshots.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, "workspace", "index.html"), "utf8")).toMatch(/<canvas/);
  });

  it("keeps the headline numbers flat so the generic viewer can draw them", () => {
    const s = sim();
    const snapshot = s.snapshot();
    const scalars = Object.entries(snapshot).filter(([, v]) => typeof v !== "object");
    // The developer viewer's fallback board filters to non-objects. Nesting
    // everything would hand it an empty panel.
    expect(scalars.map(([k]) => k)).toEqual(
      expect.arrayContaining(["round", "rounds", "filesPresent", "linesInWorkspace", "entryExists"]),
    );
  });

  /**
   * Measured live on 2026-08-20, and invisible until the report was read.
   *
   * `runRoomScenario` advances the clock *between* rounds, so an N-round run
   * crosses N-1 boundaries. A simulation whose only ending is its horizon never
   * arrives: a three-round smoke that announced rounds 0, 1 and 2 and took all
   * 33 of its turns reported `roundsPlayed 2` and wrote an `end` event carrying
   * no reason at all. The descent hides this because its runs usually end in a
   * wipe, which sets `done` from inside.
   */
  it("counts the last round, which never gets a boundary tick", () => {
    const s = sim({ days: 3 });
    // Two boundaries is what a three-round roster produces.
    s.advance();
    s.advance();
    expect(s.done).toBe(false);
    expect(s.endedBecause).toBeUndefined();

    s.finish();
    expect(s.metrics().roundsPlayed).toBe(3);
    expect(s.done).toBe(true);
    expect(s.endedBecause).toMatch(/3 rounds ran out/);
  });

  it("does not double-count when the horizon was reached by advancing", () => {
    const s = sim({ days: 2 });
    s.advance();
    s.advance();
    expect(s.done).toBe(true);
    s.finish();
    s.finish();
    expect(s.metrics().roundsPlayed).toBe(2);
  });

  it("stops announcing rounds once there are none left", () => {
    const s = sim({ days: 1 });
    s.advance();
    expect(s.done).toBe(true);
    expect(s.announce()).toMatch(/rounds are over/);
    expect(s.announce()).not.toMatch(/Round 2 of 1/);
  });

  it("does not freeze a round in which nothing changed", async () => {
    // Two rounds, one write. The second boundary and the final freeze both see
    // an identical workspace, so only round zero should exist on disk — a solo
    // arm runs 220 rounds of one turn and would otherwise write 220 frames of
    // which most are the previous frame.
    const s = sim({ days: 2 });
    await call(s, "write_file", { path: "design.md", content: "# one\n" }, "lead");
    s.advance();
    s.advance();
    expect(s.done).toBe(true);
    const manifest = JSON.parse(readFileSync(join(s.root, "manifest.json"), "utf8"));
    expect(manifest.snapshots).toEqual([0]);
  });

  it("puts the brief in the durable place rather than only in a tool result", () => {
    const s = sim({ direction: "prescribed" });
    const brief = s.briefFor("builder");
    expect(brief).toMatch(/## Your part/);
    expect(brief).toMatch(/engine\.js/);
    // The lead owns no code, and its brief has to say so rather than leaving it
    // to be inferred from an empty list.
    expect(s.briefFor("lead")).toMatch(/design\.md/);
  });

  it("refuses a file bigger than a prompt can hold", async () => {
    const s = sim();
    const out = await call(s, "write_file", { path: "engine.js", content: "x".repeat(60_000) }, "builder");
    expect(out).toMatch(/Refused/);
    expect(s.metrics().budgetRefusals).toBe(1);
  });
});

describe("the jam: a theme, a clock, and categories a person scores", () => {
  it("draws a theme from the seed, so a run can be repeated", () => {
    const a = sim({ seed: 3 });
    const b = sim({ seed: 3 });
    const c = sim({ seed: 4 });
    expect(a.theme.id).toBe(b.theme.id);
    expect(a.theme.id).not.toBe(c.theme.id);
  });

  it("takes an explicit theme by id or by free text", () => {
    expect(sim({ theme: "only-one" }).theme.title).toBe("ONLY ONE");
    // A jam organiser gets to invent one.
    expect(sim({ theme: "boiling point" }).theme.title).toBe("BOILING POINT");
  });

  it("tells the team the theme constrains mechanics, and names no mechanic at all", () => {
    const s = sim({ theme: "only-one" });
    const brief = s.briefFor("builder") ?? "";
    expect(brief).toMatch(/GAME JAM/);
    expect(brief).toMatch(/ONLY ONE/);
    // The brief renders each category's *aim*, not the judge's question —
    // the question is what the judge answers, the aim is what a builder
    // reaches for, and quoting the former at a builder is what produced a
    // shelf of sixty-second games.
    expect(brief).toMatch(/\*\*Theme\.\*\*/);
    expect(brief).toMatch(/Decide early what your reading of the theme is/);
    expect(brief).not.toMatch(/for a minute/);
    /*
     * This assertion used to be its own opposite.
     *
     * Each theme carried a `shallow` line naming its laziest reading, and the
     * brief printed it as the thing that scores worst. On YOU ARE THE HAZARD
     * that line was "an enemy that copies your movement"; the team shipped a
     * game pitched as "every death leaves a ghost that replays your path". It
     * was the only concrete mechanic in the entire brief, so it was the one
     * that got built.
     */
    expect(brief).not.toMatch(/one life, and nothing else about the game changed/);
    expect(brief).not.toMatch(/laziest possible reading/);
  });

  it("states the form constraint as a rule, and repeats it every round", () => {
    // Seeded, and coprime with the theme list so the pair does not lock.
    const s = sim({ theme: "only-one", diversifier: "stillness" });
    const brief = s.briefFor("builder") ?? "";
    expect(brief).toMatch(/## The diversifier/);
    expect(brief).toMatch(/The player never moves through space/);
    // A brief is the first thing a long room history trims away, so the
    // constraint also rides on the announcement — the fix that finally made
    // the engine choice visible.
    expect(s.announce()).toMatch(/The player never moves through space/);
    expect(s.snapshot().diversifier).toBe("stillness");
  });

  it("can be run without one, so a control arm is possible", () => {
    const s = sim({ theme: "only-one", diversifier: "none" });
    expect(s.diversifier).toBeUndefined();
    expect(s.briefFor("builder") ?? "").not.toMatch(/## The diversifier/);
    expect(s.announce()).not.toMatch(/diversifier/);
  });

  it("puts the diversifier on the scorecard as the first question", () => {
    const s = sim({ theme: "only-one", diversifier: "one-key" });
    const card = readFileSync(join(s.root, "JUDGING.md"), "utf8");
    expect(card).toMatch(/One key is the entire control scheme/);
    expect(card).toMatch(/Did they honour it\?/);
  });

  it("tells the team what is already on the shelf it is judged against", () => {
    // Originality was scored against fifteen near-identical entries the team
    // could browse and had no reason to.
    const brief = sim({ theme: "only-one" }).briefFor("builder") ?? "";
    expect(brief).toMatch(/What is already on the arcade/);
    // The collapse is described concretely, because "be original" has now
    // failed fifteen times and naming what happened is the only new information.
    expect(brief).toMatch(/same game fifteen times/);
    expect(brief).toMatch(/scores a one/);
  });

  it("writes the scorecard at the start, so an interrupted run still has one", () => {
    const s = sim({ theme: "it-grows", days: 8 });
    const card = readFileSync(join(s.root, "JUDGING.md"), "utf8");
    expect(card).toMatch(/IT GROWS/);
    // Read from the arcade rather than listed here, because the whole point of
    // moving them there was that the brief, this form and the site's review
    // form can no longer disagree about what the questions are.
    for (const category of JUDGING) {
      expect(card).toContain(category.name);
      expect(card).toContain(category.question);
    }
    expect(card).toContain("**Theme**");
    // The judge's copy keeps the question and the anchors, and never shows
    // the agent-facing aim.
    expect(card).toContain("Does the theme shape the mechanics you played");
    expect(card).not.toContain("Decide early what your reading");
  });

  it("runs a jam clock with phases rather than a bare round counter", () => {
    const s = sim({ days: 10, direction: "prescribed" });
    expect(s.announce()).toMatch(/CONCEPT/);
    for (let i = 0; i < 4; i++) s.advance();
    expect(s.announce()).toMatch(/BUILD/);
    for (let i = 0; i < 4; i++) s.advance();
    expect(s.announce()).toMatch(/POLISH|SUBMIT/);
    s.advance();
    expect(s.announce()).toMatch(/SUBMIT/);
  });

  it("says nobody has run the game until somebody has", () => {
    const s = sim();
    expect(s.announce()).toMatch(/nobody has run it yet/);
  });

  it("gives every brief a submission file for the judge to read first", () => {
    for (const id of ["arcade", "tool", "site"]) {
      const s = sim({ brief: id, direction: "prescribed" });
      expect(s.workspace.ownerOf("submission.md"), `${id} has no submission.md`).toBe("lead");
    }
  });
});

describe("the open arm: a brief that says what, not how", () => {
  it("hands over no layout at all", () => {
    const open = sim();
    // Twelve prescribed runs produced the same eight files. Nothing is planned
    // here, so `list_files` starts empty of anything the team did not make.
    expect(open.workspace.list().filter((f) => !f.provided)).toHaveLength(0);
    expect(open.workspace.ownerOf("engine.js")).toBeUndefined();

    const prescribed = sim({ direction: "prescribed" });
    expect(prescribed.workspace.ownerOf("engine.js")).toBe("builder");
  });

  it("describes the goal without naming the files", () => {
    const brief = sim().briefFor("builder") as string;
    expect(brief).toMatch(/claim_file/);
    expect(brief).not.toMatch(/render\.js/);
    // The medium survives; the decisions about the game do not.
    // The medium rule used to open "One <canvas>" and list the Canvas2D API's
    // own nouns, which read as "no 3D" — and 3D is the only reason Babylon is
    // offered. It now names what has to be generated, not what draws it.
    expect(brief).toMatch(/Everything on screen is generated by your code/);
    expect(brief).toMatch(/2D and 3D are both fine/);
    expect(brief).not.toMatch(/at most one action key/);
  });

  it("gives a file to whoever claims it first and refuses the second", async () => {
    const s = sim();
    const first = await call(s, "claim_file", { path: "engine.js", purpose: "the loop" }, "builder");
    expect(first).toMatch(/is yours/);

    const second = await call(s, "claim_file", { path: "engine.js", purpose: "mine now" }, "author");
    expect(second).toMatch(/already the builder's/);
    expect(s.workspace.ownerOf("engine.js")).toBe("builder");

    // And the claim is what the write rule reads.
    const blocked = await call(s, "write_file", { path: "engine.js", content: "// mine" }, "author");
    expect(blocked).toMatch(/belongs to the builder/);
    expect(s.metrics().writes).toBe(0);
  });

  it("lets a claimant restate what a file is for", async () => {
    const s = sim();
    await call(s, "claim_file", { path: "engine.js", purpose: "the loop" }, "builder");
    const again = await call(s, "claim_file", { path: "engine.js", purpose: "loop and collision" }, "builder");
    expect(again).toMatch(/already yours/);
    expect(s.metrics().ownershipRefusals).toBe(0);
  });

  it("claims a file for whoever writes it first, so nobody has to claim before starting", async () => {
    const s = sim();
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    expect(s.workspace.ownerOf("engine.js")).toBe("builder");

    const blocked = await call(s, "write_file", { path: "engine.js", content: "// mine" }, "author");
    expect(blocked).toMatch(/belongs to the builder/);
  });

  it("refuses a claim on the library, which belongs to nobody", async () => {
    const s = sim();
    const out = await call(s, "claim_file", { path: "lib/loop.js", purpose: "mine" }, "builder");
    expect(out).toMatch(/read-only for the whole team/);
  });

  it("shows a clock instead of telling the team when to stop building", () => {
    const open = sim({ days: 10 });
    for (let i = 0; i < 8; i++) open.advance();
    // Two rounds from the end the prescribed arm is saying "freeze the code".
    // The open arm still says "submit" — that is the opposite instruction, and
    // the thing being asserted is the absence of a stop, not of the word.
    expect(open.announce()).not.toMatch(/POLISH|no new features|freeze the code|rather than starting anything/i);

    const prescribed = sim({ days: 10, direction: "prescribed" });
    for (let i = 0; i < 8; i++) prescribed.advance();
    expect(prescribed.announce()).toMatch(/POLISH|SUBMIT/);
  });

  it("has no planned-files metric to report", () => {
    expect(sim().metrics().plannedFilesMade).toBe(0);
  });

  /*
   * The deadlock of 2026-08-23, which cost a whole run.
   *
   * A builder claimed `game.js` and wrote nothing for five rounds. The tester
   * escalated, the lead set a deadline and authorised a handoff, the author
   * volunteered — and the workspace refused eleven times, because a claim was a
   * freehold with no way out. Seven rounds in, the jam had one file.
   */
  it("frees a claim on a file nobody ever wrote, and says so where the team reads it", async () => {
    const s = sim();
    await call(s, "claim_file", { path: "game.js", purpose: "the loop" }, "builder");
    expect(s.workspace.ownerOf("game.js")).toBe("builder");

    // The builder goes quiet. Nobody else can touch it while the claim is warm.
    s.advance();
    const early = await call(s, "write_file", { path: "game.js", content: "// mine" }, "author");
    expect(early).toMatch(/belongs to the builder/);

    s.advance();
    expect(s.workspace.ownerOf("game.js")).toBeUndefined();
    // Said out loud, or the team goes on believing it is spoken for.
    expect(s.announce()).toMatch(/FREE TO CLAIM: game\.js/);
    expect(s.metrics().claimsLapsed).toBe(1);

    const out = await call(s, "write_file", { path: "game.js", content: "// mine now\n" }, "author");
    expect(out).not.toMatch(/Refused/);
  });

  it("does not let re-claiming refresh the lease", async () => {
    // Seed 27: a builder claimed `game.js` four times over eighteen rounds and
    // never wrote it. Each claim reset the clock, so the lapse never fired and
    // the file was locked for the whole jam.
    const s = sim();
    await call(s, "claim_file", { path: "game.js", purpose: "the loop" }, "builder");
    s.advance();
    await call(s, "claim_file", { path: "game.js", purpose: "still mine" }, "builder");
    s.advance();
    expect(s.workspace.ownerOf("game.js")).toBeUndefined();
    expect(s.metrics().claimsLapsed).toBe(1);
  });

  it("leaves a claim alone once the file exists", async () => {
    const s = sim();
    await call(s, "claim_file", { path: "engine.js", purpose: "the loop" }, "builder");
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    for (let i = 0; i < 4; i++) s.advance();
    // Claiming reserves a name; writing makes it yours, for as long as you want.
    expect(s.workspace.ownerOf("engine.js")).toBe("builder");
    expect(s.metrics().claimsLapsed).toBe(0);
  });

  it("lets an owner hand a file back, and the lead take one off somebody", async () => {
    const s = sim();
    await call(s, "claim_file", { path: "engine.js", purpose: "the loop" }, "builder");
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");

    // Not yours and you are not the lead.
    const refused = await call(s, "release_file", { path: "engine.js" }, "author");
    expect(refused).toMatch(/only they or the lead/);

    // The lead can, which is exactly what the deadlocked team tried to do.
    const byLead = await call(s, "release_file", { path: "engine.js" }, "lead");
    expect(byLead).toMatch(/released from the builder/);
    expect(s.workspace.ownerOf("engine.js")).toBeUndefined();

    // Releasing frees the name and keeps the work.
    expect(s.workspace.read("engine.js")).toMatch(/var a = 1;/);
    const taken = await call(s, "write_file", { path: "engine.js", content: "var b = 2;\n" }, "author");
    expect(taken).not.toMatch(/Refused/);
    expect(s.metrics().releases).toBe(1);
  });

  it("refuses to release a file nobody claimed", async () => {
    const s = sim();
    const out = await call(s, "release_file", { path: "nothing.js" }, "lead");
    expect(out).toMatch(/not claimed by anybody/);
  });

  it("never lapses the prescribed arm's assignments", async () => {
    const s = sim({ direction: "prescribed" });
    expect(s.workspace.ownerOf("engine.js")).toBe("builder");
    for (let i = 0; i < 5; i++) s.advance();
    // Those are assignments from the brief, not reservations somebody made.
    expect(s.workspace.ownerOf("engine.js")).toBe("builder");
    expect(s.metrics().claimsLapsed).toBe(0);
  });
});

describe("a real game engine, when the team asks for one", () => {
  it("installs nothing until somebody chooses", () => {
    const s = sim();
    expect(s.workspace.list().some((f) => f.path.includes("phaser"))).toBe(false);
    expect(s.metrics().engineChosen).toBe(0);
    // But the brief has to say the choice exists, or nobody makes it.
    expect(s.briefFor("builder") ?? "").toMatch(/use_engine/);
  });

  it("installs on request, read-only and off the file budget", async () => {
    const s = sim();
    const out = await call(s, "use_engine", { name: "phaser" }, "builder");
    expect(out).toMatch(/Phaser 4 is installed/);
    expect(out).toMatch(/generateTexture/);
    expect(s.metrics().engineChosen).toBe(1);

    const file = s.workspace.list().find((f) => f.path === "lib/phaser.js");
    expect(file?.provided).toBe(true);
    // The library is scenery, not output — or every count of what the team
    // produced becomes incomparable with every run before engines existed.
    expect(
      s.workspace
        .list()
        .filter((f) => !f.provided)
        .some((f) => f.path.includes("phaser")),
    ).toBe(false);
    // The skeleton *is* in the workspace, because the team edits it, so its
    // lines are reported separately rather than hidden or double-counted.
    expect(s.metrics().scaffoldLines).toBeGreaterThan(20);
    expect(s.metrics().linesInWorkspace).toBe(s.metrics().scaffoldLines);

    const edit = await call(s, "write_file", { path: "lib/phaser.js", content: "// mine" }, "builder");
    expect(edit).toMatch(/came with the workspace/);
  });

  it("refuses a second engine rather than shipping a broken game", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    const again = await call(s, "use_engine", { name: "phaser" }, "interface");
    expect(again).toMatch(/already installed/);
    const unknown = await call(s, "use_engine", { name: "unreal" }, "builder");
    expect(unknown).toMatch(/no engine called/);
  });

  it("answers an API question with a real signature", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    const out = await call(s, "docs", { query: "arcade physics set velocity" }, "builder");
    expect(out).toMatch(/setVelocity/);
    // The signature and its parameters are the half the model half-remembers.
    expect(out).toMatch(/@param/);
    expect(s.metrics().docLookups).toBe(1);
  });

  it("says what to do when nothing matches, rather than nothing", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    expect(await call(s, "docs", { query: "zzzzqqqq" }, "builder")).toMatch(/Nothing in the API matches/);
  });

  it("does not document what the brief forbids", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    // Audio and image loading are banned, and Matter is not in the build we
    // vendor. Documenting any of them produces confident code that cannot run.
    for (const banned of ["play a sound effect", "load a spritesheet image", "matter physics body"]) {
      const out = await call(s, "docs", { query: banned }, "builder");
      expect(out, banned).not.toMatch(/Phaser\.Sound|Loader\.|MatterJS/);
    }
  });

  /*
   * The scaffold has to *run*, or it is worse than nothing.
   *
   * The whole point is that `playtest` says something useful from round one and
   * the checkpoint has a working build to save. A skeleton that renders a black
   * rectangle would poison both, and would be handed to every team that asks for
   * an engine.
   */
  it("writes a Phaser skeleton that plays straight away", async () => {
    const s = sim();
    const out = await call(s, "use_engine", { name: "phaser" }, "builder");
    expect(out).toMatch(/running skeleton/);
    expect(s.workspace.exists("index.html")).toBe(true);
    expect(s.workspace.exists("game.js")).toBe(true);

    const report = await call(s, "playtest", {}, "tester");
    expect(report).toMatch(/no console errors/i);
    expect(report).toMatch(/screen changed after keys/);
  }, 60_000);

  it("writes a Babylon skeleton that plays straight away", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "babylon" }, "builder");
    const report = await call(s, "playtest", {}, "tester");
    expect(report).toMatch(/no console errors/i);
    expect(report).toMatch(/It animates on its own/);
  }, 90_000);

  it("leaves the skeleton unclaimed, and out of the team's own numbers", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");

    // Nobody owns it, so the team still has to divide the work.
    expect(s.workspace.ownerOf("game.js")).toBeUndefined();
    expect(s.workspace.ownerOf("index.html")).toBeUndefined();
    // And nobody is credited with having written it.
    expect(s.metrics().distinctWriters).toBe(0);
    expect(s.metrics().scaffoldLines).toBeGreaterThan(20);

    // The first writer takes it, exactly as with any other unclaimed file.
    await call(
      s,
      "patch_file",
      { path: "game.js", find: "const speed = 900;", replace: "const speed = 600;" },
      "builder",
    );
    expect(s.workspace.ownerOf("game.js")).toBe("builder");
    expect(s.metrics().distinctWriters).toBe(1);
  }, 30_000);

  it("never overwrites work the team already did", async () => {
    const s = sim();
    await call(s, "write_file", { path: "game.js", content: "// six rounds of work\n" }, "builder");
    const out = await call(s, "use_engine", { name: "phaser" }, "builder");
    expect(out).toMatch(/Left alone because you already made/);
    expect(s.workspace.read("game.js")).toMatch(/six rounds of work/);
    // The file they had not made is still written for them.
    expect(s.workspace.exists("index.html")).toBe(true);
  }, 30_000);

  it("answers docs before an engine is chosen, because that is when it is needed", async () => {
    /*
     * This used to assert a refusal, and the refusal was the bug.
     *
     * It put the information needed to evaluate the choice behind making the
     * choice, while the library's whole API sat in the brief for free. Six
     * consecutive teams picked the option they could inspect, and said so:
     * "engine API risk", "a framework would fight me for it", "Phaser 4 text
     * layout is fiddly". None of them was able to check.
     */
    const s = sim();
    const out = await call(s, "docs", { query: "sprite" }, "builder");
    expect(out).toMatch(/not installed/);
    expect(out).toMatch(/use_engine phaser/);
    // Counted apart from post-install lookups: `docLookups` is downstream of
    // `engineChosen` by construction, so the two were one fact counted twice.
    expect(s.metrics().docLookupsBeforeChoosing).toBe(1);
    expect(s.metrics().docLookups).toBe(0);
  });

  it("searches the engine you name, and says what else is there", async () => {
    const out = await call(sim(), "docs", { query: "mesh", engine: "babylon" }, "builder");
    expect(out).toMatch(/Babylon/);
    expect(out).toMatch(/Pass `engine` to search phaser instead\./);
  });

  it("still refuses an engine that is not on offer", async () => {
    expect(await call(sim(), "docs", { query: "x", engine: "unity" }, "builder")).toMatch(/no engine called/);
  });

  /**
   * The whole loop, through the real tools: install, build, run.
   *
   * Every piece is covered above in isolation, and none of it would catch the
   * engine being vendored in a form the browser cannot load — the failure that
   * actually threatens this, since modern libraries ship ESM by default and a
   * classic `<script>` tag cannot load one. three.js is exactly that case.
   */
  it("builds and runs a real Phaser game end to end", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    await call(
      s,
      "write_file",
      {
        path: "index.html",
        content:
          '<!doctype html><html><body style="margin:0;background:#0d0f13"><script src="lib/phaser.js"></script><script src="game.js"></script></body></html>',
      },
      "interface",
    );
    await call(
      s,
      "write_file",
      {
        path: "game.js",
        content:
          "new Phaser.Game({\n  type: Phaser.AUTO, width: 960, height: 720, backgroundColor: '#0d0f13',\n  physics: { default: 'arcade', arcade: { gravity: { y: 400 } } },\n  scene: {\n    create() {\n      const g = this.add.graphics();\n      g.fillStyle(0x6ee7b7, 1); g.fillCircle(24, 24, 24);\n      g.generateTexture('orb', 48, 48); g.destroy();\n      this.orb = this.physics.add.image(480, 80, 'orb').setBounce(0.85).setCollideWorldBounds(true);\n      this.add.text(24, 24, 'ENGINE TEST', { fontFamily: 'monospace', fontSize: '28px', color: '#e6e9ef' });\n      this.keys = this.input.keyboard.createCursorKeys();\n    },\n    update() {\n      this.orb.setVelocityX(this.keys.left.isDown ? -300 : this.keys.right.isDown ? 300 : 0);\n    },\n  },\n});\n",
      },
      "builder",
    );

    expect(await call(s, "check_syntax", {}, "tester")).toMatch(/0 problems/);

    const report = await call(s, "playtest", {}, "tester");
    expect(report).toMatch(/no console errors/i);
    expect(report).toMatch(/It animates on its own/);
    expect(report).toMatch(/screen changed after keys/);
    // The canvas is WebGL, and reading it at all is the thing that was broken:
    // before `preserveDrawingBuffer` was forced, every frame sampled empty and
    // a working Phaser game reported as a dead one.
    expect(report).toMatch(/Canvas 960x720/);
  }, 60_000);
});

describe("a 3D engine, and the API it is honest about", () => {
  it("offers both engines and installs the one asked for", async () => {
    const s = sim();
    // The brief lists the choice; picking is the team's.
    const brief = s.briefFor("builder") ?? "";
    expect(brief).toMatch(/phaser/);
    expect(brief).toMatch(/babylon/);

    const out = await call(s, "use_engine", { name: "babylon" }, "builder");
    expect(out).toMatch(/Babylon\.js 8 is installed/);
    expect(s.workspace.list().find((f) => f.path === "lib/babylon.js")?.provided).toBe(true);
    expect(s.workspace.list().some((f) => f.path === "lib/phaser.js")).toBe(false);
  });

  it("refuses to mix two engines in one game", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "babylon" }, "builder");
    expect(await call(s, "use_engine", { name: "phaser" }, "builder")).toMatch(/already using Babylon/);
  });

  it("warns about the physics that is not there, rather than leaving it to be discovered", async () => {
    const s = sim();
    const out = await call(s, "use_engine", { name: "babylon" }, "builder");
    // A model that knows Babylon knows PhysicsImpostor. It is not in this build,
    // and silence would produce confident code that throws at runtime.
    expect(out).toMatch(/no physics plugin/i);
    expect(out).toMatch(/moveWithCollisions/);
  });

  it("looks up 3D API and keeps the missing physics out of the answers", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "babylon" }, "builder");
    expect(await call(s, "docs", { query: "create a box mesh" }, "builder")).toMatch(/CreateBox/);
    expect(await call(s, "docs", { query: "does one mesh intersect another" }, "builder")).toMatch(/intersectsMesh/);

    const physics = await call(s, "docs", { query: "physics impostor gravity" }, "builder");
    expect(physics).not.toMatch(/Impostor|Havok|PhysicsAggregate/);
    // No texture files exist, so the index must not suggest them.
    expect(await call(s, "docs", { query: "diffuse texture image" }, "builder")).not.toMatch(/diffuseTexture/);
  });

  it("builds and runs a real 3D game end to end", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "babylon" }, "builder");
    await call(
      s,
      "write_file",
      {
        path: "index.html",
        content:
          '<!doctype html><html><body style="margin:0"><canvas id="game" style="width:100vw;height:100vh"></canvas><script src="lib/babylon.js"></script><script src="game.js"></script></body></html>',
      },
      "interface",
    );
    await call(
      s,
      "write_file",
      {
        path: "game.js",
        content:
          "const canvas = document.getElementById('game');\nconst engine = new BABYLON.Engine(canvas, true);\nconst scene = new BABYLON.Scene(engine);\nscene.clearColor = new BABYLON.Color4(0.05, 0.06, 0.08, 1);\nnew BABYLON.ArcRotateCamera('cam', Math.PI / 4, Math.PI / 3, 14, BABYLON.Vector3.Zero(), scene);\nnew BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);\nconst player = BABYLON.MeshBuilder.CreateBox('player', { size: 2 }, scene);\nconst mat = new BABYLON.StandardMaterial('m', scene);\nmat.diffuseColor = new BABYLON.Color3(0.4, 0.9, 0.6);\nplayer.material = mat;\nconst ground = BABYLON.MeshBuilder.CreateGround('g', { width: 40, height: 40 }, scene);\nground.position.y = -1.5;\nconst held = {};\naddEventListener('keydown', (e) => { held[e.code] = true; });\naddEventListener('keyup', (e) => { held[e.code] = false; });\nengine.runRenderLoop(() => {\n  const dt = engine.getDeltaTime() / 1000;\n  player.rotation.y += dt;\n  if (held.ArrowLeft) player.position.x -= 10 * dt;\n  if (held.ArrowRight) player.position.x += 10 * dt;\n  scene.render();\n});\n",
      },
      "builder",
    );

    expect(await call(s, "check_syntax", {}, "tester")).toMatch(/0 problems/);

    // The whole point of the flag work: WebGL initialises, the frame is
    // readable after compositing, and a rotating lit mesh reads as motion.
    const report = await call(s, "playtest", {}, "tester");
    expect(report).toMatch(/no console errors/i);
    expect(report).toMatch(/It animates on its own/);
  }, 90_000);
});

describe("choosing an engine, and being told what it is worth", () => {
  it("asks every round until the team answers, and then stops", async () => {
    const s = sim();
    expect(s.announce()).toMatch(/No engine chosen yet/);
    expect(s.briefFor("lead") ?? "").toMatch(/First decision: which foundation/);
    // The point of the choice, stated where they read it.
    expect(s.briefFor("lead") ?? "").toMatch(/judged on the game, not on how it was built/);

    await call(s, "use_engine", { name: "phaser" }, "builder");
    expect(s.announce()).not.toMatch(/No engine chosen yet/);
  }, 30_000);

  it("treats writing your own as a decision, not an absence", async () => {
    const s = sim();
    const out = await call(s, "use_engine", { name: "none" }, "lead");
    // It installs the library rather than meaning "keep what you already had",
    // and names what the library does not have, since that is the whole of the
    // decision being taken.
    expect(out).toMatch(/Installed the small library/);
    expect(out).toMatch(/no sprites, no scenes, no tweens/);

    // `engineChosen: 0` cannot tell "decided against" from "never noticed".
    expect(s.metrics().engineChosen).toBe(0);
    expect(s.metrics().engineDeclined).toBe(1);
    expect(s.announce()).not.toMatch(/No engine chosen yet/);
    // No *engine* was installed — but the library was, which is the change.
    expect(s.workspace.list().some((f) => f.path.includes("phaser"))).toBe(false);
    expect(s.workspace.list().some((f) => f.path === "lib/loop.js")).toBe(true);
  });

  it("says there is no final version, because they keep declaring one", () => {
    // Seed 28 announced "1.0.0 (final)" at round 3 of 20 and the phase ladder
    // had already been removed — the instinct outlived the instruction.
    const brief = sim().briefFor("builder") ?? "";
    expect(brief).toMatch(/There is no final version/);
    expect(brief).toMatch(/the clock decides when the jam ends/);
  });
});

describe("deciding how often to be interrupted", () => {
  /** The sim with a room store attached, as the harness does. */
  function withRooms(): { sim: WorkshopSimulation; calls: { agent: string; roomRef: string; wakeOn?: string }[] } {
    const s = sim();
    const calls: { agent: string; roomRef: string; wakeOn?: string }[] = [];
    s.attachRooms?.(
      { subscribe: (input) => calls.push(input as (typeof calls)[number]) },
      new Map([
        ["studio", "room:studio"],
        ["build", "room:build"],
      ]),
    );
    return { sim: s, calls };
  }

  it("lets an agent ask to be woken only when it is named", async () => {
    const { sim: s, calls } = withRooms();
    const out = await call(s, "attention", { room: "build", level: "mentions" }, "author");
    expect(out).toMatch(/only be woken/);
    expect(calls).toEqual([{ agent: "author", roomRef: "room:build", wakeOn: "addressed" }]);
    expect(s.metrics().attentionChanges).toBe(1);
  });

  it("turns it back up again", async () => {
    const { sim: s, calls } = withRooms();
    await call(s, "attention", { room: "studio", level: "everything" }, "tester");
    expect(calls[0].wakeOn).toBe("all");
  });

  /*
   * The safety property, and the reason `none` is not offered.
   *
   * The store supports `wakeOn: "none"` — a read-only seat. An agent that set it
   * on every room would be gone for the rest of the jam with no way back, and a
   * team whose builder has silently left is the failure this scenario keeps
   * rediscovering. `addressed` is the quiet setting and always has a way back.
   */
  it("will not let an agent make itself unreachable", async () => {
    const { sim: s, calls } = withRooms();
    expect(await call(s, "attention", { room: "studio", level: "none" }, "builder")).toMatch(
      /everything.*or.*mentions|mentions/,
    );
    expect(await call(s, "attention", { room: "studio", level: "silent" }, "builder")).toMatch(/Refused|must be/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a room that is not this jam's", async () => {
    const { sim: s } = withRooms();
    expect(await call(s, "attention", { room: "lobby", level: "mentions" }, "lead")).toMatch(/no room called/);
  });

  it("is absent when nothing attached a room store", async () => {
    // `bench` and `rehearse` run without a runtime, and a tool that would throw
    // on use is worse than one that is not there.
    expect(
      sim()
        .sharedTools()
        .map((t) => t.name),
    ).not.toContain("attention");
  });
});

describe("picking a jam up in a home that already has its rooms", () => {
  /*
   * The harness half of resume, which the block below calls "covered by the run
   * itself" — and which was not covered at all.
   *
   * `runRoomScenario` creates the scenario's rooms on the way in. That is
   * correct exactly once. On a resume the session home already holds them, and
   * `createRoom` refuses a duplicate name rather than handing back the room
   * that is already there, so every resume died one second in with
   *
   *   Room name "studio" is already used by local:studio.
   *
   * The loop then reported the run "done", moved on to the next seed, and left
   * an afternoon of conversation in a directory nothing would ever open again.
   * A resume that fails on first use is worse than no resume: the checkpoint is
   * written either way, so the failure looks exactly like success.
   */
  it("reuses a room that is already there instead of refusing it", async () => {
    const home = mkdtempSync(join(tmpdir(), "resume-rooms-"));
    const db = initDatabase(join(home, "agent.db"));
    const store = new RoomStore(db);
    const backend = new LocalRoomBackend(db, store);

    const first = await backend.createRoom({ name: "studio", purpose: "the jam" });
    expect(first.ref.id).toBeTruthy();

    // What a second run against the same home does, which is what a resume is.
    // The lookup the harness now performs finds it...
    expect(store.getRoomByName("studio")?.ref.id).toBe(first.ref.id);
    // ...and the call it used to make unconditionally still throws, which is
    // why the lookup has to come first rather than being a fallback.
    await expect(backend.createRoom({ name: "studio", purpose: "the jam" })).rejects.toThrow(/already used/);

    db.close();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("stopping a jam and picking it up later", () => {
  /*
   * The simulation half of resume.
   *
   * The harness half — keeping the agent home so the conversation survives — is
   * covered by the run itself; what is tested here is that the jam's own
   * bookkeeping round-trips, because that is the part that silently produces a
   * *plausible* wrong answer. A resumed run that forgets its claims hands every
   * file to whoever writes next; one that forgets its writers reports a team of
   * one; one that forgets its clock replays rounds it already played.
   */
  it("comes back on the same round with the same counters", async () => {
    const before = sim({ days: 20 });
    await call(before, "write_file", { path: "game.js", content: "var a = 1;\n" }, "builder");
    await call(before, "claim_file", { path: "render.js", purpose: "drawing" }, "interface");
    // Written, so the claim is permanent — an unwritten one would lapse over
    // the two rounds below, and this test is about the restore, not the lapse.
    await call(before, "write_file", { path: "render.js", content: "// draw\n" }, "interface");
    before.advance();
    before.advance();

    const saved = JSON.parse(JSON.stringify(before.checkpoint()));

    const after = sim({ days: 20, root: before.root });
    after.restore(saved);

    expect(after.metrics().roundsPlayed).toBe(before.metrics().roundsPlayed);
    expect(after.metrics().writes).toBe(before.metrics().writes);
    expect(after.metrics().claims).toBe(before.metrics().claims);
    // Ownership is the one that goes wrong quietly: the file is on disk either
    // way, and only the claim table says who may write it next.
    expect(after.workspace.ownerOf("render.js")).toBe("interface");
    expect(after.workspace.ownerOf("game.js")).toBe("builder");
    expect(after.metrics().distinctWriters).toBe(before.metrics().distinctWriters);
  });

  it("keeps the lapse clock, so a resumed claim still expires on time", async () => {
    const before = sim({ days: 20 });
    await call(before, "claim_file", { path: "game.js", purpose: "the loop" }, "builder");
    before.advance();

    const after = sim({ days: 20, root: before.root });
    after.restore(JSON.parse(JSON.stringify(before.checkpoint())));

    // One more round either side of the restore is two in total: the claim goes.
    after.advance();
    expect(after.workspace.ownerOf("game.js")).toBeUndefined();
    expect(after.metrics().claimsLapsed).toBe(1);
  });

  it("remembers which engine the team took", async () => {
    const before = sim({ days: 20 });
    await call(before, "use_engine", { name: "babylon" }, "builder");
    before.advance();

    const after = sim({ days: 20, root: before.root });
    after.restore(JSON.parse(JSON.stringify(before.checkpoint())));

    expect(after.metrics().engineChosen).toBe(1);
    // Which means `docs` still answers and a second engine is still refused —
    // the two things a resumed team would otherwise get wrong about itself.
    expect(await call(after, "docs", { query: "create a box mesh" }, "builder")).toMatch(/CreateBox/);
    expect(await call(after, "use_engine", { name: "phaser" }, "builder")).toMatch(/already using Babylon/);
  }, 30_000);

  it("survives a checkpoint from a version that knew less", () => {
    const s = sim({ days: 20 });
    // A field that is not there must leave its default alone rather than throw:
    // a resumed run slightly wrong about a counter beats one that will not run.
    s.restore({ version: 1, tick: 4 });
    // Neither of these may throw, and neither may undo the field that was there.
    s.restore(undefined);
    s.restore("nonsense");
    // Read once: `metrics()` finalises, which counts the last unbounded round,
    // so a second call reports a different number by design.
    const m = s.metrics();
    expect(m.roundsPlayed).toBe(5);
    expect(m.writes).toBe(0);
  });
});

describe("submitting a build mid-jam", () => {
  function withArcade(options: Record<string, unknown> = {}): { sim: WorkshopSimulation; store: ArcadeStore } {
    const home = temp();
    const s = sim({ arcadeHome: home, ...options });
    return { sim: s, store: new ArcadeStore(home) };
  }

  /** Enough of a game that the workspace is worth submitting. */
  async function build(s: WorkshopSimulation, body: string): Promise<void> {
    await call(s, "write_file", { path: "index.html", content: "<!doctype html><canvas id=c></canvas>" }, "lead");
    await call(s, "write_file", { path: "engine.js", content: body }, "lead");
  }

  it("puts a playable build on the board and lets the jam carry on", async () => {
    const { sim: s, store } = withArcade();
    await build(s, "// 0.1.0\n");
    const out = await call(s, "submit_version", { version: "0.1.0", notes: "it runs" }, "lead");
    expect(out).toMatch(/Submitted 0\.1\.0/);
    expect(out).toMatch(/judged unless you submit a newer one/);

    const entry = store.list({ includeDrafts: true })[0];
    expect(entry.status).toBe("published");
    // Still live, so the rest of the jam still counts.
    expect(entry.live).toBe(true);
    expect(store.versions(entry.id)).toHaveLength(1);
    expect(s.metrics().arcadeSubmits).toBe(1);
  });

  it("numbers a build for a team that did not name one", async () => {
    const { sim: s, store } = withArcade();
    await build(s, "// one\n");
    await call(s, "submit_version", {}, "lead");
    await call(s, "submit_version", {}, "lead");
    const entry = store.list({ includeDrafts: true })[0];
    expect(store.versions(entry.id).map((v) => v.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  it("does not put a run with no entry file on the board", async () => {
    // Seed 26 published with one `data.js` of tuning constants and no
    // `index.html`: a page a reviewer opens and cannot play.
    const { sim: s, store } = withArcade();
    await call(s, "write_file", { path: "data.js", content: "const TUNING = { speed: 1 };\n" }, "author");
    await s.finish?.();
    expect(store.list()).toHaveLength(0);
    expect(store.list({ includeDrafts: true })[0].status).toBe("draft");
  });

  it("refuses to submit an empty workspace", async () => {
    const { sim: s } = withArcade();
    const out = await call(s, "submit_version", { version: "0.1.0" }, "lead");
    expect(out).toMatch(/nothing to submit/);
  });

  it("says what is on the board in every announcement", async () => {
    const { sim: s } = withArcade();
    expect(s.announce()).toMatch(/Nothing is on the board yet/);
    await build(s, "// 0.1.0\n");
    await call(s, "submit_version", { version: "0.3.0" }, "lead");
    expect(s.announce()).toMatch(/0\.3\.0 is on the board/);
  });

  /**
   * A game that genuinely animates and responds, so `playtest` comes back clean.
   *
   * The backstop deliberately refuses to checkpoint anything less — a saved
   * black rectangle that parses is what would get judged if the run then died.
   */
  const RUNNING_GAME = `<!doctype html><html><body><canvas id="game" width="320" height="240"></canvas>
<script>
const c = document.getElementById('game').getContext('2d');
let t = 0, hit = 0;
addEventListener('keydown', () => { hit += 1; });
function frame() { t += 1; c.fillStyle = '#000'; c.fillRect(0, 0, 320, 240);
  c.fillStyle = '#6ee7b7'; c.fillRect((t * 3) % 300, 100 + hit * 10, 20, 20);
  requestAnimationFrame(frame); }
frame();
</script></body></html>`;

  it("checkpoints a working build so a killed run keeps one, without anybody asking", async () => {
    const { sim: s, store } = withArcade();
    await call(s, "write_file", { path: "index.html", content: RUNNING_GAME }, "lead");
    await call(s, "playtest", {}, "tester");

    const entry = store.list({ includeDrafts: true })[0];
    const builds = store.versions(entry.id);
    expect(builds).toHaveLength(1);
    expect(builds[0].auto).toBe(true);
    // Counted apart from the deliberate ones, or "did the team choose to ship"
    // stops being answerable.
    expect(s.metrics().arcadeAutoSubmits).toBe(1);
    expect(s.metrics().arcadeSubmits).toBe(0);
  }, 30_000);

  it("does not checkpoint the same workspace twice", async () => {
    const { sim: s, store } = withArcade();
    await call(s, "write_file", { path: "index.html", content: RUNNING_GAME }, "lead");
    await call(s, "playtest", {}, "tester");
    await call(s, "playtest", {}, "tester");

    const entry = store.list({ includeDrafts: true })[0];
    expect(store.versions(entry.id)).toHaveLength(1);
  }, 45_000);

  it("does not checkpoint a game that does not run", async () => {
    const { sim: s, store } = withArcade();
    // Parses, renders nothing, ignores input. Exactly what must not be saved.
    await call(s, "write_file", { path: "index.html", content: "<!doctype html><html><body></body></html>" }, "lead");
    await call(s, "playtest", {}, "tester");

    const entry = store.list({ includeDrafts: true })[0];
    expect(store.versions(entry.id)).toHaveLength(0);
    expect(s.metrics().arcadeAutoSubmits).toBe(0);
  }, 30_000);

  it("keeps the submitted build when the run stops mid-rewrite", async () => {
    const { sim: s, store } = withArcade();
    await build(s, "// the good build\n");
    await call(s, "submit_version", { version: "0.4.0" }, "lead");

    // 0.5.0 is started and the clock runs out on top of it.
    await call(s, "write_file", { path: "engine.js", content: "// half a rewrite\n" }, "lead");
    await s.finish?.();

    const entry = store.list()[0];
    expect(readFileSync(join(entry.filesPath as string, "engine.js"), "utf8")).toBe("// the good build\n");
    expect(entry.live).toBe(false);
  });
});

describe("the live feed", () => {
  /** A workshop with a real arcade behind it, pointed at a temp home. */
  function withArcade(): { sim: WorkshopSimulation; store: ArcadeStore } {
    const home = temp();
    const s = sim({ arcadeHome: home });
    return { sim: s, store: new ArcadeStore(home) };
  }

  it("forwards what was said, stamped with the round", () => {
    const { sim: s, store } = withArcade();
    s.observePost({ agent: "lead", room: "studio", body: "Theme reading is decided." });
    // Buffered until a flush; the heartbeat on the round boundary is one.
    s.advance();
    const entry = store.list({ includeDrafts: true })[0];
    const feed = store.activity(entry.id);
    const post = feed.find((row) => row.kind === "post");
    expect(post?.agent).toBe("lead");
    expect(post?.room).toBe("studio");
    expect(post?.body).toBe("Theme reading is decided.");
    expect(post?.round).toBe(1);
  });

  it("records work that changed something, and not the reading around it", async () => {
    // `read_file` and `list_files` are 37% of everything a team does. A feed of
    // "read engine.js" ninety times buries the writes that changed the game.
    const { sim: s, store } = withArcade();
    await call(s, "write_file", { path: "engine.js", content: "var a = 1;\n" }, "builder");
    await call(s, "read_file", { path: "engine.js" }, "tester");
    await call(s, "list_files", {}, "lead");
    s.advance();
    const entry = store.list({ includeDrafts: true })[0];
    const did = store.activity(entry.id).filter((row) => row.kind === "did");
    expect(did.map((row) => row.room)).toEqual(["engine.js"]);
    expect(did[0].agent).toBe("builder");
    expect(did[0].body).toMatch(/created it/);
  });

  it("says nothing at all when the arcade is off", () => {
    // `bench`, `rehearse` and most tests run with no arcade. Observing a post
    // there must be a no-op rather than a crash.
    const s = sim({ arcade: "off" });
    expect(() => s.observePost({ agent: "lead", room: "studio", body: "hello" })).not.toThrow();
  });
});

describe("putting ideas on the table before choosing one", () => {
  /*
   * Every run settled the game in turn 0 or 1: one agent decided alone, posted
   * "DECISION LOCKED", and the other four ratified. Across twenty-five traces
   * nobody ever argued for a different direction. One idea, thought of once, by
   * one agent, in its first minute, is the whole explanation for a shelf of
   * near-identical games.
   *
   * What is deliberately absent here is a threshold. An earlier version counted
   * pitches against "three from two people" and nagged until it was met, which
   * is the same prescription this scenario keeps having to remove — a rule about
   * how to work produces teams that all work the same way.
   */
  it("records an idea and says where things stand, without saying what is enough", async () => {
    const s = sim();
    const out = await call(s, "pitch", { idea: "A garden you prune", unlike: "nothing to avoid" }, "author");
    expect(out).toMatch(/1 idea on the table from 1 of you/);
    expect(out).not.toMatch(/at least|wants|should|keep going/);
    expect(s.metrics().pitches).toBe(1);
    expect(s.metrics().pitchAuthors).toBe(1);
  });

  it("counts how many of the five contributed, because one is the failure", async () => {
    const s = sim();
    await call(s, "pitch", { idea: "a", unlike: "x" }, "author");
    await call(s, "pitch", { idea: "b", unlike: "y" }, "author");
    await call(s, "pitch", { idea: "c", unlike: "z" }, "builder");
    expect(s.metrics().pitches).toBe(3);
    expect(s.metrics().pitchAuthors).toBe(2);
  });

  it("states the tradeoff rather than the procedure", () => {
    const brief = sim().briefFor("lead") ?? "";
    expect(brief).toMatch(/Brainstorming costs rounds you could spend building/);
    expect(brief).toMatch(/how you trade them off is your call/);
    // And the way back out, which nothing in the scenario used to permit.
    expect(brief).toMatch(/Changing direction later is cheaper than it feels/);
  });

  it("reports pitches in the announcement the way it reports files", async () => {
    const s = sim();
    expect(s.announce()).not.toMatch(/idea/);
    await call(s, "pitch", { idea: "a", unlike: "x" }, "lead");
    expect(s.announce()).toMatch(/1 idea pitched, from 1 of you/);
  });

  it("refuses an empty pitch and nothing else", async () => {
    expect(await call(sim(), "pitch", { idea: "  " }, "lead")).toMatch(/needs an idea/);
  });
});

describe("nothing is free until you choose", () => {
  /*
   * Why the workspace starts empty.
   *
   * Four consecutive runs chose `use_engine none`, and each gave the same
   * reason: "the provided lib covers everything, not going to burn rounds
   * porting to Phaser". That is a correct reading of the economics. `lib/`
   * was already installed, already read by round two, and free; an engine
   * cost an install, an API and a port.
   *
   * So "none" never meant "I will write my own engine" — it meant *keep the
   * engine you already gave me*, which is why the brief's argument that
   * nothing rewards writing your own engine never landed. Nobody was writing
   * one. Now all three options install a foundation and a skeleton, and the
   * decision is which foundation rather than whether to pay for one.
   */
  it("gives the open arm an empty workspace until use_engine runs", () => {
    const s = sim();
    expect(s.workspace.list()).toHaveLength(0);
    expect(s.briefFor("builder") ?? "").toMatch(/The workspace is empty/);
  });

  it("installs an engine and its skeleton, without the library", async () => {
    const s = sim();
    await call(s, "use_engine", { name: "phaser" }, "builder");
    const paths = s.workspace.list().map((f) => f.path);
    expect(paths).toContain("lib/phaser.js");
    // The point of the change: taking an engine does not also hand you the
    // 2D canvas kit whose presence made the engine look expensive.
    expect(paths).not.toContain("lib/loop.js");
    expect(s.metrics().engineChosen).toBe(1);
  });

  it("installs the library on its own if nobody ever decides", () => {
    // Making the library conditional must not make an empty workspace a way
    // to lose the jam.
    const s = sim();
    // `advance()` is the round boundary; `announce()` is called once per agent
    // per round and does not move the clock.
    for (let i = 0; i < 3; i += 1) s.advance();
    expect(s.workspace.list().some((f) => f.path === "lib/loop.js")).toBe(true);
    expect(s.metrics().engineDefaulted).toBe(1);
    // Not the same finding as a team that decided against an engine.
    expect(s.metrics().engineDeclined).toBe(0);
  });

  it("stops telling them a game that ignores the library loses", () => {
    /*
     * The sentence that made the other four runs rational. It read "a game
     * that uses none of it will lose to one that does" — and a Phaser game
     * uses none of it. The brief said "pick an engine" and "not using this
     * loses" in the same document.
     */
    const brief = sim({ direction: "prescribed" }).briefFor("builder") ?? "";
    expect(brief).toMatch(/Loop\.start/);
    expect(brief).not.toMatch(/will lose to one that does/);
  });
});

describe("the provided library", () => {
  /**
   * A sim with the library actually in it.
   *
   * It used to be there at construction. In the open arm it is now what
   * `use_engine none` installs, because being free was the whole reason four
   * consecutive teams chose it without weighing anything. The prescribed
   * control arm still gets it at construction.
   */
  async function withLibrary(): Promise<WorkshopSimulation> {
    const s = sim();
    await call(s, "use_engine", { name: "none" }, "builder");
    return s;
  }

  it("is in the workspace once the team has chosen no engine", async () => {
    const s = await withLibrary();
    const provided = s.workspace.list().filter((f) => f.provided);
    expect(provided.map((f) => f.path).sort()).toEqual(["lib/draw.js", "lib/fx.js", "lib/input.js", "lib/loop.js"]);
    expect(provided.every((f) => f.lines > 0)).toBe(true);
  });

  it("is in the prescribed arm from the start, which is the control", () => {
    // An arm that differs in what is on disk at round one is not a control arm.
    const provided = sim({ direction: "prescribed" })
      .workspace.list()
      .filter((f) => f.provided);
    expect(provided.map((f) => f.path).sort()).toEqual(["lib/draw.js", "lib/fx.js", "lib/input.js", "lib/loop.js"]);
  });

  it("is not counted as anything the team produced", async () => {
    // The load-bearing one. Charging ~580 lines of library to the team would
    // make `linesInWorkspace` incomparable with every entry built before the
    // library existed, and would spend a fifth of the byte budget on turn one.
    const s = await withLibrary();
    expect(s.metrics().filesPresent).toBe(0);
    expect(s.metrics().linesInWorkspace).toBe(0);
    expect(s.metrics().bytesInWorkspace).toBe(0);
  });

  it("refuses a write from anybody, including when ownership is off", async () => {
    // Not an ownership rule between teammates: it is what makes the library the
    // same fixed thing for every entry on the board.
    const strict = await call(await withLibrary(), "write_file", { path: "lib/loop.js", content: "x" }, "builder");
    expect(strict).toMatch(/came with the workspace/);
    const sharedSim = sim({ ownership: "shared" });
    await call(sharedSim, "use_engine", { name: "none" }, "maker");
    const shared = await call(sharedSim, "write_file", { path: "lib/fx.js", content: "x" }, "maker");
    expect(shared).toMatch(/came with the workspace/);
  });

  it("can still be read", async () => {
    const out = await call(await withLibrary(), "read_file", { path: "lib/loop.js", from: 1, to: 3 }, "builder");
    expect(out).not.toMatch(/Refused/);
    expect(out).toMatch(/lib\/loop\.js/);
  });

  it("appears in the listing without spending the budget", async () => {
    const out = await call(await withLibrary(), "list_files", {}, "lead");
    expect(out.split("\n")[0]).toMatch(/^0 files, 0 of/);
    expect(out).toMatch(/lib\/loop\.js\s+\[provided\]/);
  });

  it("tells the team what it can call, not just that it exists", async () => {
    // Four files of source is not an API. Nobody should have to read 580 lines
    // to discover there is a game loop.
    const s = await withLibrary();
    const brief = s.briefFor("builder") ?? "";
    expect(brief).toMatch(/Loop\.start/);
    expect(brief).toMatch(/Keys\.pressed/);
    expect(brief).toMatch(/Draw\.orb/);
    expect(brief).toMatch(/FX\.burst/);
  });

  it("holds the full API back until the team has chosen, and shows a taste before", () => {
    /*
     * The fifth consecutive `none` was chosen with no stated reason at all,
     * and by then the remaining asymmetry was informational: 58 lines of
     * library API on the page against one sentence per engine, with the
     * engines' runnable examples only appearing after installing one. A model
     * choosing between an API it can read and one it would have to look up
     * takes the one on the page.
     *
     * Before the choice all three now show a snippet of comparable size; the
     * long reference arrives once there is something to call.
     */
    const brief = sim().briefFor("builder") ?? "";
    // The engines are callable-looking at decision time...
    expect(brief).toMatch(/new Phaser\.Game/);
    // ...and so is the library, in the same amount of space.
    expect(brief).toMatch(/Loop\.start/);
    // But the 58-line reference is not competing with them yet.
    expect(brief).not.toMatch(/Keys\.pressed\(name\)|Draw\.meter/);
  });

  it("leaves a brief with no library alone", () => {
    // `tool` and `site` are from-scratch briefs and must stay that way.
    const s = sim({ brief: "tool" });
    expect(s.workspace.list().filter((f) => f.provided)).toEqual([]);
    expect(s.briefFor("builder") ?? "").not.toMatch(/Loop\.start/);
  });
});

describe("playtest", () => {
  it("belongs to the tester, the interface and the builder, and says so when refused", async () => {
    const s = sim();
    expect(s.sharedTools().map((t) => t.name)).toContain("playtest");
    const out = await call(s, "playtest", {}, "author");
    expect(out).toMatch(/Refused/);
    expect(out).toMatch(/tester and interface and builder/);
  });

  it("lets the builder look at the screen it is writing the loop for", async () => {
    // Regression guard for the change itself: the builder used to be refused,
    // which left the agent writing what moves on screen unable to see it. Four
    // runs in that condition stopped growing the workspace between round 3 and
    // round 14 of 20.
    const s = sim();
    const out = await call(s, "playtest", {}, "builder");
    expect(out).not.toMatch(/Refused/);
  });

  it("is open to everybody when checks are", () => {
    const s = sim({ checks: "anyone" });
    expect(s.sharedTools().map((t) => t.name)).toContain("playtest");
  });

  it("shows the opening screen and a mid-play frame, in that order", () => {
    const report = {
      screenshots: ["/s/01-opened.png", "/s/03-after-start.png", "/s/04-playing.png", "/s/05-after-input.png"],
    } as Parameters<typeof framesToShow>[0];
    // Mid-play last: it is the more useful of the two and the last image is
    // the one a model weights most heavily.
    expect(framesToShow(report)).toEqual(["/s/01-opened.png", "/s/04-playing.png"]);
  });

  it("never sends the same frame twice when only one was captured", () => {
    const report = { screenshots: ["/s/01-opened.png"] } as Parameters<typeof framesToShow>[0];
    // The store is content-addressed, so a duplicate would be one id twice in
    // a single message — which reads to a model as two identical screens.
    expect(framesToShow(report)).toEqual(["/s/01-opened.png"]);
  });

  it("shows nothing when the browser never got a frame", () => {
    expect(framesToShow({ screenshots: [] } as Parameters<typeof framesToShow>[0])).toEqual([]);
  });

  it("still returns a plain text report when no media store is attached", async () => {
    // `bench`, `rehearse` and most of these tests build a workshop with no
    // runtime behind it. A playtest there has to keep working and hand back a
    // string, not fail over the half of the answer it cannot produce.
    const s = sim();
    const out = await call(s, "playtest", {}, "tester");
    expect(typeof out).toBe("string");
  });

  it("counts frames that reached a model separately from playtests run", () => {
    // Zero here beside a healthy playtestsRun is the tell that images are not
    // wired up — a run without `--vision` plays the game just as often and
    // shows nobody anything.
    const s = sim();
    expect(s.metrics().framesShown).toBe(0);
  });

  it("separates never-run from run-and-static in the snapshot", () => {
    const s = sim();
    const snapshot = s.snapshot();
    // -1 rather than 0: "nobody tried" and "tried and nothing moved" are
    // different findings, and a board that conflates them is worse than one
    // that omits them.
    expect(snapshot.playtestAnimates).toBe(-1);
    expect(snapshot.playtestErrors).toBe(-1);
  });
});

describe("a review scenario cannot quietly become a scored one", () => {
  const base = {
    id: "x",
    category: "orchestration",
    difficulty: 5,
    intent: "y",
    rooms: [{ name: "r", members: ["a"], incoming: [{ speaker: "q", body: "go" }] }],
    agent: { name: "a" },
  };

  it("refuses expect on a review row", () => {
    expect(() => validateScenario({ ...base, review: true, expect: [{ replies: true }] } as never, "x")).toThrow(
      /cannot also carry `expect:`/,
    );
  });

  it("refuses a milestone ladder on a review row", () => {
    expect(() =>
      validateScenario(
        { ...base, review: true, milestones: [{ id: "m", points: 1, when: { replies: true } }] } as never,
        "x",
      ),
    ).toThrow(/cannot carry `milestones:`/);
  });

  it("still requires expect on everything else", () => {
    expect(() => validateScenario(base as never, "x")).toThrow(/needs `expect:`|expect/);
  });

  it("keeps the 40-round cap for a scored scenario and relaxes it for a review one", () => {
    const wake = [{ room: "r", rounds: 44, agents: ["a"] }];
    expect(() => validateScenario({ ...base, wake, expect: [{ replies: true }] } as never, "x")).toThrow(
      /capped at 40/,
    );
    expect(() => validateScenario({ ...base, wake, review: true } as never, "x")).not.toThrow();
  });
});

describe("the scenarios on disk", () => {
  it("names its agents after its roles, because ownership is checked by agent name", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "workshop");
    expect(scenarios.length).toBe(3);
    for (const scenario of scenarios) {
      // `write_file` is an `agentTool` and decides ownership from
      // `context.agentName`, while the simulation is handed roles. If the two
      // vocabularies ever diverge, every write is refused and the run looks
      // like five agents who cannot use their tools.
      for (const [role, agent] of Object.entries(scenario.simulation?.roles ?? {})) {
        const solo = Object.keys(scenario.simulation?.roles ?? {}).length > 1 && agent === "maker";
        if (!solo) expect(agent).toBe(role);
      }
      expect(scenario.review).toBe(true);
      expect(scenario.expect ?? []).toHaveLength(0);
    }
  });

  /**
   * The regression this closes was introduced and caught within a minute, and
   * would have been invisible for a whole run otherwise.
   *
   * The control arms used to recover a role's job by splitting its assembled
   * instructions on the first blank line. Giving the lead a second paragraph —
   * the one telling it to register the game — silently truncated both control
   * arms to the first paragraph, so the two arms being compared would have
   * differed by an instruction nobody intended to vary. Nothing would have
   * reported it; the arms would simply have stopped being arms.
   */
  it("gives every arm the lead's whole job, not the first paragraph of it", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "workshop");
    for (const id of ["the-workshop", "the-workshop-in-one-room"]) {
      const scenario = scenarios.find((s) => s.id === id);
      const lead = scenario?.agent?.instructions ?? "";
      // Both halves of the job. The first paragraph is the design and the theme
      // reading; the second is the arcade, and it is the one that got dropped
      // when this was written as a single string. Asserted on the tool names
      // rather than on a filename, because the open arm does not hand out
      // filenames and a guard that depends on one would fail for the wrong
      // reason.
      expect(lead, id).toMatch(/reading of the theme/);
      expect(lead, id).toMatch(/arcade_register/);
      expect(lead, id).toMatch(/submit_version/);
    }
    // The solo arm holds every job at once and is written as one block; it
    // still has to be told the game needs registering.
    const alone = scenarios.find((s) => s.id === "the-workshop-alone");
    expect(alone?.agent?.instructions ?? "").toMatch(/arcade_register/);
    expect(alone?.agent?.instructions ?? "").toMatch(/submit_version/);
  });

  /**
   * `--filter the-workshop` is three ninety-minute runs, not one.
   *
   * Substring matching is right nearly always and wrong for a family named
   * after its head. In a session that costs an afternoon; in `jam:loop` it
   * costs every iteration, forever.
   */
  it("selects one arm on an exact filter and all three on a loose one", async () => {
    const { loadScenarios } = await import("../schema.js");
    const dir = new URL("../../scenarios", import.meta.url).pathname;
    const loose = await loadScenarios(dir, "the-workshop");
    const exact = await loadScenarios(dir, "=the-workshop");
    expect(loose.scenarios.length).toBe(3);
    expect(exact.scenarios.map((s) => s.id)).toEqual(["the-workshop"]);
    // The set digest is taken over everything before either filter applies, so
    // a narrowed run still records which version of the questions it answered.
    expect(exact.hash).toBe(loose.hash);
  });

  it("gives every arm the same number of model calls", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "workshop");
    const turns = (id: string): number => {
      const scenario = scenarios.find((s) => s.id === id);
      const wake = Array.isArray(scenario?.wake) ? scenario.wake : scenario?.wake ? [scenario.wake] : [];
      return wake.reduce((sum, w) => sum + ("agents" in w ? w.rounds * w.agents.length : 0), 0);
    };
    // The comparison is "given the same budget, does the shape of the team
    // help". Round parity would answer a different question while looking like
    // it answered this one.
    expect(turns("the-workshop")).toBe(220);
    expect(turns("the-workshop-in-one-room")).toBe(220);
    expect(turns("the-workshop-alone")).toBe(220);
  });

  it("puts the lead in every channel and nobody else", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "workshop");
    const split = scenarios.find((s) => s.id === "the-workshop");
    const rooms = split?.rooms ?? [];
    expect(rooms.map((r) => r.name)).toEqual(["studio", "build", "craft"]);
    const inAll = ["lead", "builder", "interface", "author", "tester"].filter((agent) =>
      rooms.every((room) => room.members?.includes(agent)),
    );
    expect(inAll).toEqual(["lead"]);
    // The crossing the scenario is built around: the two agents whose files have
    // to fit together share only the all-hands channel.
    const shared = rooms.filter((r) => r.members?.includes("builder") && r.members?.includes("interface"));
    expect(shared.map((r) => r.name)).toEqual(["studio"]);
  });
});

describe("tool schemas say what the handlers actually accept", () => {
  /**
   * Both halves of this were live at once and neither was visible.
   *
   * A tool's schema is validated by core *before* `execute` runs, and a
   * rejection there happens inside the loop rather than in the tool — so no
   * `call` event reaches the trace at all. The instrument reads as unused, the
   * counter it feeds stays zero, and the run looks like a team that never tried
   * the thing they were in fact trying repeatedly.
   */
  it("accepts a number where a number is meant", () => {
    const s = sim();
    const read = s.sharedTools().find((t) => t.name === "read_file");
    const from = (read?.parameters.properties as Record<string, { type: unknown }>).from;
    // `num()` copes with strings, so the union widens what is accepted and
    // narrows nothing. Declaring only "string" refused the correct type.
    expect(from.type).toEqual(["string", "number"]);
  });

  it("does not require the arguments it documents as optional", () => {
    const s = sim();
    const read = s.sharedTools().find((t) => t.name === "read_file");
    const required = read?.parameters.required as string[];
    expect(required).toContain("path");
    expect(required).not.toContain("from");
    expect(required).not.toContain("to");
  });

  it("reads a file with no range at all", async () => {
    const s = sim();
    await call(s, "write_file", { path: "design.md", content: "# one\n# two\n" }, "lead");
    const out = await call(s, "read_file", { path: "design.md" }, "builder");
    expect(out).toMatch(/# one/);
  });

  it("reads a numeric range passed as numbers", async () => {
    const s = sim();
    await call(s, "write_file", { path: "design.md", content: "a\nb\nc\nd\n" }, "lead");
    const out = await call(s, "read_file", { path: "design.md", from: 2, to: 3 }, "builder");
    expect(out).toMatch(/lines 2-3/);
    expect(out).not.toMatch(/\s1\s+a/);
  });
});

describe("the brief reaches the agent, in every arm", () => {
  /**
   * The bug this holds shut was invisible and one-sided.
   *
   * `buildConfig` looked the role up as `simulation.roles[agent]` — an agent
   * name indexed into a role-keyed map — which returns the right answer only
   * while every scenario names its agents after its roles. `the-workshop-alone`
   * maps five roles onto one agent called `maker`, so the lookup returned
   * undefined and the solo arm ran with no task description at all. Nothing was
   * red; the arm would simply have produced nothing and read as a model that
   * could not build anything on its own.
   */
  it("resolves a role even when the agent is not named after one", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { buildConfig } = await import("../harness.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "workshop");

    for (const scenario of scenarios) {
      const spec = scenario.simulation as NonNullable<typeof scenario.simulation>;
      const s = createSimulation(spec.name, {
        seed: 0,
        days: spec.days,
        root: temp(),
        stamp: "t",
        ...(spec.options ?? {}),
      });
      const config = buildConfig(
        scenario,
        { model: "m", baseUrl: "u", temperature: 0, maxToolRounds: 4, seed: 0 } as never,
        s,
      );
      const agents = config.agents as Record<string, { instructions?: string }>;
      for (const name of Object.keys(spec.roles).map((role) => spec.roles[role])) {
        expect(agents[name]?.instructions, `${scenario.id}/${name} got no brief`).toMatch(/## Your part/);
        expect(agents[name]?.instructions, `${scenario.id}/${name} lost its own instructions`).toMatch(/Constraints/);
      }
    }
  });

  it("does not describe a partition that is not in force", () => {
    const solo = sim({ ownership: "shared" });
    expect(solo.briefFor("lead")).toMatch(/Every file in that layout is yours/);
    expect(solo.briefFor("lead")).not.toMatch(/only one who can write/);
  });

  it("builds twice without accumulating the brief", async () => {
    const { loadScenarios } = await import("../schema.js");
    const { buildConfig } = await import("../harness.js");
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname, "the-workshop");
    const scenario = scenarios.find((x) => x.id === "the-workshop") as NonNullable<(typeof scenarios)[number]>;
    const spec = scenario.simulation as NonNullable<typeof scenario.simulation>;
    const opts = { model: "m", baseUrl: "u", temperature: 0, maxToolRounds: 4, seed: 0 } as never;
    const make = () =>
      createSimulation(spec.name, { seed: 0, days: spec.days, root: temp(), stamp: "t", ...(spec.options ?? {}) });

    const first = buildConfig(scenario, opts, make());
    const second = buildConfig(scenario, opts, make());
    const textOf = (c: Record<string, unknown>): string =>
      (c.agents as Record<string, { instructions?: string }>).builder.instructions ?? "";
    // `deepMerge` copies an absent key by reference, so a build that mutated the
    // block would append the brief once per build. Rebuilding a tool set is
    // idempotent and hid this for months; appending text is not.
    expect(textOf(second).length).toBe(textOf(first).length);
    expect(textOf(second).match(/## Your part/g)).toHaveLength(1);
  });
});

describe("a workspace is not a place to smuggle a file out of", () => {
  it("refuses to follow a symlink that points outside", () => {
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "sensitive");
    const workspace = new Workspace(temp());
    // A directory inside the workspace that is really somewhere else. The shape
    // rule cannot see this; `containedIn` resolving symlinks is what does.
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(outside, join(workspace.filesRoot, "link"));
    expect(() => workspace.read("link/secret.txt")).toThrow(/outside the workspace/);
    expect(() => workspace.write("link/planted.js", "x", "lead", 0)).toThrow(/outside the workspace/);
  });
});

describe("the arcade", () => {
  /**
   * A workshop with a submission page, and a store that goes away afterwards.
   *
   * `arcadeHome` is what turns the arcade on for a test. It is also, with a
   * `run` context, the *only* thing that does — see the constructor. That gate
   * exists because this suite constructs the simulation dozens of times, and
   * the first version of this feature wrote forty-eight rows into the real
   * database on ~/.tai-arcade, several of them published.
   */
  function jam(options: Record<string, unknown> = {}): { s: WorkshopSimulation; store: ArcadeStore } {
    const home = temp();
    const s = sim({ arcadeHome: home, ...options });
    return { s, store: new ArcadeStore(home) };
  }

  /** Every tool the simulation exposes, however it hands it out. */
  const allTools = (s: WorkshopSimulation): string[] =>
    [...s.sharedTools(), ...Object.values(s.tools()).flat()].map((t) => t.name);

  it("hands out no arcade tools unless it was asked to", () => {
    expect(allTools(sim())).not.toContain("arcade_register");
    expect(allTools(sim())).not.toContain("arcade_browse");
  });

  it("opens for a real harness run without being told a home", () => {
    // `run` is what the harness passes and `bench`/`rehearse`/tests do not.
    const s = sim({ run: { scenario: "x", model: "m", provider: "p", baseUrl: "u" } });
    expect(allTools(s)).toContain("arcade_register");
  });

  it("stays off when the scenario switches it off", () => {
    expect(allTools(sim({ arcadeHome: temp(), arcade: "off" }))).not.toContain("arcade_register");
  });

  /**
   * The reason this is a partition rather than a refusal.
   *
   * Measured on the first live run with the arcade in `sharedTools()`: the
   * interface agent, which cannot register anything, spent four of the team's
   * six tool calls browsing the arcade and reading three previous entries, and
   * the run wrote no files at all. A refusal would still have cost the call and
   * the schema entry — four agents never seeing the tools is the fix.
   */
  it("gives the arcade to the agent who writes the submission and to nobody else", async () => {
    const { simulationGrants } = await import("../harness.js");
    const s = sim({ arcadeHome: temp() });
    const grants = simulationGrants(s, {
      lead: "lead",
      builder: "builder",
      interface: "interface",
      author: "author",
      tester: "tester",
    });
    expect(grants.lead).toContain("arcade_register");
    expect(grants.lead).toContain("arcade_browse");
    for (const agent of ["builder", "interface", "author", "tester"]) {
      expect(grants[agent], agent).not.toContain("arcade_browse");
      expect(grants[agent], agent).not.toContain("arcade_register");
      // They keep everything else.
      expect(grants[agent], agent).toContain("write_file");
    }
  });

  it("keeps the arcade reachable when one agent plays every role", async () => {
    const { simulationGrants } = await import("../harness.js");
    const s = sim({ arcadeHome: temp(), ownership: "shared", checks: "anyone" });
    const grants = simulationGrants(s, {
      lead: "maker",
      builder: "maker",
      interface: "maker",
      author: "maker",
      tester: "maker",
    });
    expect(grants.maker).toContain("arcade_register");
  });

  it("tells the other four that the page exists without naming tools they lack", () => {
    const builder = sim({ arcadeHome: temp() }).briefFor("builder") ?? "";
    expect(builder).toMatch(/arcade/i);
    expect(builder).toMatch(/lead holds the arcade tools/);
    expect(builder).not.toMatch(/arcade_register/);
  });

  it("opens a draft the moment the jam starts, so there is something to read", () => {
    const { store } = jam();
    const drafts = store.list({ includeDrafts: true });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("draft");
    expect(store.list()).toHaveLength(0);
  });

  it("records what built it, from the run context rather than from the agents", () => {
    const home = temp();
    sim({
      arcadeHome: home,
      run: {
        scenario: "the-workshop",
        model: "qwen3.8-27b",
        provider: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        gitSha: "abc1234",
        taiVersion: "0.1.10",
        modelMeta: { contextTokens: 131072, thinking: "medium" },
        roles: { lead: "lead", builder: "builder" },
      },
    });
    const entry = new ArcadeStore(home).list({ includeDrafts: true })[0];
    expect(entry.model).toBe("qwen3.8-27b");
    expect(entry.gitSha).toBe("abc1234");
    expect(entry.modelMeta.contextTokens).toBe(131072);
    expect(entry.credits.builder).toBe("builder");
    expect(entry.simVersion).toMatch(/workshop/);
  });

  it("lets only the agent who owns submission.md register the team", async () => {
    const { s, store } = jam();
    const refused = await call(s, "arcade_register", { title: "Sneaky" }, "builder");
    expect(refused).toMatch(/Refused/);
    expect(refused).toMatch(/lead/);
    expect(store.list({ includeDrafts: true })[0].title).toBeUndefined();

    const ok = await call(s, "arcade_register", { title: "Overgrowth", genre: "puzzle" }, "lead");
    expect(ok).toMatch(/Registered/);
    expect(store.list({ includeDrafts: true })[0].title).toBe("Overgrowth");
  });

  it("lets anybody register when there is nobody to own anything", async () => {
    const { s, store } = jam({ ownership: "shared" });
    await call(s, "arcade_register", { title: "Solo" }, "maker");
    expect(store.list({ includeDrafts: true })[0].title).toBe("Solo");
  });

  it("names what is still missing rather than reading back what was written", async () => {
    const { s } = jam();
    const before = await call(s, "arcade_entry", {}, "lead");
    expect(before).toMatch(/Title\s+— empty/);
    expect(before).toMatch(/Still empty:/);

    await call(s, "arcade_register", { title: "Overgrowth", tagline: "one seed" }, "lead");
    const after = await call(s, "arcade_entry", {}, "lead");
    expect(after).toMatch(/Overgrowth/);
    expect(after).toMatch(/Still empty:.*how to play/);
  });

  it("refuses an empty registration instead of marking the team registered", async () => {
    const { s, store } = jam();
    const out = await call(s, "arcade_register", {}, "lead");
    expect(out).toMatch(/Refused/);
    expect(store.list({ includeDrafts: true })[0].registered).toBe(false);
  });

  it("cannot reach another team's entry — there is no argument for it", async () => {
    const home = temp();
    const store = new ArcadeStore(home);
    const other = store.createEntry({
      runId: "somebody-else",
      scenario: "",
      brief: "arcade",
      theme: "ONLY ONE",
      themeId: "only-one",
      rounds: 20,
      seed: 0,
      artifactPath: "/nowhere",
      entryFile: "index.html",
      taiVersion: "",
      simVersion: "",
      gitSha: "",
      model: "",
      provider: "",
      baseUrl: "",
      modelMeta: {},
      credits: {},
    });
    store.register(other.id, { title: "Theirs" });
    store.publish(other.id, {});

    const s = sim({ arcadeHome: home });
    // Every shape an attempt could take. None of them is a parameter this tool
    // has, so all of them land on the caller's own row.
    await call(s, "arcade_register", { title: "Mine", slug: "theirs", id: other.id, entry: other.id }, "lead");
    expect(store.entry(other.id)?.title).toBe("Theirs");
  });

  it("shows previous entries and their scores, but not the draft being written", async () => {
    const home = temp();
    const store = new ArcadeStore(home);
    const past = store.createEntry({
      runId: "last-week",
      scenario: "",
      brief: "arcade",
      theme: "ONLY ONE",
      themeId: "only-one",
      rounds: 20,
      seed: 0,
      artifactPath: "/nowhere",
      entryFile: "index.html",
      taiVersion: "",
      simVersion: "",
      gitSha: "",
      model: "",
      provider: "",
      baseUrl: "",
      modelMeta: {},
      credits: {},
    });
    store.register(past.id, { title: "One Shot", tagline: "a single bullet", genre: "shooter" });
    store.publish(past.id, {});
    store.saveReview(past.id, "quinton", { theme: 5, gameplay: 3 }, "the reload is the whole game");

    const s = sim({ arcadeHome: home });
    const board = await call(s, "arcade_browse", {}, "lead");
    expect(board).toMatch(/one-shot/);
    expect(board).toMatch(/4\.00 overall/);
    /*
     * The per-category breakdown is deliberately gone.
     *
     * It used to print "theme 5.0  gameplay 3.0" beside every entry. With
     * one review that is inert; with thirty it is a fitness gradient that
     * tells the next team exactly which lever to pull — and teams optimising
     * the rubric rather than making a game is the failure this scenario
     * keeps rediscovering. The overall figure survives, and so does what the
     * judge actually wrote, which is far harder to hill-climb.
     */
    expect(board).not.toMatch(/theme 5\.0/);
    expect(board).not.toMatch(/gameplay 3\.0/);
    // The team's own unfinished page is not on the board it is reading.
    expect(board).not.toMatch(/workshop-test/);

    const page = await call(s, "arcade_read", { slug: "one-shot" }, "lead");
    expect(page).toMatch(/a single bullet/);
    expect(page).toMatch(/the reload is the whole game/);

    expect(s.metrics().arcadeBrowses).toBe(1);
    expect(s.metrics().arcadeReads).toBe(1);
  });

  /**
   * A tool result is charged against the history budget; a web page is not.
   *
   * The store lets a team write 8,000 characters of description, which is right
   * for somebody reading it in a browser and wrong for a single tool result in
   * a run whose binding constraint is whether the team still remembers its own
   * plan at round eighteen.
   */
  it("trims a long entry for the tool and marks the cut", async () => {
    const home = temp();
    const store = new ArcadeStore(home);
    const past = store.createEntry({
      runId: "verbose",
      scenario: "",
      brief: "arcade",
      theme: "ONLY ONE",
      themeId: "only-one",
      rounds: 20,
      seed: 0,
      artifactPath: "/nowhere",
      entryFile: "index.html",
      taiVersion: "",
      simVersion: "",
      gitSha: "",
      model: "",
      provider: "",
      baseUrl: "",
      modelMeta: {},
      credits: {},
    });
    const long = "the field grows on its own. ".repeat(300);
    store.register(past.id, { title: "Verbose", description: long, instructions: long });
    store.publish(past.id, {});

    const page = await call(sim({ arcadeHome: home }), "arcade_read", { slug: "verbose" }, "lead");
    expect(page).toMatch(/trimmed; the full text is on the site/);
    expect(page.length).toBeLessThan(4000);
    // What is stored is untouched — the trim is a property of the tool result.
    expect(store.entry(past.id)?.description?.length).toBeGreaterThan(4000);
  });

  it("says so plainly when there is nothing to compare against", async () => {
    const { s } = jam();
    expect(await call(s, "arcade_browse", {}, "lead")).toMatch(/no published games yet/);
  });

  it("refuses a slug that is not there, naming the tool that lists them", async () => {
    const { s } = jam();
    const out = await call(s, "arcade_read", { slug: "nope" }, "lead");
    expect(out).toMatch(/Refused/);
    expect(out).toMatch(/arcade_browse/);
  });

  it("publishes the finished game, with its counters, when the jam ends", async () => {
    const { s, store } = jam({ days: 2 });
    await call(s, "arcade_register", { title: "Overgrowth", genre: "puzzle" }, "lead");
    await call(s, "write_file", { path: "index.html", content: "<!doctype html><canvas></canvas>" }, "interface");
    s.finish();

    const published = store.list();
    expect(published).toHaveLength(1);
    expect(published[0].title).toBe("Overgrowth");
    expect(published[0].registered).toBe(true);
    expect(published[0].metrics.writes).toBe(1);
    expect(published[0].downloadPath).toBeTruthy();
  });

  it("publishes a team that never registered, flagged rather than hidden", async () => {
    const { s, store } = jam({ days: 2 });
    await call(s, "write_file", { path: "index.html", content: "<!doctype html>" }, "interface");
    s.finish();
    const published = store.list();
    expect(published).toHaveLength(1);
    expect(published[0].registered).toBe(false);
    expect(published[0].title).toBeUndefined();
  });

  it("does not publish a run that built nothing", () => {
    const { s, store } = jam({ days: 2 });
    s.finish();
    expect(store.list()).toHaveLength(0);
  });

  it("puts the arcade counters in the snapshot as well as the metrics", async () => {
    const { s } = jam();
    await call(s, "arcade_register", { title: "X" }, "lead");
    const snapshot = s.snapshot();
    for (const key of Object.keys(s.metrics())) {
      expect(snapshot).toHaveProperty(key);
    }
    expect(s.metrics().arcadeRegistered).toBe(1);
    expect(s.metrics().arcadeUpdates).toBe(1);
  });

  it("tells the team the site exists, and only when it does", () => {
    const withArcade = sim({ arcadeHome: temp() }).briefFor("lead") ?? "";
    expect(withArcade).toMatch(/## Submitting/);
    expect(withArcade).toMatch(/not registered on it is a game nobody plays/);

    // A control arm run with the arcade off must not differ by a stray heading.
    // Matched on the section and the tools rather than on the word: the default
    // brief is the *arcade* brief and says so in its own first line.
    const without = sim().briefFor("lead") ?? "";
    expect(without).not.toMatch(/## Submitting/);
    expect(without).not.toMatch(/arcade_/);
  });

  it("nags about an unregistered entry only once the jam is nearly over", async () => {
    const { s } = jam({ days: 10 });
    expect(s.announce()).not.toMatch(/arcade/);
    for (let i = 0; i < 7; i++) s.advance();
    expect(s.announce()).toMatch(/Nothing is registered on the arcade/);

    await call(s, "arcade_register", { title: "Late But Present" }, "lead");
    expect(s.announce()).not.toMatch(/Nothing is registered/);
  });
});
