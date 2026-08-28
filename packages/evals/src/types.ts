/**
 * What a scenario is, and what running one produces.
 *
 * The schema lives in `schema.ts` (zod, so a typo in a YAML file fails loudly
 * instead of silently grading nothing). This file is the shape everything else
 * passes around.
 */

/** A message posted into a room by somebody other than the agent under test. */
export interface RoomLine {
  /** Identity that speaks. Must appear in `identities` or be an agent name. */
  speaker: string;
  /** Identities addressed. Empty means "the room". */
  to?: string[];
  body: string;
}

export interface RoomSpec {
  /** Room name, without the `local:` prefix. Refs are `local:<slug>`. */
  name: string;
  purpose?: string;
  /**
   * Who is subscribed here. Defaults to every agent that takes a turn.
   *
   * The seam that makes routing a problem rather than a broadcast. With one
   * room holding everybody, "get this fact to the agent who needs it" collapses
   * into "say it out loud", and a team can look like it is routing while doing
   * nothing of the kind. Give two rooms different membership and a fact has to
   * be *relayed* by whoever sits in both — which is the thing worth measuring,
   * and the thing a real deployment gets wrong.
   */
  members?: string[];
  deliver?: "push" | "poll";
  wakeOn?: "named" | "addressed" | "all" | "none";
  checkInMinutes?: number | null;
  /** Per-room role. Rendered as "Your role here:" under the room's purpose. */
  role?: string;
  /**
   * Posted, then the cursor is advanced past them: history the agent has
   * already been shown. This is what a room the agent is *mid-conversation in*
   * looks like, and it is what the cross-room view reads.
   */
  seen?: RoomLine[];
  /** Posted after the subscription is armed. These are what the wake carries. */
  incoming?: RoomLine[];
}

/** A message pre-loaded into the agent's session history before the turn runs. */
export interface HistoryLine {
  role: "user" | "assistant";
  content: string;
}

/**
 * A note the agent is supposed to already know, written into its memory before
 * the turn runs.
 *
 * `history:` seeds a conversation, `toolResults:` seeds tool output and
 * `world:` seeds simulation state. None of them seed what an agent is meant to
 * remember from *before* — so every published run so far has scored memory
 * against an empty database, which measures the cost of an empty query rather
 * than the value of a memory.
 *
 * Pairs with a witness. Put the fact in a token, seed it only here, and the
 * assertions can tell retrieval from confabulation:
 *
 * ```yaml
 * tokens: { fact: code }
 * memory:
 *   - "the staging cluster deploy key is {{token:fact}}"
 * message: "what's the staging deploy key?"
 * expect:
 *   - prompt_not_contains: "{{token:fact}}"   # nobody handed it over
 *   - reply_mentions_any: ["{{token:fact}}"]  # and it came back anyway
 * ```
 */
export interface MemorySeed {
  content: string;
  tags?: string[];
  /**
   * 0..1. At or above 0.95 the note joins the pinned tier and is injected
   * regardless of relevance to the message, which is how a scenario stops
   * depending on the recall ranker to make its point.
   */
  importance?: number;
  /** Shorthand for the `pinned` tag. Same effect as `importance: 1`. */
  pinned?: boolean;
  /**
   * Whose note it is. Defaults to unowned, which every agent can see.
   *
   * Note that `listNotes` has no agent filter, so an owned note is still
   * readable by the `recall` tool from any agent; ownership narrows the
   * *injected* set, not the searchable one.
   */
  agent?: string;
}

export interface AgentSpec {
  /** Name in `config.agents`. Defaults to `bench`. */
  name?: string;
  description?: string;
  instructions?: string;
  /** Tool allowlist. Omit to give the agent everything the fixture enables. */
  tools?: string[];
  /** Anything else spliced into the agent's config block verbatim. */
  extra?: Record<string, unknown>;
}

export interface WakeStep {
  room: string;
  /** Defaults to the agent under test. Any agent named here is subscribed to every room. */
  agent?: string;
  kind?: "poll" | "checkin";
}

/**
 * A roster taking turns, repeatedly, instead of a hand-written list of turns.
 *
 * Every multi-agent scenario before this enumerated its turns, and the length
 * of that list turned out to be a hidden parameter of the measurement: the
 * first lead-and-specialists scenario gave four turns, and every run died the
 * same way — the lead worked out who had to unlock the hatch, and the scenario
 * ended before anyone could. It was measuring the wake list.
 *
 * Six agents needing a dozen exchanges is 72 hand-written entries, which nobody
 * writes correctly and nobody re-reads. So: name the roster once and say how
 * many passes it gets.
 *
 * The run also stops early when a whole pass changes nothing — no post, no
 * transition, no refusal. A team that has finished, or has jammed, should not
 * cost thirty more model calls to confirm it.
 */
export interface WakeRounds {
  room: string;
  /** Passes over `agents`. The ceiling, not the expectation. */
  rounds: number;
  /** Who takes a turn, in order, each pass. */
  agents: string[];
  /**
   * Keep going through a pass that changed nothing. Off by default, because a
   * quiet pass is the cheapest possible evidence that the team is done.
   */
  noQuiescence?: boolean;
}

