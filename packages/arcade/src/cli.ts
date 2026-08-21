/**
 * `arcade serve`, and the handful of commands that put things into it.
 *
 * `import` is the one worth knowing about: a workshop run leaves a complete
 * artifact directory whether or not the arcade existed when it ran, so every
 * game built before this package did can still be pulled in. It is also the
 * repair path — if a run's publish step fails, the directory is still on disk
 * and importing it loses nothing except what the agents would have written in
 * their own registration.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { splitCommand } from "./args.js";
import { publishRun } from "./publish.js";
import { createArcadeServer, listen } from "./server.js";
import { ArcadeStore, type EntryProvenance } from "./store.js";

const USAGE = `
the arcade — a local site for what the game jam builds

  pnpm --filter @tailored-ai/arcade run arcade serve [options]
  pnpm --filter @tailored-ai/arcade run arcade import <dir> [options]
  pnpm --filter @tailored-ai/arcade run arcade list [options]

commands
  serve            run the site (and the games server on port+1)
  import <dir>     import one workshop artifact directory, or a directory of them
  list             print what is in the database

options
  --home <dir>     where the arcade keeps its data (default ~/.tai-arcade, or $ARCADE_HOME)
  --port <n>       site port (default 4321); games are served on port+1
  --host <h>       interface to bind (default 127.0.0.1)
  --model <id>     model to record on imported entries, when the run did not say
  --min-rounds <n> skip imported runs configured for fewer rounds than this
  --drafts         include unpublished entries in \`list\`

\`import\` always skips a directory whose manifest lists no files: the workshop
writes its artifact directory at construction, so a run that never took a turn
still leaves a complete-looking one behind.
`;

function readManifest(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Turn an artifact directory into a row.
 *
 * An imported run has no registration — the agents never saw an arcade — and it
 * is left that way. Filling the title in from the brief looked helpful for
 * exactly one run and was actively misleading across twenty-seven, because the
 * brief's title is a property of the *brief*: every entry on the board read "A
 * small arcade game that runs in a browser" and the slugs differed only by a
 * counter. An untitled row that shows its run id is the honest rendering of a
 * team that never wrote a pitch, and the site already says so on the card.
 */
function importOne(store: ArcadeStore, dir: string, model: string, minRounds: number): string | undefined {
  const manifest = readManifest(dir);
  if (!manifest) return undefined;

  /*
   * A directory is not a game.
   *
   * The workshop writes its artifact directory in its *constructor*, on purpose
   * — a run that dies half-way should still leave a reviewer the brief and the
   * questions to ask. The cost is that a run which never took a turn leaves a
   * complete-looking directory with a manifest, a brief and no files at all,
   * and `results/workshops/` accumulates them. Twenty-four of the first
   * twenty-seven directories on this machine were that.
   *
   * `rounds` cannot tell them apart: it is the *horizon the run was configured
   * for*, so an abandoned 220-round arm reads as the longest run on the board.
   * What the file list says is what actually happened.
   */
  const files = Array.isArray(manifest.files) ? manifest.files.length : 0;
  if (files === 0) return undefined;
  if (Number(manifest.rounds ?? 0) < minRounds) return undefined;
  const runId = basename(dir);
  const provenance: EntryProvenance = {
    runId,
    createdAt: runDate(runId, dir),
    scenario: String(manifest.scenario ?? ""),
    brief: String(manifest.brief ?? ""),
    theme: String(manifest.theme ?? ""),
    themeId: String(manifest.themeId ?? ""),
    rounds: Number(manifest.rounds ?? 0),
    seed: null,
    artifactPath: resolve(dir),
    entryFile: String(manifest.entry ?? "index.html"),
    taiVersion: String(manifest.taiVersion ?? ""),
    simVersion: String(manifest.simVersion ?? ""),
    gitSha: String(manifest.gitSha ?? ""),
    model,
    provider: "",
    baseUrl: "",
    modelMeta: {},
    credits: {},
  };
  const entry = store.createEntry(provenance);
  publishRun(store, entry.id, { artifactPath: resolve(dir), at: provenance.createdAt });
  return store.entry(entry.id)?.slug;
}

/**
 * When a run happened, from the name the workshop gave its directory.
 *
 * `arcade-7-2026-08-20-16-34-16` — brief, seed, then a local-time stamp with
 * every separator flattened to a dash. Parsed as local time because that is how
 * it was written; falling back to the directory's own mtime when the name does
 * not match, and to now when even that fails.
 */
function runDate(runId: string, dir: string): string {
  const match = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(runId);
  if (match) {
    const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[];
    const when = new Date(year, month - 1, day, hour, minute, second);
    if (!Number.isNaN(when.getTime())) return when.toISOString();
  }
  try {
    return statSync(dir).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function main(raw: string[]): Promise<void> {
  const { command, rest } = splitCommand(raw);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      model: { type: "string" },
      "min-rounds": { type: "string" },
      drafts: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || command === "help") {
    console.log(USAGE.trim());
    return;
  }

  const store = new ArcadeStore(values.home);

  if (command === "serve") {
    const port = values.port ? Number(values.port) : 4321;
    const host = values.host ?? "127.0.0.1";
    const server = createArcadeServer({ store, port, host });
    await listen(server, { port, host });
    console.log(`arcade   ${server.url}`);
    console.log(`games    ${server.gamesUrl}`);
    console.log(`data     ${store.home}`);
    console.log(`entries  ${store.count()} published, ${store.count({ includeDrafts: true })} total`);
    return;
  }

  if (command === "import") {
    const target = positionals[0];
    if (!target) {
      console.error("import needs a directory");
      process.exitCode = 1;
      return;
    }
    const root = resolve(target);
    const model = values.model ?? "";
    const dirs = existsSync(join(root, "manifest.json"))
      ? [root]
      : readdirSync(root, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => join(root, item.name))
          .filter((dir) => existsSync(join(dir, "manifest.json")));

    // Smoke runs leave the same directory shape as a real jam and nobody wants
    // eleven three-round wiring tests on the board.
    const minRounds = values["min-rounds"] ? Number(values["min-rounds"]) : 0;

    let imported = 0;
    for (const dir of dirs) {
      const slug = importOne(store, dir, model, minRounds);
      if (slug) {
        imported += 1;
        console.log(`  ${slug}  ←  ${basename(dir)}`);
      }
    }
    console.log(`imported ${imported} of ${dirs.length} directories into ${store.home}`);
    store.close();
    return;
  }

  if (command === "list") {
    const entries = store.list({ includeDrafts: !!values.drafts, sort: "recent" });
    for (const entry of entries) {
      const score = entry.overall === null ? "  —  " : entry.overall.toFixed(2).padStart(5);
      const flag = entry.status === "draft" ? " (draft)" : entry.registered ? "" : " (unregistered)";
      console.log(`${score}  ${entry.slug.padEnd(40)} ${entry.theme.padEnd(18)} ${entry.model}${flag}`);
    }
    console.log(`${entries.length} entries in ${store.home}`);
    store.close();
    return;
  }

  console.error(`unknown command: ${command}`);
  console.error(USAGE.trim());
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(String((err as Error)?.stack ?? err));
  process.exitCode = 1;
});
