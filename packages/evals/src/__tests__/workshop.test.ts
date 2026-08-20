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
import { afterEach, describe, expect, it } from "vitest";
import { validateScenario } from "../schema.js";
import { createSimulation, simulationPolicies } from "../sim/index.js";
import { checkWorkspace } from "../sim/workshop/check.js";
import type { WorkshopSimulation } from "../sim/workshop/index.js";
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
    expect(out).toMatch(/nothing here was run/);
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
