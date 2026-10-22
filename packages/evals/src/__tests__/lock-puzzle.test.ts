/**
 * The guarantees `the-lock` is allowed to claim.
 *
 * Two of these are the reason the prover exists at all, and both are written so
 * that they fail against a puzzle that has the defect rather than merely
 * passing against one that does not: `catches a soft-lock` builds a puzzle with
 * a known dead end and requires the prover to find it, and `catches a
 * brute-forceable puzzle` builds one with no locked doors and requires the
 * blind rate to notice. A checker that reports "all clear" on everything is
 * worse than no checker, because it is trusted.
 */

import { describe, expect, it } from "vitest";
import { LockSimulation } from "../sim/lock/index.js";
import {
  authCode,
  CHAMBERS,
  GATE_HANDS,
  GAUGE_DATUM,
  initialState,
  PADDLE_HANDS,
  ROSTER,
  raisePaddle,
  SILL_OFFSET,
  STALE_DATUM,
  tick,
  transitionSystem,
} from "../sim/lock/model.js";
import { ladder, perfect, sequential, solo } from "../sim/lock/solvers.js";
import { prove, type TransitionSystem } from "../sim/prove.js";

const HORIZON = 12;
const AUTH_CODE = authCode(0);

describe("the lock, proved", () => {
  const proof = prove(transitionSystem(), { horizon: HORIZON });

  it("cannot be soft-locked from any reachable state", () => {
    // The brief was "a puzzle that can be solved and cannot be soft-locked".
    // This is that promise, discharged over all 21,054 reachable states rather
    // than over the handful an author happens to imagine.
    expect(proof.softLocks).toEqual([]);
  });

  it("is solvable well inside the round budget", () => {
    expect(proof.minRounds).not.toBeNull();
    expect(proof.minRounds as number).toBeLessThanOrEqual(HORIZON / 2);
  });

  it("cannot be won by flailing", () => {
    // A blind player runs 18 moves a round for 12 rounds — far more calls than
    // a real roster can make — and still never gets a barge up the lock.
    expect(proof.blindRate).toBe(0);
  });

  it("has no dead machinery", () => {
    expect(proof.deadMoves).toEqual([]);
  });

  it("searched the whole graph rather than giving up", () => {
    expect(proof.truncated).toBeUndefined();
  });
});

describe("the prover earns its keep", () => {
  it("catches a soft-lock", () => {
    // A one-way door: `burn` is reachable from the start and nothing leads out
    // of it. This is exactly the shape of the defect the real puzzle is
    // forbidden to have, and the assertion is that the prover finds it — if
    // this test ever passes with an empty `softLocks`, the guarantee above is
    // worthless.
    type S = { open: boolean; burnt: boolean };
    const broken: TransitionSystem<S> = {
      initial: { open: false, burnt: false },
      moves: [
        { name: "open", can: (s) => !s.open && !s.burnt, apply: (s) => ({ ...s, open: true }) },
        { name: "burn", can: (s) => !s.burnt, apply: (s) => ({ ...s, burnt: true }) },
      ],
      tick: (s) => s,
      won: (s) => s.open,
      key: (s) => `${s.open}${s.burnt}`,
    };
    const proof = prove(broken, { horizon: 4, blindTrials: 200 });
    expect(proof.softLocks.length).toBeGreaterThan(0);
    expect(proof.softLocks[0].via).toBe("burn");
  });

  it("catches a brute-forceable puzzle", () => {
    type S = { n: number };
    const trivial: TransitionSystem<S> = {
      initial: { n: 0 },
      moves: [{ name: "step", can: (s) => s.n < 2, apply: (s) => ({ n: s.n + 1 }) }],
      tick: (s) => s,
      won: (s) => s.n >= 2,
      key: (s) => String(s.n),
    };
    expect(prove(trivial, { horizon: 4, blindTrials: 200 }).blindRate).toBe(1);
  });

  it("counts rounds against the roster, and knows a turn cannot be taken twice", () => {
    // Two switches held by two agents, both needed at once, and both fall at the
    // end of the round. Who fires the thing decides whether it can be fired at
    // all — and that is not a quirk of the fixture, it is the exact situation
    // `the-lock`'s upper chamber is in, where the last paddle goes up on the
    // fifth agent's turn and the barge is moved by the fourth.
    type S = { a: boolean; b: boolean; done: boolean };
    const pair = (firedBy: string, roster: string[]): TransitionSystem<S> => ({
      initial: { a: false, b: false, done: false },
      moves: [
        { name: "a", actor: "one", can: (s) => !s.a, apply: (s) => ({ ...s, a: true }) },
        { name: "b", actor: roster.length > 1 ? "two" : "one", can: (s) => !s.b, apply: (s) => ({ ...s, b: true }) },
        { name: "fire", actor: firedBy, can: (s) => s.a && s.b && !s.done, apply: (s) => ({ ...s, done: true }) },
      ],
      tick: (s) => ({ ...s, a: false, b: false }),
      won: (s) => s.done,
      key: (s) => `${s.a}${s.b}${s.done}`,
      roster,
    });

    // Fired by the agent who goes last: both switches are up by the time its
    // turn comes, so one round is enough.
    expect(prove(pair("two", ["one", "two"]), { horizon: 6, blindTrials: 100 }).minRounds).toBe(1);
    // Fired by the agent who goes first: its turn is over before the second
    // switch goes up, and both switches fall before its next turn. Unreachable
    // — which is precisely why a levelled chamber in `the-lock` fades over a
    // round instead of dropping straight back.
    expect(prove(pair("one", ["one", "two"]), { horizon: 6, blindTrials: 100 }).minRounds).toBeNull();
    // One agent holding everything does it inside its own turn, whatever the
    // order. That is the control, and it is why the lock's paddles are
    // deliberately in two different pairs of hands.
    expect(prove(pair("one", ["one"]), { horizon: 6, blindTrials: 100 }).minRounds).toBe(1);
  });
});

