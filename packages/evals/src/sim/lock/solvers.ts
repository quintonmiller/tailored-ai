/**
 * Playing the lock without a model.
 *
 * The factory has baseline policies for a continuous objective; a puzzle needs
 * the same discipline for a different reason. A puzzle's score means nothing
 * until you know what the score is for a player that understands nothing, a
 * player that understands the machine but not the team, and a player that
 * understands everything. No GPU time, and between them they catch the two ways
 * a puzzle ships broken: unsolvable inside the budget, and solvable by flailing.
 *
 * ## The one that matters most
 *
 * `solo` — one omniscient agent holding every instrument, with nobody to talk
 * to and no turn it has to wait for. If solo walks it and six specialists
 * cannot, the difficulty is *the orchestration*, which is exactly what this
 * scenario exists to measure. If solo struggles too, the puzzle itself is too
 * hard and the measurement is about something else. That gap is the number to
 * watch, and nothing else in this package reports it.
 *
 * ## How a turn works here
 *
 * The harness wakes the roster in order and each agent's turn may make several
 * calls. So a solver is a function from (state, whose turn it is) to a list of
 * calls, and the round ends when the roster has been through. Getting this
 * wrong in the obvious direction — one move per agent per round — reports the
 * puzzle as unsolvable by any team, which is what the first draft of this file
 * did.
 */

import {
  BERTH_BEFORE,
  CHAMBERS,
  type Chamber,
  canMoveBarge,
  canOpenGate,
  GATE_HANDS,
  initialState,
  type LockState,
  moveBarge,
  openGate,
  PADDLE_HANDS,
  ROSTER,
  raisePaddle,
  tick,
  won,
} from "./model.js";

export interface PlayResult {
  solver: string;
  solved: boolean;
  rounds: number;
  /** How far the barge got: 0 basin … 3 upper pound. */
  reached: number;
  levelled: number;
  gates: number;
}

/** What one agent does when its turn comes round. */
type Turn = (state: LockState, agent: string) => LockState;

function play(name: string, turn: Turn, horizon: number, roster: string[] = ROSTER): PlayResult {
  let state = initialState();
  const levelled = new Set<Chamber>();
  const gates = new Set<Chamber>();
  const note = () => {
    for (const c of CHAMBERS) {
      if (state.level[c] !== "none") levelled.add(c);
      if (state.gates[c] === "open") gates.add(c);
    }
  };

  for (let round = 0; round < horizon && !won(state); round++) {
    for (const agent of roster) {
      state = turn(state, agent);
      note();
      if (won(state)) break;
    }
    if (won(state)) break;
    state = tick(state);
  }
  return {
    solver: name,
    solved: won(state),
    rounds: state.round,
    reached: { basin: 0, ch1: 1, ch2: 2, ch3: 3, reach: 3 }[state.barge],
    levelled: levelled.size,
    gates: gates.size,
  };
}

/** The chamber the barge is trying to enter, or undefined once it is through. */
const ahead = (state: LockState): Chamber | undefined => CHAMBERS.find((c) => BERTH_BEFORE[c] === state.barge);

/**
 * A competent turn: unlock what is needed, level what is not level, work what
 * is, and move when the way is open.
 *
 * Ordered by dependency rather than by convenience, because the order is the
 * puzzle. An agent that raises a paddle on a chamber that is already levelled
 * has wasted the turn that could have opened the gate.
 */
function competentTurn(knowsKey: boolean, knowsCode: boolean): Turn {
  return (state, agent) => {
    let s = state;
    const next = ahead(s);
    if (!next) return s;

    if (next === 2 && !s.keyed && knowsKey && agent === "pilot") s = { ...s, keyed: true };
    if (next === 3 && !s.authorised && !s.codeVoid && knowsCode && agent === "keeper") s = { ...s, authorised: true };
    if (s.codeVoid && agent === "clerk") s = { ...s, codeVoid: false, reissues: s.reissues + 1 };

    // Level it if it is not level. Both hands have to do this in the same round,
    // which is the only reason the roster order matters.
    if (s.level[next] === "none") {
      for (const which of ["a", "b"] as const) {
        if (PADDLE_HANDS[next][which] === agent && !s.paddles[next][which]) s = raisePaddle(s, next, which);
      }
    }
    if (GATE_HANDS[next] === agent && canOpenGate(s, next) === true) s = openGate(s, next);
    if (agent === "pilot" && canMoveBarge(s, next) === true) s = moveBarge(s, next);
    return s;
  };
}

