/**
 * The Lock — a derelict staircase lock, and the machinery that works it.
 *
 * A barge sits in the lower basin. Three chambers rise in series to the upper
 * reach, each behind a gate that will not move until its chamber is level with
 * the one below it. Nothing here is destructible and nothing is consumed: water
 * goes in and it goes out, a code that is burnt can be reissued, a gate that
 * closes can be opened again. That is a design constraint rather than a
 * flourish — the puzzle must be impossible to soft-lock, and the cheapest way
 * to guarantee that is to build it out of parts that are reversible by nature.
 * `prove.ts` checks the guarantee rather than trusting it.
 *
 * ## Where the difficulty is
 *
 * Not in the length of the chain. `the-machine` has fifteen steps and is solved
 * three times out of three with full marks, because every step is individually
 * obvious once you have been refused once, and probing is free. Depth is not
 * what makes coordination hard.
 *
 * What makes it hard is being unable to act alone:
 *
 *   simultaneity   a chamber levels only while *both* its paddles are up, and
 *                  paddles fall on their own at the end of every round. The two
 *                  paddles belong to two different agents, and for the upper
 *                  chamber those two agents are not in a room together.
 *   decay          a level chamber holds, fades, then is lost. A gate is only
 *                  workable while its chamber holds or fades, so the team has
 *                  about two rounds to use what it just made.
 *   combining      the middle gate wants a number nobody can read: it is one
 *                  agent's gauge less another agent's sill plate, and the rule
 *                  saying so is held by a third.
 *   two-hop        the sill plate is in the lower basin and the gauge is in the
 *                  upper reach, and no agent stands in both. Every crossing
 *                  fact has to be carried twice, by two agents who each have no
 *                  use for it.
 *   discretion     the upper gate takes an authorisation code, and the station
 *                  log is a public register. A code written into the log is
 *                  void — and reissuable, because this puzzle does not punish
 *                  permanently.
 *   misdirection   the tide table is the obvious source for the datum and it is
 *                  one revision stale. The gauge is right and says so.
 *
 * Every one of those is retryable. A team can raise the paddles again, level
 * the chamber again, ask for a new code. What it cannot do is get all six right
 * without talking to each other about *when*, which is the thing no scenario in
 * this set has ever asked for.
 */

import type { Move, TransitionSystem } from "../prove.js";

export type Chamber = 1 | 2 | 3;

/**
 * Whose hands are on each paddle — the escalation the whole puzzle turns on.
 *
 * A chamber levels only while both its paddles are up, and paddles fall at the
 * end of every round, so the two agents named here have to act in the *same*
 * round. Chamber 1 gives that job to two agents who share a room, so the team
 * can discover the mechanic by accident. Chamber 2 splits it across adjacent
 * rooms, so it has to be arranged. Chamber 3 splits it between the two ends of
 * the lock, where the two hands have no room in common and cannot address each
 * other at all — the arrangement has to be relayed by somebody who is not doing
 * either half of it.
 */
export const PADDLE_HANDS: Record<Chamber, { a: string; b: string }> = {
  1: { a: "sluice", b: "signal" },
  2: { a: "signal", b: "wright" },
  3: { a: "sluice", b: "keeper" },
};

/** Who works each gate. Separate from the paddles, so no one agent can do a chamber alone. */
export const GATE_HANDS: Record<Chamber, string> = { 1: "signal", 2: "pilot", 3: "keeper" };

/**
 * The order the roster wakes in, lower end of the lock first.
 *
 * Part of the puzzle rather than a scheduling detail. An agent that levels a
 * chamber late in the order leaves it for the next round, because everybody who
 * could have used it has already had their turn — so `sluice` and `keeper`
 * holding the upper chamber's two paddles means the upper gate is never worked
 * in the round it is levelled. The roster is what turns "both paddles at once"
 * from an instruction into a scheduling problem, and it is why the prover has
 * to know about it.
 */
export const ROSTER = ["sluice", "signal", "wright", "pilot", "keeper", "clerk"];

/** Where the barge is. Monotone: it never slides back, it just stops. */
export type Berth = "basin" | "ch1" | "ch2" | "ch3" | "reach";

/**
 * How level a chamber is.
 *
 * Three values rather than a boolean because the grace period is the point: a
 * team that levels a chamber and then spends a round working out who opens the
 * gate should still find it open, and a team that spends three should not.
 */
export type Level = "none" | "held" | "fading";

