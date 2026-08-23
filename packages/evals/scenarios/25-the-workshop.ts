/**
 * Five agents, three channels, a brief, and a directory somebody opens after.
 *
 * The first row in this package with no score. Everything else here asks a
 * question the benchmark can settle by itself — did they reach the state, beat
 * the baseline, earn the experience — and each of those is a question with an
 * author, which means it has to be re-authored every time it is answered.
 * `the-lock` cost a session to write and was solved on its third run.
 *
 * A brief cannot be beaten. It can only be executed better, and whether it was
 * is not a thing this package can compute. So it does not try: `review: true`,
 * no `expect`, no `milestones`, and a person opens `index.html`.
 *
 * ## Why three channels rather than the descent's one
 *
 * The descent puts all five agents in one room on purpose, and says why: its
 * sibling scenarios already measure what happens when a fact must cross a wall,
 * so splitting the party too would make a low score ambiguous between "could
 * not play the dungeon" and "could not get a number across a room".
 *
 * That argument does not apply to a row with no score to be ambiguous about,
 * and the reason to split here is different and specific. One room means every
 * message costs every agent context, and over 220 turns the transcript is the
 * single largest consumer of the history budget — a team that talks in one
 * place trims away its own plan. Channels let a team scope a conversation, and
 * whether they use that well is exactly the sort of thing you can only see by
 * reading the run.
 *
 *     studio   all five        decisions, blockers, anything everyone needs
 *     build    lead, builder, tester      implementation and defects
 *     craft    lead, interface, author    what it looks like and what is in it
 *
 * The **lead is the only agent in all three**, which makes it the bridge, and —
 * as `the-machine-across-a-divide` established — nothing tells it that being
 * the bridge is a job.
 *
 * The crossing that matters is not a token. `engine.js` belongs to the builder
 * and `render.js` belongs to the interface, the second reads state the first
 * defines, and those two agents share no channel but the all-hands. If they do
 * not agree on the shape of that state, the artifact opens to a blank canvas
 * and every syntax check passes on the way there.
 *
 * ## The two control arms, at turn parity rather than round parity
 *
 * `the-workshop-in-one-room` is the same brief with everybody in `studio` and
 * nothing else, and `the-workshop-alone` is one agent holding every tool. Both
 * get **220 turns**, the same as the split arm, because the question is "given
 * the same budget, does the shape of the team help" and not "does more model
 * time help". Round parity would have answered the second question while
 * appearing to answer the first.
 *
 * The solo arm is the uncomfortable one and is the reason to build it. It is
 * the only row in this package that could tell you whether five agents beat one
 * at a task with an artifact at the end, and it costs one file.
 */

import { defineScenarios } from "../src/define.js";
import { WORKSHOP_PLAY_OPTIONS } from "../src/sim/workshop/index.js";

/**
 * Twenty rounds of eleven turns.
 *
 * A budget, not a guess. An agent turn on the local model runs about 35
 * seconds, measured against `the-lock`, so 220 turns is a little over two hours
 * — the same order as a descent run, which is the most anybody has been willing
 * to wait for one row.
 *
 * Rounds here buy *building* rather than more chances at the same discovery, so
 * a longer run is a legitimate configuration rather than a stalled one. The
 * schema lets a `review:` row go to 400; the bill is the only thing in the way.
 */
const ROUNDS = 20;

/** Same total model calls in every arm. See the header. */
const TURN_BUDGET = 220;

const VERIFYING =
  "You have two instruments and they answer different questions. `check_syntax` parses every file and " +
  "reports syntax errors, unclosed tags and references to files nobody created; it cannot tell you " +
  "whether the thing works. `playtest` opens the artifact in a real browser, presses keys at it, and " +
  "reports console errors, whether it animates, whether it responds to input, and a coarse picture of " +
  "what is on screen. Neither is a substitute for the other: a page can parse perfectly and draw " +
  "nothing, and a page can run without errors and still be no fun.";

