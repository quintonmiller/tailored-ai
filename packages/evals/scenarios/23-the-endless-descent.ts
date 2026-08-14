/**
 * Five specialists, a dungeon with no bottom, and no way to win.
 *
 * Every other scenario in this package asks whether a team can reach a state
 * somebody wrote down in advance, and every one of them is finished:
 * `the-machine` scores 98/98 on three runs of three, and `the-lock` — proved
 * solvable, proved impossible to soft-lock, built over a full session — was
 * solved on its third run and every run after. A benchmark authored that way
 * has to be re-authored every time it is beaten.
 *
 * This one cannot be beaten, because there is nothing to beat. The dungeon goes
 * down forever and gets harder on six axes; the party's own growth is
 * deliberately slower than the dungeon's, so the two curves cross and the run
 * ends. The score is the experience earned before that happened. Better and
 * worse stay continuous, so it keeps discriminating after "can they do this at
 * all" has been answered — and a marginal improvement in planning, memory,
 * communication or resource management shows up as another floor.
 *
 * ## Why the party starts on floor 31
 *
 * Measured, not chosen for flavour. Against the baselines, a forty-five tick
 * run starting from floor one reaches about floor eleven — and floors one to
 * twenty-two are survivable by a party that plays *randomly*. Every rung of the
 * ladder from `tactics-only` upward finished within fifteen percent of every
 * other, because nothing that separates them has happened yet: hidden mechanics
 * do not appear until fifteen, and the dungeon does not out-scale a competent
 * party until the low thirties.
 *
 * So the run starts in the band that discriminates, with the levels, purses and
 * gear a party that walked there would have — fitted to what `rule-based`
 * actually holds on arrival, over twenty seeds. Starting from floor one is two
 * numbers away (`startFloor: 1`, and roughly 150 rounds), and is the right
 * configuration for a run nobody has to wait for.
 *
 * ## What the ladder says before any model runs
 *
 *   greedy-dps      5,483   floor 34.7   all damage, no defence; wipes a third of the time
 *   random          4,535   floor 34.7   legal moves, chosen without a thought
 *   basic-tactics   5,698   floor 35.1   taunt, heal, swing; never opens a pack
 *   tactics-only    8,220   floor 35.5   plays the fight well, ignores the rest
 *   rule-based      9,317   floor 35.8   everything a competent player does
 *   oracle          9,877   floor 36.0   and knows every hidden mechanic already
 *
 * Twenty-four seeds, forty rounds, experience *earned* rather than the
 * twenty-five thousand the party is handed for standing on floor 31. Swept at
 * this scenario's own start floor — `bench --sim-option startFloor=31` — which
 * is the only ladder that describes the game being played. The default sweep
 * starts on floor 1 and measures a different one.
 *
 * Floor 31 rather than 30 for one blunt reason: 30 is divisible by five, so the
 * party's opening fight was a boss — the hardest fight in the rotation arriving
 * before anybody has agreed on anything.
 *
 * Two things worth reading off the board. The jump from `basic-tactics` to
 * `tactics-only` is the largest on it, so the tactical layer is where most of
 * the value is. And the gap from `tactics-only` to `rule-based` is the price of
 * ignoring everything that happens *between* fights — trading, pooling,
 * equipping, dividing a cache, reviving — which is the part a five-agent
 * organisation is uniquely placed to get right or wrong.
 *
 * Bosses are the clearest discriminator on the board and only became one when
 * the pacing was fixed: a forty-round run used to cover a single floor, so *no*
 * policy — the omniscient one included — ever reached a boss at all, and the
 * column read 0.0 all the way down. It now reads 1.0 for the competent rungs
 * and 0.0-0.4 for the rest.
 *
 * Over a full-length run the oracle's lead widens sharply, because perfect
 * recall compounds. At this budget it is +6%, so the memory measurement here is
 * the diagnostic rather than the score.
 *
 * ## What makes it hard for five agents rather than for one
 *
 *   private packs   `look` gives an ally's health and what they are wearing, and
 *                   never their inventory or their purse. A plate cuirass in the
 *                   mage's bag is invisible until the mage works out it is
 *                   useless and says so.
 *   split sight     `inspect_enemy` returns a different slice per class and no
 *                   slice is sufficient. The mage sees resistances, the guardian
 *                   sees armour, and whoever is swinging sees neither.
 *   simultaneity    combat actions are *readied*, and the whole round resolves
 *                   at once. Two individually sensible choices can be jointly
 *                   terrible — a fireball into the group the rogue just put to
 *                   sleep — and nothing warns anybody.
 *   individual gold Nobody can afford the good item alone, and nothing suggests
 *                   pooling.
 *   hard caps       A cache offers six things and lets the party carry out two;
 *                   only two trinkets can be attuned at a time. Neither can be
 *                   settled by whoever happens to be richest, so the only way
 *                   through is to agree — and somebody has to concede.
 *   a private scout The rogue can go ahead alone, and what they find is theirs
 *                   alone. The party learns it only if the rogue says so.
 *   hidden rules    Ten families each carry a rule no tool will ever reveal, and
 *                   each comes back stronger later with the same rule.
 */

