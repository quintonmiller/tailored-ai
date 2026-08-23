/**
 * Turn an engine's TypeScript declarations into a searchable index.
 *
 * Run at vendor time, not at run time. `phaser.d.ts` is 8 MB and `babylon.d.ts`
 * 6 MB; parsing either on every jam start would be seconds of work repeated for
 * no reason, and committing the raw declarations would put 14 MB of TypeScript
 * in a repo that has no TypeScript engine in it.
 *
 * What comes out is one JSON object per line: a qualified name, the declaration
 * as written, and the prose that documented it. That is the shape a search wants
 * and it drops everything else — the type machinery, the overload noise, the
 * internals nobody calls from a game.
 *
 *   pnpm exec tsx packages/evals/scripts/build-engine-docs.ts \
 *     --in node_modules/phaser/types/phaser.d.ts --out assets/engines/phaser.docs.jsonl
 *
 * The point of the index is what a model is *worst* at. It has read thousands of
 * Phaser tutorials, so it has the idiom; what it half-remembers is the exact
 * signature, the parameter order and the defaults. Those are precisely what a
 * `.d.ts` states exactly.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface DocEntry {
  /** `Phaser.Physics.Arcade.Body.setVelocity` */
  name: string;
  kind: "class" | "method" | "property";
  /** The declaration line, trimmed. */
  sig: string;
  /** The JSDoc prose, `@param` lines kept — they carry the defaults. */
  doc: string;
}

function parse(source: string): DocEntry[] {
  const lines = source.split("\n");
  const entries: DocEntry[] = [];
  const scope: string[] = [];
  let doc: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (line.startsWith("/**")) {
      const buf: string[] = [];
      let j = i;
      while (j < lines.length && !lines[j].includes("*/")) {
        buf.push(lines[j].replace(/^\s*\/?\*+ ?/, ""));
        j += 1;
      }
      doc = buf.filter(Boolean).join("\n").trim();
      i = j;
      continue;
    }

    const opened = line.match(/^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(namespace|class|interface)\s+([A-Za-z0-9_]+)/);
    if (opened) {
      scope.push(opened[2]);
      if (opened[1] !== "namespace" && doc) {
        entries.push({ name: scope.join("."), kind: "class", sig: line.replace(/\s*\{$/, ""), doc });
      }
      doc = null;
      continue;
    }
    if (line === "}" && scope.length) {
      scope.pop();
      continue;
    }

    if (doc && /^[A-Za-z_][A-Za-z0-9_]*\??\s*[(:<]/.test(line)) {
      const name = (line.match(/^([A-Za-z_][A-Za-z0-9_]*)/) as RegExpMatchArray)[1];
      entries.push({
        name: scope.length ? `${scope.join(".")}.${name}` : name,
        kind: line.includes("(") ? "method" : "property",
        sig: line.replace(/;$/, ""),
        doc,
      });
      doc = null;
      continue;
    }
    if (line && !line.startsWith("*")) doc = null;
  }
  return entries;
}

/**
 * Drop what this jam cannot reach.
 *
 * Not a size optimisation — a relevance one. A query for "velocity" competing
 * against four hundred renderer internals is a query that returns internals, and
 * the index should describe the engine *as the team can actually use it*.
 *
 * Each exclusion is a constraint that already exists somewhere else:
 *
 * - **Loader, FileTypes, Video, Tilemap** — the brief forbids image files, so
 *   everything that loads or maps an external asset is unreachable.
 * - **Sound** — the brief forbids audio.
 * - **Physics.Matter** — we vendor the *arcade physics* build, which does not
 *   contain it. Documenting an engine that is not in the file is worse than
 *   documenting nothing: it produces confident code that cannot run.
 * - **Renderer internals** — pipelines, shaders, framebuffers. Real API, and
 *   nothing a jam game touches.
 *
 * `Types.*` stays. It reads as noise and is not: those are the config-object
 * shapes, and "what options does this take" is exactly the question a model
 * half-remembers.
 */
const UNREACHABLE = new RegExp(
  [
    // Renderer internals.
    "\\b(WebGL|Pipeline|Shader|Renderer|Framebuffer|GLTexture|Internal|Deprecated|__)\\b",
    // Asset loading and anything that maps one. Unanchored: the declarations
    // nest inconsistently, so `Sound.play` and `Phaser.Sound.play` both occur.
    "\\b(Loader|FileTypes|Tilemap|Tileset|LayerData|MapData)",
    // Audio.
    "\\bSound\\b",
    // Not in the arcade-physics build we vendor.
    "\\bMatter\\b",
    // Real API, unreachable without image files.
    "\\b(Video|RenderTexture|Stamp|TileSprite|DynamicBitmapText|PathFollower|Spritesheet|Atlas)\\b",
  ].join("|"),
);

function useful(e: DocEntry): boolean {
  if (UNREACHABLE.test(e.name)) return false;
  if (e.doc.length < 12) return false;
  // A `.d.ts` repeats a class member on every subclass. The qualified name keeps
  // them distinct and search dedupes on the doc, so nothing is lost here.
  return true;
}

/** Two sentences is enough to choose; the signature carries the rest. */
function trimDoc(doc: string): string {
  const params = doc
    .split("\n")
    .filter((l) => l.startsWith("@param") || l.startsWith("@returns"))
    .slice(0, 8);
  const prose = doc
    .split("\n")
    .filter((l) => !l.startsWith("@"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const twoSentences = prose.split(/(?<=\.)\s+/).slice(0, 2).join(" ");
  return [twoSentences.slice(0, 400), ...params.map((p) => p.slice(0, 180))].filter(Boolean).join("\n");
}

const args = process.argv.slice(2);
const read = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

const input = read("--in");
const output = read("--out");
if (!input || !output) {
  console.error("usage: build-engine-docs.ts --in <engine.d.ts> --out <engine.docs.jsonl>");
  process.exit(2);
}

const source = readFileSync(input, "utf8");
const all = parse(source);
const kept = all.filter(useful).map((e) => ({ ...e, doc: trimDoc(e.doc), sig: e.sig.slice(0, 400) }));
const body = `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`;
writeFileSync(output, body);

console.log(`${input}`);
console.log(`  parsed  ${all.length.toLocaleString()} documented declarations`);
console.log(`  kept    ${kept.length.toLocaleString()} a game might call`);
console.log(`  wrote   ${output} (${(body.length / 1e6).toFixed(2)} MB, from ${(source.length / 1e6).toFixed(1)} MB)`);
