/**
 * The round's five blind commitments, and what they are about to do to each other.
 *
 * This is the one thing on the page that shows the mechanic the whole scenario
 * is built around, and until now nothing did.
 *
 * A combat action is *readied*, not taken: five agents queue an intent without
 * seeing the others resolve, and the entire round settles at once when it
 * closes. That is what makes coordination measurable here rather than free —
 * "we both did something sensible and the combination was terrible" is a thing
 * that can happen, and it is the difference between this and an ordinary
 * turn-based fight. A viewer watching only the aftermath prose sees the damage
 * and never sees the commitment, which is where all the tension lives.
 *
 * So: one lane per class, filling as intents arrive, and the clash lit *before*
 * the round resolves. `scene.clashes` comes from the same pure `antiSynergies`
 * the coordination diagnostic scores on, run over the intents queued so far —
 * and it is deliberately broadcast-only. The party can see who has readied
 * what; it cannot see this. The audience gets several seconds of knowing the
 * fireball is going into the group that was just put to sleep, while the mage
 * still thinks it is a good idea.
 */

import type { BroadcastState, ClassId, Renderer, Scene } from "./types.js";

const CLASSES: readonly ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

/** Kept in step with the stage and the feed: one colour per class, everywhere. */
const CLASS_COLOUR: Record<ClassId, string> = {
  guardian: "var(--guardian)",
  mage: "var(--mage)",
  rogue: "var(--rogue)",
  cleric: "var(--cleric)",
  ranger: "var(--ranger)",
};

/**
 * `sleep_powder` → `sleep powder`, `shield_slam` → `shield slam`.
 *
 * Derived rather than tabled so a new ability needs no edit here — the same
 * choice the HUD made, for the same reason.
 */
function humanise(id: string): string {
  return id.replace(/_/g, " ");
}

const CSS = `
.rib {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
  padding: 8px 10px;
}
.rib-lane {
  border-left: 2px solid var(--who, var(--faint));
  padding: 5px 8px;
  background: #0d1219;
  border-radius: 0 4px 4px 0;
  min-width: 0;
  transition: background 0.25s ease;
}
.rib-lane.idle { opacity: 0.42; }
.rib-lane.clash { background: color-mix(in srgb, var(--bad) 24%, #0d1219); }
.rib-lane.gone { opacity: 0.3; }
.rib-who {
  font: 600 9px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--who, var(--faint));
}
.rib-act {
  margin-top: 4px;
  font: 12px/1.25 var(--sans);
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rib-act .at { color: var(--dim); }
.rib-lane.idle .rib-act, .rib-lane.gone .rib-act { color: var(--faint); }
.rib-warn {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font: 11px/1.3 var(--sans);
  color: var(--bad);
  padding-top: 2px;
}
.rib-warn b {
  font: 600 9px/1 var(--mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.rib-none { color: var(--faint); }
@media (prefers-reduced-motion: reduce) {
  .rib-lane { transition: none; }
}
`;

function ensureStyles(): void {
  if (document.getElementById("rib-css")) return;
  const style = document.createElement("style");
  style.id = "rib-css";
  style.textContent = CSS;
  document.head.append(style);
}

/**
 * Who is caught up in a clash, read out of the sentence describing it.
 *
 * `antiSynergies` returns prose — "mage's area attack will wake whatever rogue
 * puts to sleep" — because that string is also what the diagnostic stores and
 * what a reader of the report sees. Matching class names inside it is
 * deliberately loose: a name that stops appearing costs one highlight, where
 * parsing a fixed sentence shape would break silently the first time somebody
 * reworded a verb.
 *
 * Exported because it is the only real logic in this file and it needs no DOM,
 * which makes it the only part worth a test.
 */
export function culprits(clashes: readonly string[]): Set<ClassId> {
  const found = new Set<ClassId>();
  for (const line of clashes) {
    const lower = String(line).toLowerCase();
    for (const id of CLASSES) if (lower.includes(id)) found.add(id);
  }
  return found;
}

/** The nodes of one lane, kept so a render writes text rather than rebuilding. */
interface Lane {
  root: HTMLElement;
  act: HTMLElement;
}

export function mountRibbon(host: HTMLElement): Renderer {
  ensureStyles();
  host.classList.add("rib");

  const lanes = new Map<ClassId, Lane>();
  for (const id of CLASSES) {
    const root = document.createElement("div");
    root.className = "rib-lane idle";
    root.style.setProperty("--who", CLASS_COLOUR[id]);

    const who = document.createElement("div");
    who.className = "rib-who";
    who.textContent = id;

    const act = document.createElement("div");
    act.className = "rib-act";
    act.textContent = "—";

    root.append(who, act);
    host.append(root);
    lanes.set(id, { root, act });
  }

  const warn = document.createElement("div");
  warn.className = "rib-warn";
  warn.hidden = true;
  host.append(warn);

  function render(state: BroadcastState): void {
    const scene: Scene | null = state.scene;
    if (!scene) return;

    const clashing = culprits(scene.clashes ?? []);
    const fighting = scene.phase === "combat";

    for (const id of CLASSES) {
      const lane = lanes.get(id);
      if (!lane) continue;
      const member = scene.party.find((p) => p.id === id);
      const readied = member?.readied ?? null;

      if (member?.dead) {
        lane.root.className = "rib-lane gone";
        lane.act.textContent = "down";
        continue;
      }
      if (!fighting) {
        // Out of a fight there is nothing to commit blind to, and a ribbon
        // full of dashes reads as broken rather than as quiet.
        lane.root.className = "rib-lane idle";
        lane.act.textContent = scene.phase;
        continue;
      }
      if (!readied) {
        lane.root.className = "rib-lane idle";
        lane.act.textContent = "thinking";
        continue;
      }

      lane.root.className = `rib-lane${clashing.has(id) ? " clash" : ""}`;
      lane.act.replaceChildren(document.createTextNode(humanise(readied.kind)));
      if (readied.target) {
        const at = document.createElement("span");
        at.className = "at";
        at.textContent = ` → ${readied.target}`;
        lane.act.append(at);
      }
    }

    const clashes = fighting ? (scene.clashes ?? []) : [];
    warn.hidden = clashes.length === 0;
    if (clashes.length > 0) {
      warn.replaceChildren();
      const tag = document.createElement("b");
      tag.textContent = clashes.length === 1 ? "these two clash" : `${clashes.length} clashes`;
      const text = document.createElement("span");
      text.textContent = clashes[0];
      warn.append(tag, text);
    }
  }

  return render;
}
