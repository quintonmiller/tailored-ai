/**
 * Which past runs a run is allowed to be compared against, and how to say the
 * difference out loud.
 *
 * The scoreboard used to rank every trace in the directory against every other
 * one, and for a while that was harmless because every run played the same
 * game. It stopped being harmless the moment the descent grew options. The
 * traces on disk today include five runs that started on floor 31 with no maze
 * and three that start on floor 1 with a room graph and a surface outfitter;
 * the floor-31 runs score thousands of experience in their first rounds and the
 * floor-1 runs score tens. Ranking them together does not produce a slightly
 * noisy leaderboard, it produces a permanent record nobody can ever beat and a
 * "7,753 behind" that describes a different game.
 *
 * So a *cohort* is the set of runs that actually played the same game, and
 * everything on the record panel is scoped to one. Two rules follow from the
 * failure this exists to prevent:
 *
 * 1. A run whose configuration cannot be read off its trace is **unverified**,
 *    not compatible. It is named and set aside rather than quietly averaged in.
 * 2. A cohort deliberately spans seeds — different worlds, same rules — because
 *    that is what makes it a measurement of the organisation rather than of the
 *    dungeon. Which means the panel has to *say* it spans seeds, or a lucky
 *    world reads as an improvement.
 *
 * ## Not `cohort.ts`
 *
 * `cohort.ts` next door is about a different cohort entirely — the set of
 * published reports on the site, and whether they still describe the scenarios
 * they are printed beside. The word is overloaded in this package because both
 * meanings are the ordinary English one. This file is the *run* cohort: which
 * past runs of a scenario a live run may be measured against.
 *
 * ## A leaf on purpose
 *
 * This file imports nothing, exactly like `broadcast-contract.ts`, so both
 * halves of the package can compile it: `history.ts` builds the fingerprints in
 * Node, and the broadcast's records panel selects and phrases the cohort in a
 * browser that has no `node:` anything. Keeping the selection logic here rather
 * than on the server is also what lets it exist at all — `/history` is fetched
 * with a scenario and nothing else, and only the page knows which trace is the
 * one on screen.
 *
 * Nothing here reads a clock. Everything that needs "when" takes it as an
 * argument, the way `readHistory(dir, scenario, now)` already does.
 */

/* -------------------------------------------------------------------------- */
/* the fingerprint                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What game a run played, as far as its trace records it.
 *
 * Every field is nullable because every field can be missing: a trace written
 * before a facet existed, or a run that died before it published a scene, has
 * no honest value to offer. `null` here means *unknown*, never "default" — the
 * whole point is that guessing a default is how two incomparable runs end up in
 * the same average.
 */
export interface RunFingerprint {
  scenario: string;
  /**
   * Whether the trace ever published a simulation snapshot.
   *
   * The difference between "this game has no floors" and "nobody wrote down
   * which floor it started on". Without it every scenario that has no maze and
   * no floors — the lock, the machine — would compare `null` against `null`,
   * read that as two unknowns, and declare its own past runs unverified
   * forever. With it, two runs that both watched their simulation and both
   * recorded nothing for a facet are agreeing that the facet does not exist.
   */
  observed: boolean;
  /** Rounds the roster was given. The run's clock, not how far it got. */
  horizon: number | null;
  /** Floor the descent began on. A run that starts at 31 is not a hard version of a run that starts at 1. */
  startFloor: number | null;
  /** Whether floors were generated as room graphs rather than a single corridor. */
  maze: boolean | null;
  /** Whether the run began at the surface outfitter with gold and skill points. */
  preparation: boolean | null;
  /**
   * The milestone ladder, as an ordered list of ids.
   *
   * Deliberately *not* a cohort facet. The ladder decides what scores as a
   * milestone; it does not touch experience, depth, rooms or deaths, which are
   * the only things this panel compares. Recorded so the panel can warn that
   * milestone points are not comparable across the cohort even though the rest
   * of it is.
   */
  ladder: string | null;
  /**
   * Everything else the run was configured with, canonicalised.
   *
   * A bag rather than a field per option, and part of cohort identity, because
   * guessing which options are material is how the previous version of this
   * file was wrong: `startingGold` and `startingSkillPoints` change the game
   * outright, and neither had a field. Comparing the whole bag means an option
   * added tomorrow splits the cohort tomorrow, without anybody remembering to
   * come back here.
   *
   * The facets above are removed from it first, so a starting floor is not
   * reported twice, and values are normalised because the CLI's generic
   * `--sim-option` parser produces `"true"` where a scenario definition
   * produces `true`.
   *
   * `null` means the trace never recorded its options at all, which is every
   * trace written before the `simulation` field existed — and is why those
   * compare as unverified against anything that does record them.
   */
  options: Record<string, string> | null;
  /**
   * Which seeded world, named rather than numbered.
   *
   * A fallback for `seed`, and a cross-check on it. The party's generated names
   * are derived from the seed and nothing else, so two runs with the same cast
   * played the same world. It is the only world identity available on a trace
   * written before the seed was recorded.
   */
  cast: string | null;
  /**
   * The seed the simulation was built with.
   *
   * Reported, never compared: a cohort spans seeds by design, because that is
   * what makes it a measurement of the organisation rather than of the dungeon.
   * Splitting on it would leave every run alone with itself and quietly turn
   * the panel into a personal best.
   *
   * `null` for a trace written before `run.simulation` existed, which is most
   * of what is on disk — and the panel has to keep saying so rather than
   * implying the seeds happened to match.
   */
  seed: number | null;
}

