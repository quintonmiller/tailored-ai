/**
 * The social layer: instruments either side can go and get.
 *
 * Everything in `reveal.ts` is a verb the engine hands to the loyal party —
 * `vigil` appears in your tool list because you are not a traitor, it answers
 * certainly, and everybody watches you use it. Measured over 60 seeds it works,
 * in the sense that the party finds the traitor; what it does not produce is an
 * argument. A certain answer that everyone saw you obtain ends the conversation
 * in the round it is given.
 *
 * The rule this module is built on:
 *
 * > **Nothing is certain, provable and public at the same time. Pick two.**
 *
 * A fact that is certain and public ends the argument. A fact that is certain
 * and *private* starts one, because the only two people who know it can each
 * say whatever they like about it afterwards. So every instrument here is
 * private to exactly two people — the one who used it and the one it was used
 * on — and nobody else ever learns that it happened.
 *
 * | instrument | who may hold it | certain? | who learns | what it costs |
 * |---|---|---|---|---|
 * | `draught` (5A) | anyone who buys or finds one | yes | user and subject | 300 gold, and the subject knows you are hunting them |
 * | `read` (5B) | anyone, always | no — opposed roll | reader and subject | nothing but the subject knowing |
 * | `venom` (5C) | anyone who buys one; traitors start with one | — | the victim, who is not told by whom | 240 gold, or free for a traitor |
 *
 * The second column is the part that matters and the part `reveal.ts` gets
 * wrong. A traitor may buy a draught — to find a partner, to see who is hunting
 * them, or to hold a receipt they can lie about. A loyal character may buy
 * venom. An instrument only one side can hold is a rule; a rule is not a game.
 */

import type { Rng } from "../rng.js";

/** The item ids the layer trades in. Both are ordinary consumables in `ITEMS`. */
export const DRAUGHT_ITEM = "truth_draught";
export const VENOM_ITEM = "venom_vial";

/**
 * How well a reader sees, and how well a subject hides.
 *
 * An opposed roll rather than a flat error rate, for two reasons that are not
 * flavour. It gives the traitor something to *invest in* — guile grows with
 * depth, so a traitor who has survived to floor four reads cleaner than one on
 * floor one, and "he read clean at four and dirty at one" is exactly the shape
 * of argument this layer exists to produce. And it makes a false *positive*
 * possible: a loyal subject who wins the roll reads as guilty, so a single
 * dirty reading is never proof, which is what stops the instrument collapsing
 * into `vigil` with extra steps.
 *
 * The asymmetry is deliberate and is what keeps a clean reading worth having:
 * a loyal subject rolls with `LOYAL_GUILE` and mostly loses, so most readings
 * of a loyal character are correct. A traitor's guile overtakes insight around
 * the second floor, which is roughly where the party has gold to spend on
 * draughts — the cheap instrument decays exactly as the expensive one arrives.
 */
export const READ_INSIGHT_BASE = 5;
/** What `read_the_signs` is worth, for parties playing a mode that offers it. */
export const READ_TRAINED_BONUS = 4;
export const LOYAL_GUILE = 0;
export const TRAITOR_GUILE_BASE = 2;
export const TRAITOR_GUILE_PER_FLOOR = 2;

export function insightOf(partyLevel: number, trained: boolean): number {
  return READ_INSIGHT_BASE + partyLevel + (trained ? READ_TRAINED_BONUS : 0);
}

export function guileOf(traitor: boolean, floorsCleared: number): number {
  return traitor ? TRAITOR_GUILE_BASE + TRAITOR_GUILE_PER_FLOOR * floorsCleared : LOYAL_GUILE;
}

/**
 * One opposed d20. The reader wins ties, which is worth about 5% and is the
 * difference between an instrument that is slightly better than nothing and one
 * that is slightly worse.
 */
export function opposed(rng: Rng, insight: number, guile: number): boolean {
  return rng.int(1, 20) + insight >= rng.int(1, 20) + guile;
}

/**
 * What a reading says: the truth if the reader won, the opposite if they did
 * not.
 *
 * Inverting on a loss rather than returning "inconclusive" is the whole point.
 * An inconclusive result is information the party can pool safely; a *wrong*
 * result is information they have to weigh against each other, and weighing is
 * the activity being measured.
 */
export function readVerdict(
  rng: Rng,
  opts: { partyLevel: number; trained: boolean; floorsCleared: number; subjectIsTraitor: boolean },
): { saysGuilty: boolean; correct: boolean } {
  const won = opposed(
    rng,
    insightOf(opts.partyLevel, opts.trained),
    guileOf(opts.subjectIsTraitor, opts.floorsCleared),
  );
  return { saysGuilty: won ? opts.subjectIsTraitor : !opts.subjectIsTraitor, correct: won };
}

