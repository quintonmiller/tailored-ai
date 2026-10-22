/**
 * The events the trace records but never announces.
 *
 * A tool call is an *intention* — `choose_path` says a party member would like
 * to go somewhere, and the round may close without it happening. The things a
 * viewer actually wants marked are the ones that did happen: the party moved,
 * the party broke off and something got a free swing on the way out, a sword
 * went to the rogue, the cleric put on a robe, everybody levelled, the guardian
 * spent a point. None of those has an event of its own anywhere in the trace.
 * All of them are visible as a *difference between two scenes*, and a scene is
 * the simulation's own authoritative record of where things stood.
 *
 * So this module is a diff and nothing else. It reads two scenes and reports
 * what changed, in the simulation's own terms. It invents nothing: every
 * sentence below is built out of a field that moved.
 *
 * ## Two traps, both of which bit somebody already
 *
 * The harness writes a `state` event after every **turn**, so one round of five
 * agents publishes five scenes carrying identical `beats`. Anything derived
 * from beats must therefore key on `beatsTick` — hence `beatTallies` taking the
 * tick and the callers holding a `seen` set. Party state, unlike beats, really
 * does change between turns (an out-of-combat potion lands the moment the tool
 * is called), so the per-member diffs below are correct on every scene.
 *
 * And old traces are missing newer fields. Everything here reads through
 * optional access and a default, because the alternative is a page that throws
 * on a run recorded last week.
 *
 * Pure: no DOM, no imports beyond types. The tests import it directly.
 */

import type { ClassId, Scene, SceneBeat, SceneItem, ScenePartyMember } from "./types.js";
import { isClassId } from "./marks.js";

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

/**
 * The kinds of thing worth its own treatment in the feed.
 *
 * Deliberately not "everything that changed": a health total moves every round
 * and the stage already draws it. These are the state changes that are
 * invisible unless somebody says them out loud.
 */
export type HappeningKind =
  | "move"
  | "descend"
  | "retreat"
  | "opportunity"
  | "kill"
  | "loot"
  | "equip"
  | "levelup"
  | "talent"
  | "nodamage"
  | "wasted";

export interface Happening {
  kind: HappeningKind;
  /** Whose line this is, when one of the five owns it. */
  who: ClassId | null;
  /** The sentence, in the simulation's own vocabulary. */
  text: string;
  /** A short qualifier — a room's kind, a reason, a rank. */
  detail: string | null;
  /**
   * The ref this line is about, when it names one.
   *
   * This module sees exactly two scenes, and the thing a kill line is about is
   * by definition gone from both of them by the time the beat lands — so it can
   * only write the ref. The renderer holds a lexicon of everything a scene has
   * ever said a ref is called, and swaps the name in. Without this a viewer
   * reads "beast-2 goes down", which is the simulation's bookkeeping rather
   * than anything that happened.
   */
  subject?: string;
  /**
   * Stable across the five scenes one round publishes.
   *
   * The caller keeps a set of these, which is what stops a descent being
   * announced once per agent turn. Built from the thing that changed rather
   * than from a counter, so it is the same key whichever turn first saw it.
   */
  key: string;
}

// ---------------------------------------------------------------------------
// Damage, and the absence of it
// ---------------------------------------------------------------------------

/** What one round of beats did to one combatant. */
export interface BeatTally {
  /** Health lost across every hit and mechanic aimed at them. */
  damage: number;
  /** Health restored. */
  healed: number;
  /** How many blows landed on them and did nothing at all. */
  blanks: number;
  /** Why those blows did nothing, in the terms `computeDamage` allows. */
  reason: string | null;
  /** Set when their own readied action never happened, and why. */
  wasted: string | null;
  /** True once a `death` beat named them. */
  died: boolean;
}

/**
 * Why a blow landed and did nothing.
 *
 * The arithmetic in `computeDamage` is what makes this answerable rather than
 * guessed at. Damage is floored at 1 before shields, so a *physical* hit can
 * only reach zero by being swallowed whole — armour is subtracted with a floor
 * of 1, and a physical immunity comes back out of that floor as 1 rather than
 * as 0. For every other element there are exactly two ways to reach zero: a
 * resistance of ×0, or a shield with enough left in it.
 *
 * Which means the honest answer is sometimes both, and it says both. Naming one
 * mechanism when the data supports two would be the page inventing state, and a
 * viewer who learns to distrust one label distrusts the rest of them.
 */
