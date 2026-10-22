/**
 * The instrument. Written before the abilities that feed it, on purpose.
 *
 * The score of a descent is experience, and experience answers one question:
 * how far did this organisation get. It does not answer the question that would
 * actually improve TAI, which is *why*. That is what this file is for, and it
 * is the reason the scenario exists at all — a benchmark that only produces a
 * ranking tells you which framework to ship, not what to fix in the one you
 * have.
 *
 * ## Every reading here is detectable without knowing the optimal play
 *
 * This is the constraint that shaped it. For `the-lock` a perfect line could be
 * written down, because the state space was small enough to search exhaustively
 * — so "was this move optimal" had an answer. A dungeon with items, statuses
 * and an economy has no such answer at any tractable cost, and a diagnostic
 * that needs a solver is a diagnostic that will never be built.
 *
 * So every number below comes from an event the simulation can *see itself*:
 *
 *   tool correctness   an action the machinery refused
 *   information        an attack with an element the target is known to resist,
 *                      made after somebody in the party inspected it
 *   memory             a hidden mechanic that fired, in a later encounter with a
 *                      family whose mechanic has already fired once
 *   allocation         an item sitting in a pack belonging to somebody who
 *                      cannot use it, while somebody who can is standing there
 *   coordination       two individually sensible actions readied in one round
 *                      whose combination is worse than either alone
 *   conservation       a scarce consumable spent on a fight that did not need it
 *   pooling            gold moved between members, and a purchase that followed
 *                      which nobody could have afforded alone
 *
 * None of them needs a ground truth about the right move. All of them need the
 * simulation to know something the party had to work out, which it does.
 *
 * ## Why memory is the one that matters
 *
 * `the-lock` and `the-machine` both fit inside a single context window, so
 * "remembering" in them is indistinguishable from "still being able to read it".
 * A fifty-floor descent does not fit, and history gets compacted somewhere
 * around the middle. A family whose mechanic first fires on floor 15 and whose
 * stronger form appears on floor 28 is asking whether anything survived that
 * compaction — which is a property of the framework rather than the model, and
 * is not measured anywhere else in this package.
 */

import type { ClassId } from "./model.js";

export interface DiagnosticReport {
  toolCorrectness: number;
  informationRouting: number;
  memory: number;
  allocation: number;
  coordination: number;
  conservation: number;
  pooling: number;
}

/** A scarce consumable spent on a fight that was never in doubt. */
const PRECIOUS = new Set(["greater_potion", "soul_stone", "elixir"]);

export class Diagnostics {
  // Tool correctness
  actionsAttempted = 0;
  actionsRefused = 0;
  /** Readied actions that could not resolve — a dead target, an asleep actor. */
  actionsWasted = 0;
  /** Turns where an agent readied nothing at all. */
  turnsIdle = 0;

  // Information routing
  /** Enemy refs somebody has inspected, and what the inspection would have told them. */
  private inspected = new Map<string, Set<ClassId>>();
  elementIntoResistance = 0;
  physicalIntoArmour = 0;
  informedAttacks = 0;

  // Memory
  private familyEncounters = new Map<string, number>();
  private familyFiredIn = new Map<string, Set<number>>();
  /** Repeats of the sharpest reading: lightning into a crystal that has already reflected. */
  reflectRepeats = 0;

  // Allocation
  misheldTicks = 0;
  tradesMade = 0;
  upgradesLeftUnequipped = 0;

  // Coordination
  conflicts = 0;
  coordinatedRounds = 0;
  conflictExamples: string[] = [];

  // Conservation
  preciousOnTrash = 0;
  preciousOnSerious = 0;

  // Pooling
  goldTransfers = 0;
  pooledPurchases = 0;

  // -------------------------------------------------------------------------

  recordAttempt(refused: boolean): void {
    this.actionsAttempted += 1;
    if (refused) this.actionsRefused += 1;
  }

  recordInspect(ref: string, by: ClassId): void {
    const set = this.inspected.get(ref) ?? new Set<ClassId>();
    set.add(by);
    this.inspected.set(ref, set);
  }