/** The ceiling for a *team*: knows the machine, the numbers, and each other. */
export const perfect = (horizon: number) => play("perfect-team", competentTurn(true, true), horizon);

/**
 * One agent, every instrument, one room. No routing, no timing, no relaying.
 *
 * The control for "is the puzzle hard, or is coordinating hard". It plays a
 * roster of one, so nothing it does ever has to wait for somebody else's turn.
 */
export const solo = (horizon: number) =>
  play(
    "solo-omniscient",
    (state) => {
      let s = state;
      // One hand on everything: run the competent turn once as each agent.
      for (const agent of ROSTER) s = competentTurn(true, true)(s, agent);
      return s;
    },
    horizon,
    ["solo"],
  );

/**
 * Understands the machinery, has not worked out that paddles are simultaneous.
 *
 * Raises whichever paddle it holds, whenever it holds one, and never arranges
 * for the other hand to be up at the same time — modelled by only ever raising
 * the `a` paddle. The most likely near-miss a real team produces, and it has to
 * score badly or the mechanic is not doing anything.
 */
export const sequential = (horizon: number) =>
  play(
    "one-paddle-at-a-time",
    (state, agent) => {
      let s = state;
      const next = ahead(s);
      if (!next) return s;
      if (PADDLE_HANDS[next].a === agent && !s.paddles[next].a) s = raisePaddle(s, next, "a");
      if (GATE_HANDS[next] === agent && canOpenGate(s, next) === true) s = openGate(s, next);
      if (agent === "pilot" && canMoveBarge(s, next) === true) s = moveBarge(s, next);
      return s;
    },
    horizon,
  );

/**
 * Works the water perfectly and routes nothing.
 *
 * Knows neither the key nor the authorisation, because neither number ever left
 * the room it was found in. This is the failure `the-machine` was written to
 * expose, and its score is the floor a competent-but-silent team lands on.
 */
export const hydraulicsOnly = (horizon: number) => play("hydraulics-only", competentTurn(false, false), horizon);

/**
 * Gets the key across one room and never gets the code across two.
 *
 * The rung that isolates the crossing this scenario was built around. The key's
 * two halves each travel one hop; the authorisation starts in the lower basin
 * and is needed in the upper reach, where nobody who holds it can speak. A team
 * that stops here has routed successfully and still failed, which is a
 * different diagnosis from one that never routed at all — and the two are
 * indistinguishable without this row.
 *
 * It is also what the stale tide table produces, by a different route: a wrong
 * key stops the barge at the middle gate exactly as a missing one does.
 */
export const keyNotCode = (horizon: number) => play("key-routed-code-not", competentTurn(true, false), horizon);

export function ladder(horizon: number): PlayResult[] {
  return [sequential(horizon), hydraulicsOnly(horizon), keyNotCode(horizon), perfect(horizon), solo(horizon)];
}

export function formatLadder(results: PlayResult[]): string {
  const width = Math.max(...results.map((r) => r.solver.length));
  const header = `  ${"solver".padEnd(width)}  ${"solved".padStart(6)}  ${"rounds".padStart(6)}  ${"reached".padStart(7)}  ${"levelled".padStart(8)}  ${"gates".padStart(5)}`;
  return [
    header,
    ...results.map(
      (r) =>
        `  ${r.solver.padEnd(width)}  ${(r.solved ? "yes" : "no").padStart(6)}  ${String(r.rounds).padStart(6)}  ${`${r.reached}/3`.padStart(7)}  ${`${r.levelled}/3`.padStart(8)}  ${`${r.gates}/3`.padStart(5)}`,
    ),
  ].join("\n");
}