export function zeroDamageReason(element: string | undefined, shielded: boolean): string {
  const kind = String(element ?? "physical");
  if (kind === "physical") return "the shield swallowed it";
  if (shielded) return `shielded, or immune to ${kind}`;
  return `immune to ${kind}`;
}

/** Why a readied action never happened. The simulation's own word for it. */
export function wastedReason(note: string | null | undefined): string {
  const why = String(note ?? "").trim();
  if (!why) return "the action was lost";
  return `${why} — the action was lost`;
}

/**
 * Who was carrying a shield when the round closed on them.
 *
 * Read off the scene *before* the beats resolved, which is the last publication
 * of the round that was still being readied. That is the right side of the
 * boundary: a shield raised during the resolution and consumed in the same tick
 * is not visible from either scene, which is why `zeroDamageReason` keeps the
 * ambiguous case ambiguous instead of resolving it from this.
 */
export function shieldedRefs(scene: Scene | null | undefined): Set<string> {
  const shielded = new Set<string>();
  const carries = (statuses: Array<{ kind?: string; amount?: number }> | undefined): boolean =>
    (statuses ?? []).some((s) => String(s?.kind) === "shield" && (Number(s?.amount) || 0) > 0);
  for (const member of scene?.party ?? []) if (carries(member?.statuses)) shielded.add(String(member?.id));
  for (const enemy of scene?.enemies ?? []) if (carries(enemy?.statuses)) shielded.add(String(enemy?.ref));
  return shielded;
}

/**
 * Fold a round's beats into one figure per combatant.
 *
 * Beats rather than a health diff on purpose. A health total that fell by 40
 * could be one blow or four, and could have a heal hidden inside it; the beats
 * are the record the simulation writes at the point it applies each one, so
 * they are the only place the *number a viewer saw fly off a sprite* comes
 * from. It is also the only place a zero is distinguishable from an absence.
 */
