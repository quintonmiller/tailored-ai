/**
 * Six agents, three rooms, and a lock nobody can work alone.
 *
 * `the-machine` scored 98/98 three runs out of three. It is not a bad scenario
 * — it is a finished one, and a benchmark whose top rung is cleared measures
 * its own ceiling. Its sibling `the-machine-across-a-divide` scored 32, 52 and
 * 107 out of 107 on the same model, and the only difference between them is
 * that the room was cut in half. That is the measured lesson this scenario is
 * built on: difficulty in a multi-agent puzzle comes from the shape of the
 * team, not from the length of the chain.
 *
 * So this one keeps a chain about as long as the machine's and changes what a
 * team has to do with it.
 *
 * ## The five demands, and why each one is retryable
 *
 * The brief was a puzzle that can be solved and cannot be soft-locked. Every
 * mechanic below is therefore reversible: water goes in and out, a struck-out
 * code is reissued, a gate that swings shut can be opened again from the state
 * that opened it. `prove.ts` searches all 21,054 reachable states and checks
 * that the goal is still reachable from every one of them — the guarantee is a
 * proof rather than a promise, and it runs in CI.
 *
 *   simultaneity  a chamber levels only while *both* its paddles stand up, and
 *                 paddles drop at the end of every round. The two paddles belong
 *                 to two different agents, and for the upper chamber those two
 *                 have no room in common. Nothing in this benchmark has ever
 *                 asked a team to agree on *when* before.
 *   decay         a levelled chamber holds, fades, then is lost, and a gate only
 *                 stands while its chamber does. Roughly two rounds to use what
 *                 you just made.
 *   combining     the middle gate's key is one agent's gauge less another
 *                 agent's sill plate, and the rule saying so is held by a third.
 *                 Relaying is not enough; somebody has to hold two numbers at
 *                 once and do something with them.
 *   two hops      the authorisation starts in the lower basin and is needed in
 *                 the upper reach. No agent stands in both, so it crosses twice,
 *                 carried by two agents who have no use for it.
 *   discretion    the station log is a public register and the team is asked to
 *                 keep it. A code written into it is struck out — and reissued
 *                 on request, because this puzzle does not punish permanently.
 *
 * And one piece of misdirection: the tide table is the obvious source for the
 * datum, sits in the records office, and is a printing behind. The gauge is
 * right and says so on a brass card beside it. Not scored, deliberately — a
 * point for "did not fall for it" is a point collected by never trying
 * anything. It is here so the wrong key shows up in the trace.
 *
 * ## What the solver ladder says before any model runs
 *
 *   one-paddle-at-a-time   0/3 chambers   never levels anything
 *   hydraulics-only        1/3            works the water, routes nothing
 *   key-routed-code-not    2/3            one hop lands, two hops do not
 *   perfect-team           3/3, 3 rounds
 *   solo-omniscient        3/3, 3 rounds
 *
 * The last two are the important pair. One omniscient agent holding every
 * instrument finishes in the same three rounds a perfect team does, which is
 * how we know the puzzle itself is not the hard part. Everything between
 * `hydraulics-only` and `perfect-team` is the cost of being six people.
 *
 * A blind player choosing moves at random wins 0% of 3,000 trials, so nothing
 * here is farmable by calling more tools.
 */

import { defineScenario } from "../src/define.js";

/**
 * Twelve, and the number is a budget rather than a guess.
 *
 * The prover says a perfect team finishes in three rounds. Twelve is four times
 * that, which is the room a team needs to *discover* a lock nobody explained —
 * and it is also six agents × twelve turns, which is where the cost of a single
 * run stops being reasonable. Raising it is the wrong lever if runs come back
 * short: a team that has not levelled a chamber by round eight has not run out
 * of time, it has not found the mechanic.
 */
const ROUNDS = 12;

const OBJECTIVE =
  "One barge has to be worked up the staircase from the lower basin to the upper pound before the " +
  `day ends. Three chambers, three gates, and ${ROUNDS} rounds.`;

const SHARED =
  "You woke at a derelict staircase lock with a job to finish and no one to explain it. You can see " +
  "and work only what is in front of you, and the others are elsewhere on the lock — talk to them " +
  "with `room`. You only know what your own instruments tell you or what somebody tells you. Say " +
  "what a tool actually returned, in numbers, not in summary. Nothing on this lock moves unless " +
  "somebody calls a tool. " +
  OBJECTIVE;

