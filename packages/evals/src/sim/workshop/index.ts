/**
 * Five agents, a brief, and a directory that still exists when the run ends.
 *
 * The first scenario in this package with no score. Every other one answers a
 * question the package can settle by itself — did they reach the state, beat
 * the baseline, earn the experience — and this one asks the question nothing
 * here is shaped to ask: *is the thing they built any good*. That is handed to
 * a person, and the simulation's job is to give them something worth opening
 * and enough of a record to understand how it got that way.
 *
 * ## What it measures that nothing else here can
 *
 * **Whether a team stays coherent past its own context window.** Twenty rounds
 * at twelve turns is 240 model calls, and the history budget will trim the
 * conversation that agreed the plan long before the run ends. What survives is
 * whatever the team wrote down — `design.md`, the file layout, the code itself.
 * A descent run measures memory through one hidden-rule recurrence per run; here
 * the whole artifact is the memory, and a team that forgot round four's decision
 * contradicts itself in a file you can read.
 *
 * **Whether channels are worth having.** The descent puts everybody in one room
 * deliberately, and that room is the single largest consumer of the history
 * budget. This scenario ships a channel graph instead, with the lead as the only
 * agent in all three — so a decision taken in one channel reaches another only
 * if somebody carries it. Whether that helps is an open question with a control
 * arm attached; see the scenario.
 *
 * ## The three things kept out on purpose
 *
 * *No score.* `objective()` returns 0 and `metrics()` reports activity. The
 * schema forbids a `review:` scenario from asserting on either, because the
 * moment `linesWritten` can be asserted on, the benchmark is measuring typing.
 *
 * *No execution.* `check_syntax` parses and never runs. See `check.ts`.
 *
 * *No hidden information.* Every agent can read every file. The asymmetry is in
 * who may *write* — the one partition a build task survives, because hiding the
 * code from the person writing it makes the artifact worse, and the artifact is
 * the deliverable.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@tailored-ai/core";
import { agentTool, num, tool } from "../tool.js";
import {
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationOptions,
} from "../types.js";
import { type Brief, DEFAULT_BRIEF, getBrief, renderBrief, type WorkshopRole } from "./briefs.js";
import { checkWorkspace, formatCheck } from "./check.js";
import { formatPlaytest, playtest } from "./playtest.js";
import { makeScriptedPolicy } from "./policies.js";
import { JUDGING, pickTheme, renderScorecard, type Theme } from "./themes.js";
import { LIMITS, Workspace, WorkspaceRefusal } from "./workspace.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const WORKSHOP_ROLES: WorkshopRole[] = ["lead", "builder", "interface", "author", "tester"];

/**
 * The configuration the scenario plays, declared here so `bench` and `rehearse`
 * exercise the same game.
 *
 * The descent learned this the expensive way: swept at its constructor defaults
 * its ladder read a five-point gap that said the information advantage was
 * worthless, and swept at the scenario's own options the same code read a real
 * one. Both were true statements about *a* game; only the second was about the
 * game being played.
 */
export const WORKSHOP_PLAY_OPTIONS = {
  brief: DEFAULT_BRIEF,
  ownership: "strict",
  checks: "tester",
} as const;

interface WorkshopOptions extends SimulationOptions {
  brief?: string;
  /** `strict` partitions writing by role; `shared` lets anybody write anything. */
  ownership?: string;
  /** `tester` gives verification to one role; `anyone` hands it to everybody. */
  checks?: string;
  /** Where the artifact goes. Defaults under `results/workshops/`. */
  root?: string;
  /** Injected by tests so a run directory name is stable. */
  stamp?: string;
  /** The jam theme: an id from `themes.ts`, or free text to use verbatim. */
  theme?: string;
}

/** A refusal an agent should read and act on, rather than a crash. */
function refuse(message: string): never {
  throw new WorkspaceRefusal(message);
}

export class WorkshopSimulation implements Simulation {
  readonly name = "workshop";
  /**
   * A workshop with nobody in it does nothing.
   *
   * The descent sets this for a sharper reason — an unattended party is eaten,
   * so every unattended tick manufactures damage nobody chose to take. Here the
   * consequence is milder and still wrong: running on would advance the clock
   * past the roster, and the round count in the report would stop meaning turns
   * taken. The agents' horizon *is* the run.
   */
  readonly runsOnUnattended = false;

