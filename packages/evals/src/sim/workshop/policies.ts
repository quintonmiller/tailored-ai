/**
 * A bot that builds something, so the machinery can be exercised without a
 * model.
 *
 * Not a baseline. Every other simulation here ships a ladder because a score of
 * $1.31M means nothing until a random policy scores $402K beside it, and this
 * simulation has no score for a ladder to rank. What it has instead is a
 * different and equally expensive failure mode: a tool that refuses everything,
 * a snapshot that never fires, an ownership rule that locks the whole team out
 * of the layout — each of which would spend two hours of model time and read as
 * an agent failure.
 *
 * The descent's six scripted parties found four balance defects before a single
 * model call, and that remains the most valuable trick in the package. This is
 * the same trick with nothing to rank: it runs in milliseconds, it exercises
 * every tool through the same public surface an agent uses, and it produces a
 * real artifact and a real trace to develop a viewer against.
 *
 * It writes deliberately mediocre code. Making the bot good would be a way of
 * fooling yourself about what the tools make easy.
 */

import type { Policy, Simulation } from "../types.js";
import type { WorkshopSimulation } from "./index.js";

const DESIGN = `# Design

Decided in round one, and this file is the record.

- One canvas, 640x480.
- Arrow keys move, space fires.
- Score is time survived plus targets hit.
- Game over returns to the title without a reload.

## Open questions

- Does the difficulty ramp, or is it flat?
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Workshop build</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<canvas id="stage" width="640" height="480"></canvas>
<script src="content.js"></script>
<script src="engine.js"></script>
<script src="render.js"></script>
</body>
</html>
`;

const ENGINE = `var state = { mode: "title", score: 0, x: 320, y: 400, targets: [] };

function step(dt) {
  if (state.mode !== "play") return;
  state.score += dt;
  for (var i = 0; i < state.targets.length; i++) {
    state.targets[i].y += TUNING.fallSpeed * dt;
  }
}

function start() {
  state.mode = "play";
  state.score = 0;
  state.targets = [];
}
`;

const RENDER = `function draw(ctx) {
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = PALETTE.player;
  ctx.fillRect(state.x - 8, state.y - 8, 16, 16);
}
`;

const CONTENT = `var TUNING = { fallSpeed: 90, spawnEvery: 1.4, lives: 3 };
var PALETTE = { background: "#10131a", player: "#e8edf6", target: "#d08770" };
`;

const STYLE = `body { margin: 0; background: #0b0d12; display: grid; place-items: center; min-height: 100vh; }
canvas { image-rendering: pixelated; border: 1px solid #2a3040; }
`;

/**
 * A fixed script of edits, applied one per round.
 *
 * Deliberately includes the two things worth exercising that a naive bot would
 * never do: a `patch_file` whose `find` has drifted (so `patchesRefused` is
 * non-zero in a rehearsal trace), and a write to somebody else's file (so
 * `ownershipRefusals` is too). A viewer developed against a trace where every
 * counter is zero has not been developed against anything.
 */
interface Step {
  role: string;
  run: (sim: WorkshopSimulation, round: number) => void;
}

function callTool(sim: WorkshopSimulation, name: string, args: Record<string, unknown>, agent: string): void {
  const found = [...sim.sharedTools(), ...Object.values(sim.tools()).flat()].find((t) => t.name === name);
  if (!found) throw new Error(`the workshop has no tool called "${name}"`);
  // Through the real tool, including its refusal handling, because a bot that
  // reached past the tool surface would verify a code path nothing else uses.
  void found.execute(args, { agentName: agent } as Parameters<typeof found.execute>[1]);
}

const WAVES = "const WAVES = [1, 2, 3];\n";