/**
 * What a vial does.
 *
 * Poison rather than a direct hit because sabotage by omission is a *flow* — the
 * cleric heals it away and by round twenty nothing has accumulated. Poison is
 * damage that persists across a fight, that costs an antidote to clear, and
 * that is evidence something happened without being evidence of who did it.
 * `antidote` already clears it, so the counter-play shipped years before the
 * attack did.
 *
 * Seven ticks at sixteen, swept over 200 seeds against a party that answers a
 * poison with an antidote. The row that matters is `poisoner` against
 * `saboteur` — the same withdrawn traitor, with and without the vial:
 *
 * | vial | traitor wins | party xp | loyalists down |
 * |---|---|---|---|
 * | none (`saboteur`) | 36% | 371 | 2.67 |
 * | 9 x 6 | 39% | 374 | 2.67 |
 * | **16 x 7** | **45%** | 366 | 2.73 |
 * | 20 x 8 | 57% | 345 | 3.00 |
 * | 40 x 10 | 78% | 286 | 3.48 |
 *
 * Nine points of traitor win from one free consumable is the target: enough
 * that using it beats holding it, nowhere near enough that holding it is the
 * strategy. At 20 x 8 a single vial is worth more than every other thing a
 * traitor can do put together, which reproduces exactly the defect `turn`
 * already has — one move that dominates, and therefore no reason to play the
 * social game at all.
 *
 * A caveat that belongs with the number rather than under it: the antidote
 * counter-play barely moves these rows (43% to 41% at 9 x 6 in the 60-seed
 * pass), and not because it does not work. The party seldom *holds* one —
 * antidotes arrive from drops at about one roll in fifteen and from a
 * merchant's shelf at random. The counter to the layer's stock item is
 * nominally available and practically absent, which is worth knowing before
 * anybody concludes the balance point is robust.
 */
export const VENOM_TICKS = 7;
export const VENOM_AMOUNT = 16;

/**
 * The paragraph everybody reads, traitor or not.
 *
 * Shared for the reason the whole file is shared: an instrument nobody knows
 * about is never bought, and a clock the traitor cannot see changes nothing
 * about how they play. There is nothing here a traitor gains that the party
 * does not gain equally, which is the test for what belongs in a shared brief.
 *
 * ## Why the pooling arithmetic is spelled out
 *
 * Measured live on 2026-08-18: a party sized each other up nine times, got six
 * right, and acted on none of it. One character disclosed a reading, promised
 * to watch, and dropped the thread. The ranger read the traitor correctly
 * *twice*, fourteen rounds apart, and said nothing either time — its next line
 * after the second was "Agree with Corin".
 *
 * The likely cause is the honest half of the result text. Every reading ends
 * "it can be wrong in either direction", which a careful reader takes as a
 * reason not to repeat it. True, and incomplete: the error falls independently
 * per reader, so four of them comparing notes is close to decisive while one of
 * them reading four times is worth nothing. That is not derivable from a single
 * result and is useless unless somebody says it out loud, so it goes in the
 * brief on the same footing as the traitor odds already quoted there.
 *
 * Symmetric, like everything else here: the traitor reads it too, and learns
 * that a party which pools is a party to break up.
 */
export function socialBrief(opts: { draught: boolean; read: boolean; venom: boolean }): string[] {
  const out: string[] = [];
  if (opts.read) {
    out.push(
      "  Any of you may `size_up` any other for deception, for free and without spending your action, as often",
      "  as you like — including in the middle of a fight. You are matching your judgement against their",
      "  composure, and someone who has survived a few floors down here has learned to hold it, so a reading",
      "  can be wrong in either direction. Only you hear what it said; the person you sized up is told that",
      "  you did, and never what you concluded.",
      // The arithmetic, and the reason it is stated. See the note below.
      "  One reading on its own is weak: roughly one person in five who is with the party reads as hiding",
      "  something anyway, and someone against it reads clean about a third of the time — more, the deeper",
      "  they have come. The error falls differently for each of you, so several of you reading the same",
      "  person and comparing what you were told is far stronger than any one of you reading them again. It",
      "  is also the only way a reading becomes something the party can act on: nobody else ever learns what",
      "  yours said unless you say it.",
    );
  }
  if (opts.draught) {
    out.push(
      "  One of you came down carrying a Draught of Truth. Which of you is not something anybody but the",
      "  holder knows, and they are under no obligation to say. It names one person's allegiance and it does",
      "  not lie. Only you and the person you name ever hear it — the rest of the party is not told that you",
      "  used one, or on whom. The person you name is told it was you. More are on every merchant's counter",
      "  from the second floor down, and they turn up in caches.",
    );
  }
  if (opts.venom) {
    out.push(
      "  A Vial of Grey Venom is on the same counter. It poisons one person for several rounds. They will",
      "  know they were poisoned. Nobody, including them, is ever told who did it. An antidote clears it.",
      "  None of these three costs you your action. You can use any of them in the same round you fight.",
    );
  }
  if (out.length > 0) {
    out.unshift("  Some things down here can be bought, found or attempted rather than earned:");
  }
  return out;
}
