/**
 * What each instrument is called, and what kind of thing it is.
 *
 * Split out of `feed.ts` because it is data, and because `feed.ts` reads
 * `window` at module load — so nothing in Node could import it to check the
 * table against the simulation's actual tool list. Four tools were missing at
 * once before anything noticed, and the fallback renderer is deliberately
 * forgiving enough that nothing ever failed.
 */

import type { MarkName } from "./marks.js";

/**
 * One sentence per instrument, in the present tense a commentator would use.
 *
 * Placeholders are filled from the call's own arguments; `{target}` and
 * `{item}` go through the name lexicon below, so `attack target=husk-1` reads
 * "attacks Ash Husk" rather than making a viewer learn the simulation's ref
 * scheme. A tool missing from this table still renders — see `describeCall` —
 * because the bestiary and the ability list are still being balanced and a new
 * ability should degrade to a dull line, not to a blank one.
 *
 * Typed open (`string` keys, a possibly-absent value) for that reason: the tool
 * name arrives from the trace, and a table that claimed to hold every one of
 * them would make the fallback below look like dead code.
 */
export const PHRASES: Record<string, string | undefined> = {
  // Shared instruments.
  attack: "attacks {target}",
  defend: "raises a guard",
  inspect_enemy: "sizes up {target}",
  use_item: "uses {item} on {target}",
  equip_item: "puts on {item}",
  trade_item: "hands {item} to {to}",
  give_gold: "gives {amount} gold to {to}",
  // The batch call is a wrapper, not a deed: whatever it did arrives as the
  // individual tool calls it dispatched, each of which already has a sentence.
  // What is worth drawing is the part only this tool carries — the character
  // saying what it is about to do.
  execute_actions: "commits to a plan",
  buy: "buys {item}",
  sell: "sells {item}",
  take: "takes {item} from the packs",
  unequip: "takes off what was in the {slot} slot",
  choose_path: "picks the {path} way",
  unlock_route: "spends a floor key on the way to {path}",
  // The consequential-route actions, every one of which fell through to the
  // generic renderer and drew as flat grey text at the weight of a `look`. A
  // two-hundred-gold toll is one of the largest commitments a party makes in a
  // run and it read as background chatter.
  pay_toll: "pays the gate to open the {path} way",
  pick_lock: "picks the lock on the {path} way",
  breach_route: "breaks down the door to {path}",
  disarm_trap: "disarms the trap on the {path} way",
  // The consequential-route actions, every one of which fell through to the
  // generic renderer and drew as flat grey text at the weight of a `look`. A
  // two-hundred-gold toll is one of the largest commitments a party makes in a
  // run and it read as background chatter.
  enter_dungeon: "calls for the first stair",
  continue_exploring: "turns back to the floor map",
  descend: "calls for the descent",
  retreat: "calls the retreat",
  invest_skill: "spends a point on {skill}",
  revive: "brings {ally} back",
  rest: "calls a halt to rest",
  choose_name: "chooses the name {name}",
  reveal_goal: "reveals a private motive",

  // Guardian.
  taunt: "roars for their attention",
  shield: "shields {target}",
  shield_slam: "slams {target}",

  // Mage.
  firebolt: "hurls a firebolt at {target}",
  frostbite: "freezes {target}",
  lightning: "calls lightning down on {target}",
  fireball: "throws a fireball into all of them",

  // Rogue.
  backstab: "backstabs {target}",
  interrupt: "interrupts {target}",
  sleep_powder: "puts {target} to sleep",
  vanish: "slips out of sight",
  scout: "scouts the ways ahead",

  // Cleric.
  heal: "heals {target}",
  cleanse: "cleanses {target}",
  bless: "blesses {target}",
  sanctuary: "raises a sanctuary over the party",

  // Ranger.
  shoot: "shoots {target}",
  mark: "marks {target}",
  volley: "looses a volley",
  read_beast: "reads {target}'s habits",
};

export type Stripe =
  | "combat"
  | "support"
  | "consumable"
  | "gear"
  | "trade"
  | "move"
  | "retreat"
  | "growth"
  | "scout"
  | "speech"
  | "quiet";

const TOOL_STRIPE: Record<string, Stripe | undefined> = {
  attack: "combat",
  backstab: "combat",
  shield_slam: "combat",
  firebolt: "combat",
  fireball: "combat",
  lightning: "combat",
  frostbite: "combat",
  shoot: "combat",
  volley: "combat",
  interrupt: "combat",
  sleep_powder: "combat",
  mark: "combat",

  defend: "support",
  shield: "support",
  taunt: "support",
  heal: "support",
  bless: "support",
  cleanse: "support",
  sanctuary: "support",
  revive: "support",
  rest: "support",
  vanish: "support",

  use_item: "consumable",
  equip_item: "gear",
  unequip: "gear",

  trade_item: "trade",
  give_gold: "trade",
  execute_actions: "speech",
  buy: "trade",
  sell: "trade",
  take: "trade",

  choose_path: "move",
  unlock_route: "move",
  enter_dungeon: "move",
  continue_exploring: "move",
  descend: "move",
  retreat: "retreat",

  // A toll is bought, not walked through — it is the one route action that
  // costs the party something it could have spent elsewhere.
  pay_toll: "trade",
  pick_lock: "move",
  breach_route: "move",
  disarm_trap: "support",

  invest_skill: "growth",

  inspect_enemy: "scout",
  read_beast: "scout",
  scout: "scout",

  choose_name: "speech",
  reveal_goal: "speech",
  room: "speech",
};

function toolStripe(tool: string): Stripe {
  return (Object.hasOwn(TOOL_STRIPE, tool) ? TOOL_STRIPE[tool] : undefined) ?? "quiet";
}

/**
 * Does this tool have a sentence of its own, or does it fall through to the
 * generic "tool name, arguments" renderer?
 *
 * Exported for the test that walks every tool the simulation registers. Four
 * had been missing at once — `pay_toll`, `pick_lock`, `breach_route`,
 * `disarm_trap`, the whole consequential-route family — and each drew as flat
 * grey text at the visual weight of a `look`. Nothing failed; the page just
 * quietly under-reported the most expensive decisions in the run.
 */
export function isPhrased(tool: string): boolean {
  return typeof PHRASES[tool] === "string";
}

/** The stripe a tool draws under, for the same test. */
export function stripeFor(tool: string): Stripe {
  return toolStripe(tool);
}