export function beatTallies(beats: readonly SceneBeat[] | undefined, shielded: Set<string>): Map<string, BeatTally> {
  const out = new Map<string, BeatTally>();
  const at = (ref: string): BeatTally => {
    let row = out.get(ref);
    if (!row) {
      row = { damage: 0, healed: 0, blanks: 0, reason: null, wasted: null, died: false };
      out.set(ref, row);
    }
    return row;
  };
  for (const beat of beats ?? []) {
    const to = String(beat?.to ?? "");
    if (!to) continue;
    const amount = Number(beat?.amount) || 0;
    switch (beat.kind) {
      case "hit":
      case "mechanic": {
        // A mana restore from an arcane well is a `mechanic` with an amount and
        // no element. Counting it as a wound would print a number in the colour
        // of damage over somebody who was just given something.
        if (beat.kind === "mechanic" && !beat.element) break;
        const row = at(to);
        if (amount > 0) row.damage += amount;
        else {
          row.blanks += 1;
          row.reason = zeroDamageReason(beat.element, shielded.has(to));
        }
        break;
      }
      case "heal":
        if (amount > 0) at(to).healed += amount;
        break;
      case "wasted":
        at(to).wasted = wastedReason(beat.note);
        break;
      case "death":
        at(to).died = true;
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

const byId = <T extends { id?: string }>(list: readonly T[] | undefined): Map<string, T> =>
  new Map((list ?? []).filter((row) => row?.id).map((row) => [String(row.id), row]));

/** A room, as the floor map holds it, once we have found the one we want. */
type Room = NonNullable<Scene["floorMap"]>["rooms"][number];

const roomsOf = (scene: Scene | null | undefined): Map<string, Room> =>
  new Map((scene?.floorMap?.rooms ?? []).map((room) => [String(room.id), room]));

/** `combat`, `market`, `boss` — what a room is, for the line that announces it. */
function roomDescription(room: Room | undefined): string | null {
  if (!room) return null;
  const bits = [String(room.kind ?? "")].filter(Boolean);
  if (room.environment?.name) bits.push(room.environment.name);
  if (room.cleared) bits.push("already cleared");
  else if (room.threat) bits.push(`${room.threat.enemies} still standing`);
  return bits.join(" · ") || null;
}

/** `Ash Husk` — the name if the item has one, the id if it does not. */
const itemName = (item: SceneItem | null | undefined): string => String(item?.name ?? item?.id ?? "something");

/**
 * Everything that changed between two scenes, as sentences.
 *
 * `before` may be null — the first scene of a run has nothing to be a
 * difference from — and every field on both sides may be missing, because a
 * trace recorded before a field existed still has to render.
 */
export function happenings(before: Scene | null | undefined, after: Scene | null | undefined): Happening[] {
  if (!after) return [];
  const out: Happening[] = [];
  const add = (h: Happening) => out.push(h);

  const floorBefore = Number(before?.floor) || 0;
  const floorAfter = Number(after.floor) || 0;

  // -- down a floor ---------------------------------------------------------
  if (before && floorAfter > floorBefore) {
    add({
      kind: "descend",
      who: null,
      text: `The party goes down to floor ${floorAfter}.`,
      detail: after.floorMap?.zone ? String(after.floorMap.zone) : null,
      key: `descend:${floorAfter}`,
    });
  }

  // -- out of one room and into another -------------------------------------
  const roomBefore = String(before?.floorMap?.currentRoom ?? "");
  const roomAfter = String(after.floorMap?.currentRoom ?? "");
  if (roomAfter && roomAfter !== roomBefore && floorAfter === floorBefore) {
    const room = roomsOf(after).get(roomAfter);
    add({
      kind: "move",
      who: null,
      text: `The party moves into ${room?.label ?? roomAfter}.`,
      detail: roomDescription(room),
      key: `move:${floorAfter}:${roomAfter}`,
    });
  }

  // -- breaking off ---------------------------------------------------------
  //
  // A retreat is only knowable from the encounter it left behind: the room
  // keeps its enemies and counts how many times the party has run from them.
  const oldRooms = roomsOf(before);
  let retreated: Room | null = null;
  for (const [id, room] of roomsOf(after)) {
    const was = Number(oldRooms.get(id)?.threat?.retreats) || 0;
    const now = Number(room.threat?.retreats) || 0;
    if (before && now > was) {
      retreated = room;
      add({
        kind: "retreat",
        who: null,
        text: `The party breaks off and falls back from ${room.label ?? id}.`,
        detail: room.threat
          ? `${room.threat.enemies} left at ${room.threat.hp}/${room.threat.maxHp} · ${now} retreat${now === 1 ? "" : "s"}`
          : null,
        key: `retreat:${floorAfter}:${id}:${now}`,
      });
    }
  }

  // -- the free swings on the way out ---------------------------------------
  //
  // Retreat empties the party's readied actions and the enemies still take
  // their turns, so on a retreat tick *every* enemy blow is an unanswered one.
  // That makes the opportunity attacks derivable without labelling anything the
  // simulation did not label: the tick is the retreat's, and the beats are the
  // beats.
  if (retreated) {
    const tick = Number(after.beatsTick) || 0;
    let total = 0;
    let swings = 0;
    for (const beat of after.beats ?? []) {
      if (beat?.kind !== "hit") continue;
      if (!isClassId(beat.to) || isClassId(beat.from)) continue;
      swings += 1;
      total += Number(beat.amount) || 0;
    }
    if (swings > 0) {
      add({
        kind: "opportunity",
        who: null,
        text: `${swings} free swing${swings === 1 ? "" : "s"} land as the party pulls out.`,
        detail: `${total} damage, unanswered`,
        key: `opportunity:${tick}`,
      });
    }
  }

  // -- the spoils, and who they went to -------------------------------------
  const oldLoot = byId(before?.loot);
  for (const drop of after.loot ?? []) {
    const id = String(drop?.id ?? "");
    if (!id || oldLoot.has(id)) continue;
    add({
      kind: "loot",
      who: isClassId(drop.to) ? drop.to : null,
      text: `${itemName(drop)} goes to ${drop.to ?? "the party"}.`,
      detail: [drop.rarity, drop.kind].filter(Boolean).join(" · ") || null,
      key: `loot:${id}`,
    });
  }

  // -- levels ---------------------------------------------------------------
  const levelBefore = Number(before?.level) || 0;
  const levelAfter = Number(after.level) || 0;
  if (before && levelAfter > levelBefore) {
    add({
      kind: "levelup",
      who: null,
      text: `The party reaches level ${levelAfter}.`,
      detail: "a skill point each",
      key: `level:${levelAfter}`,
    });
  }

  // -- per member: what they put on, and what they spent -------------------
  const was = new Map<string, ScenePartyMember>((before?.party ?? []).map((p) => [String(p?.id), p]));
  for (const member of after.party ?? []) {
    const id = String(member?.id ?? "");
    const prior = was.get(id);
    if (!prior) continue;
    const who = isClassId(id) ? id : null;

    const wornBefore = new Map((prior.worn ?? []).map((item) => [String(item.slot), item]));
    for (const item of member.worn ?? []) {
      const slot = String(item.slot);
      const old = wornBefore.get(slot);
      if (old?.id === item.id) continue;
      add({
        kind: "equip",
        who,
        text: `${id} puts on ${itemName(item)}.`,
        detail: [slot, item.rarity].filter(Boolean).join(" · ") || null,
        key: `equip:${id}:${slot}:${item.id}`,
      });
    }

    const ranks = new Map((prior.talents ?? []).map((talent) => [String(talent.id), Number(talent.rank) || 0]));
    for (const talent of member.talents ?? []) {
      const rank = Number(talent.rank) || 0;
      if (rank <= (ranks.get(String(talent.id)) ?? 0)) continue;
      add({
        kind: "talent",
        who,
        text: `${id} invests in ${talent.name ?? talent.id}.`,
        detail: `rank ${rank}`,
        key: `talent:${id}:${talent.id}:${rank}`,
      });
    }
  }

  // -- blows that did nothing ----------------------------------------------
  //
  // Only on a new beats tick, and only once: five scenes carry these.
  const tick = Number(after.beatsTick) || 0;
  if (!before || Number(before.beatsTick) !== tick) {
    const shielded = shieldedRefs(before);
    // Both scenes, because the thing that just died is the thing most likely to
    // have already been dropped from `after.enemies`.
    const named = new Map<string, string>(
      [...(before?.enemies ?? []), ...(after.enemies ?? [])].map((e) => [String(e?.ref), String(e?.name)]),
    );
    const ranked = new Map<string, string>(
      [...(before?.enemies ?? []), ...(after.enemies ?? [])].map(
        (e) => [String(e?.ref), e?.boss ? "boss" : e?.elite ? "elite" : ""] as [string, string],
      ),
    );
    for (const [ref, tally] of beatTallies(after.beats, shielded)) {
      const who = isClassId(ref) ? ref : null;
      const name = named.get(ref) ?? ref;

      // A kill was computed here and thrown away. The only record of one in the
      // log was whatever the combat prose happened to say — the same unreliable
      // channel that let an elite die unremarked in a live run, in the log and
      // in the commentary both.
      if (tally.died && !who) {
        add({
          kind: "kill",
          who: null,
          text: `${name} goes down.`,
          detail: ranked.get(ref) || null,
          subject: ref,
          key: `kill:${tick}:${ref}`,
        });
      }
      if (tally.wasted) {
        add({
          kind: "wasted",
          who,
          text: `${name} never acted.`,
          detail: tally.wasted,
          key: `wasted:${tick}:${ref}`,
        });
      }
      if (tally.blanks === 0 || tally.damage > 0 || !tally.reason) continue;
      add({
        kind: "nodamage",
        who,
        text: `${name} takes nothing${tally.blanks > 1 ? ` from ${tally.blanks} blows` : ""}.`,
        detail: tally.reason,
        key: `nodamage:${tick}:${ref}`,
      });
    }
  }

  return out;
}