/**
 * A tool that exists only inside one scenario.
 *
 * Until this, a scenario's machinery had to be driven through the real tool
 * surface — `exec` with a command string the world matched on a regex. That
 * works, and it puts every specialist's instrument behind one verb: an agent
 * asked to inspect a reactor has to be told, in prose, to type
 * `exec("inspect reactor")`, and the scenario ends up measuring whether the
 * model reproduces an invented CLI.
 *
 * Declaring the instruments as tools puts the discovery where it belongs — in
 * the tool list the model is handed — and lets an agent's `tools:` allowlist do
 * the thing it does in production: decide who can operate what. The world's
 * `by:` still guards the transitions, so the two agree.
 *
 * These are stubbed by construction. There is no real implementation behind
 * them, which is the point: the world or `toolResults` answers every call.
 */
export interface ScenarioTool {
  name: string;
  /** One or two sentences, exactly as a real tool's would be. */
  description: string;
  /** Parameter name → what it is. Everything is a string; the world matches on it. */
  params?: Record<string, string>;
  /** Defaults to every declared parameter. */
  required?: string[];
  /** `read`, `write` or `irreversible`. Defaults to `write`; only `irreversible` is gated. */
  effect?: "read" | "write" | "irreversible";
}

/**
 * One graded step of progress, worth `points`.
 *
 * The reason this exists: a scenario with a fifteen-step dependency graph
 * reports one bit, and that bit is `false` for every run that gets thirteen
 * steps in. Which is useless twice over — it cannot tell a team that decoded
 * the language and never restored power from one that did nothing at all, and
 * it cannot show a change that moved the team from step 4 to step 11.
 *
 * `when` is an ordinary {@link Assertion}, so a milestone can be a world state,
 * a specific agent's tool call, something somebody said, or a fact having
 * reached the agent that needed it. No second predicate language, and every
 * grader written since is available here for free.
 */
export interface Milestone {
  id: string;
  /** Weight. Relative — the total is whatever they sum to. */
  points: number;
  when: Assertion;
}

export interface MilestoneResult {
  id: string;
  points: number;
  reached: boolean;
  /** Why not, from the underlying grader. */
  detail?: string;
}

/**
 * A fact that has to travel from whoever can find it to whoever needs it.
 *
 * The measurement this package was missing. Once each agent can call its own
 * tools competently, the interesting failure stops being "did an agent learn
 * the answer" and becomes "did the answer reach the agent it was useless
 * without" — which is a property of the system, not of any model in it, and is
 * invisible to every per-agent check.
 *
 * A run can discover every fact it needs and still fail, and the report will
 * say the team failed to activate the machine. With this it says instead: the
 * glyph map was found on turn 6 and never left the archive.
 */
export interface FactSpec {
  /**
   * The literal string that has to travel. Almost always a `{{token:…}}`, so
   * it cannot be guessed and its appearance anywhere is evidence of transport.
   */
  value: string;
  /** Agents whose tools can surface it. Unset means anyone's. */
  discoverableBy?: string[];
  /** Agents that need it to act. Unset means nobody in particular. */
  requiredBy?: string[];
}

/**
 * Where a fact got to. Each stage is strictly harder than the one before it,
 * and the first missing one is the diagnosis.
 *
 *   discovered  a tool told somebody
 *   shared      somebody said it out loud
 *   received    an agent that needed it took a turn after it was said
 *   used        that agent passed it to a tool
 *
 * `received` is deliberately weak — it says the value was in the room before
 * the agent's turn, not that the agent read it. That is the honest limit of
 * what the transcript can show, and the gap between `received` and `used` is
 * where "it was told and did nothing with it" lives.
 */
export interface FactTrace {
  name: string;
  value: string;
  discovered?: { agent: string; turn: number };
  shared?: { agent: string; turn: number; room: string };
  received?: { agent: string; turn: number };
  used?: { agent: string; turn: number; tool: string };
  /** Turns from first discovery to first use, or null if it never got there. */
  latency: number | null;
}

/**
 * A scenario whose grade is a number the world produced, not a check it passed.
 *
 * Every other scenario in this package asks a yes/no question, and that is the
 * right question exactly while the answer is sometimes no. On the orchestration
 * rows it is now reliably yes, and a benchmark at its own ceiling measures the
 * ceiling. A simulation replaces the question with an objective: run this
 * company for a while, and the balance sheet says how it went. Better and worse
 * stay continuous long after "can it do this at all" has been answered.
 *
 * The simulation itself is a TypeScript module in a registry — an economy needs
 * arithmetic, a clock and stochastic draws, and expressing that in YAML means
 * inventing a programming language inside YAML, badly. This block only says
 * which one to run.
 */
export interface SimulationSpec {
  /** Registered name, e.g. `factory`. */
  name: string;
  /**
   * Seed for the world. Defaults to the run's own seed, so repeats of a scenario
   * see different weather — which is the point of repeating a stochastic run.
   * Pin it to compare two frameworks on identical luck.
   */
  seed?: number;
  /**
   * Simulated days. Defaults to one day per round of the wake roster, so the
   * team manages every day of its own run and the score is comparable with a
   * baseline swept over the same horizon.
   *
   * Setting it *longer* than the roster is allowed and means something specific:
   * the team manages the first N days and the company then runs on to the
   * horizon under its last set of decisions. That is a real result rather than a
   * truncation — it is what "the management team stopped paying attention" costs.
   */
  days?: number;
  /**
   * Simulated days between one round of decisions and the next. Default 1.
   *
   * The knob that makes an affordable run an honest one. A horizon short enough
   * to give every day its own round is short enough to invert the ladder —
   * below about thirty days the random policy wins this economy outright,
   * because buying stock, maintaining a machine and hiring all cost money now
   * and repay later, and the run ends before the repayment. Cadence buys a
   * sixty-day horizon for eight rounds of turns: management meets fortnightly
   * rather than every morning, which is also what a real one does.
   *
   * `beats_baseline` runs its baseline at the same cadence, so the comparison is
   * against a policy with the same number of chances to act rather than sixty.
   */
  daysPerRound?: number;
  /**
   * Which agent holds which set of instruments, as `role: agent`.
   *
   * This is what gives the scenario its partial information. The simulation
   * decides that sales can see demand and cannot see a machine; this says who
   * sales *is*. The harness grants each named agent exactly its role's tools, so
   * the split cannot drift out of sync with a hand-written allowlist — which is
   * the failure that would quietly turn six specialists into six generalists and
   * leave the scenario measuring nothing.
   */
  roles: Record<string, string>;
  /** Anything else the simulation understands, passed through untouched. */
  options?: Record<string, unknown>;
}

