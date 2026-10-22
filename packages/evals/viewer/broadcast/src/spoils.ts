/**
 * The two moments the party has to agree, and the page could not see either.
 *
 * A dead expedition's pack offers six things and lets the party carry out two.
 * The outfitter's stock is shared, seeded, and priced above what any one purse
 * holds. Those are the scenario's two set-piece negotiations — the whole reason
 * five agents are cheaper to distinguish here than one — and `scene.cache`,
 * `scene.cacheTakesLeft` and `scene.stock` all crossed the contract and were
 * rendered *nowhere*. The stage drew a cache room; the HUD counted the stock
 * into a single number. Neither said what was in it, who could use it, who had
 * taken what, or how many takes were left.
 *
 * So a viewer watching the party argue about a cuirass had no way to know there
 * was a cuirass, and the run's most-discussed decision looked from the outside
 * like five people talking about nothing.
 *
 * Two facts this panel states that nobody has to work out:
 *
 * - **takes left**, as a count and as pips, because it is a hard cap and the
 *   thing the party is really dividing;
 * - **"no single purse"**, computed against the five gold totals, because that
 *   is precisely the condition `give_gold` exists for and the party misses it
 *   about as often as it finds it.
 */

import { itemCategory, mark } from "./marks.js";
import type { Renderer, Scene } from "./types.js";

const CLASS_COLOUR: Record<string, string> = {
  guardian: "var(--guardian)",
  mage: "var(--mage)",
  rogue: "var(--rogue)",
  cleric: "var(--cleric)",
  ranger: "var(--ranger)",
};

const CSS = `
.spoil { display: flex; flex-direction: column; gap: 7px; height: 100%; min-height: 0; }
.spoil-head { display: flex; align-items: baseline; gap: 8px; flex: 0 0 auto; }
.spoil-what {
  font: 700 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--flame);
}
.spoil-from { font: 12px/1.3 var(--sans); color: var(--dim); min-width: 0; overflow-wrap: anywhere; }

/* The cap, as a number and as pips. A count alone reads as a score; pips read
   as a thing running out, which is what it is. */
.spoil-takes { margin-left: auto; display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
.spoil-takes b { font: 800 15px/1 var(--mono); color: var(--ink); font-variant-numeric: tabular-nums; }
.spoil-takes i { width: 7px; height: 7px; border: 1px solid var(--gold); border-radius: 1px; }
.spoil-takes i.gone { border-color: var(--faint); background: none; opacity: .45; }
.spoil-takes i.left { background: var(--gold); }

.spoil-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.spoil-row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: baseline; gap: 7px;
  padding: 5px 4px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
}
.spoil-row:first-child { border-top: none; }
.spoil-row.taken { opacity: .45; }
.spoil-row .mark { align-self: center; }
.spoil-name { font: 13px/1.25 var(--sans); color: var(--ink); overflow-wrap: anywhere; }
.spoil-name .rar { font: 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.spoil-name .rar.rare, .spoil-name .rar.epic { color: var(--arcane); }

/* Who it is for, in their own colour. Five names is more legible than a
   sentence, and colour means a viewer can match a row to a party card. */
.spoil-for { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.spoil-for span { font: 11px/1 var(--mono); letter-spacing: .04em; }
.spoil-price { font: 13px/1 var(--mono); color: var(--gold); font-variant-numeric: tabular-nums; text-align: right; }
.spoil-took { font: 11px/1.2 var(--mono); text-align: right; }
.spoil-took.free { color: var(--faint); }

/* The line that names the mechanic. Deliberately loud: it is the one condition
   the whole give_gold tool exists for. */
.spoil-pool {
  flex: 0 0 auto; padding: 5px 7px; border: 1px solid var(--flame-dim); border-radius: 3px;
  font: 12px/1.3 var(--sans); color: var(--flame); background: color-mix(in srgb, var(--flame) 7%, transparent);
}
.spoil-off { font: 13px/1.4 var(--sans); color: var(--faint); }
`;

function ensureStyles(): void {
  if (document.getElementById("spoil-css")) return;
  const tag = document.createElement("style");
  tag.id = "spoil-css";
  tag.textContent = CSS;
  document.head.append(tag);
}

