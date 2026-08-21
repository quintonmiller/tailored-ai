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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateScenario } from "../schema.js";
import { createSimulation, simulationPolicies } from "../sim/index.js";
import { checkWorkspace } from "../sim/workshop/check.js";
import { framesToShow } from "../sim/workshop/playtest.js";
import type { WorkshopSimulation } from "../sim/workshop/index.js";
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
    const s = sim();
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
    const s = sim();
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

  it("tells the team the theme constrains mechanics, and names the lazy reading", () => {
    const s = sim({ theme: "only-one" });
    const brief = s.briefFor("builder") ?? "";
    expect(brief).toMatch(/GAME JAM/);
    expect(brief).toMatch(/ONLY ONE/);
    // The shallow reading is named so it can be avoided rather than stumbled into.
    expect(brief).toMatch(/one life, and nothing else about the game changed/);
    expect(brief).toMatch(/Theme relevance/);
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
    expect(card).toContain("**Theme relevance**");
  });

  it("runs a jam clock with phases rather than a bare round counter", () => {
    const s = sim({ days: 10 });
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
      const s = sim({ brief: id });
      expect(s.workspace.ownerOf("submission.md"), `${id} has no submission.md`).toBe("lead");
    }
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
      expect(lead, id).toMatch(/design\.md/);
      expect(lead, id).toMatch(/arcade_register/);
    }
    // The solo arm holds every job at once and is written as one block; it
    // still has to be told the game needs registering.
    const alone = scenarios.find((s) => s.id === "the-workshop-alone");
    expect(alone?.agent?.instructions ?? "").toMatch(/arcade_register/);
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
    expect(board).toMatch(/theme 5\.0/);
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