/** What a simulation run produced. Absent on every scenario without one. */
export interface SimulationOutcome {
  name: string;
  seed: number;
  /** The horizon, and how much of it the team was awake for. */
  days: number;
  daysManaged: number;
  daysPerRound: number;
  endedBecause?: string;
  metrics: Record<string, number>;
  objective: number;
  /** Everything that happened to the world unasked, with the day it happened. */
  events: import("./sim/types.js").SimEvent[];
  /**
   * Turn index → the simulated day that turn ran on.
   *
   * The only clock that connects the transcript to the economy, and the reason
   * organisational latency can be reported in days rather than in turns. Stored
   * rather than derived so a re-grade of an old report gets the same answer.
   */
  dayOfTurn: number[];
  /** Role → agent, carried through so a re-grade can still say who could see what. */
  roles: Record<string, string>;
  /**
   * The simulation-specific knobs the scenario set, carried for provenance.
   *
   * The report replays the baseline ladder live rather than storing it, and a
   * ladder replayed without these is a ladder for a different world: a descent
   * that starts the party on floor 30 compared against bots that started on
   * floor 1 is not a comparison. Same argument as recording the model and the
   * seed — a benchmark number with no provenance is worse than none.
   */
  options?: Record<string, unknown>;
  /**
   * What answering each event kind looks like, copied off the simulation.
   *
   * Stored on the report rather than looked up at grade time, so a re-grade of
   * an old run measures the latency the run was actually judged on. Reading it
   * live would score yesterday's transcript against today's idea of what
   * counts as a response, and silently move a number nobody changed.
   */
  responses: Record<string, string[]>;
}

export interface Scenario {
  id: string;
  category: string;
  /** Why this scenario exists — printed next to a failure. */
  intent: string;
  /**
   * How hard the turn is, 1-10. Required, because the alternative is a scenario
   * that no `--difficulty` run ever selects and nobody notices — the same
   * silent-gap failure the strict schema exists to prevent.
   *
   * The scale is in `difficulty.ts`. It grades what the turn *demands*, never
   * what it currently scores: relabelling a scenario when it starts passing
   * would make "we handle the hard ones now" true by construction.
   */
  difficulty: number;
  /**
   * Set when the scenario asserts the behaviour we *want* rather than the
   * behaviour we have, so a red row is the point rather than a defect. The
   * value says which gap, ideally as an issue reference.
   *
   * Without this a reader's first instinct on a permanently-red row is to
   * delete it, which is how a benchmark quietly stops measuring the thing it
   * was written for.
   */
  knownGap?: string;
  agent?: AgentSpec;
  /** Config keys merged over the fixture, e.g. `rooms.crossRoomView`. */
  config?: Record<string, unknown>;
  /**
   * The agent's own prior turns, seeded into its session before the turn runs.
   *
   * On a room scenario this is what carries an earlier conversation forward —
   * NOT `seen:`, which advances the cursor and is deliberately absent from the
   * next wake prompt.
   */
  history?: HistoryLine[];
  /**
   * What the agent already remembers, written into the run's notes before the
   * turn. A bare string is a note with no tags and default importance.
   *
   * Retrieval is not implied. With injection off and no memory tool in the
   * agent's reach, a seeded corpus is unreachable and the scenario measures
   * nothing — which is the point of seeding it: the two arms differ by whether
   * the fact was *handed over* or *fetched*.
   */
  memory?: Array<string | MemorySeed>;
  /** Room scenario: rooms to create, and which one wakes the agent. */
  rooms?: RoomSpec[];
  /**
   * Whose turn to run, and where.
   *
   * One entry is the ordinary case and may be written as a bare object. A
   * **list** runs the turns in order against the same rooms, which is how a
   * scenario tests two agents rather than one agent twice: A answers, B wakes
   * on what A posted, and the assertions see both. `agent` defaults to the
   * agent under test, so a single-agent scenario never names it.
   *
   * Defaults to the last room with `incoming` lines.
   *
   * A {@link WakeRounds} object says "this roster, this many passes" instead,
   * for scenarios where the number of exchanges is not knowable in advance.
   */
  wake?: WakeStep | WakeStep[] | WakeRounds;
  /** Chat scenario: the message the owner sends. Mutually exclusive with `rooms`. */
  message?: string;
  /**
   * Witness names. Each gets a fresh unguessable value per run, substituted
   * wherever `{{token:<name>}}` appears — in history, the message, rooms, tool
   * results and the assertions alike.
   *
   * This is how a scenario stops asserting a proxy. A value the agent can only
   * have obtained by doing the task cannot be guessed, confabulated, or
   * produced by a turn that stalled.
   */
  tokens?: string[] | Record<string, import("./tokens.js").TokenFormat>;
  /** Canned results for stubbed tools, keyed by tool name. */
  toolResults?: ToolResults;
  /**
   * Machinery with state, for scenarios that withhold the procedure.
   *
   * Rules here are consulted before `toolResults`, so the two compose: the
   * world answers the calls that move it, and static stubs answer the rest.
   */
  world?: WorldSpec;
  /**
   * Give the agent an `answer` tool that says whether it is right.
   *
   * Turns a scenario from "was your first answer correct" into "did you
   * converge", which is a different capability and the one most real work
   * consists of. See `oracle.ts` — including the rule about answer spaces, which
   * a scenario using this has to satisfy or the attempts become a search.
   */
  oracle?: OracleSpec;
  /** Instruments that exist only here. See {@link ScenarioTool}. */
  tools?: ScenarioTool[];
  /** An economy to run rather than a puzzle to solve. See {@link SimulationSpec}. */
  simulation?: SimulationSpec;
  /**
   * Partial credit, so a long scenario reports where it stopped rather than
   * that it stopped. See {@link Milestone}.
   */
  milestones?: Milestone[];
  /** Facts that have to reach somebody, keyed by name. See {@link FactSpec}. */
  facts?: Record<string, FactSpec>;
  /** Overrides the run-wide default. */
  repeats?: number;
  expect: Assertion[];
}

