/**
 * Who is against the party, and what the party has worked out.
 *
 * The one panel on this page that deliberately knows more than anybody in the
 * run. The page is a pure reader and cannot change a simulation, so naming the
 * traitors to the audience is free — and it is the entire appeal of the
 * mechanic: you watch four characters reason about something you already know,
 * and the interest is in whether they get there. `scene.scouted` makes the same
 * argument one level down, showing the rogue's private report while the party
 * is still waiting to be told.
 *
 * Three things, in the order they answer a viewer's questions:
 *
 * - **the cast**, with the parts marked, so the whole panel is readable at a
 *   glance and every later row can be scored against it;
 * - **murmurs**, the count of private conversations last round, because that is
 *   the one signal the party *can* see and it is the cheapest tell in the game
 *   — a spike in whispering the round before a bad decision is the sort of thing
 *   an audience notices and a party does not;
 * - **the accusations**, right or wrong, because on the roughly three seeds in
 *   ten that roll nobody at all every single one of them is wrong, and watching
 *   a party convince itself of something untrue is the control arm doing its
 *   job.
 *
 * When the layer is off the panel says so and takes no space. It must never
 * appear during an ordinary `descent` run, where there is nothing to know.
 */

import { mark } from "./marks.js";
import { onSpoilerChange, revealState } from "./reveal.js";
import type { Renderer, Scene } from "./types.js";

const CLASS_COLOUR: Record<string, string> = {
  guardian: "var(--guardian)",
  mage: "var(--mage)",
  rogue: "var(--rogue)",
  cleric: "var(--cleric)",
  ranger: "var(--ranger)",
};

const CSS = `
.bet { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.bet-off { font: 13px/1.4 var(--sans); color: var(--faint); }

/* The cast, with the parts marked. A grid rather than a list so the two columns
   — who they are, whose side they are on — line up and can be scanned down. */
.bet-cast { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
.bet-who {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 7px;
  padding: 4px 4px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
}
.bet-who:first-child { border-top: none; }
.bet-who.gone { opacity: .4; }
.bet-who.against { background: color-mix(in srgb, var(--flame) 8%, transparent); }
.bet-name { font: 13px/1.25 var(--sans); overflow-wrap: anywhere; }
.bet-name i { font: 11px/1 var(--mono); letter-spacing: .06em; color: var(--faint); font-style: normal; }
.bet-part { font: 700 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.bet-part.against {
  color: var(--flame); border: 1px solid var(--flame-dim); border-radius: 2px; padding: 3px 5px;
  background: color-mix(in srgb, var(--flame) 10%, transparent);
}
.bet-part.with { color: var(--faint); padding: 3px 5px; }

/* Nobody is against them. Said plainly, because "no badges" and "the layer is
   off" would otherwise draw identically, and they are opposite facts. */
.bet-none {
  flex: 0 0 auto; padding: 5px 7px; border: 1px solid var(--line); border-radius: 3px;
  font: 12px/1.35 var(--sans); color: var(--dim);
}

.bet-murmur { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
.bet-murmur b { font: 800 15px/1 var(--mono); color: var(--arcane); font-variant-numeric: tabular-nums; }
.bet-murmur span { font: 12px/1.3 var(--sans); color: var(--dim); }
.bet-murmur .mark { color: var(--arcane); }

.bet-charges { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.bet-charge {
  padding: 5px 4px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  display: flex; flex-direction: column; gap: 2px;
}
.bet-charge:first-child { border-top: none; }
.bet-charge-head { display: flex; align-items: baseline; gap: 6px; font: 12px/1.2 var(--mono); }
.bet-charge-head .at { margin-left: auto; color: var(--faint); font-variant-numeric: tabular-nums; }
.bet-charge-why { font: 12px/1.4 var(--sans); color: var(--dim); overflow-wrap: anywhere; }
/* Right and wrong are the whole point of the row, so they are the loudest thing
   in it — and "wrong" is the common case by design. */
.bet-verdict { font: 700 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
.bet-verdict.right { color: var(--flame); }
.bet-verdict.wrong { color: var(--faint); }
.bet-quiet { font: 12px/1.4 var(--sans); color: var(--faint); }

/*
 * The private half. Everything in the social layer is known to exactly two
 * people, so without this the page renders four characters slowly turning on
 * each other for no visible reason. It is the one part of the screen where the
 * viewer knows more than everybody in the dungeon.
 */
.bet-secrets { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.bet-secrets h4 { margin: 0 0 2px; font: 600 10px/1 var(--sans); letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint); }
.bet-secret { display: flex; align-items: baseline; gap: 6px; font: 12px/1.5 var(--sans); }
.bet-secret .verb { color: var(--faint); }
.bet-secret .said { font-weight: 600; }
.bet-secret .said.dirty { color: var(--bad, #d4623c); }
.bet-secret .said.clean { color: var(--good, #4a8f6a); }
.bet-secret .at { margin-left: auto; font: 10px/1 var(--mono); color: var(--faint); }
`;

function ensureStyles(): void {
  if (document.getElementById("bet-css")) return;
  const tag = document.createElement("style");
  tag.id = "bet-css";
  tag.textContent = CSS;
  document.head.append(tag);
}

