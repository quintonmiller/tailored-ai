/**
 * Real game engines the team can choose, and a way to look up their API.
 *
 * ## Why an engine at all, after arguing against one
 *
 * The case against was specific and it stopped holding. It was: our own 580-line
 * `lib/` is competitive for 2D, the brief bans image files so sprites, atlases
 * and tilemaps — most of an engine's value — are unusable, and a big API costs
 * context for surface the model half-remembers.
 *
 * The first two collapsed when the image ban came up for review and 3D was asked
 * for; nothing we write in 580 lines competes with a real engine there. The third
 * is what {@link EngineDocs} is for, and it is worth being precise about the
 * shape of it: a model that has read thousands of Phaser tutorials has the
 * *idiom* and half-remembers the *signature*. Training data is best at the first
 * and worst at the second. A `.d.ts` is exactly the inverse — it states
 * signatures, parameter order and defaults exactly and teaches idiom not at all.
 * So the two compose rather than overlap.
 *
 * ## Chosen, not issued
 *
 * No engine is present until somebody asks for it. That keeps the choice with
 * the team, which is the whole direction of the open arm, and it means a run
 * only carries the megabyte it actually used — the workspace is copied into the
 * arcade at publish, so an engine nobody called would otherwise be shipped with
 * every game forever.
 *
 * Which engine a team picks is also a measurement, and one nothing else here can
 * make: given a free choice and a theme, what do they reach for?
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "engines");

export interface EngineSpec {
  id: string;
  title: string;
  /** Filename under `assets/engines/`. */
  file: string;
  /** Where it lands in the workspace. */
  path: string;
  /** The docs index beside it, if there is one. */
  docs?: string;
  /** The global a classic `<script>` tag exposes. */
  global: string;
  /** One line, shown in the brief so a team knows the choice exists. */
  blurb: string;
  /** Shown once, when a team installs it. The smallest thing that runs. */
  start: string;
}

export const ENGINES: EngineSpec[] = [
  {
    id: "phaser",
    title: "Phaser 4",
    file: "phaser.min.js",
    path: "lib/phaser.js",
    docs: "phaser.docs.jsonl",
    global: "Phaser",
    blurb:
      "Phaser 4 — a full 2D game framework: scenes, sprites, arcade physics with gravity and collision, " +
      "input, tweens, timers, particles, text.",
    start:
      "Phaser is at `lib/phaser.js` and gives you the `Phaser` global. Load it before your own scripts.\n\n" +
      "The smallest thing that runs:\n\n" +
      "```js\n" +
      "new Phaser.Game({\n" +
      "  type: Phaser.AUTO, width: 960, height: 600, backgroundColor: '#0d0f13',\n" +
      "  physics: { default: 'arcade', arcade: { gravity: { y: 400 } } },\n" +
      "  scene: {\n" +
      "    create() {\n" +
      "      // No image files, so draw a texture instead of loading one.\n" +
      "      const g = this.add.graphics();\n" +
      "      g.fillStyle(0x6ee7b7, 1); g.fillCircle(16, 16, 16);\n" +
      "      g.generateTexture('orb', 32, 32); g.destroy();\n" +
      "      this.orb = this.physics.add.image(480, 80, 'orb').setBounce(0.8).setCollideWorldBounds(true);\n" +
      "      this.keys = this.input.keyboard.createCursorKeys();\n" +
      "    },\n" +
      "    update() {\n" +
      "      this.orb.setVelocityX(this.keys.left.isDown ? -300 : this.keys.right.isDown ? 300 : 0);\n" +
      "    },\n" +
      "  },\n" +
      "});\n" +
      "```\n\n" +
      "`generateTexture` is the move that matters here: it draws a texture at runtime, which is how you " +
      "get sprites when image files are not allowed. `docs` looks up any API you are unsure of — use it " +
      "rather than guessing a signature.",
  },
];

export function findEngine(id: unknown): EngineSpec | undefined {
  const wanted = String(id ?? "")
    .trim()
    .toLowerCase();
  return ENGINES.find((e) => e.id === wanted);
}