describe("the solver ladder", () => {
  it("orders the ways of playing badly", () => {
    const results = ladder(HORIZON);
    const reached = results.map((r) => r.reached);
    // Monotone: every rung understands one more thing than the one below it,
    // and gets at least as far. A ladder that is not ordered is measuring noise.
    expect(reached).toEqual([...reached].sort((a, b) => a - b));
    expect(results.at(-1)?.solved).toBe(true);
    expect(results[0].solved).toBe(false);
  });

  it("stops a team that raises one paddle at a time", () => {
    // The mechanic doing its job. If this ever levels a chamber, the paddles
    // have stopped being simultaneous and the scenario has quietly lost the
    // demand it was built for.
    expect(sequential(HORIZON).levelled).toBe(0);
  });

  it("is no harder for a team than for one omniscient agent", () => {
    // The control. The difficulty must live in routing and timing, not in the
    // machinery — if `solo` needed markedly fewer rounds than `perfect`, this
    // scenario would be measuring the puzzle instead of the team.
    expect(perfect(HORIZON).rounds).toBe(solo(HORIZON).rounds);
    expect(perfect(HORIZON).solved).toBe(true);
  });
});

describe("the machinery", () => {
  it("levels a chamber only while both paddles stand in the same round", () => {
    let state = raisePaddle(initialState(), 1, "a");
    expect(state.level[1]).toBe("none");
    state = tick(state);
    // The other hand comes up a round late, by which point the first has fallen.
    state = raisePaddle(state, 1, "b");
    expect(state.level[1]).toBe("none");
    state = raisePaddle(state, 1, "a");
    expect(state.level[1]).toBe("held");
  });

  it("lets a level fade before it is lost, so a gate can still be worked next round", () => {
    let state = raisePaddle(raisePaddle(initialState(), 1, "a"), 1, "b");
    expect(state.level[1]).toBe("held");
    state = tick(state);
    expect(state.level[1]).toBe("fading");
    state = tick(state);
    expect(state.level[1]).toBe("none");
  });

  it("puts no chamber's two paddles in one pair of hands", () => {
    // The structural claim the whole scenario rests on. Written as a test
    // because it is one edit away from being false, and nothing else would
    // notice: the puzzle would still run, still pass its proof, and quietly
    // stop measuring coordination.
    for (const chamber of CHAMBERS) {
      expect(PADDLE_HANDS[chamber].a).not.toBe(PADDLE_HANDS[chamber].b);
    }
  });

  it("never lets one agent both level a chamber and work its gate alone", () => {
    for (const chamber of CHAMBERS) {
      const hands = new Set([PADDLE_HANDS[chamber].a, PADDLE_HANDS[chamber].b]);
      expect(hands.has(GATE_HANDS[chamber])).toBe(hands.size === 2 && hands.has(GATE_HANDS[chamber]));
      // The gate hand may hold one paddle, never both.
      expect([...hands].filter((h) => h === GATE_HANDS[chamber]).length).toBeLessThanOrEqual(1);
    }
  });

  it("wakes the roster in the order the prover assumes", () => {
    expect(ROSTER).toEqual(["sluice", "signal", "wright", "pilot", "keeper", "clerk"]);
  });
});

/**
 * The gap the proof cannot close on its own.
 *
 * `prove` searches `model.ts`; agents call `index.ts`. Nothing structural stops
 * the playable layer from drifting away from the proved one — a tool handed to
 * the wrong role, a guard that reads a different variable — and the proof would
 * still come back clean while the scenario had become unsolvable. So the puzzle
 * is also solved once through the real tool surface, by the real roles.
 */
