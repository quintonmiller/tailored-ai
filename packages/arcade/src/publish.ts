/**
 * Moving a finished run into the arcade: a copy of the files, a set of
 * screenshots, and an archive somebody can download.
 *
 * ## Why a copy and not a link
 *
 * The run's own directory lives under `results/workshops/` inside whatever
 * checkout produced it — frequently a git worktree, which is a thing that gets
 * deleted. The arcade is supposed to accumulate over months. So publishing
 * copies, and the original path stays on the row as provenance that is allowed
 * to rot.
 *
 * ## Which screenshots
 *
 * A twenty-round run can call `playtest` sixty times and leave a few hundred
 * PNGs. All of them is a gigabyte across a hundred games and nobody looks at
 * the middle four hundred. Two selections earn their space:
 *
 * - **shots** — every frame from the *last* playtest, which is the finished
 *   game as it actually ran.
 * - **reel** — one frame per playtest round, evenly sampled down to twelve.
 *   Played in sequence on the detail page this is the closest thing to a video
 *   of the build, and it is the only view that shows a game getting worse.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ArcadeStore, Entry } from "./store.js";
import { zip } from "./zip.js";

/** Frames from one playtest round, in the order they were taken. */
interface RoundShots {
  round: number;
  dir: string;
  files: string[];
}

const MAX_REEL = 12;
const MAX_SHOTS = 8;
/** Anything bigger than this is not a game file and does not belong in the archive. */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

function listRounds(playtests: string): RoundShots[] {
  if (!existsSync(playtests)) return [];
  return readdirSync(playtests, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^round-\d+$/.test(item.name))
    .map((item) => {
      const dir = join(playtests, item.name);
      return {
        round: Number(item.name.slice("round-".length)),
        dir,
        files: readdirSync(dir)
          .filter((file) => file.toLowerCase().endsWith(".png"))
          .sort(),
      };
    })
    .filter((round) => round.files.length > 0)
    .sort((a, b) => a.round - b.round);
}

/** Evenly spaced picks, always including the first and the last. */
function sample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const step = (items.length - 1) / (limit - 1);
  const picked: T[] = [];
  for (let i = 0; i < limit; i += 1) picked.push(items[Math.round(i * step)]);
  return picked;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full, base));
    else if (item.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

export interface PublishResult {
  entry: Entry;
  files: number;
  shots: number;
  reel: number;
  archiveBytes: number;
}

/**
 * Publish one run.
 *
 * Safe to call twice: the destination is cleared first, so a re-publish of a
 * corrected run replaces its files rather than merging into them. The entry row
 * keeps its original `published_at`.
 */
export function publishRun(
  store: ArcadeStore,
  entryId: string,
  input: { artifactPath: string; metrics?: Record<string, number>; at?: string },
): PublishResult {
  const entry = store.entry(entryId);
  if (!entry) throw new Error(`no such entry: ${entryId}`);

  const target = store.gameDir(entryId);
  const filesDir = join(target, "files");
  const shotsDir = join(target, "shots");
  rmSync(filesDir, { recursive: true, force: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });

  const workspace = join(input.artifactPath, "workspace");
  if (existsSync(workspace)) cpSync(workspace, filesDir, { recursive: true });

  // The brief and the manifest travel with the game. Somebody who downloads it
  // in six months needs to know what the team was asked for, and the manifest
  // is the only record of who wrote which file.
  for (const extra of ["brief.md", "manifest.json", "JUDGING.md"]) {
    const source = join(input.artifactPath, extra);
    if (existsSync(source)) cpSync(source, join(target, extra));
  }

  const rounds = listRounds(join(input.artifactPath, "playtests"));
  const media: { kind: string; file: string; caption: string; round?: number }[] = [];

  const last = rounds[rounds.length - 1];
  if (last) {
    for (const file of sample(last.files, MAX_SHOTS)) {
      const name = `shot-${String(last.round).padStart(3, "0")}-${file}`;
      cpSync(join(last.dir, file), join(shotsDir, name));
      media.push({
        kind: "shot",
        file: name,
        caption: describeFrame(file),
        round: last.round,
      });
    }
  }

  for (const round of sample(rounds, MAX_REEL)) {
    // One frame per round, and the mid-play frame where there is one — an
    // "opened" frame is a title screen in every round and shows nothing about
    // how the game changed.
    const chosen = round.files.find((f) => /playing/.test(f)) ?? round.files[round.files.length - 1];
    const name = `reel-${String(round.round).padStart(3, "0")}-${chosen}`;
    cpSync(join(round.dir, chosen), join(shotsDir, name));
    media.push({ kind: "reel", file: name, caption: `round ${round.round + 1}`, round: round.round });
  }

  const archiveName = `${entry.slug}.zip`;
  const archivePath = join(target, archiveName);
  const packed = zip(
    walk(filesDir)
      .map((name) => ({ name: `${entry.slug}/${name}`, path: join(filesDir, name) }))
      .filter((file) => statSync(file.path).size <= MAX_ARCHIVE_BYTES)
      .map((file) => ({ name: file.name, data: readFileSync(file.path), modified: statSync(file.path).mtime })),
  );
  writeFileSync(archivePath, packed);

  const published = store.publish(entryId, {
    metrics: input.metrics,
    filesPath: filesDir,
    downloadPath: archivePath,
    media,
    at: input.at,
  });

  return {
    entry: published,
    files: walk(filesDir).length,
    shots: media.filter((m) => m.kind === "shot").length,
    reel: media.filter((m) => m.kind === "reel").length,
    archiveBytes: packed.length,
  };
}

/** `04-playing.png` → `playing`. The playtest names its own frames; use them. */
function describeFrame(file: string): string {
  return file
    .replace(/\.png$/i, "")
    .replace(/^\d+-/, "")
    .replace(/-/g, " ");
}