/**
 * One check. Exactly one key per entry, so a failure names itself.
 *
 * Split into three families, and the split is the point:
 *
 *   `prompt_*`  — properties of the invocation message. Deterministic: the same
 *                 code and the same seed produce the same request every time, so
 *                 these fail only when the assembly changes. They are the part of
 *                 the score you can trust after a single run.
 *   everything else — properties of what the model did. Stochastic, which is why
 *                 scenarios repeat and the score is a rate, not a verdict.
 *   `judge`     — an LLM reading the reply against a rubric. Noisiest of the
 *                 three; reach for it only when no deterministic check will do.
 */
export interface Assertion {
  /** The model called this tool at least once. */
  calls_tool?: string;
  /** It called at least one of these. */
  calls_tool_any?: string[];
  /** It called none of these. */
  does_not_call?: string[];
  /** Some call to `tool` had arguments matching every entry in `where`. */
  tool_args?: { tool: string; where: Record<string, string | number | boolean> };
  /**
   * No call to `tool` had arguments matching every entry in `where`.
   *
   * The negative `does_not_call` cannot express, and the difference matters
   * wherever a tool is both the safe way to look and the dangerous way to act.
   * `does_not_call: [exec]` forbids `aws s3 ls` as firmly as `aws s3 rb` — so a
   * scenario about not deleting the wrong bucket failed agents that checked
   * which buckets existed first, which is the behaviour it wanted.
   */
  /**
   * No call to `tool` matched `where`. Either side accepts a list, meaning
   * "any of these" — one entry can forbid four memory tools with five lookup
   * actions without forbidding the writes those same tools perform.
   */
  does_not_call_with?: {
    tool: string | string[];
    where: Record<string, string | number | boolean | Array<string | number | boolean>>;
  };
  /**
   * How many times a named agent *ran* a tool — reading executions, not the
   * model's requests.
   *
   * The multi-agent question `calls_tool` cannot ask. In a delegation chain,
   * "somebody called facts" is true whether the work was shared correctly or
   * one agent did all of it, and that difference is usually the whole scenario.
   * `min` defaults to 1 unless a `max` is given, matching `posts_by`.
   */
  calls_by?: {
    agent: string;
    tool: string;
    where?: Record<string, string | number | boolean>;
    min?: number;
    max?: number;
  };
  /** The agent posted in this room (by name). */
  posts_in?: string;
  /** It posted in none of these. */
  does_not_post_in?: string[];
  /**
   * How many times a named agent spoke. `min` defaults to 1 when no `max` is
   * given, so `posts_by: {agent: dana}` asserts dana said something at all —
   * and `posts_by: {agent: dana, max: 0}` asserts it stayed out, which a
   * fixed default of 1 would make unsatisfiable.
   *
   * The multi-agent question `posts_in` cannot ask: with two agents taking
   * turns, "somebody posted in ops" is true whether the handoff worked or one
   * agent answered twice.
   */
  posts_by?: {
    agent: string;
    min?: number;
    max?: number;
    /**
     * Regex one of that agent's own posts must match.
     *
     * `reply_matches` cannot stand in for this on a room scenario: `reply` is
     * every post joined, so it passes when *either* agent produced the text. In
     * a handoff — one agent looks something up, the next acts on it — that makes
     * the assertion true the moment the first agent speaks, which is the half
     * that was never in doubt.
     */
    matches?: string;
  };
  /** Whether the turn produced any outward message at all. */
  replies?: boolean;
  /** Regex over the reply text. */
  reply_matches?: string;
  reply_not_matches?: string;
  /** Case-insensitive substring: at least one must appear. */
  reply_mentions_any?: string[];
  /**
   * Case-insensitive substring: every one must appear.
   *
   * The assertion for "relay all of it" rather than "say something about it".
   * A character count is the usual stand-in and measures the wrong thing — it
   * passes for four hundred characters of apology and fails a dense answer that
   * covered every point.
   */
  reply_mentions_all?: string[];
  /** Case-insensitive substring: none may appear. */
  reply_mentions_none?: string[];
  max_reply_chars?: number;
  min_reply_chars?: number;
  /**
   * Word-trigram overlap between the reply and an earlier text, as a fraction
   * of the shorter one. This is the repetition-degeneration check: a healthy
   * reply scores ~0.1–0.2 against the agent's own last message, a re-emitted
   * one ~0.9. `prior_reply` compares against the last assistant line in
   * `history`; `text` compares against a literal.
   */
  max_overlap?: { threshold: number; prior_reply?: boolean; text?: string };
  /** Substring of the assembled request (system prompt + every message). */
  prompt_contains?: string;
  prompt_not_contains?: string;
  /** How many times a string appears across the whole request. */
  prompt_occurrences?: { text: string; min?: number; max?: number };
  /** Estimated tokens of the first request. Guards against prompt bloat. */
  prompt_max_tokens?: number;
  /**
   * Model round-trips this turn is allowed. The effort tripwire: a scenario
   * that starts taking four rounds to do what it did in one is more expensive
   * and no less correct, so no pass rate can express it.
   */
  max_rounds?: number;
  /** Tool calls this turn is allowed, for the same reason. */
  max_tool_calls?: number;
  /**
   * The agent submitted the right answer, within `within` attempts.
   *
   * `within` defaults to the oracle's own limit, so writing `answers_correctly:
   * true` asks only "did it get there". Setting it lower is how a scenario says
   * the answer should not have taken three tries — which is the difference
   * between knowing and searching, and the whole reason attempts are counted.
   */
  answers_correctly?: boolean | { within: number };
  /**
   * The world ended in this state — or in the scenario's `goal`, when written
   * as `world_state: goal`.
   *
   * The assertion for a scenario that gives an objective rather than a
   * procedure. It says nothing about how: any route that reaches the state
   * passes, which is the only fair way to grade a puzzle with more than one
   * solution, and a reply that merely *claims* to have done it reaches nothing.
   */
  world_state?: Record<string, string> | "goal";
  /**
   * The world *passed through* this state, whether or not it ended there.
   *
   * `world_state` is the win condition and asks about the end. Any step in the
   * middle of a chain needs this one instead: a scenario where the part is
   * fabricated and then installed leaves `part: installed`, so a `world_state:
   * {part: made}` milestone scores a team that did the work as having skipped
   * it. Read off the transitions, so it is still a claim about the machinery and
   * never about the transcript.
   */
  world_reached?: Record<string, string>;
  /**
   * A declared fact got at least this far. See {@link FactTrace} for the ladder.
   *
   * The assertion no per-agent check can make. `calls_by` says an agent used a
   * value; it cannot say the value was one somebody else had to hand it, which
   * is the only interesting question once each agent works on its own.
   */
  fact_reaches?: { fact: string; stage: import("./types.js").FactStage };
  /**
   * A number the simulation produced landed in range.
   *
   * The assertion for a scenario with an objective instead of an answer. It says
   * nothing about how the team got there, which is the only fair way to grade a
   * problem with no correct solution.
   */
  sim_metric?: { metric: string; at_least?: number; at_most?: number };
  /**
   * The team beat a named baseline policy on the same seed and the same horizon.
   *
   * The assertion that makes a dollar figure mean something. "$1.4M" is not a
   * result; "$1.4M against the reorder-point rule's $1.2M on identical weather"
   * is. The baseline is re-run in-process at grade time — no model, a few
   * milliseconds — so the comparison is exact rather than a remembered number
   * from a different build of the economy.
   *
   * It is also the only check here that cannot be satisfied by a lucky seed:
   * both sides got the same one.
   */
  beats_baseline?: { policy: string; metric?: string; by?: number };
  /**
   * The organisation acted on an event within `days` of it happening.
   *
   * See `sim/latency.ts`. `crossingRoles` additionally demands that the agent
   * who acted is not one that could see the event — the difference between
   * somebody noticing and the organisation responding, which is the whole thing
   * a multi-agent framework is supposed to add.
   */
  responds_within?: { event: string; days: number; crossingRoles?: boolean };
  /**
   * Fraction of the scenario's milestone points earned, 0–1.
   *
   * A fraction rather than a raw total because points are relative weights: a
   * scenario is free to sum to 37, and `score_at_least: 0.6` means the same
   * thing there as on one that sums to 100.
   */
  score_at_least?: number;
  /** Ask the model whether the reply satisfies a rubric. Off under `--no-judge`. */
  judge?: { rubric: string };
}

