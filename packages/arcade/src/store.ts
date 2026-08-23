/**
 * The arcade's database: what got built, what it was built by, and what a
 * person thought of it.
 *
 * ## Why a database rather than the artifact directories
 *
 * The workshop already leaves a directory per run with a manifest, a scorecard
 * form and the files. That is enough to *review* one game and useless for every
 * question that has more than one game in it — which is the entire point of
 * running the jam on a loop. "Did the model get better at theme relevance over
 * thirty runs" is a query, and a folder of markdown scorecards is not queryable
 * by anything except a person with an afternoon.
 *
 * It is also what lets the agents read the room. A team that can see what
 * scored well last week is in a different position from one that cannot, and
 * that difference is worth being able to measure rather than assume.
 *
 * ## Why it holds a copy of the files
 *
 * `results/workshops/` lives inside a git worktree that gets deleted. The whole
 * value of this thing accrues over months, so at publish time the workspace is
 * copied into the arcade's own home — which defaults outside the repo — and the
 * site serves that copy. The original path is recorded too, and it is allowed
 * to stop existing.
 *
 * ## What this deliberately does not have
 *
 * Authentication. `reviewer` is a name somebody types, stored so their previous
 * scores come back when they return. It answers "have I already reviewed this"
 * and nothing else; anyone with the port can review as anyone. That is the
 * correct amount of security for a thing running on one machine, and it is
 * written down here so nobody later mistakes it for a login.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CATEGORY_KEYS, cleanScore, normaliseGenre, overallScore, round2 } from "./categories.js";

export const ARCADE_SCHEMA_VERSION = 2;

/**
 * The newest frame from a jam still in progress, inside that entry's `shots/`.
 *
 * One fixed name rather than one file per playtest: a live view wants the
 * latest frame and nothing else, and a run that is later discarded would
 * otherwise leave a directory of PNGs behind with no policy for removing them.
 */
export const LIVE_SHOT = "live.png";

/** Messages kept per entry. A jam produces a couple of hundred. */
export const ACTIVITY_KEEP = 250;
/** Longest message body stored. The tester writes essays. */
export const ACTIVITY_BODY_MAX = 2000;

/** One thing the team said or did. `kind` is `post` for talk, `did` for work. */
export interface ActivityInput {
  kind: "post" | "did";
  agent?: string;
  /** Which channel, for a post. For work, the file or instrument touched. */
  room?: string;
  body?: string;
  round?: number;
  at?: string;
}

export interface ActivityRow extends ActivityInput {
  id: number;
  at: string;
  kind: "post" | "did";
}

/** Where the arcade keeps its database and its copies of the games. */
export function arcadeHome(explicit?: string): string {
  const chosen = explicit ?? process.env.ARCADE_HOME ?? join(homedir(), ".tai-arcade");
  return chosen;
}

/**
 * Everything about a run that the run knows and the agents do not choose.
 *
 * Provenance, in other words. Separated from the registration fields below
 * because the split is a permission boundary: an agent may write its own pitch
 * and may not write which model produced it.
 */
export interface EntryProvenance {
  /** Unique per run. The workshop uses its artifact directory name. */
  runId: string;
  scenario: string;
  brief: string;
  theme: string;
  themeId: string;
  rounds: number;
  seed: number | null;
  artifactPath: string;
  /** The file the site opens to play it, relative to the workspace. */
  entryFile: string;
  taiVersion: string;
  simVersion: string;
  gitSha: string;
  model: string;
  provider: string;
  baseUrl: string;
  /** Context window, effort, temperature — whatever the runner knew. Free-form. */
  modelMeta: Record<string, unknown>;
  /** role → agent name, so a detail page can credit who built what. */
  credits: Record<string, string>;
  /**
   * When the run happened, if that is not now.
   *
   * Only an import passes this. Without it every backfilled game claims the
   * date it was imported, which makes "sort by date added" say that a hundred
   * games were built in the same minute — and quietly destroys the one axis
   * that would show a model getting better over time.
   */
  createdAt?: string;
}

/** The fields the team fills in. The only things an agent may write. */
export interface Registration {
  title?: string;
  tagline?: string;
  description?: string;
  instructions?: string;
  genre?: string;
}

export const REGISTRATION_FIELDS: (keyof Registration)[] = ["title", "tagline", "description", "instructions", "genre"];