const SCRIPT: Step[] = [
  { role: "lead", run: (s) => callTool(s, "write_file", { path: "design.md", content: DESIGN }, "lead") },
  { role: "interface", run: (s) => callTool(s, "write_file", { path: "index.html", content: PAGE }, "interface") },
  { role: "author", run: (s) => callTool(s, "write_file", { path: "content.js", content: CONTENT }, "author") },
  { role: "builder", run: (s) => callTool(s, "write_file", { path: "engine.js", content: ENGINE }, "builder") },
  { role: "interface", run: (s) => callTool(s, "write_file", { path: "render.js", content: RENDER }, "interface") },
  { role: "interface", run: (s) => callTool(s, "write_file", { path: "style.css", content: STYLE }, "interface") },
  { role: "tester", run: (s) => callTool(s, "check_syntax", {}, "tester") },
  /*
   * The open arm's own path, so the no-model run exercises it too.
   *
   * These do nothing in the prescribed arm — `claim_file` is not handed out
   * there and `callTool` will not find it — and the try/catch in `act` swallows
   * that, the same way the script already walks into the ownership rule on
   * purpose.
   *
   * Worth having because the alternative is finding a wiring fault in the
   * claim/submit path ninety minutes into a run against a live model.
   */
  {
    role: "author",
    run: (s) => callTool(s, "claim_file", { path: "waves.js", purpose: "wave tables" }, "author"),
  },
  // Somebody else's claim, refused the same way a write to their file is.
  {
    role: "builder",
    run: (s) => callTool(s, "claim_file", { path: "waves.js", purpose: "mine now" }, "builder"),
  },
  {
    role: "author",
    run: (s) => callTool(s, "write_file", { path: "waves.js", content: WAVES }, "author"),
  },
  {
    role: "lead",
    run: (s) => callTool(s, "submit_version", { version: "0.1.0", notes: "it runs" }, "lead"),
  },
  // More work, then a second build — the case the mechanism exists for.
  {
    role: "author",
    run: (s) => callTool(s, "patch_file", { path: "waves.js", find: "1, 2, 3", replace: "1, 2, 3, 5, 8" }, "author"),
  },
  {
    role: "lead",
    run: (s) => callTool(s, "submit_version", { notes: "longer waves" }, "lead"),
  },
  // A role that does not own the submission trying to ship one.
  {
    role: "tester",
    run: (s) => callTool(s, "submit_version", { version: "9.9.9" }, "tester"),
  },
  // The drifted patch: `state.score += dt` is what is actually in the file.
  {
    role: "builder",
    run: (s) =>
      callTool(
        s,
        "patch_file",
        { path: "engine.js", find: "state.score = state.score + dt;", replace: "state.score += dt * 2;" },
        "builder",
      ),
  },
  // The same patch, correct this time.
  {
    role: "builder",
    run: (s) =>
      callTool(
        s,
        "patch_file",
        { path: "engine.js", find: "state.score += dt;", replace: "state.score += dt * TUNING.lives;" },
        "builder",
      ),
  },
  // Somebody else's file.
  {
    role: "author",
    run: (s) => callTool(s, "write_file", { path: "engine.js", content: "// mine now\\n" }, "author"),
  },
  {
    role: "tester",
    run: (s) =>
      callTool(
        s,
        "write_file",
        { path: "defects.md", content: "# Defects\\n\\n- Nothing spawns targets yet.\\n" },
        "tester",
      ),
  },
  { role: "tester", run: (s) => callTool(s, "check_syntax", {}, "tester") },
  {
    role: "author",
    run: (s) =>
      callTool(s, "patch_file", { path: "content.js", find: "fallSpeed: 90", replace: "fallSpeed: 120" }, "author"),
  },
  { role: "lead", run: (s) => callTool(s, "read_file", { path: "engine.js" }, "lead") },
  { role: "interface", run: (s) => callTool(s, "outline_file", { path: "index.html" }, "interface") },
];

export function makeScriptedPolicy(): Policy {
  let at = 0;
  return {
    name: "scripted",
    act(sim: Simulation): void {
      const workshop = sim as WorkshopSimulation;
      // Every round runs one step of the script and then a listing, so a trace
      // has a read in it as well as a write — a viewer that only ever sees
      // writes will draw a run that does not look like a real one.
      const step = SCRIPT[at % SCRIPT.length];
      at += 1;
      try {
        step.run(workshop, workshop.day);
      } catch {
        // A refusal is a legitimate outcome and is already counted inside the
        // simulation. Swallowing it here is what makes the bot able to walk
        // into the ownership rule on purpose.
      }
      try {
        callTool(workshop, "list_files", {}, step.role);
      } catch {
        // Same.
      }
    },
  };
}
