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
  {
    id: "babylon",
    title: "Babylon.js 8",
    file: "babylon.min.js",
    path: "lib/babylon.js",
    docs: "babylon.docs.jsonl",
    global: "BABYLON",
    blurb:
      "Babylon.js 8 — a full 3D engine: meshes, cameras, lights, materials, built-in collision. Pick this " +
      "if the game is in three dimensions.",
    start:
      "Babylon is at `lib/babylon.js` and gives you the `BABYLON` global. Load it before your own scripts, " +
      "and give the page a `<canvas>` to render into.\n\n" +
      "The smallest thing that runs:\n\n" +
      "```js\n" +
      "const canvas = document.getElementById('game');\n" +
      "const engine = new BABYLON.Engine(canvas, true);\n" +
      "const scene = new BABYLON.Scene(engine);\n" +
      "scene.clearColor = new BABYLON.Color4(0.05, 0.06, 0.08, 1);\n" +
      "const camera = new BABYLON.ArcRotateCamera('cam', Math.PI / 4, Math.PI / 3, 12, BABYLON.Vector3.Zero(), scene);\n" +
      "new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);\n" +
      "\n" +
      "const player = BABYLON.MeshBuilder.CreateBox('player', { size: 2 }, scene);\n" +
      "const mat = new BABYLON.StandardMaterial('m', scene);\n" +
      "mat.diffuseColor = new BABYLON.Color3(0.4, 0.9, 0.6);\n" +
      "player.material = mat;\n" +
      "const ground = BABYLON.MeshBuilder.CreateGround('g', { width: 40, height: 40 }, scene);\n" +
      "ground.position.y = -1;\n" +
      "\n" +
      "const held = {};\n" +
      "addEventListener('keydown', (e) => { held[e.code] = true; });\n" +
      "addEventListener('keyup', (e) => { held[e.code] = false; });\n" +
      "\n" +
      "engine.runRenderLoop(() => {\n" +
      "  const dt = engine.getDeltaTime() / 1000;\n" +
      "  if (held.ArrowLeft) player.position.x -= 8 * dt;\n" +
      "  if (held.ArrowRight) player.position.x += 8 * dt;\n" +
      "  scene.render();\n" +
      "});\n" +
      "addEventListener('resize', () => engine.resize());\n" +
      "```\n\n" +
      "**Two things to know before you design around them.**\n\n" +
      "There is *no physics plugin*. Babylon's physics needs Havok, Cannon or Ammo, which are separate " +
      "libraries you do not have, so `PhysicsImpostor` and `PhysicsAggregate` will not work no matter how " +
      "familiar they look. What you do have is built-in collision: `mesh.intersectsMesh(other)`, " +
      "`mesh.moveWithCollisions(vector)` with `scene.collisionsEnabled` and per-mesh `ellipsoid`, and " +
      "`mesh.checkCollisions`. Gravity is a number you subtract yourself. Plenty of good 3D games need " +
      "nothing more.\n\n" +
      "There are *no texture or model files*. Colour comes from `StandardMaterial` and its `diffuseColor`, " +
      "`emissiveColor` and `alpha`; shape comes from `MeshBuilder`. `docs` looks up any signature you are " +
      "unsure of — use it rather than guessing.",
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

/**
 * Does an identifier's word answer one of the query's?
 *
 * Prefix rather than equality, because people do not conjugate the way an API
 * does. "does one mesh intersect another" was answering with
 * `BoneLookController.mesh` — the query said `intersect`, the method says
 * `intersects`, and exact matching could not see they were the same word. Four
 * characters is the floor: below it a prefix is a coincidence.
 */
function matches(word: string, terms: string[]): boolean {
  return terms.some((t) => {
    if (t === word) return true;
    const shorter = t.length < word.length ? t : word;
    const longer = t.length < word.length ? word : t;
    return shorter.length >= 4 && longer.startsWith(shorter);
  });
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
      const covered = tailWords.filter((w) => matches(w, terms)).length;
      const extra = tailWords.filter((w) => !matches(w, terms)).length;
      let score = covered * 20 - extra * 6;

      // The namespace is weaker evidence than the member name, and still
      // evidence: "arcade physics" should favour something under Physics.Arcade.
      for (const term of terms) {
        if (!tailWords.some((w) => matches(w, [term])) && name.includes(term)) score += 5;
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
