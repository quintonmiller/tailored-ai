/**
 * The entry point: mount everything, then let the store drive.
 *
 * Lifted out of a `<script type="module">` in `index.html` when the viewer moved
 * to TypeScript. The page is now a bundle, so the shell is markup and nothing
 * else — which is worth the move on its own: an inline script is the one part of
 * a page that no compiler, linter or formatter ever looks at.
 *
 * Every module is mounted the same way and each is allowed to fail alone. A
 * broadcast with a broken map is still a broadcast, and a renderer that throws
 * on one frame must not take the poll loop with it.
 */

import { mountBetrayal } from "./betrayal.js";
import { mountSpoilerToggle } from "./reveal.js";
import { mountDirector } from "./director.js";
import { mountFeed } from "./feed.js";
import { mountHud } from "./hud.js";
import { mountRecords } from "./records.js";
import { mountRibbon } from "./ribbon.js";
import { mountSpoils } from "./spoils.js";
import { mountStage } from "./stage.js";
import { onChange, start } from "./state.js";
import type { BroadcastState, Renderer } from "./types.js";

/** Required, and a missing one is a broken shell rather than a runtime maybe. */
function need(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the page is missing #${id}`);
  return el;
}

const renderers: Array<[string, Renderer]> = [];

/** Mount one module, and keep going if it throws. */
function mount(name: string, fn: () => Renderer): void {
  try {
    renderers.push([name, fn()]);
  } catch (err) {
    console.error(`${name} failed to mount`, err);
  }
}

mount("stage", () => mountStage(need("stage")));
mount("hud", () => mountHud({ party: need("party"), map: need("map"), progress: need("progress") }));
mount("feed", () => mountFeed({ activity: need("activity"), narration: need("narration") }));
mount("ribbon", () => mountRibbon(need("ribbon")));
mount("records", () => mountRecords(need("records")));
mount("spoils", () => mountSpoils(need("spoils")));
mount("betrayal", () => mountBetrayal(need("betrayal")));
// The header switch. Returns a renderer like everything else, so it hides
// itself on a run that has nothing to spoil.
mount("spoilers", () => {
  const update = mountSpoilerToggle(need("spoilers"));
  return (s) => update(s.scene);
});
mount("director", () =>
  mountDirector({
    left: document.getElementById("slot-left"),
  }),
);

const facts = need("facts");
const status = need("status");

/**
 * The one line above everything else.
 *
 * Deliberately the only place the page states a number without a panel around
 * it: a viewer glancing at a stream for three seconds should get the floor, the
 * round and how many of the five are still standing, and nothing else.
 */
function header(s: BroadcastState): void {
  const scene = s.scene;
  const bits: string[] = [];
  if (scene) {
    bits.push(`floor <b>${scene.floor}</b>`);
    bits.push(`round <b>${s.round}</b>${s.rounds ? ` of ${s.rounds}` : ""}`);
    bits.push(`<b>${scene.party.filter((p) => !p.dead).length}</b> standing`);
    bits.push(`<b>${scene.earnedXp.toLocaleString()}</b> earned`);
    // Dread, always, and lit once it is doing something.
    //
    // It used to appear here only past a threshold and otherwise live in the
    // map panel, which rotates away — so the pressure clock that decides
    // ambushes and reinforcement counts was invisible most of the time. A
    // number that only appears when it is already bad cannot be watched
    // climbing, and watching it climb is the point.
    const dread = `dread <b>${scene.dread}</b>`;
    bits.push(scene.dread >= 4 ? `<span style="color:var(--bad)">${dread}</span>` : dread);
    // The score to beat, so a figure on screen means something to somebody who
    // arrived thirty seconds ago.
    const best = s.history?.best?.score;
    if (typeof best === "number" && best > 0) {
      const beaten = scene.earnedXp > best;
      bits.push(
        beaten
          ? `<span style="color:var(--good)">record <b>broken</b></span>`
          : `best <b>${best.toLocaleString()}</b>`,
      );
    }
  }
  if (s.run?.model) bits.push(escape(s.run.model));
  facts.innerHTML = bits.join("<span style='color:var(--faint)'>·</span> ");

  status.className = `pill ${s.ended ? "done" : s.live ? "live" : ""}`;
  status.textContent = s.ended ? "run over" : s.live ? "live" : "waiting";
}

/**
 * The model id is the only header field that comes from outside this repo.
 *
 * Everything else in that line is a number the simulation produced, but a model
 * id is a string from a config file, and the header is the one place on the
 * page that writes `innerHTML` — it needs the bold tags. So that field, and only
 * that field, is escaped before it goes in.
 */
function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

onChange((s) => {
  try {
    header(s);
  } catch (err) {
    console.error("header failed", err);
  }
  for (const [name, render] of renderers) {
    try {
      render(s);
    } catch (err) {
      console.error(`${name} render failed`, err);
    }
  }
});

start();