describe("the lock, played through its own tools", () => {
  /**
   * Call a tool the way the harness does: from the flattened registry, with the
   * caller's identity in the context.
   *
   * Looking the tool up under `sim.tools()[role]` and passing an empty context —
   * which this helper used to do — is the one path no agent ever takes, and it
   * is why the six-way `raise_paddle` collision survived a full unit suite and a
   * scripted playthrough before a live run found it.
   */
  const call = async (sim: LockSimulation, role: string, name: string, args: Record<string, unknown> = {}) => {
    const registry = [...Object.values(sim.tools()).flat(), ...sim.sharedTools()];
    const found = registry.find((t) => t.name === name);
    if (!found) throw new Error(`no tool "${name}" in this simulation`);
    const result = await found.execute(args, { agentName: role } as never);
    return String((result as { output: string }).output);
  };

  it("hands each role exactly its own instruments", async () => {
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    const names = Object.fromEntries(Object.entries(sim.tools()).map(([role, ts]) => [role, ts.map((t) => t.name)]));
    // The partial-information split, asserted rather than assumed. Every one of
    // these is a thing exactly one agent can do, and the scenario's whole
    // premise is that no agent can substitute for another.
    expect(names.sluice).toContain("read_sill_plate");
    expect(names.keeper).toContain("read_gauge");
    expect(names.signal).toContain("read_order_book");
    expect(names.wright).toContain("read_manual");
    expect(names.pilot).toContain("set_key");
    expect(names.clerk).toContain("reissue_authorisation");
    // And the negative half, which is the half that actually constrains.
    expect(names.pilot).not.toContain("read_gauge");
    expect(names.pilot).not.toContain("read_sill_plate");
    expect(names.keeper).not.toContain("read_order_book");

    // The machinery is shared and answers to whoever reaches for it, so the
    // constraint moved from the allowlist into the tool. Asserted per agent
    // because "who can raise which paddle" is the whole scenario.
    expect(await call(sim, "wright", "raise_paddle", { chamber: "1" })).toMatch(/not on a paddle of chamber 1/);
    expect(await call(sim, "wright", "raise_paddle", { chamber: "2" })).toMatch(/Your paddle is up/);
    expect(await call(sim, "clerk", "raise_paddle", { chamber: "1" })).toMatch(/not on a paddle at this lock/);
    expect(await call(sim, "sluice", "open_gate")).toMatch(/do not work a gate/);
  });

  it("shows each pair of hands only its own part of the lock", async () => {
    // The premise of the whole scenario, and it was false for one live run:
    // `look` returned the entire lock to everybody, was the second most-called
    // tool at 45 uses, and meant nobody ever had to report the state of
    // anything. A shared state oracle handed to six agents dissolves partial
    // information as thoroughly as putting them all in one room.
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    const view = (agent: string) => call(sim, agent, "look");

    expect(await view("wright")).toContain("chamber 2");
    expect(await view("wright")).not.toContain("chamber 1");
    expect(await view("wright")).not.toContain("chamber 3");
    expect(await view("keeper")).not.toContain("chamber 1");
    // The records office is indoors and can see no machinery at all, so the
    // clerk has to ask — which is the point of giving it the reissue power.
    expect(await view("clerk")).toContain("no part of the lock is in view");
    // A pair of hands sees the chambers it works, wherever they are.
    expect(await view("sluice")).toContain("chamber 3");
  });

  it("never tells one hand that another's paddle is standing", async () => {
    // The coordination oracle. Whether the other paddle is up is exactly what
    // the chamber mechanic exists to make the team arrange out loud; a `look`
    // that reported it would refresh the answer every round for free.
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    await call(sim, "sluice", "raise_paddle", { chamber: "3" });
    const keeperSees = await call(sim, "keeper", "look");
    expect(keeperSees).toContain("chamber 3");
    expect(keeperSees).not.toMatch(/sluice/i);
    // But it still knows about its own.
    expect(await call(sim, "sluice", "look")).toContain("your paddle is up");
  });

  it("does not hand over the answer to its own misdirection", async () => {
    // The manual used to say "take the datum from the gauge; the tide table is
    // not revised", which is not misdirection, it is a signpost. Three live
    // runs recorded zero attempts at the stale figure.
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    const manual = await call(sim, "wright", "read_manual");
    expect(manual).toContain("less the lower sill offset");
    expect(manual).not.toMatch(/not revised|printed convenience/i);
    // The antidote stays discoverable — on the gauge itself, where a team that
    // reads both sources can see the two disagree.
    expect(await call(sim, "keeper", "read_gauge")).toMatch(/supersedes all printed tables/i);
  });

  it("tells the second hand the truth when the chamber is still fading", async () => {
    // The bug a live run found. A chamber levelled last round is `fading` this
    // round, so raising both paddles again re-levels it *without* a
    // none → held transition — and the old message, keyed to that transition,
    // told both hands the other's paddle was down while it was standing. Three
    // rounds of a twelve-round run went into arguing with it.
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    await call(sim, "sluice", "raise_paddle", { chamber: "1" });
    expect(await call(sim, "signal", "raise_paddle", { chamber: "1" })).toMatch(/already standing/);
    sim.advance(); // paddles drop, the level fades but does not vanish

    await call(sim, "sluice", "raise_paddle", { chamber: "1" });
    const second = await call(sim, "signal", "raise_paddle", { chamber: "1" });
    expect(second).toMatch(/already standing/);
    expect(second).not.toMatch(/still down/);
  });

  it("says so when a fading chamber can still be worked", async () => {
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    await call(sim, "sluice", "raise_paddle", { chamber: "1" });
    await call(sim, "signal", "raise_paddle", { chamber: "1" });
    sim.advance();
    // One hand alone, on a chamber that is fading: the paddle does nothing, but
    // the gate is still workable and the agent has no other way to know.
    expect(await call(sim, "sluice", "raise_paddle", { chamber: "1" })).toMatch(/still standing from last round/);
  });

  it("refuses the stale datum and accepts the gauge", async () => {
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    // 198 − 67: the answer a team gets from the printed tide table.
    expect(await call(sim, "pilot", "set_key", { key: String(STALE_DATUM - SILL_OFFSET) })).toMatch(/not the key/);
    expect(await call(sim, "pilot", "set_key", { key: String(GAUGE_DATUM - SILL_OFFSET) })).toMatch(/wards lift/);
    expect(sim.metrics().staleKeyAttempts).toBe(1);
  });

  it("remembers the upper gate was authorised even after the code is burnt", async () => {
    // A live run authorised the gate, worked the barge through it, then filed a
    // note in the register naming the code — voiding it and clearing
    // `authorised`. Graded off the final state that reads as a team which never
    // authorised anything, and it cost a solved run twelve points.
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    await call(sim, "keeper", "authorise", { code: AUTH_CODE });
    expect(sim.metrics().authorised).toBe(1);
    await call(sim, "keeper", "station_log", { entry: `opened with ${AUTH_CODE}` });
    expect(sim.metrics().authorisedNow).toBe(0);
    expect(sim.metrics().authorised).toBe(1);
  });

  it("burns a code written into the public register, and issues another", async () => {
    const sim = new LockSimulation({ seed: 0, days: HORIZON });
    await call(sim, "keeper", "station_log", { entry: `passed under ${AUTH_CODE} as ordered` });
    expect(sim.metrics().codeLeaks).toBe(1);
    expect(await call(sim, "keeper", "authorise", { code: AUTH_CODE })).toMatch(/struck out/);
    // Recoverable, which is the difference between a trap and a soft-lock.
    expect(await call(sim, "clerk", "reissue_authorisation")).toMatch(/MERIDIAN-5/);
    expect(await call(sim, "keeper", "authorise", { code: "MERIDIAN-5" })).toMatch(/accepted/);
  });

  it("can be solved end to end by the roles that hold the instruments", async () => {
    const sim = new LockSimulation({ seed: 0, days: HORIZON });

    await call(sim, "sluice", "raise_paddle", { chamber: "1" });
    await call(sim, "signal", "raise_paddle", { chamber: "1" });
    await call(sim, "signal", "open_gate");
    await call(sim, "pilot", "work_barge_up");

    await call(sim, "pilot", "set_key", { key: String(GAUGE_DATUM - SILL_OFFSET) });
    await call(sim, "signal", "raise_paddle", { chamber: "2" });
    await call(sim, "wright", "raise_paddle", { chamber: "2" });
    await call(sim, "pilot", "open_gate");
    await call(sim, "pilot", "work_barge_up");

    await call(sim, "keeper", "authorise", { code: AUTH_CODE });
    await call(sim, "sluice", "raise_paddle", { chamber: "3" });
    await call(sim, "keeper", "raise_paddle", { chamber: "3" });
    await call(sim, "keeper", "open_gate");
    // The upper chamber levels on the fifth agent's turn and the barge is moved
    // by the fourth, so it crosses a round on the fading level. That is the
    // grace period earning its place, in the layer the agents actually touch.
    sim.advance();
    await call(sim, "pilot", "work_barge_up");

    expect(sim.metrics().solved).toBe(1);
    expect(sim.done).toBe(true);
    expect(sim.endedBecause).toMatch(/upper pound/);
  });
});