  readonly brief: Brief;
  readonly workspace: Workspace;
  readonly events: SimEvent[] = [];
  readonly root: string;

  private tick = 0;
  private readonly horizon: number;
  private readonly strictOwnership: boolean;
  private readonly checksAreTesterOnly: boolean;

  /** Counters. Every one of them is a fact about process, and none is a score. */
  private counts = {
    writes: 0,
    patches: 0,
    deletes: 0,
    patchesRefused: 0,
    ownershipRefusals: 0,
    budgetRefusals: 0,
    pathRefusals: 0,
    reads: 0,
    outlines: 0,
    listings: 0,
    checksRun: 0,
    playtestsRun: 0,
  };

  private lastCheck: { problems: number; filesChecked: number; atRound: number } | undefined;
  private lastPlaytest:
    | { ok: boolean; errors: number; animates: boolean; responds: boolean; atRound: number }
    | undefined;
  /** Who may call `playtest`. Undefined means everybody. */
  private readonly playtestRoles: string[] | undefined;
  /** The jam's theme, which is the creative constraint the work is judged against. */
  readonly theme: Theme;
  private roundsWithNoWrite = 0;
  private writesThisRound = 0;
  private finalised = false;

  constructor(options: WorkshopOptions) {
    this.brief = getBrief(options.brief ?? WORKSHOP_PLAY_OPTIONS.brief);
    this.horizon = Math.max(1, Math.floor(options.days ?? 20));
    this.strictOwnership = String(options.ownership ?? WORKSHOP_PLAY_OPTIONS.ownership) !== "shared";
    this.checksAreTesterOnly = String(options.checks ?? WORKSHOP_PLAY_OPTIONS.checks) !== "anyone";
    this.theme = pickTheme(options.theme, Number(options.seed ?? 0));
    // The tester verifies; the interface draws. Asking somebody to draw a screen
    // they are never allowed to look at is a handicap, not a constraint.
    this.playtestRoles = this.checksAreTesterOnly ? ["tester", "interface"] : undefined;

    // A timestamp rather than the seed alone, because two runs of the same
    // scenario at the same seed are two different artifacts and overwriting the
    // first with the second would destroy the thing the run exists to produce.
    const stamp = String(options.stamp ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
    this.root = String(
      options.root ?? join(packageRoot, "results", "workshops", `${this.brief.id}-${options.seed ?? 0}-${stamp}`),
    );
    this.workspace = new Workspace(this.root);

    for (const file of this.brief.layout) {
      this.workspace.plan(file.path, { owner: file.owner, purpose: file.purpose });
    }

    // The brief on disk as well as in the prompt. Both matter, for different
    // reasons: the instructions are what an agent sees on turn one, and the file
    // is what it can still read on turn two hundred once the history budget has
    // trimmed away the conversation that set the whole thing up.
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, "brief.md"), `${this.jamBrief()}\n`);
    // The scorecard is written at the start, not the end: a run that dies
    // half-way still leaves a reviewer the questions to ask of what survived.
    writeFileSync(join(this.root, "JUDGING.md"), `${renderScorecard(this.theme, this.horizon, this.brief.entry)}\n`);