export function blankFingerprint(scenario = ""): RunFingerprint {
  return {
    scenario,
    observed: false,
    horizon: null,
    startFloor: null,
    maze: null,
    preparation: null,
    ladder: null,
    options: null,
    cast: null,
    seed: null,
  };
}

/**
 * Option names that have a field of their own, and so must not also appear in
 * the bag. `days` is the horizon under the name the simulation registry uses.
 */
const BROKEN_OUT = new Set(["startFloor", "maze", "preparation", "days"]);

/**
 * One option value, as a string two traces can be compared on.
 *
 * Deliberately thin. An earlier version of this lower-cased and re-parsed
 * numbers, on the theory that `--sim-option` produces `"true"` where a scenario
 * definition produces `true` — which is real, but stringifying already settles
 * it, and the extra work only made the comparison *more* permissive than the
 * simulation itself. `--sim-option maze=TRUE` does not switch the maze on, so a
 * fingerprint that folded `"TRUE"` into `true` would report two runs as matching
 * when the game they played did not.
 *
 * So: booleans and numbers become their obvious text, strings are left exactly
 * as written, and a value that is absent is dropped rather than recorded as
 * "undefined".
 */
export function canonicaliseOptionValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return value;
  // Anything structured is compared as its JSON, which is stable enough for a
  // value that came out of a config file in the first place.
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * The options bag a fingerprint carries.
 *
 * Three things happen here and each one is a comparison that would otherwise go
 * wrong: the facets with a field of their own are removed so a starting floor
 * is not also reported as an option, absent values are dropped so a bag that
 * names an option as `undefined` matches one that never named it, and the keys
 * are sorted so two bags written in a different order are one cohort.
 *
 * `null` — an absent bag — is not the same as `{}`. It means the trace never
 * recorded its options, and it is what makes every trace older than the
 * `simulation` field unverified against every trace newer than it.
 */
export function canonicaliseOptions(raw: Record<string, unknown> | null | undefined): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw).sort()) {
    if (BROKEN_OUT.has(key)) continue;
    const value = canonicaliseOptionValue(raw[key]);
    if (value != null) out[key] = value;
  }
  return out;
}

/** `startingGold=180 startingSkillPoints=2`, in sorted key order. */
function optionsKey(options: Record<string, string>): string {
  return Object.keys(options)
    .sort()
    .map((k) => `${k}=${options[k]}`)
    .join(" ");
}

/** The option names two runs disagree about, named so an exclusion can say which. */
function optionsDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((k) => a[k] !== b[k]).sort();
}

/**
 * The facets that decide compatibility, in the order a reader would ask about
 * them: what game, for how long, starting where, under which rules.
 *
 * A table rather than a hand-written comparison so that the key, the exclusion
 * reason and the human label cannot drift apart — the failure mode of the old
 * code was a comparison whose stated basis and actual basis were different.
 */
