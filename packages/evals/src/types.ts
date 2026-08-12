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
   */
  wake?: WakeStep | WakeStep[];
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
  /** Ask the model whether the reply satisfies a rubric. Off under `--no-judge`. */
  judge?: { rubric: string };
}

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
  tool: string;
  /** Short form of the call, enough to recognise it in a trace. */
  call: string;
  /** `power: off → on`, or the requirement that was not met. */
  effect: string;
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
  /** Every post the turn(s) produced, attributed — `agent` is the speaker on the envelope. */
  posts: Array<{ room: string; body: string; agent?: string }>;
  requests: RecordedRequest[];
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
    thinking?: string | null;
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
