/**
 * Who cuts to what, and when.
 *
 * There is far more to show than fits on a screen: a map, a scoreboard, a
 * transcript, a milestone ladder, the party channel. The obvious answers are
 * both bad. Showing everything at once produces a wall of small boxes nobody
 * can read at broadcast size; showing a fixed subset throws most of the run
 * away.
 *
 * So the rotating slots have a director, and it works the way a live gallery
 * does rather than the way a slideshow does:
 *
 *   1. A **base rotation** keeps things moving when nothing much is happening,
 *      so a quiet stretch still cycles the map, the records and the ladder.
 *   2. An **interrupt** cuts immediately to the panel that has just become the
 *      most interesting thing — a fresh burst of party chatter, a record being
 *      broken, the run ending.
 *   3. A **dwell** protects every cut. Nothing may be replaced for a few
 *      seconds after it appears, so a run of events cannot make the page
 *      strobe. This is the rule that separates a director from a bug.
 *
 * The stage is deliberately not in here. It never rotates away — a viewer needs
 * one thing on screen that is always the same thing, or there is nothing to
 * come back to.
 */

/** How long a panel holds when nothing is competing for the slot. */
import { hasSpoils } from "./spoils.js";
import type { BroadcastState, Renderer } from "./types.js";

/** Which column a panel can appear in. */
type Side = "left" | "right";

/** One rotating column, and what it is currently showing. */
interface Seat {
  side: Side;
  el: HTMLElement;
  order: string[];
  index: number;
  since: number;
  claim: string | null;
  claimUntil: number;
}

const ROTATE_MS = 14_000;

/** Nothing may be cut away for this long after it appears. Anti-strobe. */
const DWELL_MS = 6_000;

/** How long an interrupt keeps its claim before the base rotation resumes. */
const CLAIM_MS = 12_000;

/**
 * What each slot can show, in the order the base rotation walks them.
 *
 * `map` first on the left and `chat` first on the right because those are the
 * two panels that make sense with no prior context — a viewer who has just
 * arrived should land on where the party is and what they are saying, not on a
 * milestone ladder whose ids mean nothing yet.
 */
const ORDER: Record<Side, string[]> = {
  // Two panels, and both of them are context rather than news. The map left
  // this rotation and took a permanent box above it, because "where are they
  // and what is left of this floor" is a question a viewer has continuously,
  // not once every fourteen seconds. The log left it in the other direction —
  // it merged into Activity on the right, where it belongs next to the talk it
  // is the consequence of.
  left: ["spoils", "records", "progress"],
  // The right column does not rotate. Commentary and Activity both hold their
  // place: losing the party mid-argument to a progress panel is the worst trade
  // on the page, because the negotiation *is* the show.
  right: [],
};

function show(slot: HTMLElement, name: string): boolean {
  let found = false;
  for (const panel of slot.querySelectorAll<HTMLElement>("[data-panel]")) {
    const on = panel.dataset.panel === name;
    panel.classList.toggle("on", on);
    if (on) found = true;
  }
  return found;
}

export function mountDirector(slots: Partial<Record<Side, HTMLElement | null>>): Renderer {
  const live = Object.entries(slots).filter((entry): entry is [Side, HTMLElement] => !!entry[1]);
  if (!live.length) return () => {};

  const desk: Seat[] = live.map(([side, el]) => ({
    side,
    el,
    order: ORDER[side] ?? [],
    index: 0,
    /** When the current panel appeared. Nothing may replace it before dwell. */
    since: 0,
    /** An interrupt's claim on this slot, and when it expires. */
    claim: null as string | null,
    claimUntil: 0,
  }));

  for (const seat of desk) {
    show(seat.el, seat.order[0]);
    seat.since = performance.now();
  }

  /**
   * Ask for a panel. Honoured only if the current one has had its dwell.
   *
   * Returning rather than queueing on a rejected cut is deliberate: an
   * interrupt that arrives during a dwell has usually stopped being urgent by
   * the time the dwell ends, and a queue of stale cuts is how a director
   * becomes a slideshow that is always a few seconds behind the run.
   */
  function request(side: Side, name: string, now: number): void {
    const seat = desk.find((s) => s.side === side);
    if (!seat || !seat.order.includes(name)) return;
    if (now - seat.since < DWELL_MS) return;
    if (!show(seat.el, name)) return;
    seat.index = Math.max(0, seat.order.indexOf(name));
    seat.since = now;
    seat.claim = name;
    seat.claimUntil = now + CLAIM_MS;
  }

  // What the last frame saw, so "new" can mean new rather than "still present".
  let seenSaid = 0;
  let seenRound = 0;
  let seenEnded = false;
  let seenRecord = false;
  let seenSpoils = false;

  /**
   * Read the run and decide whether anything deserves a cut.
   *
   * Ordered by how much a viewer would regret missing it: the end of a run is
   * unmissable, a record falling is the reason to have a scoreboard at all, and
   * the party arguing about which way to go is the most watchable thing that
   * happens in an ordinary round.
   */
  function consider(state: BroadcastState, now: number): void {
    if (state.ended && !seenEnded) {
      seenEnded = true;
      request("left", "records", now);
      return;
    }

    // A cache or a merchant is the one thing on the left that is *news*: it
    // appears, it is a decision with a hard cap, and it is gone in a few
    // rounds. Everything else over there is standing context, so this is the
    // only interrupt the column has.
    const spoils = hasSpoils(state.scene);
    if (spoils && !seenSpoils) {
      seenSpoils = true;
      request("left", "spoils", now);
      return;
    }
    if (!spoils) seenSpoils = false;

    const best = state.history?.best?.score ?? null;
    const earned = state.scene?.earnedXp ?? 0;
    if (best !== null && earned > best && !seenRecord) {
      seenRecord = true;
      request("left", "records", now);
      return;
    }

    // Nothing interrupts for talk any more: Activity is permanent, so a burst
    // of chatter is already on screen and cutting to it would be cutting to
    // where the viewer is looking. The round counter is still tracked because
    // `seenSaid` is what makes "new" mean new for anything added later.
    const said = state.said?.length ?? 0;
    if (state.roundVersion !== seenRound) {
      seenRound = state.roundVersion;
    }
    seenSaid = said;
  }

  let last = performance.now();
  function frame() {
    const now = performance.now();
    if (now - last >= 250) {
      last = now;
      for (const seat of desk) {
        // A claim outlives its interrupt, then the rotation takes over again.
        if (seat.claim && now > seat.claimUntil) seat.claim = null;
        if (seat.claim) continue;
        if (now - seat.since < ROTATE_MS) continue;
        seat.index = (seat.index + 1) % Math.max(1, seat.order.length);
        show(seat.el, seat.order[seat.index]);
        seat.since = now;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // The director is a renderer like any other: it is handed the state and
  // decides, rather than reaching into the store and subscribing itself.
  return function render(state: BroadcastState): void {
    consider(state, performance.now());
  };
}