import { defineScenario } from "../src/define.js";

/**
 * Forty-five rounds, which is a budget rather than a guess.
 *
 * One round is one tick of the dungeon and five agent turns. Measured against
 * `the-lock`, an agent turn on the local model runs about 35 seconds, so forty
 * rounds is roughly two hours per repeat.
 *
 * It is also the ceiling the schema allows, and that ceiling is the right one to
 * respect rather than raise: it exists to stop a single scenario costing more
 * than anybody will wait for. Unlike `the-lock`, though, rounds here buy
 * *measurement* rather than more chances at the same discovery — this scenario
 * has no answer to find — so a deeper run is a legitimate configuration and the
 * only thing standing in its way is the bill.
 */
const ROUNDS = 40;

/** Where the party is already standing when the run starts. See the note above. */
const START_FLOOR = 31;

const OBJECTIVE =
  "There is no way out and nothing to win. Go as deep as you can and take as much from it as you " +
  "can, for as long as the five of you are still standing.";

const SHARED =
  "You are one of five in a party descending an endless dungeon. Everything you do happens through " +
  "your tools — nothing moves in this place unless somebody calls one. In a fight your action is " +
  "*readied*, not taken: the whole round resolves at once when it closes, so what the others do this " +
  "round matters as much as what you do. Talk to them with `room`. You can see your allies' " +
  "condition and what they are wearing, and you cannot see inside their packs or their purses — if " +
  "you are carrying something you cannot use, nobody else knows unless you say so. Some things here " +
  "are capped for the whole party rather than for you: a dead expedition's packs hold more than the " +
  "five of you can carry out, and only two of you can wear a trinket at a time. Those cannot be " +
  "settled alone. Say what a tool actually returned, in numbers, not in summary. " +
  OBJECTIVE;

const hand = (description: string, instructions: string) => ({
  description,
  instructions: `${instructions}\n\n${SHARED}`,
});