function el(tag: string, className?: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Is there anything here at all? Also what the director asks before cutting to it. */
export function hasBetrayal(scene: Scene | null | undefined): boolean {
  return Boolean(scene?.betrayal);
}

export function mountBetrayal(host: HTMLElement): Renderer {
  ensureStyles();
  const root = el("div", "bet");
  const cast = el("div", "bet-cast");
  const none = el("div", "bet-none");
  const murmur = el("div", "bet-murmur");
  const charges = el("div", "bet-charges");
  const secrets = el("div", "bet-secrets");
  root.append(cast, none, murmur, secrets, charges);
  const off = el("div", "bet-off", "Nobody here has a second objective. This run is the plain descent.");
  host.append(root, off);

  let drawn = "";
  // A toggle flipped between two polls must repaint now, not on the next scene.
  onSpoilerChange(() => {
    drawn = "";
  });

  return function render(state) {
    const scene = state.scene ?? null;
    const betrayal = scene?.betrayal ?? null;
    root.style.display = betrayal ? "" : "none";
    off.style.display = betrayal ? "none" : "";
    if (!betrayal) return;

    const reveal = revealState(scene);
    const key = JSON.stringify([betrayal, reveal.state, (scene?.party ?? []).map((m) => [m.id, m.dead])]);
    if (key === drawn) return;
    drawn = key;

    const against = reveal.state === "shown" ? reveal.traitors : new Set<string>();

    cast.replaceChildren();
    for (const member of scene?.party ?? []) {
      const row = el("div", `bet-who${member.dead ? " gone" : ""}`);
      // The enemy glyph, not a special one. Whose side somebody is on is the
      // only thing this row says, and the page already teaches that shape.
      row.append(mark(against.has(member.id) ? "enemy" : "character", "mark sm"));
      if (against.has(member.id)) row.classList.add("against");
      const name = el("div", "bet-name");
      name.append(el("span", null, member.identity?.displayName ?? member.id), el("i", null, ` ${member.id}`));
      name.style.color = CLASS_COLOUR[member.id] ?? "var(--ink)";
      row.append(name);
      const partKnown = reveal.state === "shown" || reveal.state === "none";
      row.append(
        against.has(member.id)
          ? el("span", "bet-part against", "against")
          : el("span", "bet-part with", member.dead ? "lost" : partKnown ? "with" : "—"),
      );
      cast.append(row);
    }

    /*
     * Three ways to have no badges, and they mean different things.
     *
     * "nobody rolled" is a fact about the run; "hidden" is a fact about this
     * viewer; "concealed" is a fact about the trace. Drawing all three as an
     * empty cast would state the first one — confidently, and often falsely —
     * over a run with two traitors in it.
     */
    const NOTE: Record<string, string> = {
      none:
        "This seed rolled nobody. Every suspicion below is wrong by construction — " +
        "which is what makes these runs the control arm.",
      hidden: "Parts hidden at your request. The trace knows; this page is not saying. Toggle it in the header.",
      concealed:
        "This run was recorded with `revealTraitors: false`, so the answer is not in the trace. " +
        "Nothing on this page can reveal it.",
    };
    const note = NOTE[reveal.state];
    none.style.display = note ? "" : "none";
    if (note) none.textContent = note;

    murmur.replaceChildren(
      mark("think", "mark sm"),
      el("b", null, String(betrayal.murmurs)),
      el(
        "span",
        null,
        betrayal.murmurs === 1
          ? "thing said out of earshot last round — the party can see the count and nothing else"
          : "things said out of earshot last round — the party can see the count and nothing else",
      ),
    );

    /*
     * What was done in private, and what it said.
     *
     * Concealed traces carry an empty list, so this section simply does not
     * appear — the same rule the cast badges follow. `said` is rendered as the
     * *instrument's answer*, never as the truth: a read that says "hiding
     * something" about a loyal character is drawn exactly as one that says it
     * about a traitor, because the interesting thing on screen is the gap
     * between what somebody was told and what they then announce.
     */
    secrets.replaceChildren();
    const used = betrayal.instruments ?? [];
    if (used.length > 0) {
      secrets.append(el("h4", null, "In private"));
      const VERB: Record<string, string> = {
        read: "read",
        draught: "drank a draught on",
        poison: "poisoned",
        vigil: "kept a vigil over",
        tally: "read the signs",
        reckoning: "called a reckoning",
      };
      for (const act of used.slice(-8).reverse()) {
        const row = el("div", "bet-secret");
        const by = el("span", null, act.by);
        by.style.color = CLASS_COLOUR[act.by] ?? "var(--ink)";
        row.append(by, el("span", "verb", VERB[act.kind] ?? act.kind));
        if (act.target) {
          const at = el("span", null, act.target);
          at.style.color = CLASS_COLOUR[act.target] ?? "var(--ink)";
          row.append(at);
        }
        if (act.verdict !== undefined) {
          row.append(
            el("span", "verb", "—"),
            el("span", `said ${act.verdict ? "dirty" : "clean"}`, act.verdict ? "against us" : "with us"),
          );
        }
        row.append(el("span", "at", `r${act.tick}`));
        secrets.append(row);
      }
    }

    charges.replaceChildren();
    if (betrayal.accusations.length === 0) {
      charges.append(el("div", "bet-quiet", "Nobody has said anything out loud yet."));
      return;
    }
    for (const charge of [...betrayal.accusations].reverse()) {
      const row = el("div", "bet-charge");
      const head = el("div", "bet-charge-head");
      const by = el("span", null, charge.by);
      by.style.color = CLASS_COLOUR[charge.by] ?? "var(--ink)";
      const at = el("span", null, charge.target);
      at.style.color = CLASS_COLOUR[charge.target] ?? "var(--ink)";
      const known = reveal.state === "shown" || reveal.state === "none";
      const right = against.has(charge.target);
      head.append(by, el("span", null, "→"), at);
      // No verdict when the page is not being told the answer. A grey "wrong"
      // next to every accusation would be a claim, and on a concealed trace it
      // would be a false one.
      if (known) head.append(el("span", `bet-verdict ${right ? "right" : "wrong"}`, right ? "right" : "wrong"));
      head.append(el("span", "at", `r${charge.tick}`));
      row.append(head, el("div", "bet-charge-why", charge.why));
      charges.append(row);
    }
  };
}
