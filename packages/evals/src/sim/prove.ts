/**
 * Proving things about a puzzle before anyone plays it.
 *
 * The failure this exists to prevent is a scenario in which some sequence of
 * reasonable-looking moves leaves the goal permanently unreachable — a
 * soft-lock. It cannot be found by playing, because the runs that hit it look
 * exactly like runs where the team was not good enough, and it poisons the
 * measurement in the worst possible direction: the harder a team tries, the
 * more likely it is to trip one.
 *
 * A puzzle written as an explicit transition system is a finite graph, so the
 * question is decidable rather than a matter of the author's care:
 *
 *   reachable      every state the machinery can actually be driven into
 *   winnable       every state from which the goal is still reachable
 *   soft-locks     reachable ∧ ¬winnable — must be empty
 *
 * Three more answers fall out of the same search, and each replaces a number
 * that would otherwise be guessed:
 *
 *   minRounds      the shortest solution, so the round budget is calibrated
 *                  against the puzzle rather than against a feeling
 *   blindRate      how often a player choosing uniformly at random wins, which
 *                  is what separates a hard puzzle from a merely long one
 *   deadMoves      transitions whose guard holds in no reachable state
 *
 * ## What this deliberately does not model
 *
 * Who holds which tool, and whether they know the argument. The question here
 * is whether the *machinery* can still be driven to the goal by a team with
 * perfect knowledge and perfect coordination — if it cannot, no amount of
 * either will help. Whether a team can discover the right value and get it to
 * the agent who needs it is the thing the scenario measures; it is not a
 * property of the state machine, and folding it in here would make the prover
 * answer a question it cannot answer.
 */

/**
 * A puzzle as something searchable.
 *
 * Deliberately tiny, and deliberately not tied to any one simulation: a puzzle
 * exposes its own moves and its own clock, and gets every proof below for free.
 * `key` is what makes the search finite — two states with the same key are the
 * same node, so a puzzle that carries un-keyed detail (prose, counters nobody
 * branches on) stays tractable by leaving it out of the key.
 */
export interface Move<S> {
  name: string;
  can(state: S): boolean;
  apply(state: S): S;
  /**
   * Who runs it. Used only to bound `minRounds`, and it is what makes that
   * number mean anything: an agent takes one turn per round, so two moves by
   * the same hand cannot be simultaneous. A puzzle whose two halves belong to
   * two agents needs at least one round; one whose halves belong to the same
   * agent needs two. Omit for machinery anybody can drive.
   */
  actor?: string;
  /**
   * True when running it requires knowing a value — a code, a computed key.
   *
   * The blind player is a model of an agent operating machinery it has not
   * understood: it can push every button, and it cannot invent a three-digit
   * number. Without this flag the blind estimate answers a question nobody
   * asked ("could a flailer win if it were also told every secret") and comes
   * back reassuringly, uselessly high.
   */
  needsKnowledge?: boolean;
}

export interface TransitionSystem<S> {
  initial: S;
  /** Every move the machinery affords, with its guard. Both must be pure. */
  moves: Array<Move<S>>;
  /** One round passing: decay, deadlines, anything the world does to itself. */
  tick(state: S): S;
  /** Solved. */
  won(state: S): boolean;
  /** Two states with the same key are the same node. */
  key(state: S): string;
  /**
   * Who takes a turn, in the order they take it.
   *
   * The harness wakes a roster once per round and each agent's turn may make
   * several calls, so the real constraint is not "one move per agent" — it is
   * that an agent whose turn has passed cannot act again until the clock comes
   * round. That ordering is what decides whether a chamber levelled by the
   * fifth agent can still be used by the second, and it is therefore what
   * decides how many rounds the puzzle actually takes.
   *
   * Omit for a puzzle where anybody can do anything at any time; `minRounds`
   * then reports the one-omniscient-hand answer, which is a floor rather than
   * a budget.
   */
  roster?: string[];
}

export interface ProofOptions {
  /** Rounds the scenario gives the team. Bounds `minRounds` and the search. */
  horizon?: number;
  /** Refuse rather than grind — a world this big is a design problem, not a search problem. */
  maxStates?: number;
  /** Trials for the blind-player estimate. */
  blindTrials?: number;
  /** Moves a blind player gets per round. Roughly what a roster can physically emit. */
  movesPerRound?: number;
}

export interface Proof {
  /** Distinct states the machinery can be driven into. */
  reachable: number;
  /** Reachable states from which the goal can no longer be reached. Must be empty. */
  softLocks: Array<{ state: unknown; via: string }>;
  /** Fewest rounds a perfect team needs, or null if the goal is unreachable at all. */
  minRounds: number | null;
  /** Fewest moves a perfect team needs, ignoring who runs them. */
  minMoves: number | null;
  /** How often a player choosing uniformly at random reaches the goal. */
  blindRate: number;
  /** Moves whose guard holds in no reachable state. Dead machinery, usually a typo. */
  deadMoves: string[];
  /** Set when the search was abandoned. Everything else is then unreliable. */
  truncated?: string;
}

