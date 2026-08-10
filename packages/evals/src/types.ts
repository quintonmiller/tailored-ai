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

export interface Scenario {
  id: string;
  category: string;
  /** Why this scenario exists — printed next to a failure. */
  intent: string;
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
  /** Which room to poll. Defaults to the last room with `incoming` lines. */
  wake?: { room: string; kind?: "poll" | "checkin" };
  /** Chat scenario: the message the owner sends. Mutually exclusive with `rooms`. */
  message?: string;
  /** Canned results for stubbed tools, keyed by tool name. */
  toolResults?: Record<string, string>;
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
  /** The agent posted in this room (by name). */
  posts_in?: string;
  /** It posted in none of these. */
  does_not_post_in?: string[];
  /** Whether the turn produced any outward message at all. */
  replies?: boolean;
  /** Regex over the reply text. */
  reply_matches?: string;
  reply_not_matches?: string;
  /** Case-insensitive substring: at least one must appear. */
  reply_mentions_any?: string[];
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
  /** Ask the model whether the reply satisfies a rubric. Off under `--no-judge`. */
  judge?: { rubric: string };
}

/** What one tool call looked like. */
export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/** One request as it went over the wire. */
export interface RecordedRequest {
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
  estimatedTokens: number;
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
  posts: Array<{ room: string; body: string }>;
  requests: RecordedRequest[];
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
  pass: boolean;
  checks: CheckResult[];
  outcome: RunOutcome;
}

export interface ScenarioResult {
  id: string;
  category: string;
  intent: string;
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
    judge: boolean;
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
  };
  scenarios: ScenarioResult[];
}