/** Stages a {@link FactSpec} passes through, hardest last. */
export type FactStage = "discovered" | "shared" | "received" | "used";

/** What one tool call looked like. */
export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A tool call that actually executed, and who ran it.
 *
 * Distinct from {@link RecordedCall}, which is what the model *asked* for.
 * The two differ whenever the loop declines a call — the derivability gate
 * refusing an ambiguous delete is a request with no execution — and a scenario
 * that wants "the delete did not happen" has to read this one. `agent` is unset
 * only where a tool ran outside a named agent's turn.
 */
export interface RecordedExecution {
  name: string;
  args: Record<string, unknown>;
  agent?: string;
  /**
   * What the tool handed back, truncated.
   *
   * Kept because it is the only place a fact enters the system. Fact routing
   * asks "who was told this", and the answer is exactly "whose tool result
   * contained it" — unrecoverable from the request trace, which shows the value
   * only after the model has already repeated it.
   */
  result?: string;
  /**
   * Which turn ran it, indexed from 0 over the scenario's wake steps.
   *
   * Executions and posts live in separate lists with no shared clock, so
   * "did Boron act on this after Atlas said it" was not answerable at all.
   * Stamping both with the turn index gives a total order for the price of a
   * counter.
   */
  turn?: number;
}

/** One rule for a stubbed tool: answer `then` when the call matches `when`. */
export interface ToolResultRule {
  when?: Record<string, string | number | boolean>;
  then: string;
}