const FACETS: ReadonlyArray<{
  id: keyof RunFingerprint;
  /** How it reads in the exclusion list: "a different horizon". */
  differs: string;
  short(value: unknown): string;
  /** For a facet whose value is not a scalar. Defaults to `String(value)`. */
  key?(value: unknown): string;
  /** A more specific exclusion reason when the values are known. Defaults to `differs`. */
  diff?(a: unknown, b: unknown): string;
}> = [
  { id: "scenario", differs: "a different scenario", short: (v) => String(v ?? "?") },
  { id: "horizon", differs: "a different horizon", short: (v) => `${v} rounds` },
  { id: "startFloor", differs: "a different starting floor", short: (v) => `from floor ${v}` },
  { id: "maze", differs: "a different floor layout", short: (v) => (v ? "maze floors" : "single rooms") },
  { id: "preparation", differs: "a different start", short: (v) => (v ? "outfitted" : "no preparation") },
  {
    id: "options",
    differs: "different simulation options",
    // Named individually. "Different simulation options" tells a viewer that a
    // run was excluded; "a different startingGold" tells them whether to care.
    diff: (a, b) => {
      const names = optionsDiff(a as Record<string, string>, b as Record<string, string>);
      if (!names.length) return "different simulation options";
      return `a different ${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` (+${names.length - 2} more)` : ""}`;
    },
    key: (v) => optionsKey(v as Record<string, string>),
    short: (v) => {
      const options = v as Record<string, string>;
      const names = Object.keys(options).sort();
      if (!names.length) return "no other options";
      const shown = names.slice(0, 3).map((k) => `${k} ${options[k]}`);
      return `${shown.join(", ")}${names.length > 3 ? `, +${names.length - 3} more` : ""}`;
    },
  },
];

const facetKey = (facet: (typeof FACETS)[number], value: unknown) => (facet.key ? facet.key(value) : String(value));

/** A stable string for a fingerprint, so "same cohort" is one comparison rather than six. */
export function fingerprintKey(fp: RunFingerprint | null | undefined): string {
  if (!fp) return "unknown";
  return FACETS.map((f) => {
    const value = fp[f.id];
    return value == null ? "?" : facetKey(f, value);
  }).join("|");
}

/** "the endless descent · 40 rounds · from floor 1 · maze floors · outfitted · startingGold 180" */
export function describeCohort(fp: RunFingerprint | null | undefined): string {
  if (!fp) return "unknown configuration";
  const parts: string[] = [];
  for (const facet of FACETS) {
    const value = fp[facet.id];
    parts.push(value == null ? `${facet.id} unknown` : facet.short(value));
  }
  return parts.join(" · ");
}

export type Verdict = "same" | "different" | "unverified";

export interface Comparison {
  verdict: Verdict;
  /** Facets that are known on both sides and disagree. */
  differs: string[];
  /** Facets one side or the other never recorded. */
  unknown: string[];
  /** One line fit to print beside an excluded run. */
  reason: string;
  /**
   * The single most important thing that is different.
   *
   * What a tally of exclusions groups on. A run that differs on both floor and
   * preparation reads as "a different starting floor"; grouping on the full
   * list instead produces a line with one entry per *combination*, which for
   * seven excluded runs was three groups where there should have been two.
   */
  primary: string;
}

/**
 * Whether two runs played the same game.
 *
 * "Unverified" is a third answer rather than a lenient "yes" on purpose. A
 * trace with no state event never says which floor it started on, and treating
 * that silence as "the same as mine" is exactly the false comparison this
 * module exists to stop. It is also not simply "different": the run may well be
 * compatible and nobody can tell, which is a thing worth showing to a person
 * and not worth feeding to an average.
 */