export interface LockState {
  round: number;
  /** Raised paddles, by chamber. Cleared by the clock at the end of every round. */
  paddles: Record<Chamber, { a: boolean; b: boolean }>;
  level: Record<Chamber, Level>;
  gates: Record<Chamber, "shut" | "open">;
  barge: Berth;
  /** The middle gate's key has been set correctly. */
  keyed: boolean;
  /** The upper gate's authorisation has been accepted. */
  authorised: boolean;
  /** The current code was written into the public log, so it is void. */
  codeVoid: boolean;
  /** How many times a fresh code has been issued. Each one is a different code. */
  reissues: number;
  /** Entries written to the station log. The team is asked to keep it. */
  logged: number;
}

/** The numbers the puzzle is built on. Fixed rather than seeded: see `NOTE ON SEEDS`. */
export const GAUGE_DATUM = 214;
export const SILL_OFFSET = 67;
/** What the tide table says. One revision stale, and the obvious place to look. */
export const STALE_DATUM = 198;
export const gateKey = (reissues = 0) => GAUGE_DATUM - SILL_OFFSET + reissues * 0;
export const authCode = (reissues: number) => `MERIDIAN-${4 + reissues}`;

/**
 * NOTE ON SEEDS
 *
 * The factory simulation draws its shocks from a seed, because its question is
 * "how did this policy do across many worlds". A puzzle's question is "did this
 * team solve *the* puzzle", and reseeding the numbers changes nothing about the
 * difficulty while making every stored run incomparable with every other. So
 * the constants are constants, and `seed` is accepted and ignored.
 */

export function initialState(): LockState {
  return {
    round: 0,
    paddles: { 1: { a: false, b: false }, 2: { a: false, b: false }, 3: { a: false, b: false } },
    level: { 1: "none", 2: "none", 3: "none" },
    gates: { 1: "shut", 2: "shut", 3: "shut" },
    barge: "basin",
    keyed: false,
    authorised: false,
    codeVoid: false,
    reissues: 0,
    logged: 0,
  };
}

export const CHAMBERS: Chamber[] = [1, 2, 3];

/** Which berth the barge must be in to enter chamber N, and where it lands. */
export const BERTH_BEFORE: Record<Chamber, Berth> = { 1: "basin", 2: "ch1", 3: "ch2" };
export const BERTH_AFTER: Record<Chamber, Berth> = { 1: "ch1", 2: "ch2", 3: "ch3" };

export function clone(state: LockState): LockState {
  return {
    ...state,
    paddles: { 1: { ...state.paddles[1] }, 2: { ...state.paddles[2] }, 3: { ...state.paddles[3] } },
    level: { ...state.level },
    gates: { ...state.gates },
  };
}

/**
 * A chamber levels the instant both its paddles are up.
 *
 * Automatic rather than a separate "equalise" call, and the difference matters.
 * With a call, a team that got both paddles up in one round and forgot the call
 * would be told nothing and would conclude the paddles were the problem. This
 * way the paddle tool itself reports the level, so the mechanic teaches itself
 * from the one action the team already took.
 */
export function settle(state: LockState): LockState {
  const next = clone(state);
  for (const chamber of CHAMBERS) {
    const { a, b } = next.paddles[chamber];
    if (a && b) next.level[chamber] = "held";
  }
  return next;
}

/** Raise one paddle. Idempotent within a round, which keeps a retry harmless. */
export function raisePaddle(state: LockState, chamber: Chamber, which: "a" | "b"): LockState {
  const next = clone(state);
  next.paddles[chamber][which] = true;
  return settle(next);
}

export function canOpenGate(state: LockState, chamber: Chamber): true | string {
  if (state.gates[chamber] === "open") return "the gate is already open";
  if (state.level[chamber] === "none")
    return `chamber ${chamber} is not level — the gate will not shift against a head of water`;
  if (chamber === 2 && !state.keyed) return "the middle gate is keyed and the key has not been set";
  if (chamber === 3 && !state.authorised) return "the upper gate wants an authorisation that has not been accepted";
  return true;
}

export function openGate(state: LockState, chamber: Chamber): LockState {
  const next = clone(state);
  next.gates[chamber] = "open";
  return next;
}

export function canMoveBarge(state: LockState, chamber: Chamber): true | string {
  if (state.barge !== BERTH_BEFORE[chamber]) return `the barge is not below gate ${chamber}`;
  if (state.gates[chamber] !== "open") return `gate ${chamber} is shut`;
  return true;
}