/**
 * Can this puzzle still be won, from everywhere it can get to?
 *
 * The whole point of the file. A non-empty `softLocks` is a bug in the puzzle,
 * and each entry names a state and one move that reaches it — enough to find
 * the offending transition by reading.
 */
export function prove<S>(system: TransitionSystem<S>, opts: ProofOptions = {}): Proof {
  const maxStates = opts.maxStates ?? 400_000;
  const horizon = opts.horizon ?? 24;

  const states = new Map<string, S>();
  // Reverse edges only: the forward direction is walked as the search runs, and
  // the backward index is what "can this state still win" needs.
  const backward = new Map<string, Set<string>>();
  const via = new Map<string, string>();

  const startKey = system.key(system.initial);
  states.set(startKey, system.initial);
  const queue: string[] = [startKey];
  let truncated: string | undefined;
  const usedMoves = new Set<string>();

  while (queue.length) {
    const currentKey = queue.shift() as string;
    const current = states.get(currentKey) as S;

    const successors: Array<[S, string]> = [];
    for (const move of system.moves) {
      if (!move.can(current)) continue;
      usedMoves.add(move.name);
      successors.push([move.apply(current), move.name]);
    }
    successors.push([system.tick(current), "clock"]);

    for (const [next, how] of successors) {
      const nextKey = system.key(next);
      if (nextKey !== currentKey) {
        const preds = backward.get(nextKey) ?? new Set<string>();
        preds.add(currentKey);
        backward.set(nextKey, preds);
        if (!via.has(nextKey)) via.set(nextKey, how);
      }
      if (states.has(nextKey)) continue;
      if (states.size >= maxStates) {
        truncated = `stopped at ${maxStates} states — the puzzle is too large to prove; reduce the number of independent variables in key()`;
        queue.length = 0;
        break;
      }
      states.set(nextKey, next);
      queue.push(nextKey);
    }
  }

  // Backward closure from every winning state. Everything reachable and outside
  // it is, by definition, a state the team can never recover from.
  const winnable = new Set<string>();
  const stack: string[] = [];
  for (const [key, state] of states) {
    if (system.won(state)) {
      winnable.add(key);
      stack.push(key);
    }
  }
  while (stack.length) {
    const current = stack.pop() as string;
    for (const prev of backward.get(current) ?? []) {
      if (winnable.has(prev)) continue;
      winnable.add(prev);
      stack.push(prev);
    }
  }

  const softLocks = [...states]
    .filter(([key]) => !winnable.has(key))
    .slice(0, 12)
    .map(([key, state]) => ({ state, via: via.get(key) ?? "(initial)" }));

  return {
    reachable: states.size,
    softLocks,
    ...shortest(system, horizon, maxStates),
    blindRate: blindRate(system, horizon, opts.blindTrials ?? 3000, opts.movesPerRound ?? 18),
    deadMoves: system.moves.map((m) => m.name).filter((name) => !usedMoves.has(name)),
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * The shortest solution, in rounds and in moves.
 *
 * Rounds are what a scenario budgets, and they are not the same as moves: six
 * agents each take a turn per round and each turn can make several calls, so
 * within one round a team can drive many transitions. So the round search takes
 * the closure of moves for free and charges one round per tick — a lower bound
 * rather than an exact answer, which is the right side to be wrong on when the
 * number is used to set a budget.
 */
function shortest<S>(
  system: TransitionSystem<S>,
  horizon: number,
  maxStates: number,
): { minRounds: number | null; minMoves: number | null } {
  let minMoves: number | null = null;
  {
    const seen = new Map<string, number>();
    const start = system.key(system.initial);
    seen.set(start, 0);
    const queue: Array<[S, number]> = [[system.initial, 0]];
    while (queue.length) {
      const [state, depth] = queue.shift() as [S, number];
      if (system.won(state)) {
        minMoves = depth;
        break;
      }
      const next: S[] = system.moves.filter((m) => m.can(state)).map((m) => m.apply(state));
      next.push(system.tick(state));
      for (const candidate of next) {
        const key = system.key(candidate);
        if (seen.has(key) || seen.size >= maxStates) continue;
        seen.set(key, depth + 1);
        queue.push([candidate, depth + 1]);
      }
    }
  }

  // Rounds, played the way the harness plays them: the roster in order, each
  // agent free to make as many calls as it likes during its own turn and unable
  // to act once its turn has passed.
  //
  // Without this, the answer for any puzzle whose whole solution is legal in
  // the opening position is one round — an omniscient hand doing everything
  // before the clock ticks — which is exactly the number that would let a
  // simultaneity puzzle ship with a budget it cannot be solved in. Carrying the
  // roster position alongside the state costs a factor of `roster.length + 1`
  // and buys a number that means something.
  let minRounds: number | null = null;
  {
    const roster = system.roster ?? [];
    type Node = { state: S; pos: number };
    const id = (n: Node) => `${system.key(n.state)}@${n.pos}`;
    let frontier: Node[] = [{ state: system.initial, pos: 0 }];

    for (let round = 0; round <= horizon; round++) {
      const closed = new Map<string, Node>();
      const stack = [...frontier];
      for (const node of frontier) closed.set(id(node), node);
      let solved = false;
      while (stack.length && !solved) {
        const node = stack.pop() as Node;
        if (system.won(node.state)) {
          solved = true;
          break;
        }
        const successors: Node[] = [];
        for (const move of system.moves) {
          if (!move.can(node.state)) continue;
          // Machinery with no named hand can be driven by whoever is up.
          if (roster.length && move.actor && move.actor !== roster[node.pos]) continue;
          successors.push({ state: move.apply(node.state), pos: node.pos });
        }
        // Stand down and let the next agent take its turn.
        if (roster.length && node.pos < roster.length) successors.push({ state: node.state, pos: node.pos + 1 });

        for (const next of successors) {
          const key = id(next);
          if (closed.has(key) || closed.size >= maxStates) continue;
          closed.set(key, next);
          stack.push(next);
        }
      }
      if (solved || [...closed.values()].some((n) => system.won(n.state))) {
        minRounds = round + 1;
        break;
      }
      const advanced = new Map<string, Node>();
      for (const node of closed.values()) {
        // Only states where the whole roster has been through reach the clock.
        if (roster.length && node.pos !== roster.length) continue;
        const next: Node = { state: system.tick(node.state), pos: 0 };
        advanced.set(id(next), next);
      }
      frontier = [...advanced.values()];
      if (!frontier.length) break;
    }
  }

  return { minRounds, minMoves };
}

/**
 * How often does flailing win?
 *
 * The check that separates a hard puzzle from a long one. A blind player picks
 * a move at random and runs it whether or not its guard holds — a fair model of
 * an agent that has learned nothing about the machine and is trying things. If
 * that player wins with any regularity, the scenario measures persistence, and
 * a model that simply calls more tools will score better without understanding
 * anything.
 *
 * Deterministic: seeded from the trial number, so a proof is reproducible.
 */
function blindRate<S>(system: TransitionSystem<S>, horizon: number, trials: number, movesPerRound: number): number {
  // A flailer pushes buttons; it does not guess a code. Dropping the
  // knowledge-gated moves is what makes this number about the machinery a team
  // can reach without understanding it.
  const reachable = system.moves.filter((m) => !m.needsKnowledge);
  if (reachable.length === 0) return 0;
  let wins = 0;
  for (let trial = 0; trial < trials; trial++) {
    let seed = trial * 2654435761 + 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let state = system.initial;
    let won = false;
    for (let round = 0; round < horizon && !won; round++) {
      for (let i = 0; i < movesPerRound; i++) {
        const move = reachable[Math.floor(next() * reachable.length)];
        if (move?.can(state)) state = move.apply(state);
        if (system.won(state)) {
          won = true;
          break;
        }
      }
      if (!won) {
        state = system.tick(state);
        if (system.won(state)) won = true;
      }
    }
    if (won) wins++;
  }
  return wins / Math.max(1, trials);
}

/** The proof as a person reads it, and as the CLI prints it. */
export function formatProof(name: string, proof: Proof): string {
  const lines = [
    name,
    `  reachable states   ${proof.reachable.toLocaleString()}`,
    `  soft-locks         ${proof.softLocks.length === 0 ? "none" : `${proof.softLocks.length}+ — PUZZLE IS BROKEN`}`,
    `  shortest solution  ${proof.minRounds === null ? "UNREACHABLE" : `${proof.minRounds} rounds, ${proof.minMoves} moves`}`,
    `  blind player wins  ${(proof.blindRate * 100).toFixed(1)}%`,
  ];
  if (proof.deadMoves.length) lines.push(`  dead moves         ${proof.deadMoves.join(", ")}`);
  if (proof.truncated) lines.push(`  TRUNCATED          ${proof.truncated}`);
  for (const lock of proof.softLocks.slice(0, 5))
    lines.push(`    locked via ${lock.via}: ${JSON.stringify(lock.state)}`);
  return lines.join("\n");
}
