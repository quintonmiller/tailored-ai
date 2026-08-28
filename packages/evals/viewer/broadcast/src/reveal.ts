/**
 * Whether the page says out loud who is against the party.
 *
 * Two switches, at different distances, because they answer different
 * questions and only one of them is real concealment:
 *
 * - **`revealTraitors: false` on the simulation** keeps the answer out of the
 *   trace. That is the switch for a run somebody else should watch blind, or a
 *   trace you are going to hand over. Nothing on the page can undo it.
 * - **the toggle here** hides the reveal on a trace that carries it. Instant,
 *   reversible, per-viewer, survives a reload — and no protection at all, since
 *   the names are still in the file. This is the switch for *you*, when you want
 *   to watch a run you have not spoiled for yourself.
 *
 * Keeping them separate is the point. Collapsing them into one flag would mean
 * either that hiding the panel required re-running the benchmark, or that a
 * "concealed" run still shipped the answer to anybody who opened the trace.
 *
 * Every renderer asks {@link revealedTraitors} rather than reading
 * `scene.betrayal.traitors` directly, so the two switches are enforced in one
 * place instead of three.
 */

import type { Scene } from "./types.js";

const KEY = "descent.spoilers";

type Listener = () => void;
const listeners = new Set<Listener>();

/** Default on: the mechanic's whole appeal is watching them not know. */
let on = read();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // Storage can be unavailable (private mode, a sandboxed frame). A broadcast
    // that throws here would take the whole page down over a preference.
    return true;
  }
}

export function spoilersOn(): boolean {
  return on;
}

export function setSpoilers(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    /* a preference that cannot be remembered still applies to this session */
  }
  for (const fn of listeners) fn();
}

export function onSpoilerChange(fn: Listener): void {
  listeners.add(fn);
}

/**
 * The three states a viewer can be in, which are not two.
 *
 * `hidden` and `none` both draw no badges and mean opposite things — one is
 * "you asked not to be told", the other is "there is genuinely nobody". Any
 * panel that explains itself has to tell them apart, so this returns the reason
 * rather than just a set.
 */
export type RevealState =
  | { state: "off" }
  | { state: "hidden"; traitors: ReadonlySet<string> }
  | { state: "concealed" }
  | { state: "none" }
  | { state: "shown"; traitors: ReadonlySet<string> };

export function revealState(scene: Scene | null | undefined): RevealState {
  const betrayal = scene?.betrayal;
  if (!betrayal) return { state: "off" };
  // `!== false`, not `!revealed`. Every trace written before this flag existed
  // has a betrayal block with no `revealed` on it, and those runs *were*
  // revealed — reading a missing field as concealment would make the panel
  // announce "recorded with revealTraitors: false" over a run that was nothing
  // of the kind, including one that was in flight when the flag landed.
  if (betrayal.revealed === false) return { state: "concealed" };
  if (!on) return { state: "hidden", traitors: new Set(betrayal.traitors) };
  if (betrayal.traitors.length === 0) return { state: "none" };
  return { state: "shown", traitors: new Set(betrayal.traitors) };
}

/** Just the names, for a renderer that only wants to mark somebody. */
export function revealedTraitors(scene: Scene | null | undefined): ReadonlySet<string> {
  const r = revealState(scene);
  return r.state === "shown" ? r.traitors : EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

const CSS = `
.spoil-toggle {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  font: 700 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase;
  color: var(--faint); user-select: none;
}
.spoil-toggle:hover { border-color: var(--flame-dim); color: var(--dim); }
.spoil-toggle:focus-visible { outline: 2px solid var(--flame); outline-offset: 2px; }
.spoil-toggle[data-on="yes"] { color: var(--flame); border-color: var(--flame-dim); }
.spoil-toggle i {
  width: 7px; height: 7px; border-radius: 999px; border: 1px solid currentColor;
}
.spoil-toggle[data-on="yes"] i { background: var(--flame); }
.spoil-toggle[hidden] { display: none; }
`;

/**
 * The control itself.
 *
 * Hidden unless the run has a betrayal layer *and* the trace carries the
 * answer. A toggle that cannot change anything is worse than no toggle: it
 * invites a click and then does nothing, which reads as a broken page rather
 * than as an inapplicable option.
 */
export function mountSpoilerToggle(host: HTMLElement): (scene: Scene | null | undefined) => void {
  if (!document.getElementById("spoil-toggle-css")) {
    const tag = document.createElement("style");
    tag.id = "spoil-toggle-css";
    tag.textContent = CSS;
    document.head.append(tag);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "spoil-toggle";
  button.hidden = true;
  const dot = document.createElement("i");
  const label = document.createElement("span");
  button.append(dot, label);
  host.append(button);

  const paint = () => {
    button.dataset.on = on ? "yes" : "no";
    label.textContent = on ? "parts shown" : "parts hidden";
    button.title = on
      ? "Who is against the party is marked. Click to watch it blind."
      : "Who is against the party is hidden. Click to reveal.";
    button.setAttribute("aria-pressed", on ? "true" : "false");
  };
  paint();
  button.addEventListener("click", () => setSpoilers(!on));
  onSpoilerChange(paint);

  return (scene) => {
    const r = revealState(scene);
    button.hidden = r.state === "off" || r.state === "concealed";
  };
}
