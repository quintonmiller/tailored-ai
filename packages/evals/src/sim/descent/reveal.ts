/**
 * How a loyal party can find out who is against it.
 *
 * The betrayal layer shipped with `accuse`, which is free, public, unlimited and
 * changes nothing. That is the right bottom rung — it records suspicion — but it
 * leaves the party with no way to ever be *right*, and it leaves a traitor with
 * no reason to hurry. Measured on 2026-08-18: a traitor guardian held its role
 * in every round of a 24-round run, described the mage as "the frag", waited for
 * a fight chaotic enough to hide a kill, and the horizon ran out. Nobody
 * suspected anything, because there was nothing yet to suspect.
 *
 * Three constraints shape every variant here, and they are what stop a reveal
 * from being either useless or an instant win:
 *
 * 1. **It has to be earned.** Available from round one, a party would simply
 *    ask on round one and the variant would be a coin-flip with extra steps.
 *    Each mode is gated behind progress the party has to actually make.
 * 2. **It has to cost something.** A free answer is asked reflexively; a costly
 *    one is a decision, and the decision is the thing worth measuring.
 * 3. **The traitor has to know it is coming, from the start.** This is the load
 *    bearing one. A clock a traitor cannot see changes nothing about how they
 *    play; a clock they can see is the only reason to move early, and moving
 *    early against a party still at full strength is the risk that makes the
 *    whole mechanic a game rather than a countdown.
 *
 * The three differ along the axes worth sweeping: whether the answer is certain,
 * whether the asker chooses the subject, and what the cost is denominated in.
 *
 * | mode | earned by | answer | asker picks? | cost |
 * |---|---|---|---|---|
 * | `vigil` | clearing a floor | certain, yes/no | yes | dread, and everyone sees it |
 * | `tally` | a skill point | narrows to a pair, sometimes wrong | no | dread |
 * | `reckoning` | killing a boss | certain, names one | no | the party's purse, and dread |
 */

import type { Rng } from "../rng.js";
import type { ClassId } from "./model.js";

/**
 * The three original modes are engine-granted verbs; the four added on
 * 2026-08-18 are the social layer of `social.ts`, where the instrument is a
 * thing either side can go and get. Both families are kept because the first
 * one has swept numbers attached to it — deleting `vigil` would silently
 * invalidate the 60-seed table in `index.ts`, and a measurement whose code is
 * gone is not a measurement.
 *
 * | mode | family | what it offers |
 * |---|---|---|
 * | `off` | — | nothing |
 * | `vigil` | granted | certain, rationed by floors, publicly seen |
 * | `tally` | granted | a noisy pair, gated on a skill point |
 * | `reckoning` | granted | certain, names one, empties every purse |
 * | `both` | granted | `vigil` + `tally` |
 * | `draught` | social | 5A — a bought consumable, certain, private to two |
 * | `read` | social | 5B — free opposed check, wrong in both directions |
 * | `venom` | social | 5C — a bought vial, and one free to every traitor |
 * | `social` | social | all three, which is the intended shape of the game |
 */
export type RevealMode = "off" | "vigil" | "tally" | "reckoning" | "both" | "draught" | "read" | "venom" | "social";

export const REVEAL_MODES: RevealMode[] = [
  "off",
  "vigil",
  "tally",
  "reckoning",
  "both",
  "draught",
  "read",
  "venom",
  "social",
];

/** Which social instruments a mode turns on. `reveal.ts` owns nothing else about them. */
export function socialInstruments(mode: RevealMode): { draught: boolean; read: boolean; venom: boolean } {
  return {
    draught: mode === "draught" || mode === "social",
    read: mode === "read" || mode === "social",
    venom: mode === "venom" || mode === "social",
  };
}

export function parseRevealMode(raw: unknown): RevealMode {
  const s = String(raw ?? "off");
  return (REVEAL_MODES as string[]).includes(s) ? (s as RevealMode) : "off";
}

/**
 * What the party has achieved, as far as unlocking a reveal is concerned.
 *
 * Every gate below was chosen from a 30-seed sweep of the baseline party rather
 * than picked for flavour, because a gate is only a design if it opens at the
 * right time. The number it has to beat is **round 30**: that is where a
 * well-played turn lands, from the finisher sweep, so a reveal that opens later
 * never enters a traitor's calculation and is decoration.
 *
 * | candidate gate | median round | never opens |
 * |---|---|---|
 * | one elite down | 9 | 4/30 |
 * | one floor cleared | 11 | 0/30 |
 * | party level 2 | 19 | 0/30 |
 * | two floors cleared | 22 | 0/30 |
 * | two elites down | 24 | 18/30 |
 * | one boss down | 37 | **22/30** |
 *
 * The last row is why `reckoning` is not gated on a boss, which is where it
 * started: it would have been unreachable in more than two runs in three.
 */