export function compareRuns(a: RunFingerprint | null | undefined, b: RunFingerprint | null | undefined): Comparison {
  const differs: string[] = [];
  const unknown: string[] = [];
  const bothWatched = !!a?.observed && !!b?.observed;
  for (const facet of FACETS) {
    const mine = a?.[facet.id] ?? null;
    const theirs = b?.[facet.id] ?? null;
    if (mine == null && theirs == null) {
      // Neither game has this facet, and both were watching. See `observed`.
      if (!bothWatched) unknown.push(facet.differs);
      continue;
    }
    if (mine == null || theirs == null) {
      unknown.push(facet.differs);
      continue;
    }
    if (facetKey(facet, mine) === facetKey(facet, theirs)) continue;
    differs.push(facet.diff ? facet.diff(mine, theirs) : facet.differs);
  }
  const verdict: Verdict = differs.length ? "different" : unknown.length ? "unverified" : "same";
  const reason = differs.length
    ? differs.join(", ")
    : unknown.length
      ? "configuration not recorded"
      : "same configuration";
  return { verdict, differs, unknown, reason, primary: differs[0] ?? reason };
}

/* -------------------------------------------------------------------------- */
/* runs                                                                        */
/* -------------------------------------------------------------------------- */

/** One round of a run, kept so a comparison can be made at the same round rather than at the end. */
export interface RunPoint {
  round: number;
  xp: number;
  floor: number;
  rooms: number;
  bosses: number;
  deaths: number;
}

/**
 * The parts of a past run this module needs.
 *
 * Structurally minimal, and everything the record book added is optional, so
 * `RunRecord` from either side of the package satisfies it — including the
 * browser's mirror in `viewer/broadcast/src/types.ts`, which this file must not
 * depend on and cannot edit.
 */