export interface Entry extends EntryProvenance, Registration {
  id: string;
  slug: string;
  status: "draft" | "published";
  registered: boolean;
  /**
   * The jam that made this is still running.
   *
   * Independent of `status` on purpose. A team that submits a build at round
   * twelve and keeps working is published *and* live: playable on the board,
   * still accumulating versions. Only the end of the run clears this, so a run
   * that is killed leaves `live` set — which is why the site treats a live
   * entry that has gone quiet as finished rather than as still building.
   */
  live: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  metrics: Record<string, number>;
  filesPath: string | null;
  downloadPath: string | null;
}

/** One build a team put on the board, and what was true when they did. */
export interface Version {
  id: number;
  entryId: string;
  /** The team's own name for the build. `0.4.0`, `rc1`, whatever they chose. */
  version: string;
  /** What changed, in the team's words. */
  notes: string;
  round: number | null;
  filesPath: string;
  metrics: Record<string, number>;
  createdAt: string;
}

export interface VersionInput {
  version: string;
  notes?: string;
  round?: number;
  filesPath: string;
  metrics?: Record<string, number>;
  at?: string;
}

export interface CategoryScore {
  mean: number;
  count: number;
}

export interface ScoredEntry extends Entry {
  scores: Record<string, CategoryScore>;
  overall: number | null;
  reviewCount: number;
  /** Filename of the card image, inside this entry's `shots/`. Null when nobody ever ran it. */
  thumb: string | null;
}

export interface Review {
  id: number;
  entryId: string;
  reviewer: string;
  notes: string;
  scores: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface ListQuery {
  sort?: string;
  genre?: string;
  model?: string;
  theme?: string;
  brief?: string;
  scenario?: string;
  q?: string;
  /** Draft entries are runs still in progress. Excluded unless asked for. */
  includeDrafts?: boolean;
  limit?: number;
  offset?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'draft',
  registered    INTEGER NOT NULL DEFAULT 0,
  live          INTEGER NOT NULL DEFAULT 0,

  title         TEXT,
  tagline       TEXT,
  description   TEXT,
  instructions  TEXT,
  genre         TEXT,

  run_id        TEXT NOT NULL,
  scenario      TEXT NOT NULL DEFAULT '',
  brief         TEXT NOT NULL DEFAULT '',
  theme         TEXT NOT NULL DEFAULT '',
  theme_id      TEXT NOT NULL DEFAULT '',
  rounds        INTEGER NOT NULL DEFAULT 0,
  seed          INTEGER,
  artifact_path TEXT NOT NULL DEFAULT '',
  entry_file    TEXT NOT NULL DEFAULT 'index.html',
  tai_version   TEXT NOT NULL DEFAULT '',
  sim_version   TEXT NOT NULL DEFAULT '',
  git_sha       TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  base_url      TEXT NOT NULL DEFAULT '',
  model_meta    TEXT NOT NULL DEFAULT '{}',
  credits       TEXT NOT NULL DEFAULT '{}',
  metrics       TEXT NOT NULL DEFAULT '{}',

  files_path    TEXT,
  download_path TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  published_at  TEXT
);

CREATE INDEX IF NOT EXISTS entries_status  ON entries(status);
CREATE INDEX IF NOT EXISTS entries_created ON entries(created_at);

CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  version    TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  round      INTEGER,
  files_path TEXT NOT NULL,
  metrics    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS versions_entry ON versions(entry_id, id);

CREATE TABLE IF NOT EXISTS media (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL DEFAULT 'image',
  file     TEXT NOT NULL,
  caption  TEXT NOT NULL DEFAULT '',
  round    INTEGER,
  ord      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS media_entry ON media(entry_id, ord);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  reviewer   TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entry_id, reviewer)
);

/*
 * What the team said and did, newest last.
 *
 * Rolling rather than complete: this exists so a person can watch a jam happen,
 * not so the run can be replayed. The run's own trace is the complete record
 * and stays the complete record — duplicating it here would put a second copy
 * of every message in a database whose value is that it outlives the worktree.
 */
CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  round    INTEGER NOT NULL DEFAULT 0,
  kind     TEXT NOT NULL,
  agent    TEXT NOT NULL DEFAULT '',
  room     TEXT NOT NULL DEFAULT '',
  body     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS activity_entry ON activity(entry_id, id);