/** The engine files that are actually on disk, so a missing asset is not fatal. */
export function availableEngines(): EngineSpec[] {
  return ENGINES.filter((e) => existsSync(join(assetRoot, e.file)));
}

export function engineSource(engine: EngineSpec): string {
  return readFileSync(join(assetRoot, engine.file), "utf8");
}

interface DocEntry {
  name: string;
  kind: string;
  sig: string;
  doc: string;
}

/**
 * `setVelocityX` -> `["set", "velocity", "x"]`.
 *
 * Matching whole identifiers cannot see that `setVelocity` answers "set
 * velocity", which is how a person asks and therefore how a model asks.
 */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How many results one lookup returns before it costs more than it explains. */
const RESULTS = 4;

/**
 * Search over one engine's API.
 *
 * Deliberately lexical rather than embedded. The queries are API questions —
 * "arcade physics set velocity", "how do I tween alpha" — where the answer
 * contains the query's nouns almost by construction, and an embedding model
 * would be a second model to stand up, a second thing to keep loaded on the one
 * GPU the jam is already using, and a dependency for a problem that keyword
 * matching handles.
 *
 * Loaded lazily: an index nobody searches should cost nothing, and most runs
 * will not install an engine at all.
 */
export class EngineDocs {
  private readonly path: string;
  private entries: DocEntry[] | undefined;

  constructor(docsFile: string) {
    this.path = join(assetRoot, docsFile);
  }

  private load(): DocEntry[] {
    if (this.entries) return this.entries;
    try {
      this.entries = readFileSync(this.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DocEntry);
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  get size(): number {
    return this.load().length;
  }

  search(query: string, limit = RESULTS): DocEntry[] {
    const terms = String(query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    if (!terms.length) return [];

    const wanted = new Set(terms);
    const scored: { entry: DocEntry; score: number }[] = [];
    for (const entry of this.load()) {
      const name = entry.name.toLowerCase();
      const tailWords = words(entry.name.slice(entry.name.lastIndexOf(".") + 1));
      const doc = entry.doc.toLowerCase();

      /*
       * Coverage, minus the words nobody asked for.
       *
       * Summing per-term hits ranked `setAngularVelocity` above `setVelocity`
       * for "arcade physics set velocity" — both contain every term, so both
       * scored the same and the tiebreak was arbitrary. What separates them is
       * the word the query did *not* contain. Likewise "keyboard cursor keys"
       * returned `Structs.Map.keys`, because an exact match on one common word
       * beat a partial match on the right method.
       */
      const covered = tailWords.filter((w) => wanted.has(w)).length;
      const extra = tailWords.filter((w) => !wanted.has(w)).length;
      let score = covered * 20 - extra * 6;

      // The namespace is weaker evidence than the member name, and still
      // evidence: "arcade physics" should favour something under Physics.Arcade.
      for (const term of terms) {
        if (!tailWords.includes(term) && name.includes(term)) score += 5;
        if (doc.includes(term)) score += 2;
      }

      if (covered === 0) continue;
      if (entry.kind === "method") score += 3;
      // Prefer the shallow name. `Sprite.setVelocity` is a better answer than
      // the same method reached through four layers of component mixin.
      score -= entry.name.split(".").length;
      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);

    // A `.d.ts` repeats a member on every class that mixes it in, so an
    // undeduped result set is the same answer four times.
    const seen = new Set<string>();
    const out: DocEntry[] = [];
    for (const { entry } of scored) {
      const key = `${entry.sig}::${entry.doc.split("\n")[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  render(query: string, limit = RESULTS): string {
    const hits = this.search(query, limit);
    if (!hits.length) {
      return `Nothing in the API matches "${query}". Try the name of the thing itself — a class like Sprite, or a method like setVelocity.`;
    }
    return hits.map((h) => `${h.name}\n  ${h.sig}\n  ${h.doc.split("\n").join("\n  ")}`).join("\n\n");
  }
}