/**
 * Canned results per tool. A string answers every call the same way; a list
 * answers this call, which is what lets a stub act as a witness.
 */
export type ToolResults = Record<string, string | ToolResultRule[]>;

/**
 * One transition in a scenario's world: what a call does, and when it works.
 *
 * `when` matches the call's arguments, exactly as `toolResults` does. `requires`
 * matches the *world* — the part `toolResults` cannot express — and a call whose
 * arguments match but whose requirements do not gets `else` and changes nothing.
 * `sets` is what the call did to the world if it worked.
 */
export interface WorldRule {
  tool: string;
  /**
   * Who is allowed to drive this transition. Omit for anyone.
   *
   * The difference between a team and a group of people with the same job. A
   * lead that has to route work only has something to route when the machinery
   * refuses the wrong hands — otherwise whoever wakes first does the lot, which
   * is what happened the first time this scenario ran: the archivist threw the
   * main breaker and the lead's decisions changed nothing.
   */
  by?: string | string[];
  /** Argument match. Same syntax as a `toolResults` rule, `/regex/` included. */
  when?: Record<string, string | number | boolean>;
  /** World state this call needs. Unmet means `else`, and no mutation. */
  requires?: Record<string, string>;
  /** What the tool returns when the call lands. */
  then: string;
  /** What it returns when `requires` is unmet. The scenario's way of teaching. */
  else?: string;
  /** What the call changed. */
  sets?: Record<string, string>;
}

/**
 * A scenario with machinery in it, rather than a scenario with answers in it.
 *
 * Every stub before this was a pure function of the call: the same arguments
 * returned the same string forever, so a scenario could ask "did you make the
 * right call" and never "did you work out what the right calls *were*". Nothing
 * could be locked, so nothing had to be unlocked first, and the order of
 * operations — most of what coordinating anything actually consists of — was
 * not expressible at all.
 *
 * A world is a small state machine the tools drive. The agent is told a goal
 * and not a procedure; what it has to do is discover the dependencies from what
 * the tools say when they refuse, and then drive them in an order that works.
 *
 * `goal` is the win condition, and it is a claim about the world rather than
 * about the transcript. That matters more than it looks: a puzzle with two
 * solutions passes on either, an agent that reaches the state by a route nobody
 * thought of still passes, and no amount of fluent description of having done
 * it counts for anything. It is the witness idea applied to actions instead of
 * facts.
 */
export interface WorldSpec {
  /** Every variable and its starting value. Rules may only touch these. */
  state: Record<string, string>;
  rules: WorldRule[];
  /**
   * The state that means the scenario was solved. Asserted with
   * `world_state`, which defaults to this when written bare.
   */
  goal?: Record<string, string>;
}

export interface OracleSpec {
  /** The accepted answer, or several. Compared loosely: trailing punctuation and case do not matter. */
  answer: string | string[];
  /** Attempts before the tool stops accepting. Default 3. */
  attempts?: number;
  /**
   * Accept "I don't know" as correct.
   *
   * For a scenario whose fact has become unreachable, where conceding is the
   * right answer and a specific value is by definition invented. Makes
   * "how many fabrications before it concedes" a measurable quantity.
   */
  acceptsUnknown?: boolean;
}

/** One submitted answer. */
export interface Submission {
  agent?: string;
  answer: string;
  correct: boolean;
  /** Correct because it conceded, rather than because it knew. */
  conceded: boolean;
}

/** One thing that happened to the world, for reading a solution back. */
export interface WorldEvent {
  /** Who ran the call, when a named agent's turn ran it. */
  agent?: string;
  /** Which wake step ran it. See {@link RecordedExecution.turn}. */
  turn?: number;
  tool: string;
  /** Short form of the call, enough to recognise it in a trace. */
  call: string;
  /** `power: off → on`, or the requirement that was not met. */
  effect: string;
  /**
   * The changes this call actually applied, structured.
   *
   * `effect` is a display string and parsing it back was the obvious cheap
   * option; this exists because a milestone on a *transient* state cannot be
   * graded any other way. `world_state: {part: made}` is a claim about the final
   * state, so a team that fabricated the part and then installed it scores as
   * never having fabricated it — which is what happened on the first run of
   * `the-machine`, and reads as a step the team skipped rather than one it
   * completed.
   */
  sets?: Record<string, string>;
  /** Whether the call landed or was refused by `requires`. */
  applied: boolean;
}

/** One request as it went over the wire. */
export interface RecordedRequest {
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
  estimatedTokens: number;
  /**
   * True for a provider call the *runtime* made on the agent's behalf rather
   * than a turn the agent took — today that means the history summariser.
   *
   * It exists because `prompt_*` assertions and `max_rounds` describe the
   * invocation message, and the summariser's call is not one: it carries no
   * tools, a different system prompt, and a flattened transcript of the
   * messages about to be dropped. When `summarizeOnTrim` became the default it
   * moved to the front of `requests`, and every prompt assertion on a scenario
   * that trims silently began grading it — reading 299 tokens where the agent's
   * request was 6,409, and failing a `prompt_contains` for text that was
   * present in the request the model actually answered.
   *
   * Discriminated by the absence of tools, which is a property of the call and
   * not a guess: the loop passes the resolved tool set on every turn it takes,
   * and a scenario's allowlist cannot be empty.
   */
  auxiliary?: boolean;
}