CREATE TABLE IF NOT EXISTS review_scores (
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  category  TEXT NOT NULL,
  score     INTEGER NOT NULL,
  PRIMARY KEY (review_id, category)
);
`;

interface EntryRow {
  id: string;
  slug: string;
  status: string;
  registered: number;
  live: number;
  title: string | null;
  tagline: string | null;
  description: string | null;
  instructions: string | null;
  genre: string | null;
  run_id: string;
  scenario: string;
  brief: string;
  theme: string;
  theme_id: string;
  rounds: number;
  seed: number | null;
  artifact_path: string;
  entry_file: string;
  tai_version: string;
  sim_version: string;
  git_sha: string;
  model: string;
  provider: string;
  base_url: string;
  model_meta: string;
  credits: string;
  metrics: string;
  files_path: string | null;
  download_path: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface VersionRow {
  id: number;
  entry_id: string;
  version: string;
  notes: string;
  round: number | null;
  files_path: string;
  metrics: string;
  created_at: string;
}

function hydrateVersion(row: VersionRow): Version {
  return {
    id: row.id,
    entryId: row.entry_id,
    version: row.version,
    notes: row.notes,
    round: row.round,
    filesPath: row.files_path,
    metrics: parseJson<Record<string, number>>(row.metrics, {}),
    createdAt: row.created_at,
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function hydrate(row: EntryRow): Entry {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status === "published" ? "published" : "draft",
    registered: row.registered === 1,
    live: row.live === 1,
    title: row.title ?? undefined,
    tagline: row.tagline ?? undefined,
    description: row.description ?? undefined,
    instructions: row.instructions ?? undefined,
    genre: row.genre ?? undefined,
    runId: row.run_id,
    scenario: row.scenario,
    brief: row.brief,
    theme: row.theme,
    themeId: row.theme_id,
    rounds: row.rounds,
    seed: row.seed,
    artifactPath: row.artifact_path,
    entryFile: row.entry_file,
    taiVersion: row.tai_version,
    simVersion: row.sim_version,
    gitSha: row.git_sha,
    model: row.model,
    provider: row.provider,
    baseUrl: row.base_url,
    modelMeta: parseJson<Record<string, unknown>>(row.model_meta, {}),
    credits: parseJson<Record<string, string>>(row.credits, {}),
    metrics: parseJson<Record<string, number>>(row.metrics, {}),
    filesPath: row.files_path,
    downloadPath: row.download_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/**
 * Turn a title into something that can live in a URL.
 *
 * Falls back to the run id when a title is empty or reduces to nothing — a team
 * that registers with a title of `"???"` still needs a page.
 */
export function slugify(raw: string, fallback: string): string {
  const slug = String(raw ?? "")
    .toLowerCase()
    // NFD, not NFKD. Canonical decomposition splits an accent off its letter so
    // the combining mark can be dropped; the *compatibility* form additionally
    // expands symbols into the letters they resemble, which turns `Tower™` into
    // `tower-tm` — an accent removed is the same word, a trademark sign spelled
    // out is not.
    .normalize("NFD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export class ArcadeStore {
  readonly home: string;
  readonly db: Database.Database;

  constructor(home?: string) {
    this.home = arcadeHome(home);
    mkdirSync(join(this.home, "games"), { recursive: true });
    this.db = new Database(join(this.home, "arcade.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(ARCADE_SCHEMA_VERSION));
  }

  /**
   * Columns added to `entries` after the first release.
   *
   * `CREATE TABLE IF NOT EXISTS` in `SCHEMA` covers a new *table* but says
   * nothing about a new *column* on a table that already exists, and the board
   * this runs against is months of games that must not be rebuilt to gain a
   * flag. So each addition is applied on open if the column is missing, which
   * is idempotent and cheap — `table_info` on a table with a dozen rows.
   *
   * Additive only. A migration here may never drop or rewrite a column: the
   * arcade is the record of what was built, and a schema change is not a reason
   * to lose any of it.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(entries)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("live")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN live INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.db.close();
  }

  /** `<home>/games/<id>` — where a published copy of one game lives. */
  gameDir(id: string): string {
    return join(this.home, "games", id);
  }

  // ---------------------------------------------------------------- entries

  /**
   * Open a draft for a run that has just started.
   *
   * Created at the *start* rather than at registration time so the agents have
   * something to read on turn one and so a run that dies half-way still leaves
   * a row saying it happened. Idempotent on `runId`: a resumed or re-entered
   * run gets the same draft back rather than a second one.
   */
  createEntry(provenance: EntryProvenance): Entry {
    const existing = this.db.prepare("SELECT * FROM entries WHERE run_id = ?").get(provenance.runId) as
      | EntryRow
      | undefined;
    if (existing) return hydrate(existing);

    const now = provenance.createdAt ?? new Date().toISOString();
    const id = provenance.runId;
    const slug = this.uniqueSlug(slugify(provenance.runId, id));
    this.db
      .prepare(
        `INSERT INTO entries (
           id, slug, status, registered, live, run_id, scenario, brief, theme, theme_id, rounds, seed,
           artifact_path, entry_file, tai_version, sim_version, git_sha, model, provider, base_url,
           model_meta, credits, created_at, updated_at
         ) VALUES (
           @id, @slug, 'draft', 0, 1, @runId, @scenario, @brief, @theme, @themeId, @rounds, @seed,
           @artifactPath, @entryFile, @taiVersion, @simVersion, @gitSha, @model, @provider, @baseUrl,
           @modelMeta, @credits, @now, @now
         )`,
      )
      .run({
        id,
        slug,
        runId: provenance.runId,
        scenario: provenance.scenario,
        brief: provenance.brief,
        theme: provenance.theme,
        themeId: provenance.themeId,
        rounds: provenance.rounds,
        seed: provenance.seed,
        artifactPath: provenance.artifactPath,
        entryFile: provenance.entryFile,
        taiVersion: provenance.taiVersion,
        simVersion: provenance.simVersion,
        gitSha: provenance.gitSha,
        model: provenance.model,
        provider: provenance.provider,
        baseUrl: provenance.baseUrl,
        modelMeta: JSON.stringify(provenance.modelMeta ?? {}),
        credits: JSON.stringify(provenance.credits ?? {}),
        now,
      });
    return this.entry(id) as Entry;
  }

  entry(id: string): Entry | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  entryBySlug(slug: string): Entry | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE slug = ?").get(slug) as EntryRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  /**
   * Write the fields a team owns, and nothing else.
   *
   * The scoping is structural rather than checked: there is no parameter here
   * for *which* entry beyond the id the caller was handed, and the only columns
   * this statement can reach are the five in `REGISTRATION_FIELDS`. A tool
   * bound to one id therefore cannot express an edit to another team's row even
   * if it wanted to, which is a stronger guarantee than validating an argument.
   */
  register(id: string, fields: Registration): Entry {
    const entry = this.entry(id);
    if (!entry) throw new Error(`no such entry: ${id}`);

    const updates: Record<string, unknown> = {};
    if (typeof fields.title === "string" && fields.title.trim()) updates.title = fields.title.trim().slice(0, 120);
    if (typeof fields.tagline === "string") updates.tagline = fields.tagline.trim().slice(0, 240);
    if (typeof fields.description === "string") updates.description = fields.description.trim().slice(0, 8000);
    if (typeof fields.instructions === "string") updates.instructions = fields.instructions.trim().slice(0, 4000);
    if (fields.genre !== undefined) updates.genre = normaliseGenre(fields.genre);

    if (Object.keys(updates).length === 0) return entry;

    // The slug follows the title until the entry is published, and is frozen
    // after — a published URL that changes because somebody edited a title is a
    // dead link in whatever was already written down.
    if (updates.title && entry.status === "draft") {
      updates.slug = this.uniqueSlug(slugify(String(updates.title), entry.id), entry.id);
    }
    updates.registered = 1;
    updates.updated_at = new Date().toISOString();

    const assignments = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(", ");
    this.db.prepare(`UPDATE entries SET ${assignments} WHERE id = @id`).run({ ...updates, id });
    return this.entry(id) as Entry;
  }

  /**
   * Freeze a run: attach its final counters, its copied files, and its media.
   *
   * Publishing is what makes an entry visible on the site and readable by the
   * next run's agents. A draft is deliberately invisible to `list()` — a team
   * browsing mid-jam should not be reading a half-written pitch from a run that
   * is still going, least of all its own.
   */
  /**
   * A run saying it is still alive, and how far it has got.
   *
   * Called every round while a jam is in progress. It writes the same counter
   * bag `publish` eventually writes, which is what lets the live panel and a
   * finished entry share one renderer instead of growing a second shape for
   * the same numbers.
   *
   * `updated_at` moving is the load-bearing half. A jam takes over two hours,
   * so a board that has not changed since breakfast looks exactly like a loop
   * that died at breakfast — and "in progress" on a row whose last sign of life
   * was ninety minutes ago is worse than saying nothing, because it is a claim
   * rather than an omission.
   *
   * Refuses to touch a finished entry: a finished game's numbers are final, and
   * a late heartbeat from a run that already wrote its manifest must not
   * rewrite them.
   *
   * Gated on `live` rather than on `status = 'draft'` because those stopped
   * meaning the same thing when teams gained the ability to submit a build
   * mid-jam. A team that ships `0.4.0` at round twelve is published and still
   * building, and its heartbeat has fourteen rounds left to report.
   */
  progress(id: string, input: { metrics: Record<string, number>; at?: string }): void {
    const now = input.at ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE entries SET metrics = @metrics, updated_at = @now
          WHERE id = @id AND live = 1`,
      )
      .run({ id, metrics: JSON.stringify(input.metrics), now });
  }

  /**
   * The frame the live panel shows, written straight into the entry's own
   * `shots/` so the existing `/shots/:slug/:file` route serves it unchanged.
   *
   * Always the same filename. A live view wants the newest frame and nothing
   * else, and a directory that accumulates one PNG per playtest for a run that
   * is later discarded is litter with a retention policy attached.
   */
  liveShot(id: string, bytes: Buffer): void {
    const dir = join(this.gameDir(id), "shots");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LIVE_SHOT), bytes);
  }

  /**
   * Record what the team just said or did.
   *
   * Trimmed to {@link ACTIVITY_KEEP} rows per entry on write. A jam produces a
   * couple of hundred messages and some of them are essays, so an untrimmed
   * feed is a slow page for the one view nobody scrolls to the bottom of —
   * and the complete record already exists in the run's trace.
   *
   * Bodies are clipped rather than stored whole for the same reason. The cut is
   * marked, because a message that merely *looks* like it ended mid-sentence
   * would read as an agent that stopped mid-sentence.
   */
  addActivity(entryId: string, rows: ActivityInput[]): void {
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO activity (entry_id, at, round, kind, agent, room, body)
       VALUES (@entryId, @at, @round, @kind, @agent, @room, @body)`,
    );
    const write = this.db.transaction((batch: ActivityInput[]) => {
      for (const row of batch) {
        const body = row.body ?? "";
        insert.run({
          entryId,
          at: row.at ?? new Date().toISOString(),
          round: row.round ?? 0,
          kind: row.kind,
          agent: row.agent ?? "",
          room: row.room ?? "",
          body: body.length > ACTIVITY_BODY_MAX ? `${body.slice(0, ACTIVITY_BODY_MAX)}…` : body,
        });
      }
      this.db
        .prepare(
          `DELETE FROM activity WHERE entry_id = ? AND id NOT IN (
             SELECT id FROM activity WHERE entry_id = ? ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(entryId, entryId, ACTIVITY_KEEP);
    });
    write(rows);
  }

  /** The feed, oldest first, which is the order a conversation reads in. */
  activity(entryId: string, limit = ACTIVITY_KEEP): ActivityRow[] {
    const rows = this.db
      .prepare("SELECT * FROM activity WHERE entry_id = ? ORDER BY id DESC LIMIT ?")
      .all(entryId, Math.max(1, Math.min(ACTIVITY_KEEP, limit))) as ActivityRow[];
    return rows.reverse();
  }

  /**
   * A team putting a build on the board without ending its jam.
   *
   * This is the whole point of versions: before it existed a run had exactly
   * one chance to publish, at the horizon, so the rational move was to freeze
   * the code well before the end and spend the remaining rounds proving it
   * still worked. A team that can ship `0.4.0` and carry on has no reason to
   * stop early, and a run that is killed at round sixteen leaves a playable
   * game behind instead of a directory somebody has to rescue by hand.
   *
   * The entry becomes `published` on the first submit — submitting *is* what
   * publishing means at a jam — but stays `live`, so heartbeats keep landing
   * and the site can say "playable, still building". `files_path` moves to the
   * newest build, which is what `/play/:slug` serves, and every earlier build
   * stays on disk and in the table.
   */
  submitVersion(id: string, input: VersionInput): Version {
    const entry = this.entry(id);
    if (!entry) throw new Error(`no such entry: ${id}`);
    const now = input.at ?? new Date().toISOString();
    const version = input.version.trim() || "0.1.0";

    const submit = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO versions (entry_id, version, notes, round, files_path, metrics, created_at)
           VALUES (@entryId, @version, @notes, @round, @filesPath, @metrics, @now)`,
        )
        .run({
          entryId: id,
          version,
          notes: input.notes ?? "",
          round: input.round ?? null,
          filesPath: input.filesPath,
          metrics: JSON.stringify(input.metrics ?? {}),
          now,
        });
      // `published_at` is COALESCEd so the board keeps saying when the game
      // first appeared rather than when it was last touched.
      this.db
        .prepare(
          `UPDATE entries
              SET status = 'published',
                  files_path = @filesPath,
                  published_at = COALESCE(published_at, @now),
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ id, filesPath: input.filesPath, now });
      return this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    });

    const { id: rowId } = submit();
    return this.version(rowId) as Version;
  }

  /** Every build a team submitted, newest first. */
  versions(entryId: string): Version[] {
    const rows = this.db
      .prepare("SELECT * FROM versions WHERE entry_id = ? ORDER BY id DESC")
      .all(entryId) as VersionRow[];
    return rows.map(hydrateVersion);
  }

  version(rowId: number): Version | undefined {
    const row = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(rowId) as VersionRow | undefined;
    return row ? hydrateVersion(row) : undefined;
  }

  /** The run is over: stop the heartbeat gate, whatever else happened. */
  endRun(id: string): void {
    this.db.prepare("UPDATE entries SET live = 0 WHERE id = ?").run(id);
  }

  publish(
    id: string,
    input: {
      metrics?: Record<string, number>;
      filesPath?: string | null;
      downloadPath?: string | null;
      media?: { kind?: string; file: string; caption?: string; round?: number }[];
      /** When it was finished, if that is not now. Imports of old runs pass this. */
      at?: string;
    },
  ): Entry {
    const entry = this.entry(id);
    if (!entry) throw new Error(`no such entry: ${id}`);
    const now = input.at ?? new Date().toISOString();

    this.db
      .prepare(
        `UPDATE entries
            SET status = 'published',
                live = 0,
                metrics = @metrics,
                files_path = @filesPath,
                download_path = @downloadPath,
                published_at = COALESCE(published_at, @now),
                updated_at = @now
          WHERE id = @id`,
      )
      .run({
        id,
        metrics: JSON.stringify(input.metrics ?? entry.metrics ?? {}),
        filesPath: input.filesPath ?? entry.filesPath ?? null,
        downloadPath: input.downloadPath ?? entry.downloadPath ?? null,
        now,
      });

    if (input.media) {
      this.db.prepare("DELETE FROM media WHERE entry_id = ?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO media (entry_id, kind, file, caption, round, ord) VALUES (?, ?, ?, ?, ?, ?)",
      );
      input.media.forEach((item, index) => {
        insert.run(id, item.kind ?? "image", item.file, item.caption ?? "", item.round ?? null, index);
      });
    }
    return this.entry(id) as Entry;
  }

  media(id: string): { kind: string; file: string; caption: string; round: number | null }[] {
    return this.db.prepare("SELECT kind, file, caption, round FROM media WHERE entry_id = ? ORDER BY ord").all(id) as {
      kind: string;
      file: string;
      caption: string;
      round: number | null;
    }[];
  }

  private uniqueSlug(base: string, exceptId?: string): string {
    const taken = this.db.prepare("SELECT id FROM entries WHERE slug = ?");
    let candidate = base;
    let n = 2;
    for (;;) {
      const row = taken.get(candidate) as { id: string } | undefined;
      if (!row || row.id === exceptId) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
    }
  }

  // ------------------------------------------------------------------ query

  /**
   * The board.
   *
   * Sorting by a score happens in JS rather than SQL on purpose: `overall` is
   * the mean of category means (see `overallScore`), which SQL can express only
   * as a subquery per category, and the number of entries here is measured in
   * hundreds. When that stops being true this becomes a materialised column and
   * the definition stays in one place.
   */
  /** The WHERE clause a `ListQuery` describes, shared by `list` and `count`. */
  private filter(query: ListQuery): { clause: string; params: Record<string, unknown> } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (!query.includeDrafts) where.push("status = 'published'");
    for (const [key, column] of [
      ["genre", "genre"],
      ["model", "model"],
      ["theme", "theme"],
      ["brief", "brief"],
      ["scenario", "scenario"],
    ] as const) {
      const value = query[key];
      if (value) {
        where.push(`${column} = @${key}`);
        params[key] = value;
      }
    }
    if (query.q) {
      where.push(
        "(LOWER(COALESCE(title,'')) LIKE @q OR LOWER(COALESCE(tagline,'')) LIKE @q OR LOWER(COALESCE(description,'')) LIKE @q)",
      );
      params.q = `%${query.q.toLowerCase()}%`;
    }
    return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  list(query: ListQuery = {}): ScoredEntry[] {
    const { clause, params } = this.filter(query);
    const rows = this.db.prepare(`SELECT * FROM entries ${clause}`).all(params) as EntryRow[];

    const entries = rows.map(hydrate);
    const scored = this.attachScores(entries);
    const sorted = sortEntries(scored, query.sort ?? "recent");
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit === undefined ? sorted.length : Math.max(0, query.limit);
    return sorted.slice(offset, offset + limit);
  }

  /**
   * How many rows match, without scoring any of them.
   *
   * This used to be `list().length`, which meant every call to `/api/health`
   * loaded and scored the entire board. Harmless at three games and silly at
   * three hundred, and the fix is the same query the listing already builds.
   */
  count(query: ListQuery = {}): number {
    const { clause, params } = this.filter(query);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM entries ${clause}`).get(params) as { n: number }).n;
  }

  scored(id: string): ScoredEntry | undefined {
    const entry = this.entry(id);
    return entry ? this.attachScores([entry])[0] : undefined;
  }

  /**
   * Scores, review counts and card images for a whole page of entries.
   *
   * Three queries for the page rather than three per row. Per-row was correct
   * and would have made a hundred-game board three hundred round trips; SQLite
   * is fast enough that nobody would have noticed until it was a habit.
   */
  private attachScores(entries: Entry[]): ScoredEntry[] {
    if (entries.length === 0) return [];
    const ids = entries.map((e) => e.id);
    const holes = ids.map(() => "?").join(",");

    const scoreRows = this.db
      .prepare(
        `SELECT r.entry_id AS id, rs.category AS category, AVG(rs.score) AS mean, COUNT(*) AS n
           FROM review_scores rs
           JOIN reviews r ON r.id = rs.review_id
          WHERE r.entry_id IN (${holes})
          GROUP BY r.entry_id, rs.category`,
      )
      .all(...ids) as { id: string; category: string; mean: number; n: number }[];

    const counts = this.db
      .prepare(`SELECT entry_id AS id, COUNT(*) AS n FROM reviews WHERE entry_id IN (${holes}) GROUP BY entry_id`)
      .all(...ids) as { id: string; n: number }[];

    // A mid-play frame from the final playtest, falling back to whatever exists.
    // A title screen makes every card in the grid look identical, which is the
    // one thing a board of a hundred games cannot afford.
    const thumbs = this.db
      .prepare(
        `SELECT entry_id AS id, file FROM media
          WHERE entry_id IN (${holes})
          ORDER BY entry_id, (kind = 'shot') DESC, (file LIKE '%playing%') DESC, ord`,
      )
      .all(...ids) as { id: string; file: string }[];

    const byId = new Map<string, Record<string, CategoryScore>>();
    for (const row of scoreRows) {
      if (!CATEGORY_KEYS.includes(row.category)) continue;
      const bucket = byId.get(row.id) ?? {};
      bucket[row.category] = { mean: round2(row.mean), count: row.n };
      byId.set(row.id, bucket);
    }
    const reviewCounts = new Map(counts.map((row) => [row.id, row.n]));
    const firstThumb = new Map<string, string>();
    for (const row of thumbs) if (!firstThumb.has(row.id)) firstThumb.set(row.id, row.file);

    return entries.map((entry) => {
      const scores = byId.get(entry.id) ?? {};
      return {
        ...entry,
        scores,
        overall: overallScore(scores),
        reviewCount: reviewCounts.get(entry.id) ?? 0,
        thumb: firstThumb.get(entry.id) ?? null,
      };
    });
  }

  /** Distinct values for the filter menus, drawn from what actually exists. */
  facets(): { genres: string[]; models: string[]; themes: string[]; briefs: string[]; scenarios: string[] } {
    const distinct = (column: string): string[] =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT ${column} AS v FROM entries WHERE status = 'published' AND ${column} <> '' ORDER BY v`,
          )
          .all() as { v: string | null }[]
      )
        .map((row) => row.v)
        .filter((v): v is string => !!v);
    return {
      genres: distinct("COALESCE(genre,'')"),
      models: distinct("model"),
      themes: distinct("theme"),
      briefs: distinct("brief"),
      scenarios: distinct("scenario"),
    };
  }

  // ---------------------------------------------------------------- reviews

  /**
   * One review per person per game, replaced rather than appended.
   *
   * A second opinion from the same person is a correction, not a second data
   * point, and averaging both would let anyone who changed their mind count
   * twice. Categories left blank are deleted rather than kept at their old
   * value — clearing a score has to be expressible.
   */
  saveReview(entryId: string, reviewer: string, scores: Record<string, unknown>, notes?: string): Review | undefined {
    const name = String(reviewer ?? "")
      .trim()
      .slice(0, 60);
    if (!name) throw new Error("a review needs a reviewer name");
    if (!this.entry(entryId)) throw new Error(`no such entry: ${entryId}`);
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (entry_id, reviewer, notes, created_at, updated_at)
                VALUES (@entryId, @reviewer, @notes, @now, @now)
           ON CONFLICT(entry_id, reviewer) DO UPDATE
                SET notes = excluded.notes, updated_at = excluded.updated_at`,
        )
        .run({ entryId, reviewer: name, notes: String(notes ?? "").slice(0, 4000), now });
      const row = this.db.prepare("SELECT id FROM reviews WHERE entry_id = ? AND reviewer = ?").get(entryId, name) as {
        id: number;
      };

      this.db.prepare("DELETE FROM review_scores WHERE review_id = ?").run(row.id);
      const insert = this.db.prepare("INSERT INTO review_scores (review_id, category, score) VALUES (?, ?, ?)");
      for (const key of CATEGORY_KEYS) {
        const value = cleanScore(scores?.[key]);
        if (value !== null) insert.run(row.id, key, value);
      }
    });
    run();
    return this.review(entryId, name);
  }

  review(entryId: string, reviewer: string): Review | undefined {
    const row = this.db
      .prepare("SELECT * FROM reviews WHERE entry_id = ? AND reviewer = ?")
      .get(entryId, String(reviewer ?? "").trim()) as
      | { id: number; entry_id: string; reviewer: string; notes: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return this.hydrateReview(row);
  }

  reviews(entryId: string): Review[] {
    const rows = this.db.prepare("SELECT * FROM reviews WHERE entry_id = ? ORDER BY updated_at DESC").all(entryId) as {
      id: number;
      entry_id: string;
      reviewer: string;
      notes: string;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((row) => this.hydrateReview(row));
  }

  private hydrateReview(row: {
    id: number;
    entry_id: string;
    reviewer: string;
    notes: string;
    created_at: string;
    updated_at: string;
  }): Review {
    const scoreRows = this.db.prepare("SELECT category, score FROM review_scores WHERE review_id = ?").all(row.id) as {
      category: string;
      score: number;
    }[];
    const scores: Record<string, number> = {};
    for (const scoreRow of scoreRows) scores[scoreRow.category] = scoreRow.score;
    return {
      id: row.id,
      entryId: row.entry_id,
      reviewer: row.reviewer,
      notes: row.notes,
      scores,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * The orderings the board offers.
 *
 * `overall` and any category key push unreviewed games to the bottom rather
 * than treating a missing score as zero — an unjudged game is not a bad game,
 * and burying it under the ones with a 1.0 would be a lie the sort order tells.
 */
export function sortEntries(entries: ScoredEntry[], sort: string): ScoredEntry[] {
  const rows = [...entries];
  const byDateDesc = (a: ScoredEntry, b: ScoredEntry) =>
    (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt);

  if (sort === "oldest") return rows.sort((a, b) => -byDateDesc(a, b));
  if (sort === "reviews") return rows.sort((a, b) => b.reviewCount - a.reviewCount || byDateDesc(a, b));
  if (sort === "title")
    return rows.sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug) || byDateDesc(a, b));

  if (sort === "overall" || CATEGORY_KEYS.includes(sort)) {
    const value = (entry: ScoredEntry): number | null =>
      sort === "overall" ? entry.overall : (entry.scores[sort]?.mean ?? null);
    return rows.sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === null && right === null) return byDateDesc(a, b);
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left || byDateDesc(a, b);
    });
  }
  return rows.sort(byDateDesc);
}