const hand = (description: string, instructions: string) => ({
  description,
  instructions: `${instructions}\n\n${SHARED}`,
});

export default defineScenario({
  id: "the-lock",
  category: "orchestration",
  difficulty: 10,
  intent:
    "A staircase lock worked by six agents across three rooms, where every chamber needs two pairs " +
    "of hands in the same round, the middle gate's key is split between the two ends of the lock, " +
    "and the upper gate's authorisation has to cross two rooms without being written into a public " +
    "register. Proved solvable and proved impossible to soft-lock; a perfect team finishes in three " +
    "rounds and a blind one never does.\n\n" +
    "It exists because `the-machine` is finished — 98/98 on three runs of three — and its split-room " +
    "sibling is not, at 32/52/107. The difference between those two rows is the whole thesis: what " +
    "makes a multi-agent puzzle hard is the shape of the team, not the length of the chain. This " +
    "scenario adds the demand neither of them makes, which is agreeing on *when*.",

  simulation: {
    name: "lock",
    days: ROUNDS,
    daysPerRound: 1,
    roles: {
      sluice: "sluice",
      signal: "signal",
      wright: "wright",
      pilot: "pilot",
      keeper: "keeper",
      clerk: "clerk",
    },
  },

  agent: {
    name: "pilot",
    ...hand(
      "Aboard the barge, in the chambers of the lock.",
      "You are the pilot. Yours is the only craft in the lock and the only hands that can move it. " +
        "You work the middle gate and you can set its key, but you cannot read either of the numbers " +
        "the key is made from — they are at the two ends of the lock. You can reach both the lock " +
        "office and the head of the lock.",
    ),
  },

  config: {
    agents: {
      sluice: hand(
        "At the lower paddles, in the basin below the lock.",
        "You are the sluice keeper. Your hands are on one paddle of the lower chamber and one of the " +
          "upper chamber, and there is a cast plate on the lower sill you can read. You are at the " +
          "bottom of the lock and cannot see the top of it.",
      ),
      signal: hand(
        "At the semaphore station, between the basin and the lock office.",
        "You are the signaller. You work the lower gate, one paddle of the lower chamber and one of " +
          "the middle, and you keep the station's order book. You are the only one who can be heard " +
          "in both the basin and the lock office.",
      ),
      wright: hand(
        "In the workshop off the lock office.",
        "You are the lock wright. You keep the working manual for this lock and your hands are on one " +
          "paddle of the middle chamber. You hold no numbers of your own.",
      ),
      keeper: hand(
        "In the gate house at the head of the lock.",
        "You are the gate keeper. You work the upper gate, you have one paddle of the upper chamber, " +
          "and there is a gauge on the head of the lock you can read. The upper gate will not answer " +
          "until an authorisation has been presented to it, and yours are the only hands that can " +
          "present one.",
      ),
      clerk: hand(
        "In the records office beside the gate house.",
        "You are the records clerk. You keep the printed tide table and you can ask the harbourmaster " +
          "for a fresh authorisation when one has been struck out. You have no hands on the machinery " +
          "at all — everything you hold is worth nothing until somebody else has it.",
      ),
    },
  },

  /**
   * Three rooms, two bridges, and no one standing at both ends.
   *
   * `signal` is heard in the basin and the office; `pilot` in the office and
   * the head of the lock. So a fact starting in the basin and needed at the
   * head is carried twice, by two agents who have no use for it — which is the
   * measurement `the-machine-across-a-divide` made once and this makes in
   * series. Nothing tells either carrier that it is a carrier.
   */
  rooms: [
    {
      name: "basin",
      purpose: "The lower basin, below the first gate. Voices carry from here to the semaphore station and no further.",
      members: ["sluice", "signal"],
      deliver: "poll",
      wakeOn: "all",
      incoming: [
        {
          speaker: "robin",
          body:
            "There is a barge in the basin that has to be in the upper pound by the end of the day. " +
            "Nobody left instructions. Work out how the lock goes and get her up it.",
        },
      ],
    },
    {
      name: "office",
      purpose: "The lock office, amidships. The semaphore station and the head of the lock can both be reached from here.",
      members: ["signal", "wright", "pilot"],
      deliver: "poll",
      wakeOn: "all",
      incoming: [
        {
          speaker: "robin",
          body:
            "There is a barge in the basin that has to be in the upper pound by the end of the day. " +
            "Nobody left instructions. Work out how the lock goes and get her up it.",
        },
      ],
    },
    {
      name: "head",
      purpose: "The head of the lock: the gate house and the records office. The basin cannot be heard from here.",
      members: ["pilot", "keeper", "clerk"],
      deliver: "poll",
      wakeOn: "all",
      incoming: [
        {
          speaker: "robin",
          body:
            "There is a barge in the basin that has to be in the upper pound by the end of the day. " +
            "Nobody left instructions. Work out how the lock goes and get her up it.",
        },
      ],
    },
  ],

  /**
   * The roster order is part of the puzzle, not a scheduling detail.
   *
   * Lower end first. An agent that levels a chamber late in the order leaves it
   * for the next round, because everybody who could have used it has already
   * had their turn — so `sluice` and `keeper` holding the upper chamber's two
   * paddles means the upper gate is never worked in the round it is levelled.
   * The prover knows this roster and its three-round answer depends on it.
   */
  wake: [
    { room: "basin", rounds: ROUNDS, agents: ["sluice", "signal"] },
    { room: "office", rounds: ROUNDS, agents: ["wright", "pilot"] },
    { room: "head", rounds: ROUNDS, agents: ["keeper", "clerk"] },
  ],

  /**
   * The ladder, weighted towards the things that cannot be done alone.
   *
   * A run that gets the barge into the first chamber has understood the single
   * hardest mechanic in the puzzle — two hands, one round — and should be
   * clearly above a run that read every instrument and moved nothing. The top
   * rungs are the two crossings: a key made of two numbers from opposite ends,
   * and an authorisation that has to travel two rooms and stay out of the log.
   */
  milestones: [
    { id: "read-their-own-instruments", points: 2, when: { calls_tool_any: ["look", "sound_chamber"] } },
    { id: "found-the-sill-offset", points: 3, when: { calls_by: { agent: "sluice", tool: "read_sill_plate" } } },
    { id: "found-the-gauge-datum", points: 3, when: { calls_by: { agent: "keeper", tool: "read_gauge" } } },
    { id: "found-the-manual", points: 3, when: { calls_by: { agent: "wright", tool: "read_manual" } } },
    { id: "found-the-order-book", points: 3, when: { calls_by: { agent: "signal", tool: "read_order_book" } } },
    { id: "kept-the-station-log", points: 2, when: { sim_metric: { metric: "logEntries", at_least: 1 } } },
    // The mechanic. Two hands on one chamber in one round, which no agent can
    // arrange without saying so first.
    { id: "levelled-a-chamber", points: 8, when: { sim_metric: { metric: "chambersLevelled", at_least: 1 } } },
    { id: "opened-a-gate", points: 5, when: { sim_metric: { metric: "gatesOpened", at_least: 1 } } },
    { id: "moved-the-barge", points: 8, when: { sim_metric: { metric: "chambersCleared", at_least: 1 } } },
    { id: "levelled-all-three", points: 6, when: { sim_metric: { metric: "chambersLevelled", at_least: 3 } } },
    // The first crossing: two numbers from opposite ends of the lock, combined
    // by a third party who can read neither.
    { id: "keyed-the-middle-gate", points: 10, when: { sim_metric: { metric: "keySet", at_least: 1 } } },
    { id: "reached-the-middle-chamber", points: 6, when: { sim_metric: { metric: "chambersCleared", at_least: 2 } } },
    // The second crossing: two rooms, and a public register to keep it out of.
    { id: "authorised-the-upper-gate", points: 12, when: { sim_metric: { metric: "authorised", at_least: 1 } } },
    { id: "worked-her-into-the-pound", points: 15, when: { sim_metric: { metric: "solved", at_least: 1 } } },
  ],

  /**
   * The five values that have to travel, and where each one starts.
   *
   * `authorisation` is the one this scenario was built around: discovered in
   * the basin, needed at the head, and no agent is in both rooms. Everything
   * else crosses once.
   */
  facts: {
    sill_offset: { value: "67", discoverableBy: ["sluice"], requiredBy: ["pilot"] },
    gauge_datum: { value: "214", discoverableBy: ["keeper"], requiredBy: ["pilot"] },
    authorisation: { value: "MERIDIAN-4", discoverableBy: ["signal"], requiredBy: ["keeper"] },
  },

  repeats: 1,

  expect: [
    // The real thing, and the reason the row is expected to be red.
    { sim_metric: { metric: "solved", at_least: 1 } },
    // The curve. Drawn where a team has done the hard mechanic and one of the
    // two crossings — which is the band this scenario is built to resolve.
    { score_at_least: 0.5 },
  ],
});