const WORKSPACE =
  "You are building a real artifact in a real directory, and it will still be there when this ends: a " +
  "person is going to open it and form an opinion. Everything happens through your tools — `list_files` " +
  "to see what exists and what the brief expects, `read_file` for a numbered slice, `outline_file` to " +
  "find your way around something long, `write_file` for a whole file, `patch_file` to change one exact " +
  "passage. Prefer `patch_file`: a whole-file write of a long file costs the entire file twice over, and " +
  "the run has a fixed budget for that. You can read every file. You can only write the ones that are " +
  "yours; the rest you have to ask for. Say what a tool actually returned, in numbers, not in summary. " +
  VERIFYING;

/**
 * One role's instructions: what the job is, which channels it is in, and the
 * workspace rules everybody gets.
 *
 * `role` is kept alongside the assembled string because the control arms need
 * the job without the channel graph, and the obvious way to get it back —
 * splitting the assembled string on the first blank line — silently truncated
 * the lead the moment its job description grew a second paragraph. A derived
 * value that can be recovered by parsing is a value that will eventually be
 * recovered wrongly.
 */
const hand = (description: string, role: string, channels: string) => ({
  description,
  role,
  instructions: `${role}\n\n${channels}\n\n${WORKSPACE}`,
});

/**
 * The two fields a scenario's agent block is allowed to carry.
 *
 * `hand` keeps `role` for the control arms to rebuild from, and the scenario
 * schema is strict — spreading the whole thing fails validation with
 * `Unrecognized key(s) in object: 'role'`, which is exactly the right
 * behaviour and the reason this is a function rather than a convention.
 */
const block = (h: { description: string; instructions: string }) => ({
  description: h.description,
  instructions: h.instructions,
});

/**
 * The lead carries one thread across three rooms; everybody else gets one per
 * room.
 *
 * Room sessions are per-`(room, agent)` by default, which is right — what an
 * agent does in one place should not leak into another. Applied to the bridge
 * it is wrong in a way that would sink the run: the lead would arrive in
 * `craft` with no memory of what it agreed in `build` ninety seconds earlier,
 * and the one agent whose entire job is carrying decisions between channels
 * would be the one agent unable to.
 *
 * Core's own note on this setting says continuity of *work* is better served by
 * durable state than by a shared session, and that is true — `design.md` is
 * exactly that durable state and the lead owns it. This is the other half:
 * continuity of *conversation*, which is what a bridge is made of. The cost is
 * a session that grows with three rooms rather than one, and the lead is the
 * agent most likely to hit the history budget because of it. That is a real
 * trade and it is worth watching in the first run.
 */
const BRIDGE = { roomSessionScope: "shared" as const };