    // Announced as an event rather than a metric, because a path is not a
    // number and `metrics()` only carries numbers. This is how the report and
    // the review bundle find the artifact.
    this.events.push({ day: 0, kind: "artifact", message: this.root });
  }

  /**
   * The brief, with the jam wrapped around it.
   *
   * The theme is chosen at construction from a seed, so no scenario file can
   * state it — which is exactly what `briefFor` exists for. It goes in the
   * instructions *and* in `brief.md`, because the instructions are what an
   * agent reads on turn one and the file is what it can still read on turn two
   * hundred once the history budget has trimmed the conversation away.
   */
  private jamBrief(): string {
    return [
      `# GAME JAM — theme: ${this.theme.title}`,
      "",
      `You have **${this.horizon} rounds**. That is the whole jam; when it runs out, whatever exists is`,
      "what gets submitted. A person is going to open it, play it, and score it.",
      "",
      `## The theme is ${this.theme.title}`,
      "",
      "It is a constraint on the *mechanics*, not a title. The laziest possible reading of it —",
      `${this.theme.shallow} — is the one that scores worst, and it is the first thing a judge checks.`,
      "Decide in round one what your reading of it is, write that down, and build the game that",
      "reading demands. If the theme could be removed without the game changing, you have not used it.",
      "",
      "## How you will be judged",
      "",
      ...JUDGING.map((c) => `- **${c.name}** — ${c.question}`),
      "",
      "Nothing about how much you wrote is scored. A small finished game beats a large unfinished one.",
      "",
      "---",
      "",
      renderBrief(this.brief),
    ].join("\n");
  }

  get day(): number {
    return this.tick;
  }

  get done(): boolean {
    return this.tick >= this.horizon;
  }

  get endedBecause(): string | undefined {
    return this.done ? `the ${this.horizon} rounds ran out` : undefined;
  }

  /**
   * One round boundary: freeze what exists, then move the clock.
   *
   * The freeze is what turns a run into a timeline rather than an ending. It is
   * what the broadcast's preview panel points at, and it is what makes "round
   * fourteen is where it broke" a claim anybody can check rather than a thing
   * you remember watching.
   */
  advance(): SimEvent[] {
    if (this.done) return [];
    const produced: SimEvent[] = [];
    this.workspace.snapshot(this.tick);
    if (this.writesThisRound === 0) this.roundsWithNoWrite += 1;
    this.writesThisRound = 0;
    this.tick += 1;
    if (this.done) {
      this.finalise();
      produced.push({ day: this.tick, kind: "ended", message: `The ${this.horizon} rounds ran out.` });
    }
    return produced;
  }

  /**
   * The line posted in every channel at the top of each round.
   *
   * Load-bearing rather than decoration, for the reason the harness documents:
   * `pollOnce` runs no turn when a room has nothing new in it, so on a round
   * where nobody happened to post, every agent would sleep while the clock ran
   * to the horizon — and the report would show a team that chose to say nothing.
   *
   * It says only what the whole team may know, which here is everything: the
   * workspace is readable by all, so there is nothing in this line to leak.
   */
  announce(): string {
    const files = this.workspace.list().filter((f) => !f.planned);
    const lines = files.reduce((sum, f) => sum + f.lines, 0);
    const check = this.lastCheck
      ? this.lastCheck.problems === 0
        ? `last check (round ${this.lastCheck.atRound + 1}): everything parsed`
        : `last check (round ${this.lastCheck.atRound + 1}): ${this.lastCheck.problems} problem${this.lastCheck.problems === 1 ? "" : "s"}`
      : "nothing has been checked yet";
    const remaining = this.horizon - this.tick;
    const played = this.horizon - remaining;
    const fraction = played / this.horizon;
    // A jam clock rather than a round counter. The phases are what stop a team
    // adding a feature in the last round and shipping it half-wired — the first
    // twenty-round run reached a complete v1 by round three and then had
    // seventeen rounds with nothing to do, which is a scheduling problem the
    // announcement can actually address.
    const phase =
      fraction < 0.2
        ? "CONCEPT — decide your reading of the theme and write it down. Do not start building until it is agreed."
        : fraction < 0.7
          ? "BUILD — make the game the theme demands."
          : fraction < 0.9
            ? "POLISH — no new features. Play it, fix what is wrong, make it look considered."
            : "SUBMIT — freeze the code. Finish `submission.md` and make sure every state resolves.";
    const seen = this.lastPlaytest
      ? this.lastPlaytest.ok
        ? `last playtest (round ${this.lastPlaytest.atRound + 1}): ${this.lastPlaytest.errors} console errors, ` +
          `${this.lastPlaytest.animates ? "animates" : "static"}, ` +
          `${this.lastPlaytest.responds ? "responds to input" : "no response to input"}`
        : `last playtest (round ${this.lastPlaytest.atRound + 1}) could not run it`
      : "nobody has run it yet";
    // Past the horizon there is no round to announce, and saying "round 17 of
    // 16" is the kind of small wrongness that makes a reader distrust every
    // other number on the page.
    if (remaining <= 0) {
      return (
        `The ${this.horizon} rounds are over. ` +
        `${files.length} file${files.length === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}; ${check}.`
      );
    }
    return (
      `Round ${this.tick + 1} of ${this.horizon} — theme ${this.theme.title}. ${phase} ` +
      `${seen}. ` +
      `${files.length} file${files.length === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}; ${check}. ` +
      (remaining <= 3
        ? `${remaining} round${remaining === 1 ? "" : "s"} left — finish what exists rather than starting anything.`
        : `${remaining} rounds left.`)
    );
  }

  /**
   * The brief, delivered where it will still be read on turn two hundred.
   *
   * The descent measured what happens otherwise. A traitor's objective was
   * delivered thirteen times as the first line of a tool result, correctly
   * scoped, and across nineteen rounds the agent's private reasoning referenced
   * it zero times while it played a textbook loyal cleric. One line of
   * transient data against a persistent instruction is not a fair fight.
   *
   * The brief is chosen at construction (`--sim-option brief=…`), so the
   * scenario cannot state it; this is the only durable channel a simulation has
   * to an agent, and it is exactly what it is for.
   */
  briefFor(role: string): string | undefined {
    // With ownership off, a role-specific "your part" is not merely unhelpful,
    // it is wrong: the solo arm plays every role through one agent, and telling
    // it that it owns `design.md` and nothing else would describe a partition
    // that is not in force. The one thing worth saying then is that all of it
    // is theirs.
    if (!this.strictOwnership) {
      return [
        this.jamBrief(),
        "",
        "## Your part",
        "",
        "Every file in that layout is yours to write. The owners named above are how the work would be " +
          "divided if there were more of you; in this run there is nothing stopping you writing any of it.",
      ].join("\n");
    }
    const mine = this.brief.layout.filter((f) => f.owner === role);
    return [
      this.jamBrief(),
      "",
      "## Your part",
      "",
      mine.length
        ? `You are the only one who can write ${mine.map((f) => `\`${f.path}\``).join(", ")}. ` +
          "Everybody can read them. If somebody else needs a change in one of your files, they have to " +
          "ask you, and you have to actually make it."
        : "You do not own any file in the layout. Work through the people who do.",
      "",
      "Writing to a file you do not own is refused. That is not a bug to work around — it is how the " +
        "work is divided, and the way through it is to ask.",
    ].join("\n");
  }

  /** Nobody may write here but its owner — unless ownership is off for this run. */
  private assertMayWrite(path: string, agent: string | undefined): void {
    if (!this.strictOwnership) return;
    const owner = this.workspace.ownerOf(path);
    if (!owner) return;
    if (owner === agent) return;
    this.counts.ownershipRefusals += 1;
    refuse(
      `"${path}" belongs to the ${owner}. You can read it, and you cannot write it. ` +
        `Ask ${owner} in the channel you share.`,
    );
  }

  /**
   * Turn a refusal into a counted one.
   *
   * Which counter fires is the diagnostic. `patchesRefused` climbing means the
   * agents' model of a file stopped matching the file — the single most useful
   * signal this simulation produces, and it is free to collect.
   */
  private classify<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (/is not in "|appears more than once|`find` and `replace`/.test(message)) this.counts.patchesRefused += 1;
      else if (/bytes|limit/.test(message)) this.counts.budgetRefusals += 1;
      else if (/path|extension|name|deeply|upwards/.test(message)) this.counts.pathRefusals += 1;
      throw err;
    }
  }

  private describeList(): string {
    const files = this.workspace.list();
    const real = files.filter((f) => !f.planned);
    const rows = files.map((f) => {
      const owner = f.owner ? ` [${f.owner}]` : "";
      if (f.planned)
        return `  ${f.path.padEnd(18)}${owner}  (not created yet) — ${this.workspace.purposeOf(f.path) ?? ""}`;
      const who = f.lastWriter ? ` last written by ${f.lastWriter} in round ${(f.lastRound ?? 0) + 1}` : "";
      return `  ${f.path.padEnd(18)}${owner}  ${f.lines} lines, ${f.bytes} bytes;${who || " unchanged"}`;
    });
    const total = real.reduce((s, f) => s + f.bytes, 0);
    return [
      `${real.length} file${real.length === 1 ? "" : "s"}, ${total.toLocaleString("en-US")} of ` +
        `${LIMITS.totalBytes.toLocaleString("en-US")} bytes used.`,
      ...rows,
    ].join("\n");
  }

  /**
   * Instruments everybody holds.
   *
   * `write_file`, `patch_file` and `delete_file` live here rather than under a
   * role because `simulationGrants` registers tools by *name*: two roles
   * exporting a `write_file` would not get one each, they would both get
   * whichever was built last. A tool whose behaviour depends on who picked it
   * up belongs in `sharedTools()`, where `agentTool` can read the caller — the
   * machinery is public, the hands on it are not.
   */
  sharedTools(): Tool[] {
    /**
     * Mark some of a tool's parameters as genuinely optional.
     *
     * `tool()` makes every declared parameter required, which is right for an
     * instrument where all the arguments matter and wrong for `read_file`,
     * whose `from`/`to` describe an optional window. Saying "Optional" in the
     * description and `required` in the schema is worse than either alone: core
     * validates against the schema and refuses the call *before* `execute`
     * runs, so a model that read the description and did the correct thing got
     * a refusal with no `call` event in the trace — the same shape as the
     * string/number bug in `tool.ts`, from the other direction.
     *
     * Post-processing rather than a new parameter on `tool()`, because the
     * shared helper is used by three simulations and this concerns one tool.
     */
    const optional = (built: Tool, ...keys: string[]): Tool => ({
      ...built,
      parameters: {
        ...built.parameters,
        required: (built.parameters.required as string[]).filter((k) => !keys.includes(k)),
      },
    });

    const shared: Tool[] = [
      tool(
        "list_files",
        "List every file in the workspace with its size, who last wrote it, and what the brief expects to exist.",
        {},
        () => {
          this.counts.listings += 1;
          return this.describeList();
        },
        "read",
      ),
      optional(
        tool(
          "read_file",
          `Read part of a file, with line numbers. Returns ${LIMITS.readLines} lines from the start unless you give a range.`,
          {
            path: "Which file, relative to the workspace, like index.html",
            from: "First line to read. Optional; defaults to 1.",
            to: "Last line to read. Optional.",
          },
          (args) => {
            this.counts.reads += 1;
            const path = String(args.path ?? "");
            const from = args.from === undefined || args.from === "" ? undefined : num(args.from, 1);
            const to = args.to === undefined || args.to === "" ? undefined : num(args.to, 1);
            const slice = this.workspace.slice(path, from, to);
            const tail =
              slice.to < slice.total
                ? `\n… lines ${slice.to + 1}-${slice.total} not shown. Read again with from=${slice.to + 1}, or use outline_file.`
                : "";
            return `${path}, lines ${slice.from}-${slice.to} of ${slice.total}:\n${slice.text}${tail}`;
          },
          "read",
        ),
        "from",
        "to",
      ),
      tool(
        "outline_file",
        "List a file's headings and top-level definitions with their line numbers. How to find your way around a long file without reading it.",
        { path: "Which file to outline." },
        (args) => {
          this.counts.outlines += 1;
          return this.workspace.outline(String(args.path ?? ""));
        },
        "read",
      ),
      tool(
        "read_brief",
        "Read the brief again: what is being built, the constraints, and who writes which file.",
        {},
        () => renderBrief(this.brief),
        "read",
      ),
      agentTool(
        "write_file",
        "Write a whole file, creating it or replacing everything in it. For changing part of an existing file, patch_file is safer.",
        { path: "Which file, relative to the workspace.", content: "The complete new contents of the file." },
        (args, agent) =>
          this.classify(() => {
            const path = String(args.path ?? "");
            this.assertMayWrite(path, agent);
            const content = String(args.content ?? "");
            const edit = this.workspace.write(path, content, agent ?? "unknown", this.tick);
            this.counts.writes += 1;
            this.writesThisRound += 1;
            const delta = edit.linesAfter - edit.linesBefore;
            return (
              `${edit.kind === "create" ? "Created" : "Replaced"} ${path}: ${edit.linesAfter} lines` +
              (edit.kind === "create" ? "." : ` (${delta >= 0 ? "+" : ""}${delta}).`)
            );
          }),
      ),
      agentTool(
        "patch_file",
        "Replace one exact passage of a file with another. Refuses unless `find` appears exactly once, so it cannot change the wrong one.",
        {
          path: "Which file to change.",
          find: "The exact current text to replace, including its indentation.",
          replace: "What to put there instead.",
        },
        (args, agent) =>
          this.classify(() => {
            const path = String(args.path ?? "");
            this.assertMayWrite(path, agent);
            const edit = this.workspace.patch(
              path,
              String(args.find ?? ""),
              String(args.replace ?? ""),
              agent ?? "unknown",
              this.tick,
            );
            this.counts.patches += 1;
            this.writesThisRound += 1;
            const delta = edit.linesAfter - edit.linesBefore;
            return `Patched ${path}: now ${edit.linesAfter} lines (${delta >= 0 ? "+" : ""}${delta}).`;
          }),
      ),
      agentTool(
        "delete_file",
        "Delete a file from the workspace. Only for something genuinely not needed.",
        { path: "Which file to delete." },
        (args, agent) =>
          this.classify(() => {
            const path = String(args.path ?? "");
            this.assertMayWrite(path, agent);
            this.workspace.remove(path, agent ?? "unknown", this.tick);
            this.counts.deletes += 1;
            this.writesThisRound += 1;
            return `Deleted ${path}.`;
          }),
      ),
    ];

    if (!this.checksAreTesterOnly) shared.push(this.checkTool());
    // Always handed out, and gated inside by who picked it up — the same shape
    // `write_file` uses. A tool registered per-role could not be given to two
    // of them: `simulationGrants` registers by name, so both would get whichever
    // was built last.
    shared.push(this.playtestTool());
    return shared;
  }

  private checkTool(): Tool {
    return tool(
      "check_syntax",
      "Parse every file in the workspace and report syntax errors, unclosed tags, and references to files that do not exist. Nothing is run.",
      {},
      () => {
        this.counts.checksRun += 1;
        const report = checkWorkspace(this.workspace);
        this.lastCheck = { problems: report.problems.length, filesChecked: report.filesChecked, atRound: this.tick };
        return formatCheck(report, this.brief.entry, this.workspace);
      },
      "read",
    );
  }

  /**
   * The one instrument that actually runs the artifact.
   *
   * Built by hand rather than through `tool()`, because opening a browser is
   * asynchronous and the shared helper takes a synchronous handler. Everything
   * else about it matches: a failure is a refusal the agent reads, never a
   * crash, because a headless browser that will not start must not end a run
   * whose model time has already been spent.
   *
   * Held by the **tester and the interface**. The tester because verifying is
   * its job; the interface because it is the one drawing, and asking somebody
   * to draw a screen they are never allowed to look at is not a constraint,
   * it is a handicap. Those two share no channel but `studio`, which makes
   * "what did you actually see" a thing that has to be said out loud.
   */
  private playtestTool(): Tool {
    return {
      name: "playtest",
      description:
        "Open the artifact in a real browser, press keys at it, and report what appeared: console errors, " +
        "whether it animates, whether it responds to input, and a coarse picture of the screen.",
      parameters: { type: "object", properties: {}, required: [] },
      effect: "read",
      execute: async (_args, context) => {
        const agent = context?.agentName;
        if (this.playtestRoles && agent && !this.playtestRoles.includes(agent)) {
          return {
            success: true,
            output:
              `Refused: playtest belongs to ${this.playtestRoles.join(" and ")}. ` +
              "Ask one of them to run it and say what they saw.",
          };
        }
        this.counts.playtestsRun += 1;
        const report = await playtest({
          entry: this.brief.entry,
          workspace: this.workspace.filesRoot,
          shotDir: join(this.root, "playtests", `round-${String(this.tick).padStart(3, "0")}`),
        });
        this.lastPlaytest = {
          ok: report.ok,
          errors: report.errors.length,
          animates: report.animates,
          responds: report.respondsToInput,
          atRound: this.tick,
        };
        return { success: true, output: formatPlaytest(report, this.brief.entry) };
      },
    };
  }

  /**
   * Verification as something somebody has to ask for.
   *
   * The one deliberately artificial constraint in the design, and the most
   * interesting one: handing `check_syntax` to a single role makes "has anybody
   * checked this" a question the team has to notice it should be asking. Set
   * `checks=anyone` for the arm where everybody can see for themselves.
   */
  tools(): Record<string, Tool[]> {
    const byRole: Record<string, Tool[]> = {};
    for (const role of WORKSHOP_ROLES) byRole[role] = [];
    if (this.checksAreTesterOnly) byRole.tester = [this.checkTool()];
    return byRole;
  }

  /**
   * Freeze the finished artifact and leave a manifest beside it.
   *
   * `rounds/` holds a directory per round boundary, and the last round never
   * reaches one — the harness stops calling `advance()` when the roster runs
   * out. Without this the final state would exist only in `workspace/`, which
   * is correct but leaves the timeline one frame short of the thing being
   * reviewed.
   */
  private finalise(): void {
    if (this.finalised) return;
    this.finalised = true;

    /*
     * The last round is played but never gets a boundary, so count it here.
     *
     * `runRoomScenario` calls `advance()` *between* rounds — N rounds produce
     * N-1 boundaries — and then stops when the roster runs out. A simulation
     * whose only ending is the horizon therefore never reaches it: `done` stays
     * false, `endedBecause` stays undefined, and the run reports one fewer
     * round than it played.
     *
     * The descent hides this because its runs usually end in a wipe, which sets
     * `done` from inside. Measured here on 2026-08-20: a three-round smoke that
     * announced rounds 0, 1 and 2 and took all 33 of its turns reported
     * `roundsPlayed 2` and wrote an `end` event with no reason on it at all.
     *
     * Clamped, so the path where `advance()` reached the horizon itself stays
     * idempotent. A run killed early still counts the round it was in, which is
     * honest: those turns were taken.
     */
    if (this.writesThisRound === 0) this.roundsWithNoWrite += 1;
    this.tick = Math.min(this.tick + 1, this.horizon);

    this.workspace.snapshot(this.tick);
    const check = checkWorkspace(this.workspace);
    writeFileSync(
      join(this.root, "manifest.json"),
      `${JSON.stringify(
        {
          brief: this.brief.id,
          theme: this.theme.title,
          themeId: this.theme.id,
          judging: JUDGING.map((c) => c.key),
          title: this.brief.title,
          entry: this.brief.entry,
          rounds: this.horizon,
          ownership: this.strictOwnership ? "strict" : "shared",
          checks: this.checksAreTesterOnly ? "tester" : "anyone",
          files: this.workspace.list().filter((f) => !f.planned),
          problems: check.problems,
          snapshots: this.workspace.snapshots,
          edits: this.workspace.edits,
        },
        null,
        2,
      )}\n`,
    );
  }

  /**
   * Activity, never achievement.
   *
   * Every number here is a fact about process — how much was written, how often
   * a patch missed, how often somebody reached for a file that was not theirs.
   * None of them says whether the artifact is any good, and `schema.ts` refuses
   * to let a `review:` scenario assert on one so that nobody can quietly decide
   * otherwise later.
   *
   * The two worth reading first are `patchesRefused` and `roundsWithNoWrite`.
   * The first climbs when the team's model of a file has drifted from the file;
   * the second climbs when they are talking instead of building.
   */
  /**
   * The harness saying the roster has run out. See `Simulation.finish`.
   *
   * Separate from `metrics()` calling `finalise()` because the trace's closing
   * `end` event is written *before* the report asks for metrics, so relying on
   * `metrics()` alone left the trace saying the run stopped for no reason while
   * the report knew perfectly well why.
   */
  finish(): void {
    this.finalise();
  }

  metrics(): SimMetrics {
    this.finalise();
    return this.counters();
  }

  /**
   * The counters, without the side effect of finishing the run.
   *
   * Split out because `snapshot()` has to carry every one of them and is called
   * after every turn, while `metrics()` freezes the final artifact and writes a
   * manifest. Folding the two together would rewrite the manifest two hundred
   * times per run and — worse — would mark the run finished on turn one.
   */
  private counters(): SimMetrics {
    const files = this.workspace.list().filter((f) => !f.planned);
    const check = checkWorkspace(this.workspace);
    const writers = new Set(files.map((f) => f.lastWriter).filter(Boolean));
    return {
      roundsPlayed: this.tick,
      filesPresent: files.length,
      linesInWorkspace: files.reduce((sum, f) => sum + f.lines, 0),
      bytesInWorkspace: files.reduce((sum, f) => sum + f.bytes, 0),
      writes: this.counts.writes,
      patches: this.counts.patches,
      deletes: this.counts.deletes,
      patchesRefused: this.counts.patchesRefused,
      ownershipRefusals: this.counts.ownershipRefusals,
      budgetRefusals: this.counts.budgetRefusals,
      pathRefusals: this.counts.pathRefusals,
      reads: this.counts.reads,
      outlines: this.counts.outlines,
      checksRun: this.counts.checksRun,
      playtestsRun: this.counts.playtestsRun,
      // -1 for "nobody has run it", so a board can tell "not tried" from "tried
      // and it was static" — the difference between an untested game and a
      // broken one.
      playtestAnimates: this.lastPlaytest ? (this.lastPlaytest.animates ? 1 : 0) : -1,
      playtestResponds: this.lastPlaytest ? (this.lastPlaytest.responds ? 1 : 0) : -1,
      playtestErrors: this.lastPlaytest ? this.lastPlaytest.errors : -1,
      // Two different questions, and the gap between them is the interesting
      // one. `checkProblems` is what a check would say right now; the team
      // cannot see it unless somebody runs one. `lastCheckProblems` is what
      // they were actually told, and `-1` means nobody has ever asked.
      checkProblems: check.problems.length,
      lastCheckProblems: this.lastCheck?.problems ?? -1,
      roundsSinceCheck: this.lastCheck === undefined ? this.tick : this.tick - this.lastCheck.atRound,
      distinctWriters: writers.size,
      roundsWithNoWrite: this.roundsWithNoWrite,
      entryExists: this.workspace.exists(this.brief.entry) ? 1 : 0,
      plannedFilesMade: this.brief.layout.filter((f) => this.workspace.exists(f.path)).length,
    };
  }

  /**
   * Zero, on purpose, and this is the honest answer rather than a placeholder.
   *
   * The `Simulation` contract requires a headline figure so a report can rank
   * runs without knowing the domain. This simulation's whole premise is that
   * its runs cannot be ranked without a person, so the only truthful number to
   * return is one that ranks nothing. A scoreboard reading it sees a flat line,
   * which is exactly what it should see.
   */
  objective(): number {
    return 0;
  }

  /**
   * Enough for a viewer to draw, with the headline numbers at the top level.
   *
   * The flat scalars are not stylistic. The developer viewer's generic fallback
   * filters a snapshot to `typeof v !== "object"` and renders what is left —
   * its own comment says a new simulation should be watchable the day it is
   * written — so nesting everything would hand it an empty board.
   */
  snapshot(): Record<string, unknown> {
    return {
      // Every metric, because the live milestone scorer rebuilds a partial run
      // from the trace and reads this object *as* the run's metrics. A
      // simulation whose snapshot carries only display fields silently
      // disables every `sim_metric` milestone for the whole run — a descent run
      // reported one milestone of fifteen on screen while the party was
      // clearing floors. This scenario has no milestones to disable, and the
      // convention is undocumented enough that the next author would not know
      // either; `descent-sim.test.ts` holds it across every simulation.
      ...this.counters(),
      round: this.tick,
      rounds: this.horizon,
      brief: this.brief.id,
      workshop: {
        root: this.root,
        entry: this.brief.entry,
        title: this.brief.title,
        files: this.workspace.list(),
        recentEdits: this.workspace.edits.slice(-12),
      },
    };
  }
}

registerSimulation(
  "workshop",
  (options) => new WorkshopSimulation(options as WorkshopOptions),
  // No baseline ladder. A scripted policy that types plausible files exists in
  // `policies.ts` for developing the viewer against, and it is registered here
  // so `rehearse` can reach it — but it is not a rung on anything, because
  // there is nothing to be a rung of.
  { scripted: () => makeScriptedPolicy() },
  // Ranked by `objective`, which is always zero here. Correct rather than
  // lazy: a scoreboard pointed at these runs should show a flat line, because
  // that is what a set of runs nobody scored looks like.
  { key: "objective" },
);

export type { Brief, WorkshopRole } from "./briefs.js";
export { getBrief, listBriefs, renderBrief } from "./briefs.js";
export { makeScriptedPolicy } from "./policies.js";