/**
 * Tokens for one run, or totalled for a whole report.
 *
 * `cacheRead` / `cacheWrite` are optional because most endpoints do not report
 * them. The local vLLM returns `prompt_tokens_details: null`; OpenAI-compatible
 * hosted providers populate `prompt_tokens_details.cached_tokens`, which
 * `providers/openai.ts` surfaces as `cacheRead`. A cached read is priced in a
 * third tier — on some providers around 50× cheaper than an uncached one — so
 * where it is reported it dominates the bill rather than decorating it.
 *
 * Absent is not zero, and the difference matters: reporting 0 cached tokens for
 * a provider that never said would read as "the cache is not working".
 */
export interface RunUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RunOutcome {
  reply: string;
  /**
   * Provider calls that threw, whether or not the turn recovered. Recorded
   * separately from `error` because the room path swallows a failed turn by
   * design, so "the loop returned" is not evidence the model answered.
   */
  providerErrors?: string[];
  /** Calls that needed a retry (throttling, transient 5xx). Surfaced so pacing problems are visible. */
  retries?: number;
  calls: RecordedCall[];
  /**
   * Calls that ran, with the agent that ran them. See {@link RecordedExecution}.
   *
   * Optional because reports written before it existed do not carry it, and
   * `undefined` there means "not recorded", never "nothing ran". `regrade`
   * skips `calls_by` on such a report rather than reading an absence as a
   * result — the same rule `prompt_*` follows on a report with no prompt text.
   */
  executions?: RecordedExecution[];
  /**
   * Every post the turn(s) produced, attributed — `agent` is the speaker on the
   * envelope, `turn` the wake step that produced it (see
   * {@link RecordedExecution.turn}).
   */
  posts: Array<{ room: string; body: string; agent?: string; turn?: number }>;
  requests: RecordedRequest[];
  /**
   * The turns that actually ran, in order — the index is the `turn` stamped on
   * executions and posts.
   *
   * Recorded rather than derived from the scenario because a `rounds:` wake
   * stops early when a pass changes nothing, so the declared roster and the
   * turns taken are different lists. It is also the only way to know an agent
   * woke and said nothing, which is a distinct failure from never being woken.
   */
  turns?: Array<{ agent: string; room: string }>;
  /** Simulation runs only: which simulated day each turn ran on, indexed by turn. */
  dayOfTurn?: number[];
  /**
   * Why the loop ended, when the runner could capture it.
   *
   * Read structurally rather than off the reply text: a turn that runs out of
   * rounds gets a tools-withheld retry and usually returns ordinary prose, so
   * there is no marker to match.
   *
   * Both paths report it now. The chat path takes it from `onStop`; the room
   * path listens for `room.turn_ended`, because `pollOnce` returns void and the
   * FIFO chain behind it has nowhere to thread a value back. It stayed
   * undefined on 56% of a 237-run cohort before that, so a report predating
   * this carries no stop for its room runs — undefined means "not recorded",
   * which graders must treat as unknown and never as "did not stall".
   */
  stop?: import("@tailored-ai/core").LoopStop;
  /**
   * The world as the run left it, and every transition that got it there.
   *
   * The trace is not scored. It is here because a scenario that withholds the
   * procedure has no single right transcript, so "why did this fail" cannot be
   * read off the reply — the interesting question is which door it never opened,
   * and that is only answerable from the machinery's side.
   *
   * Absent on scenarios with no `world`, and on reports written before it
   * existed, which `regrade` treats as "not recorded" rather than as failure.
   */
  world?: Record<string, string>;
  worldLog?: WorldEvent[];
  /** The economy this run drove, and what it was worth at the end. */
  simulation?: SimulationOutcome;
  /**
   * Every answer submitted, in order.
   *
   * The count is a score and the sequence is the finding: three different
   * fabrications reads nothing like one guess followed by a concession, and no
   * pass rate can tell them apart.
   */
  guesses?: Submission[];
  latencyMs: number;
  usage: RunUsage;
  error?: string;
}

export interface CheckResult {
  /** The assertion key, e.g. `calls_tool`. */
  kind: string;
  pass: boolean;
  /** Present on failure: what was expected vs what happened. */
  detail?: string;
  /** Judge checks are excluded from the score under `--no-judge`. */
  skipped?: boolean;
}

export interface RunResult {
  /**
   * Partial credit, and where it stopped. Absent on a scenario with no
   * `milestones:` and on reports written before they existed.
   */
  milestones?: MilestoneResult[];
  /** Where each declared fact got to. Absent on a scenario with no `facts:`. */
  facts?: FactTrace[];
  /**
   * The witness values this run was given, so it can be re-graded later.
   *
   * Without them a replay grades today's `{{token:secret}}` against a reply
   * containing the value that run actually saw, and every witness scenario
   * scores 0 — which is what happened the first time `regrade` was pointed at
   * one. The values are random per run and mean nothing outside it.
   */
  tokens?: Record<string, string>;
  pass: boolean;
  checks: CheckResult[];
  outcome: RunOutcome;
}