const LEAD = hand(
  "Holds the brief, owns the design, and is the only one in every channel.",
  "You are the lead. You hold the design and the write-up, and you write no code at all — if something " +
    "needs building, somebody else builds it. This is a jam, so it starts the way a jam starts.\n\n" +
    "What the game is, and what it is built on, are both yours to settle — how you settle them is up " +
    "to you. You can decide and announce, or ask the other four for pitches first and choose between " +
    "them; `pitch` exists for the second. Either way write the theme reading down, because a game " +
    "that only mentions the theme scores worst on the category a judge checks first, and the " +
    "conversation is not memory — it gets trimmed, and what you did not write down is gone.\n\n" +
    "The foundation is `use_engine`: phaser, babylon or none. `docs` will show you what any of them " +
    "can do before you install one, so it is a question you can answer rather than guess at. It gets " +
    "more expensive to revisit the longer it is left, whichever way it ends up going.\n\n" +
    "Keeping the five of you building one thing rather than five is the part nobody else can do — " +
    "deciding who is writing what, and saying so out loud.\n\n" +
    "If the game turns out not to be fun, changing course is your call, and it is a real option " +
    "rather than an admission — a build already on the board keeps its score whatever you do next.\n\n" +
    "You are also the one who can unblock the team. If somebody has claimed a file and is not writing " +
    "it, `release_file` takes it back and anybody can then claim it — you do not have to wait, and you " +
    "should not let a silent teammate hold up the game. A claim on a file nobody writes also lapses on " +
    "its own after a couple of rounds.\n\n" +
    "Two jobs at the arcade are yours and neither can wait for the last round. **Registering**: a game " +
    "that is not registered is a game the judge never opens — `arcade_entry` shows what is still " +
    "missing, `arcade_register` writes it. **Submitting**: `submit_version` puts the game as it stands " +
    "on the board, and the most recent build you submit is the one that gets judged. Submit the moment " +
    "it is playable and again whenever it gets better; there is no reason to hold anything back and " +
    "nothing you have already put up can be lost by carrying on. You can also read what previous teams " +
    "submitted and what they scored — `arcade_browse` and `arcade_read`. Do that early if you are going " +
    "to; it is worth more before you have committed to a reading of the theme than after.",
  "You are in all three channels: `studio`, `build` and `craft`. Nobody else is. The builder and the " +
    "interface never speak to each other except in `studio`, and their two files have to fit together, " +
    "so anything one of them decides that the other needs is yours to carry.",
);

const BUILDER = hand(
  "Writes the logic. Never sees the channel where the look is decided.",
  "You are the builder. You write the logic — state, rules, and everything that happens. You do not draw " +
    "anything and you do not own the page. Claim the files you are going to write before you start, so " +
    "nobody writes over you. Whoever renders your state has to know its shape, and they are not in this " +
    "channel — say what your state looks like out loud, in `studio`, in the exact names you used.",
  "You are in `studio` and `build`.",
);

const INTERFACE = hand(
  "Owns the page and everything drawn on it.",
  "You are the interface. You own the entry page and everything drawn on it. You decide the load order " +
    "of the scripts, which means a file you do not own can be broken by a tag you write. You " +
    "read the state somebody else defines and you never change it. If you do not know its shape, ask in " +
    "`studio` rather than guessing — a guess here costs a blank screen that every check passes. You can " +
    "call `playtest`, which is how you see what you have actually drawn rather than what you intended: " +
    "it gives you the colour balance and a coarse map of the screen. Use it before you claim anything " +
    "looks right.",
  "You are in `studio` and `craft`.",
);

const AUTHOR = hand(
  "Writes what is in it: data, tuning, copy.",
  "You are the author. You write what there *is* to play: the levels, the waves, the enemies, the " +
    "hazards, the things a player finds, the words on the screen. Not just the numbers — a game with one " +
    "kind of threat and a speed that goes up is a game with nothing in it, and filling that in is your " +
    "job rather than the builder's. Data, not behaviour: the builder writes what a thing *does*, you " +
    "write what things there *are* and what they are like. Everything you write is read by somebody " +
    "else's code, so the names you choose are an interface and changing one silently breaks them.",
  "You are in `studio` and `craft`.",
);

const TESTER = hand(
  "The only one who can check anything.",
  "You are the tester. You keep the defect log, you write no code, and you hold both instruments: " +
    "`check_syntax` and `playtest`. Only you and the interface can run the game at all, so if you do not " +
    "run it and say what happened, nobody knows whether it works. Play it often — an error on the " +
    "console, a screen that never changes, or a game that ends instantly are all things only you can " +
    "see. Report what the tools actually said, including line numbers and the numbers from the frame " +
    "description, and write down what you still cannot check.",
  "You are in `studio` and `build`. The interface and the author are not in `build`, so a problem in the " +
    "page or the content has to go through `studio` or through the lead.",
);

const OPENING =
  "The brief is in your instructions and in `brief.md`. You have {ROUNDS} rounds and then this stops, " +
  "finished or not. Agree what you are building before anybody writes a line of it, and decide who is " +
  "writing what. Get it playable early and put it on the board, then spend the rest of the jam making " +
  "it better — the last build submitted is the one judged, so a working game is never at risk from " +
  "carrying on.";