export interface RevealProgress {
  floorsCleared: number;
  partyLevel: number;
  /** Who has bought the skill, for `tally`. */
  trained: ReadonlySet<ClassId>;
}

/**
 * What a vigil costs, now that it is not health.
 *
 * The first version charged the asker a quarter of their maximum health,
 * permanently, and across two live runs with the vigil available it was used
 * **zero times**. That is the cost design failing rather than the party being
 * incurious: a permanent stat tax is paid by one character for a benefit the
 * whole party gets, so nobody wants to be the one who goes first, and a party
 * with no suspicion yet has no case for paying anything at all. Which made the
 * instrument a *confirmation* tool — it could settle a suspicion but never
 * create one — while the gap it was built to fill was detection.
 *
 * The replacement charges two things that are not a stat bar — and *not* the
 * round, which the tool description claimed for two days and never took. That
 * claim was found on 2026-08-18 while writing the social layer's own cost
 * language, and it is the same defect as the euphemism: a sentence in a tool
 * description that the code does not implement. A model that budgets its action
 * economy around a cost that is not there declines an instrument it could have
 * used for free.
 *
 * - **dread**, which scales the difficulty for everybody, so seeking the truth
 *   makes the floor harder rather than making one character weaker;
 * - **publicity** — everyone sees who kept a vigil over whom.
 *
 * The third is the real price, and it is the one that serves the brief. A
 * traitor watching the net close on them is a traitor with a reason to move,
 * which is the whole point of giving the party an instrument in the first
 * place. It also means being wrong costs credibility rather than hit points,
 * which is the currency a social game should be denominated in.
 */
export const VIGIL_DREAD = 2;

/** What a reading costs the party in dread. Cheaper than a vigil, and repeatable. */
export const TALLY_DREAD = 1;

/** How often `tally` names a pair that does not contain a traitor. */
export const TALLY_ERROR_RATE = 0.25;

/**
 * Whether the capability is available yet, and what to say when it is not.
 *
 * The refusal names the unlock condition on purpose. A party that asks too early
 * should learn the shape of the clock — that is the same information the traitor
 * already has from the shared brief, and asymmetry here would be an accident
 * rather than a design.
 */
export function revealAvailability(
  mode: RevealMode,
  progress: RevealProgress,
  who: ClassId,
): { ready: boolean; why: string } {
  switch (mode) {
    case "off":
      return { ready: false, why: "There is no rite of that kind in this dungeon." };
    case "vigil":
      return progress.floorsCleared >= 1
        ? { ready: true, why: "" }
        : { ready: false, why: "The vigil needs a floor cleared behind you. Clear one and it will answer." };
    case "both":
      // The two instruments answer different questions, so the gate is whichever
      // one the caller can reach: a reading to *find* a suspicion, a vigil to
      // settle it. See the note on `VIGIL_DREAD` for why they belong together.
      if (progress.floorsCleared >= 1) return { ready: true, why: "" };
      if (progress.partyLevel >= 2 && progress.trained.has(who)) return { ready: true, why: "" };
      return {
        ready: false,
        why: "Neither the signs nor the vigil will answer yet. The vigil needs a floor cleared; the signs need level 2 and a skill point.",
      };
    case "tally":
      // Two gates, and the second is the one that matters. A skill point alone
      // is spendable on round one, which fails the "has to be earned" test
      // outright — the party would simply buy certainty before anything had
      // happened. Party level 2 is reached on a median round 19 and in every
      // run of a 30-seed sweep, so the skill is a choice and the level is the
      // clock.
      if (progress.partyLevel < 2) {
        return { ready: false, why: "The signs mean nothing to a party this green. Come back at level 2." };
      }
      return progress.trained.has(who)
        ? { ready: true, why: "" }
        : { ready: false, why: "You have not learned to read the signs. Spend a skill point on `read_the_signs`." };
    case "draught":
    case "read":
    case "venom":
    case "social":
      // Ungated on purpose, and this is the substantive difference between the
      // two families. `vigil` needs a floor behind you because it is free once
      // you have one; a draught needs three hundred gold, which on floor one
      // nobody has, and reading is free but unreliable enough that doing it on
      // round one buys a coin flip. The economy and the arithmetic are the
      // gates, so there is no clock to explain and no refusal to write.
      return { ready: true, why: "" };
    case "reckoning":
      // Two floors, not a boss. Gated on a boss it opened on a median round 37
      // and never opened at all in 22 of 30 runs, which makes the strongest rung
      // of the ladder the one nobody ever reaches.
      return progress.floorsCleared >= 2
        ? { ready: true, why: "" }
        : {
            ready: false,
            why: "The reckoning needs two floors behind you. It will answer when the dungeon has taken that much.",
          };
  }
}

