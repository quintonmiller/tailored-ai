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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ContentPart, type MediaStore, mediaPart, type Tool, textPart } from "@tailored-ai/core";
import { agentTool, num, optional, tool } from "../tool.js";
import {
  type RunContext,
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationOptions,
} from "../types.js";
import { ArcadeDesk, openArcade } from "./arcade.js";
import { type Brief, DEFAULT_BRIEF, getBrief, renderBrief, type WorkshopRole } from "./briefs.js";
import { checkWorkspace, formatCheck } from "./check.js";
import { formatPlaytest, framesToShow, playtest } from "./playtest.js";
import { makeScriptedPolicy } from "./policies.js";
import { JUDGING, pickTheme, renderScorecard, type Theme } from "./themes.js";
import { LIMITS, Workspace, WorkspaceRefusal } from "./workspace.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const WORKSHOP_ROLES: WorkshopRole[] = ["lead", "builder", "interface", "author", "tester"];

/**
 * The version of the game being played, recorded on every arcade entry.
 *
 * Bump it whenever a change would make two runs incomparable — a new tool, a
 * changed brief, a different round budget, a rule the agents can feel. The git
 * sha is also recorded and is more precise; this is the coarse one, because
 * "these forty entries played the same game" is the question a board actually
 * gets asked and no human reads that off a sha.
 */
export const WORKSHOP_VERSION = "workshop-5-open";

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
  direction: "open",
} as const;

interface WorkshopOptions extends SimulationOptions {
  brief?: string;
  /** `strict` partitions writing by role; `shared` lets anybody write anything. */
  ownership?: string;
  /** `tester` gives verification to one role; `anyone` hands it to everybody. */
  checks?: string;
  /**
   * How much of the *how* the brief supplies.
   *
   * `prescribed` names eight files, their owners and a paragraph defining done,
   * which is what every entry before `workshop-5` played. `open` states the
   * goal and the medium and leaves structure to the team, who claim files as
   * they go.
   *
   * The control arm exists because de-prescribing is not obviously an
   * improvement: a team handed a layout has orientation on turn one, and a team
   * that has to invent one may spend rounds on it and arrive somewhere worse.
   * Twelve prescribed runs produced a byte-identical file set, so the *sameness*
   * is not in question; whether the games get better is, and only a pair of arms
   * on the same code can answer it.
   */
  direction?: string;
  /** Where the artifact goes. Defaults under `results/workshops/`. */
  root?: string;
  /** Injected by tests so a run directory name is stable. */
  stamp?: string;
  /** The jam theme: an id from `themes.ts`, or free text to use verbatim. */
  theme?: string;
  /**
   * `off` runs the jam with no arcade at all: no entry, no tools, no publish.
   *
   * Note that `on` is not enough on its own — see the constructor. The arcade
   * also needs either a `run` context or an explicit `arcadeHome`, so that
   * merely constructing this simulation never writes to a database that
   * outlives the process.
   */
  arcade?: string;
  /** Where the arcade keeps its data. Tests point this at a temporary directory. */
  arcadeHome?: string;
  /**
   * What is running this, handed down by the harness.
   *
   * A simulation is normally told nothing about the model — correctly, since
   * nothing it does should depend on one. The arcade is the exception and it is
   * not really an exception: the *page* records which model built the game,
   * because a board of a hundred entries with no provenance cannot answer the
   * one question it exists to answer. Absent under `bench` and `rehearse`,
   * which have no model at all.
   */
  run?: RunContext;
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
    /**
     * Files claimed in the open arm.
     *
     * Reads against `ownershipRefusals`: claims low and refusals high is a team
     * that started writing before it divided the work, which is the failure the
     * prescribed layout used to prevent for free.
     */
    claims: 0,
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
  /** The team's page on the arcade. Undefined when the arcade is off or unreachable. */
  private readonly desk: ArcadeDesk | undefined;
  /**
   * The role that speaks for the team on the arcade.
   *
   * Whoever owns `submission.md`: the arcade page and that file are the same
   * document written twice, and splitting them across two agents is how a game
   * ends up pitched two different ways.
   */
  private readonly registrar: string;
  /**
   * Where a screenshot goes so the model can be handed it.
   *
   * Undefined whenever nobody attached one — `bench`, `rehearse` and the unit
   * tests all build a workshop with no runtime behind it — and every read is
   * guarded, because a playtest that cannot show a picture still has a full
   * report to give and must not fail over the missing half.
   */
  private mediaStore: MediaStore | undefined;
  /** How many frames actually reached the model, for the report. */
  private framesShown = 0;
  /** The brief states the goal and leaves structure to the team. */
  private readonly open: boolean;
  /** Edits at the last automatic checkpoint, so an unchanged one is skipped. */
  private lastCheckpointEdits: number | undefined;