const opening = (rounds: number, extra: string) => OPENING.replace("{ROUNDS}", String(rounds)) + extra;

const INTENT =
  "Five agents with partitioned write access build a real software artifact from a brief over 20 rounds " +
  "across three channels, and a person reviews what they made. There is no score, no `expect` and no " +
  "milestone ladder: the deliverable is a directory you open.\n\n" +
  "It exists because every scored scenario here answers a question somebody had to author, and an " +
  "authored question has to be re-authored every time it is answered. It is also the only row that can " +
  "show whether a team stays coherent past its own context window — 220 turns will trim away the " +
  "conversation that agreed the plan, and what survives is whatever got written into a file.\n\n" +
  "The brief is a `--sim-option`, not a scenario: `arcade`, `tool` or `site`. Two control arms run the " +
  "same brief at the same turn budget, one with everybody in a single room and one with a single agent, " +
  "because the question underneath all of this is whether the shape of the team was worth anything.";

/*
 * `delegate` is stubbed by the harness, and the stub lies.
 *
 * Every tool that reaches outside the process is stubbed in the benchmark, and
 * the default stub answers "(stubbed in the benchmark — assume it succeeded and
 * continue)". For `exec` or `web_fetch` that is exactly right: the scenario does
 * not care, and a fake success keeps the run moving.
 *
 * For `delegate` in *this* scenario it is corrosive, and it took a live run to
 * see why. The lead called `delegate` three times — handing the builder, the
 * interface and the author explicit file assignments — was told three times
 * that it had worked, and then, believing the work was assigned, built the whole
 * game itself inside a single turn. Nobody was delegated to. The builder never
 * received anything.
 *
 * Two things break, and the second is worse than the first:
 *
 * 1. A lead that thinks it has assigned the work stops coordinating through the
 *    rooms, which is the only mechanism this scenario exists to test.
 * 2. It routes around the information asymmetry on purpose. The builder is not
 *    supposed to see the channel where the look is decided; the lead's delegate
 *    prompt handed it the theme reading, the diversifier and the file layout
 *    directly. A benchmark about coordinating under partial information cannot
 *    ship a tool that quietly dissolves the partition.
 *
 * So the stub tells the truth instead. It is phrased as a fact about this world
 * rather than as a refusal, because an error reads as something to retry and a
 * fact reads as something to plan around — and it points at the tool that does
 * work, since an agent told only "no" tends to try the same thing again.
 */
const DELEGATION_IS_NOT_A_THING = {
  delegate:
    "There is nobody to delegate to. The other four are not your subagents — they are running " +
    "on their own clocks, and the only way to reach them is `room`. Post what you need in the " +
    "channel they are in and they will read it on their next turn.",
} as const;