export interface CohortRun {
  file: string;
  scenario: string;
  model: string;
  startedAt: number;
  /** Rounds actually played. Compare against `fingerprint.horizon` for the budget. */
  rounds: number;
  score: number | null;
  floor: number | null;
  bosses: number | null;
  survivors: number | null;
  finished: boolean;
  fingerprint?: RunFingerprint | null;
  roomsExplored?: number | null;
  deaths?: number | null;
  track?: RunPoint[];
  /**
   * True for a baseline-policy rehearsal.
   *
   * Carried on the run rather than kept in a separate list at the call site
   * because the rule it enforces is absolute: a bot's score must never become
   * the record an agent is told it is behind. A convention at the call site is
   * one careless spread away from being broken, and this one was — the panel
   * briefly handed `[...runs, ...baselines]` straight to `buildCohort`.
   */
  baseline?: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A run that reported a headline figure. Everything that ranks or subtracts wants this. */
export type ScoredRun = CohortRun & { score: number };

export const isScored = (run: CohortRun): run is ScoredRun => isNum(run.score);

/* -------------------------------------------------------------------------- */
/* the cohort                                                                  */
/* -------------------------------------------------------------------------- */

export interface SetAside {
  run: CohortRun;
  verdict: Exclude<Verdict, "same">;
  /** Everything that differs, for a reader who wants the whole story. */
  reason: string;
  /** The headline difference, which is what a tally of exclusions groups on. */
  primary: string;
}

export interface Cohort {
  /** The fingerprint every member shares — the run on screen's own. */
  fingerprint: RunFingerprint | null;
  key: string;
  label: string;
  /** Comparable past runs, newest first. Never includes the run on screen. */
  members: CohortRun[];
  best: ScoredRun | null;
  /** The member at the median score. A real run, so its round-by-round track can be drawn. */
  median: ScoredRun | null;
  /** The most recent member that ran to a conclusion. */
  previous: CohortRun | null;
  setAside: SetAside[];
  /**
   * Comparable baseline rehearsals, best first.
   *
   * Their own list, never `members`: "where does this run sit against the
   * ladder" is a fair question and "the record was set by a bot" is not an
   * answer. A rehearsal that played a different configuration is not here and
   * is not in `setAside` either — it was never a candidate.
   */
  baselines: ScoredRun[];
  /** Distinct seeded worlds among the members, and how many never said. */
  worlds: { distinct: number; unknown: number; sharedWithCurrent: number };
  /** True when members disagree about the milestone ladder, so points are not comparable. */
  ladderVaries: boolean;
  /**
   * Every seed in play, ascending — the run on screen's included.
   *
   * The panel's job with this is to say the quiet part: a cohort of six runs
   * over two seeds is a much weaker claim than six over six, and a run that is
   * ahead of a cohort it shares a seed with is a different finding again.
   */
  seeds: number[];
  /** How many of those runs, current included, never recorded which seed they played. */
  seedsUnknown: number;
}

/**
 * Split every run on file into "played my game" and "did not".
 *
 * The run on screen is excluded from its own cohort. It is a file in the trace
 * directory like any other, and a record it is compared against must not be
 * itself — the panel would otherwise sit at "0 to go" for the whole run.
 */
export function buildCohort(runs: readonly CohortRun[], currentFile: string, current: RunFingerprint | null): Cohort {
  const mine = base(currentFile);
  const members: CohortRun[] = [];
  const setAside: SetAside[] = [];
  const baselines: ScoredRun[] = [];

  for (const run of runs) {
    if (mine && base(run.file) === mine) continue;
    const verdict = compareRuns(current, run.fingerprint);
    if (run.baseline) {
      if (verdict.verdict === "same" && isScored(run)) baselines.push(run);
      continue;
    }
    if (verdict.verdict === "same") members.push(run);
    else setAside.push({ run, verdict: verdict.verdict, reason: verdict.reason, primary: verdict.primary });
  }

  members.sort((a, b) => b.startedAt - a.startedAt);
  baselines.sort((a, b) => b.score - a.score);

  const scored = members.filter(isScored);
  const best = scored.length ? scored.reduce((top, r) => (r.score > top.score ? r : top)) : null;

  // A world is the seed where one was recorded, and the cast where it was not.
  // Both identify the same thing — the cast is generated from the seed — so a
  // cohort that straddles the day the seed started being recorded still counts
  // its worlds, it just cannot match an old run against a new one.
  const worldOf = (fp: RunFingerprint | null | undefined): string | null =>
    isNum(fp?.seed) ? `seed:${fp.seed}` : fp?.cast ? `cast:${fp.cast}` : null;

  const memberWorlds = members.map((r) => worldOf(r.fingerprint));
  const named = memberWorlds.filter((c): c is string => !!c);
  const here = worldOf(current);
  const worlds = {
    distinct: new Set(named).size,
    unknown: memberWorlds.length - named.length,
    sharedWithCurrent: here ? named.filter((c) => c === here).length : 0,
  };

  // The current run counts: "seeds 1000, 1001" for a cohort the run on screen
  // is not part of would be a list a viewer cannot place themselves in.
  const everyone = [current, ...members.map((r) => r.fingerprint)];
  const seeds = [...new Set(everyone.map((fp) => fp?.seed).filter(isNum))].sort((a, b) => a - b);
  const seedsUnknown = everyone.filter((fp) => !isNum(fp?.seed)).length;

  const ladders = new Set(members.map((r) => r.fingerprint?.ladder ?? "?"));
  if (current?.ladder) ladders.add(current.ladder);

  return {
    fingerprint: current,
    key: fingerprintKey(current),
    label: describeCohort(current),
    members,
    best,
    median: medianRun(scored),
    previous: members.find((r) => r.finished) ?? null,
    setAside,
    baselines,
    worlds,
    ladderVaries: ladders.size > 1,
    seeds,
    seedsUnknown,
  };
}

/**
 * The run at the median score, rather than the median of the scores.
 *
 * A synthetic midpoint could not be drawn as a ghost line — there is no
 * round-by-round track for a number nobody ran — and "the typical run went this
 * way" is the thing worth seeing. Nearest-rank, taking the lower of the two
 * middles on an even count, so the answer is always an actual run.
 */
export function medianRun(rows: readonly ScoredRun[]): ScoredRun | null {
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => a.score - b.score);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Filename comparison across a `/events` path and a `/history` basename. */
function base(path: string | null | undefined): string {
  return (
    String(path ?? "")
      .split(/[\\/]/)
      .pop() ?? ""
  );
}

/* -------------------------------------------------------------------------- */
/* comparing at the same round                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a run stood at the end of round `round`.
 *
 * The load-bearing helper on this page. Comparing a live run's ninth round
 * against a finished run's fortieth is not a comparison, it is a statement that
 * the run in progress is not finished yet — and that is what the old panel did
 * every time it said "7,753 behind the record". Every figure the cohort panel
 * shows is sampled here first.
 *
 * Returns the latest point at or before `round`, so a run that published
 * nothing in a given round holds its last known position instead of dropping to
 * zero.
 */
export function sampleAt(track: readonly RunPoint[] | undefined, round: number): RunPoint | null {
  if (!track?.length) return null;
  let found: RunPoint | null = null;
  for (const point of track) {
    if (point.round > round) break;
    found = point;
  }
  return found;
}

/** How far a run got before it stopped. Used to say "it had ended by here" on the ghost line. */
export function lastPoint(track: readonly RunPoint[] | undefined): RunPoint | null {
  return track?.length ? track[track.length - 1] : null;
}

export type Axis = "xp" | "floor" | "rooms" | "bosses" | "deaths";

export interface AxisDelta {
  axis: Axis;
  mine: number | null;
  theirs: number | null;
  /** Positive means the run on screen is doing better, including for deaths. */
  delta: number | null;
}

/**
 * Which of the four things a lead can come from each axis speaks for.
 *
 * The acceptance criterion for this panel is that a viewer can tell whether a
 * lead came from pace, combat success, optional exploration or survival, so the
 * axes are chosen to map one-to-one onto those four and the mapping is written
 * down rather than implied by the row order.
 */
export const AXIS_MEANS: Record<Axis, string> = {
  xp: "score",
  floor: "pace",
  rooms: "exploration",
  bosses: "combat",
  deaths: "survival",
};

/** Deaths are the one axis where fewer is better, so its delta is negated to keep "positive is good". */
const LOWER_IS_BETTER: ReadonlySet<Axis> = new Set<Axis>(["deaths"]);

/**
 * How much of one axis counts as one unit of advantage.
 *
 * Used only to decide which axis to *name* as the source of a lead. Rooms move
 * several per floor and bosses move one per floor, so an unweighted comparison
 * would report exploration as the cause of every lead ever.
 */
const AXIS_SCALE: Record<Axis, number> = { xp: 250, floor: 1, rooms: 3, bosses: 1, deaths: 1 };

function axisValue(point: RunPoint | null, axis: Axis): number | null {
  if (!point) return null;
  return point[axis];
}

/** Every axis compared at one round, in the order the table shows them. */
export function deltasAt(
  mine: readonly RunPoint[] | undefined,
  theirs: readonly RunPoint[] | undefined,
  round: number,
  axes: readonly Axis[] = ["xp", "floor", "rooms", "bosses", "deaths"],
): AxisDelta[] {
  const a = sampleAt(mine, round);
  const b = sampleAt(theirs, round);
  return axes.map((axis) => {
    const left = axisValue(a, axis);
    const right = axisValue(b, axis);
    const raw = left == null || right == null ? null : left - right;
    const delta = raw == null ? null : LOWER_IS_BETTER.has(axis) ? -raw : raw;
    return { axis, mine: left, theirs: right, delta };
  });
}

/* -------------------------------------------------------------------------- */
/* saying it in words                                                          */
/* -------------------------------------------------------------------------- */

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * Small counts as words, larger ones as digits.
 *
 * "one floor ahead" is a sentence and "1 floor ahead" is a readout; the point of
 * this half of the panel is that it reads as somebody talking. Past ten the
 * word is longer than the number and stops helping.
 */
export function count(n: number): string {
  const abs = Math.abs(Math.round(n));
  return abs <= 10 ? WORDS[abs] : String(abs);
}

const NOUN: Record<Axis, [one: string, many: string]> = {
  xp: ["experience", "experience"],
  floor: ["floor", "floors"],
  rooms: ["room", "rooms"],
  bosses: ["boss", "bosses"],
  deaths: ["death", "deaths"],
};

/**
 * One delta, said out loud: "one floor ahead", "two rooms behind", "level on
 * bosses".
 *
 * Deaths get their own phrasing because "one death ahead" is genuinely
 * ambiguous about who is winning, and this panel is read at a glance.
 */
export function phrase(axis: Axis, delta: number | null): string {
  if (delta == null) return "";
  const rounded = Math.round(delta);
  const [one, many] = NOUN[axis];
  if (rounded === 0) return `level on ${many}`;
  const magnitude = Math.abs(rounded);
  const noun = magnitude === 1 ? one : many;
  if (axis === "xp") {
    return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toLocaleString("en-US")} ${one}`;
  }
  if (axis === "deaths") {
    return `${count(magnitude)} ${noun} ${rounded > 0 ? "fewer" : "more"}`;
  }
  return `${count(magnitude)} ${noun} ${rounded > 0 ? "ahead" : "behind"}`;
}

/**
 * The first round a run had reached a value on some axis.
 *
 * What "the boss went down four rounds earlier" is measured from. `null` when
 * it never happened, which is a different answer from "it happened at round 0".
 */
export function roundReached(track: readonly RunPoint[] | undefined, axis: Axis, value: number): number | null {
  if (!track?.length) return null;
  for (const point of track) {
    if (point[axis] >= value) return point.round;
  }
  return null;
}

/**
 * "the first boss went down four rounds earlier than the typical run".
 *
 * Only produced when both runs actually got there. A pace claim against a run
 * that never reached the milestone would be an infinite lead dressed up as a
 * number.
 */
export function pacePhrase(
  mine: readonly RunPoint[] | undefined,
  theirs: readonly RunPoint[] | undefined,
  axis: Axis,
  value: number,
  what: string,
): string {
  const a = roundReached(mine, axis, value);
  const b = roundReached(theirs, axis, value);
  if (a == null || b == null) return "";
  const gap = b - a;
  if (gap === 0) return `${what} on the same round`;
  return `${what} ${count(gap)} round${Math.abs(gap) === 1 ? "" : "s"} ${gap > 0 ? "earlier" : "later"}`;
}

/**
 * Which axis is carrying the run, named rather than left to be inferred.
 *
 * Returns the largest weighted advantage when there is one, and the largest
 * weighted deficit when there is not, so the line is never silent about a run
 * that is behind. `null` only when nothing can be compared at all.
 */
export function leadSource(deltas: readonly AxisDelta[]): { axis: Axis; delta: number; ahead: boolean } | null {
  let top: { axis: Axis; delta: number; weighted: number } | null = null;
  for (const d of deltas) {
    // Score is the sum of the others rather than a cause of its own; naming it
    // as the source of a lead would answer "why is it ahead" with "it is ahead".
    if (d.axis === "xp" || d.delta == null) continue;
    const weighted = d.delta / AXIS_SCALE[d.axis];
    if (!top || Math.abs(weighted) > Math.abs(top.weighted)) top = { axis: d.axis, delta: d.delta, weighted };
  }
  if (!top || top.delta === 0) return null;
  return { axis: top.axis, delta: top.delta, ahead: top.delta > 0 };
}

/* -------------------------------------------------------------------------- */
/* markers                                                                     */
/* -------------------------------------------------------------------------- */

export interface RunMarker {
  round: number;
  kind: "boss" | "death" | "floor" | "end";
  label: string;
}

/**
 * The rounds worth putting a dot on.
 *
 * Derived from the track rather than recorded alongside it, so the trace stays
 * exactly as it is and a change of mind about what counts as important costs
 * nothing. Floors are included because depth is the pace axis, but only when
 * the run is short enough that a dot per floor is still countable.
 */
export function markersFor(run: CohortRun, options: { floors?: boolean } = {}): RunMarker[] {
  const track = run.track ?? [];
  const markers: RunMarker[] = [];
  let bosses = 0;
  let deaths = 0;
  let floor: number | null = null;
  for (const point of track) {
    if (point.bosses > bosses) {
      bosses = point.bosses;
      markers.push({ round: point.round, kind: "boss", label: bosses === 1 ? "first boss" : `boss ${bosses}` });
    }
    if (point.deaths > deaths) {
      deaths = point.deaths;
      if (deaths === 1) markers.push({ round: point.round, kind: "death", label: "first death" });
    }
    if (options.floors && floor != null && point.floor > floor) {
      markers.push({ round: point.round, kind: "floor", label: `floor ${point.floor}` });
    }
    floor = point.floor;
  }
  const last = lastPoint(track);
  if (last && run.finished) {
    markers.push({ round: last.round, kind: "end", label: run.survivors === 0 ? "wiped" : "out of clock" });
  }
  return markers;
}