  constructor(options: WorkshopOptions) {
    this.brief = getBrief(options.brief ?? WORKSHOP_PLAY_OPTIONS.brief);
    this.horizon = Math.max(1, Math.floor(options.days ?? 20));
    this.strictOwnership = String(options.ownership ?? WORKSHOP_PLAY_OPTIONS.ownership) !== "shared";
    this.checksAreTesterOnly = String(options.checks ?? WORKSHOP_PLAY_OPTIONS.checks) !== "anyone";
    this.open = String(options.direction ?? WORKSHOP_PLAY_OPTIONS.direction) === "open";
    this.theme = pickTheme(options.theme, Number(options.seed ?? 0));
    /*
     * Who is allowed to look at the screen: the tester, the interface, and —
     * since 2026-08-21 — the builder.
     *
     * `check_syntax` is the deliberately artificial constraint, the one that
     * makes "has anybody verified this" a question the team has to notice it
     * should ask. `playtest` was added later and inherited that role list
     * without inheriting the argument for it, which left the agent writing the
     * game loop unable to see the game. The same sentence that justified giving
     * it to the interface — asking somebody to draw a screen they may never
     * look at is a handicap, not a constraint — applies at least as strongly to
     * whoever writes what moves on that screen.
     *
     * Measured on the four runs before this: the workspace stopped growing at
     * round 3 of 20 in one and round 14 in another, while 44% of all agent
     * turns were an explicit `pass`. A team that cannot see its game has no way
     * to falsify "it is finished", and idles for the rest of the jam.
     */
    this.playtestRoles = this.checksAreTesterOnly ? ["tester", "interface", "builder"] : undefined;

    // A timestamp rather than the seed alone, because two runs of the same
    // scenario at the same seed are two different artifacts and overwriting the
    // first with the second would destroy the thing the run exists to produce.
    const stamp = String(options.stamp ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
    this.root = String(
      options.root ?? join(packageRoot, "results", "workshops", `${this.brief.id}-${options.seed ?? 0}-${stamp}`),
    );
    this.workspace = new Workspace(this.root);

    // The open arm plans nothing. `list_files` therefore starts genuinely
    // empty, which is the point: a layout shown from round zero with "(not
    // created yet)" beside each row is orientation, and it is also the reason
    // twelve consecutive runs produced the same eight files.
    if (!this.open) {
      for (const file of this.brief.layout) {
        this.workspace.plan(file.path, { owner: file.owner, purpose: file.purpose });
      }
    }
    this.provideLibrary();

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

    /*
     * Open the team's page at the arcade.
     *
     * A draft, created now rather than when somebody first calls
     * `arcade_register`, for two reasons. The team can read what it has (and
     * has not) written from turn one, which is what makes "still empty:
     * instructions" a thing they can act on. And a run that dies half-way still
     * leaves a row saying it happened — the same argument as writing `brief.md`
     * and the scorecard up here.
     *
     * The whole thing degrades to nothing. `openArcade` swallows a store it
     * cannot open, and every use below is guarded: a locked database costs the
     * team its submission page, not its run.
     */
    const run = options.run;
    /*
     * Two ways in, and neither of them is "by default".
     *
     * A real harness run (which is what a `run` context means) or an explicit
     * home. Everything else — `bench`, `rehearse`, a unit test, a scenario
     * loaded to read its brief — gets no arcade at all.
     *
     * This started as a default-on flag and lasted one test run: the suite
     * constructs this simulation forty-eight times, and forty-eight rows landed
     * in the real database, several of them *published*, because `metrics()`
     * publishes and the tests call it. A convention that tests must remember to
     * pass a temporary home is not a guard; it is a thing somebody forgets in
     * the next test file. Writing to a store that outlives the process should
     * take saying so.
     */
    const wanted = String(options.arcade ?? "on") !== "off" && (run !== undefined || options.arcadeHome !== undefined);
    const store = wanted ? openArcade(options.arcadeHome) : undefined;
    this.registrar = this.brief.layout.find((f) => f.path === "submission.md")?.owner ?? "lead";
    this.desk = store
      ? new ArcadeDesk(
          store,
          {
            runId: basename(this.root),
            scenario: run?.scenario ?? "",
            brief: this.brief.id,
            theme: this.theme.title,
            themeId: this.theme.id,
            rounds: this.horizon,
            seed: options.seed ?? null,
            artifactPath: this.root,
            entryFile: this.brief.entry,
            taiVersion: run?.taiVersion ?? "",
            simVersion: WORKSHOP_VERSION,
            gitSha: run?.gitSha ?? "",
            model: run?.model ?? "",
            provider: run?.provider ?? "",
            baseUrl: run?.baseUrl ?? "",
            modelMeta: run?.modelMeta ?? {},
            credits: run?.roles ?? {},
          },
          // A second belt behind `tools()`, which is the real partition. This
          // one only matters for a direct call — a test, or a policy — and for
          // the solo arm, where every role resolves to the same agent and the
          // per-role grant cannot distinguish anybody.
          this.strictOwnership ? [this.registrar] : undefined,
          // Asked at submit time rather than pushed on the heartbeat: a build
          // submitted mid-round would otherwise be filed under the counters as
          // they stood before any of that round's work.
          () => ({ round: this.tick, metrics: this.counters() }),
        )
      : undefined;
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
      ...(this.open
        ? [
            `You have **${this.horizon} rounds**. That is the whole jam. Submit a build the moment it is`,
            "playable and keep improving it — the last build you submit is the one a person opens, plays",
            "and scores, so nothing you have already put up can be lost by carrying on.",
          ]
        : [
            `You have **${this.horizon} rounds**. That is the whole jam; when it runs out, whatever exists is`,
            "what gets submitted. A person is going to open it, play it, and score it.",
          ]),
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
      ...this.arcadeBrief(),
      "---",
      "",
      renderBrief(this.brief, this.open ? "open" : "prescribed"),
    ].join("\n");
  }