function el(tag: string, className?: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Is this worth showing at all? Also what the director asks before cutting to it. */
export function hasSpoils(scene: Scene | null | undefined): boolean {
  return Boolean((scene?.cache?.length ?? 0) > 0 || (scene?.stock?.length ?? 0) > 0);
}

export function mountSpoils(host: HTMLElement): Renderer {
  ensureStyles();
  const root = el("div", "spoil");
  const head = el("div", "spoil-head");
  const what = el("span", "spoil-what", "");
  const from = el("span", "spoil-from", "");
  const takes = el("div", "spoil-takes");
  head.append(what, from, takes);
  const list = el("div", "spoil-list");
  const pool = el("div", "spoil-pool");
  const off = el("div", "spoil-off", "Nothing to divide. The spoils show at a cache or a merchant.");
  root.append(head, list, pool);
  host.append(root, off);

  /** What was drawn last, so a poll that changed nothing does not rebuild the list. */
  let drawn = "";

  return function render(state) {
    const scene = state.scene ?? null;
    const cache = scene?.cache ?? [];
    const stock = scene?.stock ?? [];
    const showing = cache.length > 0 ? "cache" : stock.length > 0 ? "stock" : "none";
    const purses = (scene?.party ?? []).filter((member) => !member.dead).map((member) => member.gold ?? 0);
    const richest = purses.length ? Math.max(...purses) : 0;
    const together = purses.reduce((sum, gold) => sum + gold, 0);

    const key = JSON.stringify([showing, cache, stock, scene?.cacheTakesLeft, scene?.cacheOrigin, richest, together]);
    if (key === drawn) return;
    drawn = key;

    root.style.display = showing === "none" ? "none" : "";
    off.style.display = showing === "none" ? "" : "none";
    if (showing === "none") return;

    list.replaceChildren();
    takes.replaceChildren();
    pool.style.display = "none";

    if (showing === "cache") {
      what.textContent = "Dead expedition";
      from.textContent = scene?.cacheOrigin ? `${scene.cacheOrigin} got this far` : "";
      const left = Math.max(0, scene?.cacheTakesLeft ?? 0);
      const claimed = cache.filter((item) => item.taken).length;
      takes.append(el("b", null, String(left)));
      for (let i = 0; i < left + claimed; i++) takes.append(el("i", i < left ? "left" : "gone"));
      takes.append(el("span", "spoil-what", left === 1 ? "take left" : "takes left"));

      for (const item of cache) {
        const row = el("div", `spoil-row${item.taken ? " taken" : ""}`);
        row.append(mark(itemCategory(item), "mark sm"));
        const name = el("div", "spoil-name");
        name.append(el("span", null, item.name), el("span", `rar ${item.rarity}`, ` ${item.rarity}`));
        const forWho = el("div", "spoil-for");
        for (const id of item.forClasses ?? []) {
          const chip = el("span", null, id);
          chip.style.color = CLASS_COLOUR[id] ?? "var(--dim)";
          forWho.append(chip);
        }
        if ((item.forClasses ?? []).length) name.append(forWho);
        row.append(name);
        const took = el("div", item.taken ? "spoil-took" : "spoil-took free", item.taken ?? "unclaimed");
        if (item.taken) took.style.color = CLASS_COLOUR[item.taken] ?? "var(--dim)";
        row.append(took);
        list.append(row);
      }
      return;
    }

    what.textContent = "The outfitter";
    from.textContent = "";
    let anyPooled = 0;
    for (const item of stock) {
      const row = el("div", "spoil-row");
      row.append(mark(itemCategory(item), "mark sm"));
      const name = el("div", "spoil-name");
      name.append(el("span", null, item.name), el("span", `rar ${item.rarity}`, ` ${item.rarity}`));
      row.append(name);
      const price = el("div", "spoil-price", `${item.price}g`);
      if (item.price > richest) {
        price.style.color = "var(--flame)";
        anyPooled += 1;
      }
      row.append(price);
      list.append(row);
    }
    if (anyPooled > 0) {
      pool.style.display = "";
      pool.textContent =
        `${anyPooled} of these cost more than anybody is carrying. ` +
        `The five purses hold ${together} between them.`;
    }
  };
}