export default defineScenario({
  id: "the-endless-descent",
  category: "orchestration",
  difficulty: 10,
  intent:
    "Five agents with asymmetric classes, information and inventories run an endless dungeon until " +
    "the party dies or the clock does. There is no win condition and no ceiling: the score is total " +
    "experience, the dungeon scales on six axes, and the party's growth is deliberately slower than " +
    "the dungeon's so the two curves cross.\n\n" +
    "It exists because every other scenario here is finished — `the-machine` at 98/98 and `the-lock` " +
    "solved on its third run — and re-authoring a harder riddle each time one falls does not scale. " +
    "A scored descent keeps discriminating indefinitely, and a six-rung baseline ladder from a " +
    "random party to an omniscient one says what any given number is worth. It is also the only " +
    "scenario in the package that can measure memory: ten enemy families carry a hidden rule no tool " +
    "reveals, and each returns later, stronger, with the same rule.",

  simulation: {
    name: "descent",
    days: ROUNDS,
    daysPerRound: 1,
    roles: {
      guardian: "guardian",
      mage: "mage",
      rogue: "rogue",
      cleric: "cleric",
      ranger: "ranger",
    },
    options: { startFloor: START_FLOOR },
  },

  agent: {
    name: "guardian",
    ...hand(
      "At the front, between the party and whatever is in the room.",
      "You are the guardian. You have the most health and the heaviest armour, and you are the only " +
        "one who can pull enemies onto yourself or put a shield on somebody else. Your inspection " +
        "tells you an enemy's armour and how hard it hits, and nothing about what it resists — the " +
        "mage sees that. Heavy armour is yours alone; nobody else can wear it.",
    ),
  },

  config: {
    agents: {
      mage: hand(
        "Behind the line, where it is safe enough to cast from.",
        "You are the mage. You deal the most damage and you have the least health of anybody here. " +
          "You are the only one who can read an enemy's elemental resistances, and the only one who " +
          "can hit every enemy at once. Your spells cost mana, which comes back slowly in a fight " +
          "and quickly out of one.",
      ),
      rogue: hand(
        "Ahead of the party, or behind whatever it is fighting.",
        "You are the rogue. You do the heaviest single hit, you are the only one who can interrupt " +
          "something that is winding up, and you are the only one who can go ahead and look at the " +
          "ways on before the party commits. What you see when you scout, you see alone — nobody " +
          "else learns any of it unless you tell them, and looking costs the party time. Your " +
          "inspection tells you how fast an enemy is and whether there is something odd about it — " +
          "never what.",
      ),
      cleric: hand(
        "Wherever the worst of it has landed.",
        "You are the cleric. Yours are the only hands that can heal, cleanse or revive, and the " +
          "party does not last long without you. Your inspection reads an enemy's aura — whether it " +
          "is watching the fighters or watching you. Healing is not always safe.",
      ),
      ranger: hand(
        "At range, watching the whole room.",
        "You are the ranger. You do reliable damage at range and you can mark a target so everybody " +
          "hits it harder. Your training tells you how a creature behaves and where its thresholds " +
          "are — more about habits than any of the others get, and still not everything.",
      ),
    },
  },

  /**
   * One room, on purpose.
   *
   * `the-machine` and its split sibling already measure what happens when a
   * fact has to cross a wall — 98/98 against 32/52/107, on the same model. This
   * scenario is asking a different question, and putting the party in separate
   * rooms as well would confound the two: a low score would not distinguish
   * "could not play the dungeon" from "could not get a number across a room".
   *
   * The information split here is inside the party rather than between rooms:
   * five inspections that each see something different, and five packs nobody
   * else can look into. Splitting the party across rooms is the obvious next
   * variant, and belongs in a second scenario rather than this one.
   */
  rooms: [
    {
      name: "party",
      purpose: "The five of you, within earshot of each other, somewhere under a mountain.",
      members: ["guardian", "mage", "rogue", "cleric", "ranger"],
      deliver: "poll",
      wakeOn: "all",
      incoming: [
        {
          speaker: "quinton",
          body:
            "You have been down here a while and there is no way back up. Whatever you were sent for, " +
            "it is further down. Keep each other alive and take everything you can carry.",
        },
      ],
    },
  ],

  wake: [{ room: "party", rounds: ROUNDS, agents: ["guardian", "mage", "rogue", "cleric", "ranger"] }],

  /**
   * A ladder of depth and organisation, not a checklist.
   *
   * The scenario has no solution, so these are not steps toward one — they are
   * the bands the baselines separate into, so a run's score says which rung it
   * played like. The expensive rows are the ones only an organisation earns:
   * moving an item to somebody who can use it, pooling purses for something no
   * single purse could buy, and getting out of a floor without losing anybody.
   */
  milestones: [
    { id: "took-stock-of-the-party", points: 2, when: { calls_tool_any: ["look"] } },
    { id: "read-an-enemy", points: 3, when: { calls_tool_any: ["inspect_enemy", "read_beast"] } },
    { id: "scouted-before-committing", points: 3, when: { calls_by: { agent: "rogue", tool: "scout" } } },
    { id: "fought-at-all", points: 4, when: { sim_metric: { metric: "enemiesDefeated", at_least: 3 } } },
    { id: "cleared-a-floor", points: 5, when: { sim_metric: { metric: "floorsCleared", at_least: 1 } } },
    // The out-of-combat layer, which is worth more than the fighting in the
    // measured ladder and which nobody is told to do.
    { id: "moved-an-item-to-somebody-who-can-use-it", points: 8, when: { sim_metric: { metric: "tradesMade", at_least: 1 } } },
    { id: "pooled-a-purse", points: 4, when: { sim_metric: { metric: "goldTransfers", at_least: 1 } } },
    { id: "bought-something-nobody-could-afford-alone", points: 3, when: { sim_metric: { metric: "pooledPurchases", at_least: 1 } } },
    // A cache offers six things and lets the party carry out two, so the only
    // way to resolve it is to agree. Taking anything at all is the low bar;
    // *spreading* the takes is the one that says a conversation happened,
    // because one agent emptying every cache is identical on every other
    // metric here.
    { id: "took-from-a-dead-expedition", points: 3, when: { sim_metric: { metric: "cacheTakes", at_least: 1 } } },
    { id: "divided-a-cache", points: 8, when: { sim_metric: { metric: "cacheTakers", at_least: 2 } } },
    // Depth, which is the headline the whole simulation is built around.
    { id: "went-three-floors-down", points: 6, when: { sim_metric: { metric: "floorsCleared", at_least: 3 } } },
    { id: "went-six-floors-down", points: 8, when: { sim_metric: { metric: "floorsCleared", at_least: 6 } } },
    { id: "put-down-a-boss", points: 10, when: { sim_metric: { metric: "bossesDefeated", at_least: 1 } } },
    // Both re-derived against the ladder swept at this scenario's own start
    // floor, which is the only ladder that describes the game being played:
    // random 4,534 · basic-tactics 5,675 · tactics-only 8,711 ·
    // rule-based 9,483 · oracle 9,816, over twelve seeds at forty rounds.
    //
    // The previous numbers (2,500 and 6,000) were calibrated before the pacing
    // fix and had drifted below the bottom of the ladder — a party that beat
    // nothing collected the "beat a thoughtless party" points.
    { id: "beat-a-thoughtless-party", points: 8, when: { sim_metric: { metric: "earnedXp", at_least: 4_500 } } },
    { id: "played-like-a-competent-one", points: 10, when: { sim_metric: { metric: "earnedXp", at_least: 8_700 } } },
    // Kept everybody alive, and remembered what the dungeon taught them.
    { id: "nobody-was-left-behind", points: 8, when: { sim_metric: { metric: "permanentDeaths", at_most: 0 } } },
    { id: "did-not-fall-for-the-same-thing-twice", points: 7, when: { sim_metric: { metric: "memoryLapses", at_most: 0 } } },
  ],

  repeats: 1,

  expect: [
    // Asserted against the ladder rather than a constant.
    //
    // The hardcoded threshold here had to be re-derived twice as the balance
    // moved, and was wrong both times in between — which is exactly the failure
    // a benchmark cannot afford, because a stale number turns every run red or
    // every run green for reasons that have nothing to do with the agents.
    // `beats_baseline` replays the chosen policy on this run's own seed,
    // horizon and start floor, so it stays true through any future tuning.
    //
    // `basic-tactics` is the bar deliberately: it fights competently and does
    // nothing else. Clearing it means the framework's out-of-combat
    // organisation was worth something, which is the thing under test.
    { beats_baseline: { policy: "basic-tactics", metric: "earnedXp" } },
    // The band this scenario is built to resolve — got down some floors, kept
    // the party together, and did at least one thing that needed five people.
    { score_at_least: 0.5 },
  ],
});