  /**
   * The paragraph about the site, or nothing when there is no site.
   *
   * Split out so the brief reads identically with the arcade off — a control
   * arm that differs by an empty heading is a control arm that differs.
   */
  private arcadeBrief(): string[] {
    if (!this.desk) return [];
    return [
      "## Submitting",
      "",
      "There is an arcade where finished games go. A judge browses it, plays what is there and scores it on",
      "the categories above, and **a game that is not registered on it is a game nobody plays**. The entry is",
      "the page a judge reads before pressing a key: a title, a one-line pitch, what kind of game it is, what",
      "it is and how the theme shaped it, and how to play — which keys, what the goal is, how you lose.",
      "",
      `The ${this.registrar} holds the arcade tools and writes that page; the rest of you do not have them.`,
      `If something about the game changes that the page would be wrong about, tell the ${this.registrar}.`,
      "",
    ];
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
    } else {
      // Round boundaries are the natural heartbeat: roughly every seven
      // minutes, already the moment the snapshot is taken, and the only place
      // that knows the round actually completed. Not sent after `finalise()` —
      // `publish` has already written the final numbers and a heartbeat behind
      // it would be a draft update to a row that is no longer a draft.
      this.desk?.heartbeat(this.counters(), this.newestFrame());
    }
    return produced;
  }

  /**
   * The most recent playtest frame on disk, for the live panel.
   *
   * Reads the directory rather than remembering the path, because the frame
   * worth showing is whichever the last playtest wrote and a run that has not
   * playtested since round four should still show round four's screen. Returns
   * undefined freely: no playtest yet is the normal state for the first few
   * rounds, and the panel is built to say so.
   */
  private newestFrame(): string | undefined {
    const root = join(this.root, "playtests");
    try {
      const rounds = readdirSync(root).sort();
      for (const round of rounds.reverse()) {
        const dir = join(root, round);
        const frames = readdirSync(dir)
          .filter((f) => f.endsWith(".png"))
          .sort();
        // Mid-play if it exists, opening screen otherwise — the same preference
        // `framesToShow` applies, for the same reason.
        const pick = frames.find((f) => f.includes("04-playing")) ?? frames[frames.length - 1];
        if (pick) return join(dir, pick);
      }
    } catch {
      // No playtests directory yet.
    }
    return undefined;
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
    const files = this.workspace.list().filter((f) => !f.planned && !f.provided);
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
    /*
     * The open arm shows a clock and no phases.
     *
     * The ladder below was written to stop a team shipping a half-wired feature
     * in the last round, and it did — by forbidding feature work in ten of
     * twenty rounds and telling teams at 70% to stop adding. Measured on ONE,
     * rounds 4-11 carried 74% of all edits and rounds 12-20 carried 13.5%: the
     * team had already stopped before POLISH began, and then spent the last
     * third re-reading its own files to confirm it was done.
     *
     * What made freezing rational was having one chance to publish. Versions
     * removed that, so the schedule can go too: a team that can submit a build
     * and carry on does not need to be told when to stop, and being told when
     * to stop is the part that capped what got built.
     */
    const phase = this.open
      ? "Build. Submit a build as soon as it is playable, then keep making it better — the last build you submit is the one judged."
      : fraction < 0.2
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
    // Said out loud only once it is late enough to matter. Repeating "not
    // registered" from round one trains the team to read past the line, and the
    // page cannot sensibly be written before there is a game to describe.
    const submission =
      this.desk && !this.desk.registered && fraction >= 0.7
        ? " Nothing is registered on the arcade yet — a game nobody registers is a game nobody plays."
        : "";
    // What is actually on the board, which is the only number that decides what
    // a person ends up playing. Stated every round in the open arm because
    // "nothing submitted yet" at round nine is the single most useful thing the
    // announcement can say, and "0.3.0 is up" is what makes carrying on safe.
    const builds = this.open && this.desk ? ` ${this.describeBuilds()}` : "";
    return (
      `Round ${this.tick + 1} of ${this.horizon} — theme ${this.theme.title}. ${phase}${submission}${builds} ` +
      `${seen}. ` +
      `${files.length} file${files.length === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}; ${check}. ` +
      (remaining <= 3
        ? this.open
          ? `${remaining} round${remaining === 1 ? "" : "s"} left — submit again if what you have now is better than what is up.`
          : `${remaining} round${remaining === 1 ? "" : "s"} left — finish what exists rather than starting anything.`
        : `${remaining} rounds left.`)
    );
  }

  /** "0.3.0 is on the board (round 12)." — or that nothing is. */
  private describeBuilds(): string {
    const builds = this.desk?.submitted ?? [];
    const newest = builds[0];
    if (!newest) return "Nothing is on the board yet — submit as soon as it is playable.";
    const when = newest.round === null ? "" : ` (round ${newest.round + 1})`;
    return `${newest.version} is on the board${when}${builds.length > 1 ? `, ${builds.length} builds so far` : ""}.`;
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
    // Nothing is assigned in the open arm, so there is no "your part" to state
    // — only how a part comes to be yours. Saying it here rather than only in
    // the brief matters because this is the durable channel: on turn two
    // hundred this is still in the prompt and round one's conversation is not.
    if (this.open) {
      return [
        this.jamBrief(),
        "",
        "## Your part",
        "",
        `You are the **${role}**. Nobody has been assigned any file — decide together what the game ` +
          "needs, then claim what you are going to write with `claim_file`. A file belongs to whoever " +
          "claimed it and writing to somebody else's is refused, so claim before you build and say what " +
          "you have claimed.",
        "",
        "Everybody can read everything. If you need a change in a file that is not yours, ask the person " +
          "who claimed it, and if it is yours and somebody asks, actually make it.",
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

  /**
   * Put the shared library in the workspace, if this brief asks for one.
   *
   * Every jam before this one hand-wrote a fixed-timestep loop, keyboard edge
   * detection, a particle emitter and a seeded RNG, and most of them wrote the
   * naive version of each because the correct version always loses to "make the
   * collision work first". That is a few hundred lines per run spent on the
   * part of a game nobody plays.
   *
   * Read from `assets/workshop-lib/` rather than embedded as strings so the
   * files stay real files — lintable, diffable, and openable by whoever wants
   * to know what the teams were given.
   *
   * Failure here is not fatal. A missing asset directory means a jam without a
   * library, which is exactly the game the first eight entries played; taking
   * the run down over it would be a worse outcome than running the older
   * version of the same jam.
   */
  private provideLibrary(): void {
    if (!this.brief.library?.length) return;
    const dir = join(packageRoot, "assets", "workshop-lib");
    for (const file of this.brief.library) {
      try {
        const source = readFileSync(join(dir, file.source), "utf8");
        this.workspace.provide(file.path, source, file.purpose);
      } catch (err) {
        this.events.push({
          day: this.tick,
          kind: "library-missing",
          message: `The provided file ${file.path} could not be read: ${(err as Error).message}`,
        });
      }
    }
  }

  /** Nobody may write here but its owner — unless ownership is off for this run. */
  private assertMayWrite(path: string, agent: string | undefined): void {
    // Provided files are refused for everybody, in every arm, including the
    // solo one where ownership is off: "you cannot edit the library" is not an
    // ownership rule between teammates, it is what makes the library a fixed
    // thing every entry on the board shares.
    if (this.workspace.isProvided(path)) {
      this.counts.ownershipRefusals += 1;
      refuse(
        `"${path}" came with the workspace and cannot be edited — it is the same for every team. ` +
          "Read it and call it. If it does not do what you need, write your own in a file you own.",
      );
    }
    if (!this.strictOwnership) return;
    const owner = this.workspace.ownerOf(path);
    if (!owner) {
      /*
       * In the open arm, writing an unclaimed file claims it.
       *
       * Without this the arm has no partition at all until somebody remembers
       * to call `claim_file`, and two roles can spend three rounds writing over
       * each other in the same file — which is the failure the prescribed
       * layout prevented for free and the main risk in removing it. Requiring
       * the claim *first* would be the other extreme: round one would refuse
       * every write for a reason the team has to infer.
       *
       * So the tool is for reserving a file before it exists, and this is the
       * backstop for the far more common case of somebody simply starting.
       */
      if (this.open && agent) {
        this.workspace.claim(path, agent, "claimed by writing it");
        this.counts.claims += 1;
      }
      return;
    }
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
    // The team's own output. A provided file is listed — they have to know it
    // is there — but never counted, or the budget line would read as though a
    // fifth of the workspace were spent before round one.
    const real = files.filter((f) => !f.planned && !f.provided);
    const rows = files.map((f) => {
      const owner = f.owner ? ` [${f.owner}]` : "";
      if (f.planned)
        return `  ${f.path.padEnd(18)}${owner}  (not created yet) — ${this.workspace.purposeOf(f.path) ?? ""}`;
      if (f.provided)
        return `  ${f.path.padEnd(18)}[provided]  ${f.lines} lines — ${this.workspace.purposeOf(f.path) ?? ""}`;
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
            // Said every time, because it is the mistake that cost the most in
            // the first jam run: a model copies a numbered read straight into
            // `patch_file` and the exact match fails on every continuation
            // line.
            return (
              `${path}, lines ${slice.from}-${slice.to} of ${slice.total} ` +
              `(the line numbers are added here and are not in the file):\n${slice.text}${tail}`
            );
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
        () => renderBrief(this.brief, this.open ? "open" : "prescribed"),
        "read",
      ),
      // Only in the open arm. In the prescribed arm every file already has an
      // owner from the brief, and a tool that could reassign them would quietly
      // dismantle the partition the arm exists to test.
      ...(this.open
        ? [
            agentTool(
              "claim_file",
              "Take responsibility for a file you are going to write. Nobody else can write it after that, " +
                "so claim it before you start and tell the others what you claimed.",
              {
                path: "The file, like `engine.js` or `src/enemies.js`.",
                purpose: "One line: what goes in it. The others see this beside the filename.",
              },
              (args, agent) => {
                const role = String(agent ?? "");
                if (!role) refuse("only a named role can claim a file.");
                const purpose = String(args.purpose ?? "").trim();
                if (!purpose) refuse("say what the file is for — the others read it beside the name.");
                const { path, already } = this.workspace.claim(String(args.path ?? ""), role, purpose);
                this.counts.claims += 1;
                return already
                  ? `\`${path}\` was already yours; its purpose now reads "${purpose}".`
                  : `\`${path}\` is yours. Nobody else can write it. Say so in the room so the others build around it.`;
              },
            ),
          ]
        : []),
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
            this.noted(agent, path, `${edit.kind === "create" ? "created" : "rewrote"} it — ${edit.linesAfter} lines`);
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
            this.noted(agent, path, `patched it — ${edit.linesAfter} lines (${delta >= 0 ? "+" : ""}${delta})`);
            return (
              `Patched ${path}: now ${edit.linesAfter} lines (${delta >= 0 ? "+" : ""}${delta}).` +
              // Never let a loosened match read as an exact one. If the
              // indentation they sent was wrong, they should know before they
              // build their next patch on the same wrong copy.
              (edit.loosened
                ? " Note: your `find` did not match exactly — it was matched ignoring indentation, and it " +
                  "was unambiguous so it was applied. Your copy of this passage has the wrong leading whitespace."
                : "")
            );
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
            this.noted(agent, path, "deleted it");
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
        // No agent: `tool()` handlers are handed args and nothing else, and
        // `check_syntax` reads perfectly well as an action rather than a
        // person. Restructuring it into an `agentTool` to attribute a line in
        // a feed would be the tail wagging the dog.
        this.noted(
          undefined,
          "check_syntax",
          report.problems.length === 0
            ? `${report.filesChecked} files parsed clean`
            : `${report.problems.length} problem${report.problems.length === 1 ? "" : "s"} in ${report.filesChecked} files`,
        );
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
        this.noted(
          agent,
          "playtest",
          report.ok
            ? `${report.animates ? "animates" : "static"}, ${report.respondsToInput ? "responds to input" : "no response"}` +
                `${report.errors.length ? `, ${report.errors.length} console error${report.errors.length === 1 ? "" : "s"}` : ""}`
            : "could not run it",
        );
        this.checkpoint(report);
        const text = formatPlaytest(report, this.brief.entry);
        const shots = await this.attachFrames(report);
        if (shots.length === 0) return { success: true, output: text };
        return { success: true, output: { parts: [textPart(text), ...shots] } };
      },
    };
  }

  /**
   * Put a working game on the board without anybody deciding to.
   *
   * `submit_version` belongs to one role, for a measured reason (see `tools()`),
   * and that leaves the whole point of versions resting on one agent
   * remembering. At a natural end nothing is lost — `publishRun` falls back to
   * the workspace — so the exposure is precisely the case that motivated
   * versions in the first place: a run killed mid-jam, which is how OVERGROWTH
   * came to be published by hand.
   *
   * So a clean playtest checkpoints the workspace. Costs no turn, no schema
   * entry and nobody's attention, which is what makes it affordable where
   * handing the tool to five roles was not.
   *
   * Counted as `arcadeAutoSubmits`, separately from the deliberate ones, so
   * "did the team choose to ship" stays answerable. A run whose only builds are
   * automatic is a run where the mechanism did not land, and that has to be
   * visible rather than hidden inside a healthy-looking total.
   */
  private checkpoint(report: Awaited<ReturnType<typeof playtest>>): void {
    if (!this.desk) return;
    // Only a game that actually runs. A checkpoint of a black rectangle that
    // parses would be worse than none: it is what gets judged if the run dies.
    if (!report.ok || report.errors.length > 0 || !report.animates || !report.respondsToInput) return;
    // Nothing new since the last build on the board. Re-submitting an unchanged
    // workspace every playtest would fill the history with noise and make the
    // count meaningless.
    const edits = this.counts.writes + this.counts.patches;
    if (this.lastCheckpointEdits !== undefined && edits <= this.lastCheckpointEdits) return;
    try {
      this.desk.autoSubmit(this.tick, edits);
      this.lastCheckpointEdits = edits;
    } catch {
      // A checkpoint that cannot be written costs the safety net for one round.
      // Taking the jam down over it would cost the whole run.
    }
  }

  /** Take the runtime's media store. See {@link Simulation.attachMedia}. */
  attachMedia(store: MediaStore | undefined): void {
    this.mediaStore = store;
  }

  /**
   * Forward what was said to the arcade's live feed.
   *
   * Recording only — nothing here reads a post to decide anything, and the
   * interface says why that rule is not negotiable. The round is stamped on so
   * a reader can see the conversation against the clock the team was working
   * to; it is the only thing added.
   */
  observePost(post: { agent?: string; room: string; body: string }): void {
    this.desk?.note({
      kind: "post",
      round: this.tick + 1,
      ...(post.agent ? { agent: post.agent } : {}),
      room: post.room,
      body: post.body,
    });
  }

  /**
   * Note a piece of work for the live feed.
   *
   * Deliberately not every tool call. `list_files` and `read_file` are 37% of
   * everything a team does and none of it is legible as activity — a feed of
   * "read engine.js" repeated ninety times buries the four writes that changed
   * the game. What lands here is what changed something, or what checked it.
   */
  private noted(agent: string | undefined, what: string, detail: string): void {
    this.desk?.note({
      kind: "did",
      round: this.tick + 1,
      ...(agent ? { agent } : {}),
      room: what,
      body: detail,
    });
  }

  /**
   * Put this playtest's frames in the media store and return them as parts.
   *
   * Returns an empty array for every reason it might not work — no store
   * attached, no screenshot captured, the file unreadable, the store refusing
   * the bytes — and never throws. The text report is the deliverable; the
   * pictures are an improvement on it, and an improvement that fails has to
   * leave the deliverable standing rather than take it down.
   *
   * `alt` names which frame this is. Without it the model gets two images in
   * one message with nothing to say which came first, and "the second one"
   * is not a thing it can see.
   */
  private async attachFrames(report: Awaited<ReturnType<typeof playtest>>): Promise<ContentPart[]> {
    const store = this.mediaStore;
    if (!store) return [];
    const parts: ContentPart[] = [];
    const seen = new Set<string>();
    let collapsed = false;
    for (const path of framesToShow(report)) {
      try {
        const bytes = await readFile(path);
        const label = basename(path, ".png");
        const ref = await store.put(bytes, { mimeType: "image/png", name: `${label}.png` });
        /*
         * Deduped on the content hash, not the path.
         *
         * `framesToShow` can only compare filenames, and two differently named
         * frames are routinely the same bytes — which is exactly what happens
         * while the game is still a black canvas. The store is
         * content-addressed, so that arrives here as one id twice: 1,500
         * estimated history tokens spent to show a model the same screen again.
         */
        if (seen.has(ref.id)) {
          collapsed = true;
          continue;
        }
        seen.add(ref.id);
        parts.push(mediaPart(ref, `${label} — round ${this.tick + 1} of ${this.brief.entry}`));
      } catch {
        // A frame we could not hand over is one the text report already
        // describes. Nothing to say about it that would help anybody.
      }
    }
    // Not a gap to paper over: two pixel-identical frames means the opening
    // screen and a frame taken mid-play are the same picture, which is a real
    // and damning fact about the game. Say it in the words the image would
    // otherwise have had to carry on its own.
    if (collapsed && parts.length > 0) {
      parts.push(
        textPart(
          "Both captured frames are pixel-identical, so only one is shown: the screen after playing " +
            "looks exactly like the screen on open. Nothing you pressed changed anything that draws.",
        ),
      );
    }
    this.framesShown += parts.filter((p) => p.type === "media").length;
    return parts;
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

    /*
     * The arcade belongs to whoever writes the submission, and to nobody else.
     *
     * It started as a shared instrument on the theory that reading how other
     * teams scored is useful to anybody. The first live run said otherwise: the
     * *interface* agent — which cannot register anything — spent four of the
     * team's six tool calls browsing the arcade and reading three previous
     * entries, and the run wrote no files at all. A cheap, interesting, public
     * tool is a tool every agent will call once, and "once" times five agents
     * times twenty rounds is a large amount of sightseeing.
     *
     * Handed out per role rather than gated inside a shared tool, because the
     * refusal is not the goal — four agents never seeing the tool at all is.
     * A refusal still costs the call, the schema entry and the turn.
     *
     * In the solo arm every role maps to the same agent, so `simulationGrants`
     * unions these into the one roster it has and the maker keeps them.
     */
    if (this.desk) byRole[this.registrar] = [...(byRole[this.registrar] ?? []), ...this.desk.tools()];
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

    /*
     * Put it on the site.
     *
     * After the manifest, because publishing copies that file, and inside the
     * `finalised` guard so it happens exactly once. A run with no files is not
     * published at all — a three-round smoke test leaves the same directory
     * shape as a real jam, and a board padded with empty pages is worse than a
     * shorter board.
     *
     * Wrapped, because this is the last thing a run does and the artifact is
     * already safely on disk by now. A failure here should cost the entry, not
     * the run's own report.
     */
    // Provided files excluded deliberately: they are present in every run
    // from round zero, so counting them would make `files.length > 0` true
    // for a team that wrote nothing at all and publish an empty entry.
    const files = this.workspace.list().filter((f) => !f.planned && !f.provided);
    try {
      this.desk?.publish(this.root, this.counters(), files.length > 0);
    } catch (err) {
      this.events.push({
        day: this.tick,
        kind: "arcade-failed",
        message: `could not publish to the arcade: ${(err as Error).message}`,
      });
    }
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
    const files = this.workspace.list().filter((f) => !f.planned && !f.provided);
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
      // Read against `ownershipRefusals`: claims low with refusals high is a
      // team that started writing before it divided the work.
      claims: this.counts.claims,
      // Frames that actually reached a model, which is a different fact from
      // playtests run: a run without `--vision` plays the game just as often
      // and shows nobody anything. Zero here next to a healthy `playtestsRun`
      // is the tell that the images are not wired up.
      framesShown: this.framesShown,
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
      // Whether the team looked at the arcade, and whether it ever wrote its own
      // page. `arcadeRegistered` is the one that matters: a finished game with
      // no pitch is a page a judge cannot read, and it is a failure that
      // survives to the site where it is visible.
      ...(this.desk?.counts ?? {
        arcadeBrowses: 0,
        arcadeReads: 0,
        arcadeUpdates: 0,
        arcadeRegistered: 0,
        arcadeSubmits: 0,
      }),
      roundsSinceCheck: this.lastCheck === undefined ? this.tick : this.tick - this.lastCheck.atRound,
      distinctWriters: writers.size,
      roundsWithNoWrite: this.roundsWithNoWrite,
      entryExists: this.workspace.exists(this.brief.entry) ? 1 : 0,
      // Meaningless in the open arm — nothing was planned, so "how much of the
      // plan got made" has no denominator. Reported as 0 rather than as a count
      // of files that happen to share a name with the arm that isn't running.
      plannedFilesMade: this.open ? 0 : this.brief.layout.filter((f) => this.workspace.exists(f.path)).length,
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