export default defineScenarios(
  {
    id: "the-workshop",
    category: "orchestration",
    difficulty: 10,
    review: true,
    intent: INTENT,

    simulation: {
      name: "workshop",
      days: ROUNDS,
      daysPerRound: 1,
      // Agent names are role names, deliberately. `write_file` and `patch_file`
      // are `agentTool`s that read `context.agentName` to decide whether the
      // caller owns the file, and the simulation is handed roles rather than
      // agents — so the two vocabularies have to be the same one. The descent
      // does this too. `sim-roles-are-agent-names.test.ts` holds it.
      roles: {
        lead: "lead",
        builder: "builder",
        interface: "interface",
        author: "author",
        tester: "tester",
      },
      options: { ...WORKSHOP_PLAY_OPTIONS },
    },

    agent: { name: "lead", ...block(LEAD), extra: BRIDGE },

    config: {
      agents: {
        builder: block(BUILDER),
        interface: block(INTERFACE),
        author: block(AUTHOR),
        tester: block(TESTER),
      },
    },

    toolResults: DELEGATION_IS_NOT_A_THING,

    rooms: [
      {
        name: "studio",
        purpose: "All five of you. Decisions, blockers, and anything the whole team needs.",
        members: ["lead", "builder", "interface", "author", "tester"],
        deliver: "poll",
        wakeOn: "all",
        incoming: [
          {
            speaker: "quinton",
            body:
              "Jam starts now. The theme is in your instructions and in `brief.md`. Five of you, twenty " +
              "rounds, and at the end I open whatever exists on the arcade, play it, and score it on " +
              "theme relevance, gameplay, visuals, originality and polish — five categories, all worth " +
              "the same. I would rather play something rough that surprises me than something tidy I " +
              "have played before.\n\n" +
              "How you land on an idea is up to you — `pitch` is there if you want a few on the table " +
              "before choosing. Same for what you build it on: `use_engine`, and `docs` will show you " +
              "what each option can do before you commit. Register on the arcade before you run out of " +
              "rounds; I play what is on the site, and I play the last build you submitted, so put " +
              "something up early and keep going.\n\n" +
              "This channel reaches everybody; the other two do not.",
          },
        ],
      },
      {
        name: "build",
        purpose: "The lead, the builder and the tester. Implementation and defects.",
        members: ["lead", "builder", "tester"],
        deliver: "poll",
        wakeOn: "all",
        incoming: [
          {
            speaker: "quinton",
            body: "Implementation channel. The interface and the author cannot hear this one.",
          },
        ],
      },
      {
        name: "craft",
        purpose: "The lead, the interface and the author. What it looks like and what is in it.",
        members: ["lead", "interface", "author"],
        deliver: "poll",
        wakeOn: "all",
        incoming: [
          {
            speaker: "quinton",
            body: "Look and content channel. The builder and the tester cannot hear this one.",
          },
        ],
      },
    ],

    /*
     * Round-major across all three channels, which `wakeSteps` does for free and
     * which is the only ordering that makes a bridge a bridge.
     *
     * Running `studio` to exhaustion and then `build` would let the lead carry
     * everything across in one trip at a moment when the other channels had not
     * started — a different scenario, and an easier one.
     *
     * Eleven turns a round: the lead three, everybody else two.
     */
    wake: [
      { room: "studio", rounds: ROUNDS, agents: ["lead", "builder", "interface", "author", "tester"] },
      { room: "build", rounds: ROUNDS, agents: ["lead", "builder", "tester"] },
      { room: "craft", rounds: ROUNDS, agents: ["lead", "interface", "author"] },
    ],

    repeats: 1,
  },

  /**
   * The same brief, the same budget, one room.
   *
   * The arm that says whether the channel graph was worth anything. Forty-four
   * rounds of five turns is the same 220 model calls the split arm gets, so a
   * difference in the artifact is a difference in the shape of the team rather
   * than in how long they had.
   *
   * Ownership stays on. Changing two things at once would make the comparison
   * unreadable, and the room graph is the thing under test here.
   */
  {
    id: "the-workshop-in-one-room",
    category: "orchestration",
    difficulty: 10,
    review: true,
    intent:
      "The control arm for `the-workshop`: same brief, same five roles, same partitioned write access, " +
      "same 220 turns — and one shared channel instead of three. Read the two artifacts side by side.",

    simulation: {
      name: "workshop",
      days: TURN_BUDGET / 5,
      daysPerRound: 1,
      roles: { lead: "lead", builder: "builder", interface: "interface", author: "author", tester: "tester" },
      options: { ...WORKSHOP_PLAY_OPTIONS },
    },

    // No `BRIDGE` here: with one room there is nothing to bridge, and a shared
    // session scope would be an unrelated second difference between the arms.
    agent: {
      name: "lead",
      ...block(hand(LEAD.description, LEAD.role, "Everybody is in `studio`. There are no other channels.")),
    },

    config: {
      agents: {
        builder: block(hand(BUILDER.description, BUILDER.role, "Everybody is in `studio`.")),
        interface: block(hand(INTERFACE.description, INTERFACE.role, "Everybody is in `studio`.")),
        author: block(hand(AUTHOR.description, AUTHOR.role, "Everybody is in `studio`.")),
        tester: block(hand(TESTER.description, TESTER.role, "Everybody is in `studio`.")),
      },
    },

    toolResults: DELEGATION_IS_NOT_A_THING,

    rooms: [
      {
        name: "studio",
        purpose: "All five of you, in one place.",
        members: ["lead", "builder", "interface", "author", "tester"],
        deliver: "poll",
        wakeOn: "all",
        incoming: [
          {
            speaker: "quinton",
            body: opening(TURN_BUDGET / 5, " Everything is decided in here."),
          },
        ],
      },
    ],

    wake: [
      {
        room: "studio",
        rounds: TURN_BUDGET / 5,
        agents: ["lead", "builder", "interface", "author", "tester"],
      },
    ],

    repeats: 1,
  },

  /**
   * One agent, every tool, the same 220 turns.
   *
   * The row that answers the question underneath the whole framework, and the
   * one most likely to produce an answer nobody wanted. Ownership is off
   * because there is nobody to own anything, which is the only difference that
   * cannot be avoided.
   *
   * Read it against the other two on the artifact, not on the counters. A solo
   * agent will win `linesWritten` almost by construction — it never spends a
   * turn agreeing with anybody — and that is precisely the number that does not
   * matter.
   */
  {
    id: "the-workshop-alone",
    category: "orchestration",
    difficulty: 10,
    review: true,
    intent:
      "The solo control for `the-workshop`: one agent, every tool, no ownership partition, the same brief " +
      "and the same 220 turns that five agents get. Whether a team beat one person is a question about " +
      "the artifact, not about the counters.",

    simulation: {
      name: "workshop",
      days: TURN_BUDGET,
      daysPerRound: 1,
      // Every file belongs to the one role that exists, so the ownership rule
      // can never fire. Declared rather than switched off, so the tools behave
      // identically in all three arms.
      roles: { lead: "maker", builder: "maker", interface: "maker", author: "maker", tester: "maker" },
      options: { ...WORKSHOP_PLAY_OPTIONS, ownership: "shared", checks: "anyone" },
    },

    agent: {
      name: "maker",
      description: "Building the whole thing alone.",
      instructions:
        "You are building this by yourself. Every file is yours and every tool is yours, including " +
        "`check_syntax`. You have one turn per round and a lot of rounds; treat each one as a small unit " +
        "of work rather than a burst, and keep a design file to remember decisions across them — this " +
        "conversation gets trimmed, and what you did not write down is gone.\n\n" +
        "Registering the game on the arcade is yours too, and so is submitting it. Neither can wait for " +
        "the last round: a game that is not registered is a game the judge never opens, and " +
        "`submit_version` puts what you have on the board — the most recent build you submit is the one " +
        "judged, so submit as soon as it is playable and again whenever it gets better. `arcade_entry` " +
        "shows what you have written and what is still missing; `arcade_register` writes it. You can " +
        "also read what previous teams submitted and what they scored — `arcade_browse` and " +
        "`arcade_read`.\n\n" +
        WORKSPACE,
    },

    toolResults: DELEGATION_IS_NOT_A_THING,

    rooms: [
      {
        name: "studio",
        purpose: "Your own working notes. Nobody else is here.",
        members: ["maker"],
        deliver: "poll",
        wakeOn: "all",
        incoming: [
          {
            speaker: "quinton",
            body: opening(TURN_BUDGET, " You are on your own for this one."),
          },
        ],
      },
    ],

    wake: [{ room: "studio", rounds: TURN_BUDGET, agents: ["maker"] }],

    repeats: 1,
  },
);
