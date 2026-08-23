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

/**
 * Members carry modifiers, and the name is not the first word on the line.
 *
 * Babylon writes `static CreateBox(options: {...})` and `readonly position`;
 * Phaser mostly does not. Stripping them is what lets one parser read both.
 */
const MODIFIERS = /^(?:export\s+|declare\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|get\s+|set\s+)+/;

function parse(source: string): DocEntry[] {
  const lines = source.split("\n");
  const entries: DocEntry[] = [];
  /** Each open scope, with the brace depth it was opened at. */
  const scope: { name: string; depth: number }[] = [];
  let depth = 0;
  let doc: string | null = null;

  const path = (): string => scope.map((s) => s.name).join(".");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

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

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    // `declare module BABYLON.Debug`, `namespace Physics`, `class Sprite`.
    const opened = line
      .replace(MODIFIERS, "")
      .match(/^(module|namespace|class|interface)\s+([A-Za-z0-9_.]+)/);
    if (opened) {
      if (opened[1] === "class" || opened[1] === "interface") {
        if (doc) entries.push({ name: [path(), opened[2]].filter(Boolean).join("."), kind: "class", sig: line.replace(/\s*\{$/, ""), doc });
      }
      scope.push({ name: opened[2], depth });
      depth += opens - closes;
      doc = null;
      continue;
    }

    // A documented member, once its modifiers are out of the way.
    const member = doc ? line.replace(MODIFIERS, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\??\s*[(:<]/) : null;
    if (member) {
      const prefix = path();
      entries.push({
        name: prefix ? `${prefix}.${member[1]}` : member[1],
        kind: line.includes("(") ? "method" : "property",
        sig: line.replace(/;$/, ""),
        doc,
      });
      doc = null;
    } else if (line && !line.startsWith("*")) {
      doc = null;
    }

    depth += opens - closes;
    // Close every scope the braces have now left. Depth-tracked rather than
    // matching a bare `}`, because a multi-line options type closes with one too
    // and would otherwise pop a class that is still open.
    while (scope.length && depth <= scope[scope.length - 1].depth) scope.pop();
  }
  return entries;
}

/**
 * Drop what this jam cannot reach.
 *
 * Not a size optimisation — a relevance one, and a correctness one. A query for
 * "velocity" competing against four hundred renderer internals returns
 * internals; worse, documenting an API that is not in the vendored build
 * produces confident code that cannot run. The index should describe the engine
 * *as this team can actually use it*.
 *
 * Every exclusion restates a constraint that already exists somewhere else — the
 * brief's, or the build we chose to vendor.
 */
const PROFILES: Record<string, RegExp> = {
  // Case-insensitive and mostly unanchored, for the same reason as Babylon:
  // `Phaser.Game.sound` and `Config.loaderImageLoadType` are the real member
  // names, and a `\b`-anchored PascalCase pattern matches neither.
  phaser: new RegExp(
    [
      // Renderer internals.
      "(webgl|pipeline|shader|renderer|framebuffer|gltexture|internal|deprecated|__)",
      // Asset loading, and anything that maps one.
      "(loader|filetypes|tilemap|tileset|layerdata|mapdata|spritesheet|atlas)",
      // Audio.
      "sound",
      // Not in the arcade-physics build we vendor.
      "matter",
      // Real API, unreachable without image files.
      "(video|rendertexture|tilesprite|dynamicbitmaptext|pathfollower)",
    ].join("|"),
    "i",
  ),
  // Case-insensitive: Babylon names members in camelCase and classes in Pascal,
  // so `texture` and `Texture` are the same exclusion.
  babylon: new RegExp(
    [
      // Asset loading of every kind: no image, model or texture files exist.
      "\\b(SceneLoader|AssetsManager|AssetContainer|FilesInput|glTF|GLTF|OBJFile|STLFile|Loader)",
      "(texture|dds|ktx|basis|draco)",
      // Audio.
      "\\b(Sound|Audio|WebAudio|Analyser)",
      // Physics needs a plugin package we do not vendor. Babylon's built-in
      // collision — intersectsMesh, moveWithCollisions, ellipsoids — is what a
      // game here can actually call, and stays.
      // No word boundary and case-insensitive below: the members are named
      // `physicsImpostor` and `getPhysicsImpostor`, and `\\bPhysics` matches
      // neither. This one has to be airtight — a familiar-looking physics API
      // that is not in the build is the worst thing the index could suggest.
      "(havok|cannonjs|ammojs|impostor|physicsaggregate|physicsbody|physicsshape|physicsengine|physicsmaterial|physicsconstraint|physicsviewer|physicsjoint|physicsprestep)",
      // Headsets, editors, debug tooling, node-graph materials.
      "\\b(WebXR|XR|VRExperience|DeviceOrientation|Inspector|DebugLayer|NodeMaterial|NodeGeometry|Recast|Navigation)",
      // Engine internals and the WebGPU backend.
      "\\b(WebGPU|ThinEngine|NativeEngine|Effect|EffectLayer|PostProcessRenderPipeline|RenderTargetTexture|Internal|Deprecated|__)",
    ].join("|"),
    "i",
  ),
};

function useful(e: DocEntry, exclude: RegExp): boolean {
  if (exclude.test(e.name)) return false;
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
  console.error("usage: build-engine-docs.ts --in <engine.d.ts> --out <engine.docs.jsonl> [--profile phaser|babylon]");
  process.exit(2);
}

const profile = read("--profile") ?? "phaser";
const exclude = PROFILES[profile];
if (!exclude) {
  console.error(`unknown profile "${profile}". Known: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(2);
}

const source = readFileSync(input, "utf8");
const all = parse(source);
const kept = all
  .filter((e) => useful(e, exclude))
  .map((e) => ({ ...e, doc: trimDoc(e.doc), sig: e.sig.slice(0, 400) }));
const body = `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`;
writeFileSync(output, body);

console.log(`${input}`);
console.log(`  parsed  ${all.length.toLocaleString()} documented declarations`);
console.log(`  kept    ${kept.length.toLocaleString()} a game might call`);
console.log(`  wrote   ${output} (${(body.length / 1e6).toFixed(2)} MB, from ${(source.length / 1e6).toFixed(1)} MB)`);