/**
 * Work the barge up one chamber.
 *
 * The gate shuts behind it, which is what a lock does and is also what stops
 * the puzzle from being solvable by opening all three gates in whatever order
 * and then walking through. Shutting is not a loss: the gate can be opened
 * again from the same state that opened it the first time.
 */
export function moveBarge(state: LockState, chamber: Chamber): LockState {
  const next = clone(state);
  next.barge = BERTH_AFTER[chamber];
  next.gates[chamber] = "shut";
  if (next.barge === "ch3") next.barge = "reach";
  return next;
}

/** The clock. Paddles fall, levels decay, and a gate cannot outlive its chamber's level. */
export function tick(state: LockState): LockState {
  const next = clone(state);
  next.round += 1;
  for (const chamber of CHAMBERS) {
    next.paddles[chamber] = { a: false, b: false };
    next.level[chamber] = next.level[chamber] === "held" ? "fading" : "none";
    // A gate stands open only while its chamber is level. This is what puts the
    // team on a clock without ever taking a route away from them.
    if (next.level[chamber] === "none") next.gates[chamber] = "shut";
  }
  return next;
}

export function won(state: LockState): boolean {
  return state.barge === "reach";
}

/**
 * The searchable projection of a state.
 *
 * `round`, `logged` and `reissues` are left out on purpose. Including `round`
 * would multiply the graph by the horizon for no gain — no transition in this
 * puzzle reads the clock — and including counters that only ever grow would
 * make the state space infinite. What is left is exactly the part a soft-lock
 * could hide in.
 */
export function key(state: LockState): string {
  const paddles = CHAMBERS.map((c) => `${state.paddles[c].a ? "A" : "-"}${state.paddles[c].b ? "B" : "-"}`).join("");
  const levels = CHAMBERS.map((c) => state.level[c][0]).join("");
  const gates = CHAMBERS.map((c) => state.gates[c][0]).join("");
  return `${paddles}|${levels}|${gates}|${state.barge}|${state.keyed ? "k" : "-"}${state.authorised ? "a" : "-"}${
    state.codeVoid ? "v" : "-"
  }`;
}

/**
 * The puzzle as `prove.ts` sees it.
 *
 * Every move the machinery affords, with no reference to who holds which tool
 * or whether anybody knows the argument. Setting the key and accepting the
 * authorisation appear here as bare transitions, because the prover's question
 * is whether the *machinery* can still be driven to the goal — a team that
 * cannot work out the key has a routing problem, not a locked door.
 */
export function transitionSystem(): TransitionSystem<LockState> {
  const moves: Array<Move<LockState>> = [];
  for (const chamber of CHAMBERS) {
    for (const which of ["a", "b"] as const) {
      moves.push({
        name: `paddle${chamber}${which}`,
        actor: PADDLE_HANDS[chamber][which],
        can: (s) => !s.paddles[chamber][which],
        apply: (s) => raisePaddle(s, chamber, which),
      });
    }
    moves.push({
      name: `gate${chamber}`,
      actor: GATE_HANDS[chamber],
      can: (s) => canOpenGate(s, chamber) === true,
      apply: (s) => openGate(s, chamber),
    });
    moves.push({
      name: `move${chamber}`,
      actor: "pilot",
      can: (s) => canMoveBarge(s, chamber) === true,
      apply: (s) => moveBarge(s, chamber),
    });
  }
  moves.push({
    name: "setKey",
    actor: "pilot",
    needsKnowledge: true,
    can: (s) => !s.keyed,
    apply: (s) => ({ ...clone(s), keyed: true }),
  });
  moves.push({
    name: "authorise",
    actor: "keeper",
    needsKnowledge: true,
    can: (s) => !s.authorised && !s.codeVoid,
    apply: (s) => ({ ...clone(s), authorised: true }),
  });
  // The two halves of the discretion mechanic. Voiding is a move a team can
  // make by accident, so the prover has to be able to make it too — that is
  // precisely the sequence most likely to hide a soft-lock.
  moves.push({
    name: "voidCode",
    can: (s) => !s.codeVoid,
    apply: (s) => ({ ...clone(s), codeVoid: true, authorised: false }),
  });
  moves.push({
    name: "reissue",
    actor: "clerk",
    can: (s) => s.codeVoid,
    apply: (s) => ({ ...clone(s), codeVoid: false, reissues: s.reissues + 1 }),
  });

  return { initial: initialState(), moves, tick, won, key, roster: ROSTER };
}