  /** Has anybody looked at this enemy, and would that look have told them? */
  wasInspected(ref: string, byWhom?: ClassId): boolean {
    const set = this.inspected.get(ref);
    if (!set) return false;
    return byWhom ? set.has(byWhom) : set.size > 0;
  }

  /**
   * An attack landed. Was the element a known-bad choice?
   *
   * Only counted when somebody had already inspected the target — before that,
   * hitting a warden with fire is exploration, and the benchmark should not
   * punish finding out. Afterwards it is a routing failure: the mage knew, and
   * whoever swung did not.
   */
  recordAttack(ref: string, resistFactor: number, physicalIntoArmour: boolean): void {
    if (!this.wasInspected(ref)) return;
    this.informedAttacks += 1;
    if (resistFactor < 0.6) this.elementIntoResistance += 1;
    if (physicalIntoArmour) this.physicalIntoArmour += 1;
  }

  recordEncounter(families: string[]): void {
    // Enemy refs are unique only inside an encounter (`husk-1`, `husk-2`). An
    // old inspection must not make a different `husk-1` several floors later
    // count as informed.
    this.inspected.clear();
    for (const family of new Set(families)) {
      this.familyEncounters.set(family, (this.familyEncounters.get(family) ?? 0) + 1);
    }
  }

  /**
   * A hidden mechanic fired against the party.
   *
   * Recorded against the *encounter index* rather than the tick, because a bell
   * that tolls three times in one fight has taught one lesson, not three. The
   * question is whether the lesson survived to the next fight.
   */
  recordMechanic(family: string, kind: string): void {
    const index = this.familyEncounters.get(family) ?? 0;
    const set = this.familyFiredIn.get(family) ?? new Set<number>();
    set.add(index);
    this.familyFiredIn.set(family, set);
    if (kind === "reflect" && set.size > 1) this.reflectRepeats += 1;
  }

  recordConflicts(count: number, examples: string[], hadMultipleActors: boolean): void {
    if (hadMultipleActors) this.coordinatedRounds += 1;
    this.conflicts += count;
    for (const e of examples) if (this.conflictExamples.length < 40) this.conflictExamples.push(e);
  }

  recordConsumable(item: string, serious: boolean): void {
    if (!PRECIOUS.has(item)) return;
    if (serious) this.preciousOnSerious += 1;
    else this.preciousOnTrash += 1;
  }

  recordMisheld(count: number): void {
    this.misheldTicks += count;
  }

  recordTrade(): void {
    this.tradesMade += 1;
  }

  recordGoldTransfer(): void {
    this.goldTransfers += 1;
  }

  recordPooledPurchase(): void {
    this.pooledPurchases += 1;
  }

  /**
   * Who took what out of a cache.
   *
   * A cache offers more than the party can carry, so somebody has to concede.
   * The reading worth having is not *what* was taken but *whether the taking
   * was shared* — one agent emptying every cache it finds and a party dividing
   * them are the same total in every other metric here.
   */
  recordCacheTake(who: string, cache = "current"): void {
    this.cacheTakes += 1;
    const takers = this.cacheTakersByCache.get(cache) ?? new Set<string>();
    takers.add(who);
    this.cacheTakersByCache.set(cache, takers);
  }

  cacheTakes = 0;
  private readonly cacheTakersByCache = new Map<string, Set<string>>();

  private mostTakersAtOneCache(): number {
    return Math.max(0, ...[...this.cacheTakersByCache.values()].map((takers) => takers.size));
  }

  // -------------------------------------------------------------------------

  /**
   * Opportunities to have remembered, and the ones that were taken.
   *
   * An opportunity is an encounter with a family whose mechanic has already
   * fired in an *earlier* encounter. The party has been shown the rule; this
   * asks whether the rule was applied. A family met once and never again
   * contributes nothing either way, which is correct — nobody was asked
   * anything.
   */
  memoryLedger(): { opportunities: number; repeats: number } {
    let opportunities = 0;
    let repeats = 0;
    for (const [family, encounters] of this.familyEncounters) {
      const fired = this.familyFiredIn.get(family);
      if (!fired || fired.size === 0) continue;
      const first = Math.min(...fired);
      // Every encounter after the one that taught the lesson is a chance to
      // show it was learned.
      const later = encounters - first;
      if (later <= 0) continue;
      opportunities += later;
      for (const at of fired) if (at > first) repeats += 1;
    }
    return { opportunities, repeats };
  }