export interface ScenarioResult {
  id: string;
  category: string;
  intent: string;
  /**
   * Copied from the scenario, so a report can be scored by difficulty without
   * re-reading the YAML — which by then may have been relabelled. Optional
   * because reports written before the scale existed have none.
   */
  difficulty?: number;
  /** Copied from the scenario so a report explains its own red rows. */
  knownGap?: string;
  runs: RunResult[];
  /** Fraction of runs that passed every check. */
  passRate: number;
  error?: string;
}

export interface BenchmarkReport {
  meta: {
    startedAt: string;
    finishedAt: string;
    gitSha: string;
    gitDirty: boolean;
    model: string;
    baseUrl: string;
    /** Provider id the agent ran on, and any plugins loaded to supply it. */
    provider: string;
    plugins: string[];
    repeats: number;
    seed: number | null;
    /**
     * The settings that decide what the model does, recorded so a published
     * result can be read back to see what produced it.
     *
     * All optional: reports written before this existed have none of them, and
     * a reader has to be able to tell "ran without a cap" from "ran before we
     * wrote the cap down".
     *
     * `maxTokens` and `thinking` between them caused #490 — a turn spent its
     * whole budget on a reasoning trace and answered nothing — and neither was
     * visible in the report that showed the failure. `pinnedAt`/`timeZone` say
     * whether a wall-clock scenario reproduces at all; null means it ran on the
     * host clock, so a re-run on a different day may legitimately differ.
     */
    maxTokens?: number | null;
    /**
     * How many tool rounds a turn was allowed before the harness called it a
     * stall.
     *
     * Recorded because it is a *scoring* setting disguised as a plumbing one. A
     * model that searches before it answers spends rounds; one that answers
     * immediately does not. Comparing the two under a low cap does not measure
     * which is better, it measures which gives up sooner — and a report that
     * does not say what the cap was cannot be read back to notice that.
     * Measured on Qwen3.8, raising it from 6 to 20 moved a category from 33.3%
     * to 54.2% and dropped stalls from 16 to 5, with no change to the model.
     */
    maxToolRounds?: number;
    thinking?: string | null;
    /**
     * The dialect that carried {@link thinking} to the wire.
     *
     * The level alone does not identify the request. Under `vllm` every enabled
     * level sends the same `enable_thinking: true`, so the template's own
     * default decides the effort — `medium` and `high` are the same call. Under
     * `vllm_effort` they are different calls. Without this field a report
     * asking for `medium` cannot be told apart from one that asked for medium
     * and was served the template's maximum, which is exactly the confound that
     * made every Qwen3.8 number before 2026-08-15 an `xhigh` number.
     */
    thinkingDialect?: string | null;
    /**
     * Whether the agent was handed its memory or left to fetch it. Null means
     * the flag was not passed and core's default (off) applied — which is what
     * every run before this field existed did.
     */
    injectMemory?: boolean | null;
    pinnedAt?: string | null;
    timeZone?: string | null;
    judge: boolean;
    /**
     * Whether this run kept the prompt text of every run.
     *
     * Recorded because it decides what `regrade` can score: without it the
     * `prompt_*` checks on passing runs have nothing to read, and a re-score
     * has to skip them rather than fail them.
     */
    keepPrompts?: boolean;
    /**
     * Set when this report was produced by `regrade` rather than by running the
     * model: today's assertions scored against an older run's behaviour.
     *
     * Named on the report because such a file is *not* a baseline — its score
     * belongs to one commit's questions and another commit's answers, and
     * publishing it would pair the two silently.
     */
    regradedFrom?: { report: string; gitSha: string };
    scenarioSetHash: string;
    /**
     * Digest per scenario this run covered, so a published result can be told
     * apart from the scenario it is rendered beside.
     *
     * The set hash cannot do it. The site reads intent and `knownGap` from
     * today's scenario files and pairs them with an old report, so a scenario
     * that keeps its id and changes its assertions shows an old number under a
     * new description — and coverage matches perfectly, because the id did not
     * move. Absent on reports written before this existed.
     */
    scenarioFingerprints?: Record<string, string>;
    durationSeconds: number;
    /**
     * What the run cost, totalled from every recorded call.
     *
     * Split rather than summed, because input and output are priced an order of
     * magnitude apart and a single "tokens" figure cannot separate *the prompt
     * got bigger* from *the model talked more* — which have opposite fixes, and
     * the first is the thing this benchmark exists to catch.
     *
     * Absent on reports written before this existed; derive it from the runs
     * (`totalUsage`) rather than treating a missing field as zero.
     */
    usage?: RunUsage;
    /**
     * What it cost, at the rates in force when it ran, or `null` for a model
     * with no known price. Recorded rather than derived so every surface shows
     * the same bill and an old run keeps the rates it was actually billed at.
     */
    cost?: { usd: number; rates: { input: number; output: number; cachedInput?: number; asOf: string } } | null;
  };
  score: {
    overall: number;
    passed: number;
    total: number;
    byCategory: Record<string, { passed: number; total: number; rate: number }>;
    /**
     * The same runs, cut by how hard the question was rather than what it was
     * about. Keyed by level as a string, because JSON has no integer keys.
     *
     * This is the cut that says where the ceiling is. Category tells you which
     * subsystem is weak; difficulty tells you whether the model is failing the
     * hard half of every subsystem, which is a different problem with a
     * different fix. Absent on reports written before the scale existed.
     */
    byDifficulty?: Record<string, { passed: number; total: number; rate: number }>;
  };
  scenarios: ScenarioResult[];
}