/**
 * What `tally` reports: two names, one of whom is against the party — usually.
 *
 * Noisy on purpose, and noisy in the direction that keeps the game alive. A
 * certain answer that anybody can buy with one skill point ends the variant; a
 * pair that is wrong a quarter of the time gives the party something to argue
 * about, gives a traitor something to exploit — arguing loudly for the wrong
 * half of a correct pair is the strongest play in the mode — and makes repeated
 * readings worth more than one, which is what makes the round cost bite.
 *
 * The pair always contains two living characters other than the reader, so a
 * reader can never be told about themselves and can never be handed a pair of
 * one.
 */
export function tallyPair(
  rng: Rng,
  reader: ClassId,
  living: readonly ClassId[],
  traitors: ReadonlySet<ClassId>,
): { pair: [ClassId, ClassId]; honest: boolean } {
  const others = living.filter((id) => id !== reader);
  if (others.length < 2) throw new Error("a tally needs two other people to point at");

  const suspects = others.filter((id) => traitors.has(id));
  const clean = others.filter((id) => !traitors.has(id));
  const honest = suspects.length > 0 && rng.next() >= TALLY_ERROR_RATE;

  if (honest) {
    const guilty = suspects[rng.int(0, suspects.length - 1)];
    const rest = others.filter((id) => id !== guilty);
    const partner = rest[rng.int(0, rest.length - 1)];
    return { pair: orderPair(guilty, partner), honest: true };
  }

  // A wrong reading, or a run with nobody to find. Two innocents where possible;
  // a party where everyone else is a traitor gets a true pair by arithmetic, and
  // that is correct rather than a leak.
  const pool = clean.length >= 2 ? clean : others;
  const first = pool[rng.int(0, pool.length - 1)];
  const rest = pool.filter((id) => id !== first);
  const second = rest[rng.int(0, rest.length - 1)];
  return { pair: orderPair(first, second), honest: false };
}

function orderPair(a: ClassId, b: ClassId): [ClassId, ClassId] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

/**
 * The paragraph every character reads at the start, traitor or not.
 *
 * Shared deliberately. The traitor needs the clock to feel real, and the loyal
 * party needs to know the instrument exists or nobody will ever earn it. There
 * is nothing here a traitor gains from that the party does not gain equally,
 * which is the test for whether something belongs in the shared brief.
 */
export function revealBrief(mode: RevealMode): string[] {
  switch (mode) {
    case "off":
    // The social modes brief themselves, from `socialBrief` in `social.ts`,
    // because their text describes items and arithmetic rather than a rite.
    case "draught":
    case "read":
    case "venom":
    case "social":
      return [];
    case "vigil":
      return [
        "  Once you have cleared a floor, any one of you may keep a vigil and name one other person.",
        "  It answers truthfully whether that person is against the party, and it can be kept once for every",
        "  two floors you have put behind you. It wakes the floor — dread rises for everybody.",
        "  Everybody sees who kept a vigil and who they named. Nobody but the keeper hears the answer.",
      ];
    case "tally":
      return [
        "  `read_the_signs` is a skill any of you may buy with a skill point. Once learned, reading them raises",
        "  dread and names two people, one of whom is against the party — though the reading is wrong",
        "  about one time in four, and it never tells you which of the two. Everybody sees that you read them.",
      ];
    case "both":
      return [
        ...revealBrief("tally"),
        ...revealBrief("vigil"),
        "  The two answer different questions. A reading is cheap and wrong often enough to argue about; a vigil",
        "  is certain, rationed, and everybody sees who you kept it over.",
      ];
    case "reckoning":
      return [
        "  With two floors behind you the party may call a reckoning, which names one person who is against",
        "  it, truthfully. You do not choose who it names. It empties every purse in the party and the noise",
        "  of it brings the floor down on you — dread rises sharply — so it is bought with the rest of the run.",
      ];
  }
}