  report(): DiagnosticReport {
    const ratio = (good: number, total: number) => (total === 0 ? 1 : Math.max(0, Math.min(1, good / total)));

    const { opportunities, repeats } = this.memoryLedger();
    const badAttacks = this.elementIntoResistance + this.physicalIntoArmour;

    return {
      toolCorrectness: ratio(this.actionsAttempted - this.actionsRefused, this.actionsAttempted),
      informationRouting: ratio(this.informedAttacks - badAttacks, this.informedAttacks),
      memory: opportunities === 0 ? 1 : ratio(opportunities - repeats, opportunities),
      // A misheld item costs a fraction of a point per tick it sits in the
      // wrong pack, so a trade made late still scores better than never.
      allocation: ratio(Math.max(0, 100 - this.misheldTicks), 100),
      coordination: ratio(this.coordinatedRounds - this.conflicts, Math.max(1, this.coordinatedRounds)),
      conservation: ratio(this.preciousOnSerious, this.preciousOnSerious + this.preciousOnTrash),
      pooling: this.poolingScore(),
    };
  }

  /**
   * Did the party resolve a scarce resource together, or did one member settle it?
   *
   * Two routes lead to the same question, so both feed one reading. Gold: money
   * moved between purses to reach a purchase nobody could make alone. Caches: a
   * find that offers more than the party can carry, where the reading worth
   * having is whether the takes were *spread* — one agent emptying every cache
   * and a party dividing them are identical in every other metric.
   *
   * Reading zero when neither happened is deliberate and unchanged: no
   * opportunity taken is not the same as a decision made well, and it should
   * not flatter a run that never engaged.
   */
  private poolingScore(): number {
    const parts: number[] = [];
    if (this.goldTransfers > 0) {
      parts.push(Math.max(0, Math.min(1, (this.pooledPurchases + 1) / (this.goldTransfers + 1))));
    }
    if (this.cacheTakes > 0) {
      // Perfect is every take going to a different member; the ceiling is the
      // smaller of the takes made and the members available to take them.
      parts.push(Math.max(0, Math.min(1, this.mostTakersAtOneCache() / Math.min(this.cacheTakes, 5))));
    }
    if (parts.length === 0) return 0;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  }

  /** Flattened for `SimMetrics`, which is a flat `Record<string, number>`. */
  metrics(): Record<string, number> {
    const r = this.report();
    const { opportunities, repeats } = this.memoryLedger();
    return {
      diagToolCorrectness: Math.round(r.toolCorrectness * 100),
      diagInformationRouting: Math.round(r.informationRouting * 100),
      diagMemory: Math.round(r.memory * 100),
      diagAllocation: Math.round(r.allocation * 100),
      diagCoordination: Math.round(r.coordination * 100),
      diagConservation: Math.round(r.conservation * 100),
      diagPooling: Math.round(r.pooling * 100),
      actionsAttempted: this.actionsAttempted,
      actionsRefused: this.actionsRefused,
      actionsWasted: this.actionsWasted,
      turnsIdle: this.turnsIdle,
      memoryOpportunities: opportunities,
      memoryLapses: repeats,
      reflectRepeats: this.reflectRepeats,
      elementIntoResistance: this.elementIntoResistance,
      physicalIntoArmour: this.physicalIntoArmour,
      antiSynergies: this.conflicts,
      tradesMade: this.tradesMade,
      goldTransfers: this.goldTransfers,
      pooledPurchases: this.pooledPurchases,
      cacheTakes: this.cacheTakes,
      cacheTakers: this.mostTakersAtOneCache(),
      misheldTicks: this.misheldTicks,
      preciousOnTrash: this.preciousOnTrash,
      preciousOnSerious: this.preciousOnSerious,
    };
  }
}
