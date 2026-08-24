/**
 * The arcade's HTTP surface: a JSON API, a static site, and a second server
 * that runs the games.
 *
 * ## Why two ports
 *
 * The games are written by a language model and then executed in the reviewer's
 * browser. That is the whole point and it is also the only genuinely
 * adversarial thing in this package. Served from the same origin as the API, a
 * game could `fetch("/api/entries/its-own-slug/reviews", …)` and give itself
 * fives — not because a model would, but because nothing would stop it, and a
 * review database that can be written by its own subjects is worth nothing.
 *
 * So games get their own port. Same host, different origin, no CORS headers on
 * the API, and the browser refuses the request for us. The alternative —
 * `<iframe sandbox="allow-scripts">` without `allow-same-origin` — also works
 * and costs more: it puts the game in an opaque origin where `localStorage`
 * throws, and a game that saves a high score would crash on load through no
 * fault of its own.
 *
 * Both servers bind to loopback. This is a local tool and there is no
 * authentication anywhere in it.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, CLAIMS, GATES, GENRES } from "./categories.js";
import { ArcadeStore, LIVE_SHOT } from "./store.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && MIME[path.slice(dot).toLowerCase()]) || "application/octet-stream";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * Serve one file from inside one directory, and refuse anything else.
 *
 * The containment check is on the *resolved* path rather than on the request
 * string, because `%2e%2e/` and `a/../../b` both survive a textual check and
 * neither survives this one.
 */
function sendFile(res: ServerResponse, root: string, relativePath: string, headers: Record<string, string> = {}): void {
  const full = resolve(root, `.${normalize(`/${relativePath}`)}`);
  if (full !== root && !full.startsWith(`${root}/`)) {
    json(res, 403, { error: "outside the served directory" });
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    json(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": mimeFor(full),
    "content-length": statSync(full).size,
    "cache-control": "no-cache",
    ...headers,
  });
  createReadStream(full).pipe(res);
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface ArcadeServer {
  site: Server;
  games: Server;
  store: ArcadeStore;
  url: string;
  gamesUrl: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  home?: string;
  port?: number;
  /** Defaults to `port + 1`. */
  gamesPort?: number;
  host?: string;
  store?: ArcadeStore;
}

export function createArcadeServer(options: ServeOptions = {}): ArcadeServer {
  const store = options.store ?? new ArcadeStore(options.home);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4321;
  const gamesPort = options.gamesPort ?? port + 1;
  const gamesUrl = `http://${host}:${gamesPort}`;

  const site = createServer((req, res) => {
    handleSite(req, res, store, gamesUrl).catch((err) => {
      json(res, 500, { error: String((err as Error).message ?? err) });
    });
  });
  const games = createServer((req, res) => {
    handleGame(req, res, store);
  });

  return {
    site,
    games,
    store,
    url: `http://${host}:${port}`,
    gamesUrl,
    close: () =>
      new Promise<void>((done) => {
        site.close(() => games.close(() => done()));
      }),
  };
}

export async function listen(server: ArcadeServer, options: ServeOptions = {}): Promise<ArcadeServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4321;
  const gamesPort = options.gamesPort ?? port + 1;
  await new Promise<void>((done, fail) => {
    server.site.once("error", fail);
    server.site.listen(port, host, () => done());
  });
  await new Promise<void>((done, fail) => {
    server.games.once("error", fail);
    server.games.listen(gamesPort, host, () => done());
  });
  return server;
}

async function handleSite(
  req: IncomingMessage,
  res: ServerResponse,
  store: ArcadeStore,
  gamesUrl: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://arcade.local");
  const path = decodeURIComponent(url.pathname);
  const q = url.searchParams;

  if (path === "/api/health") {
    const published = store.count();
    const total = store.count({ includeDrafts: true });
    // `total - published` is the number of jams currently running: a draft is
    // created when a run starts and published when its rounds run out. Worth
    // surfacing, because `jam:loop` runs for hours and a board that has not
    // changed since breakfast is otherwise indistinguishable from a loop that
    // died at breakfast.
    return json(res, 200, { ok: true, home: store.home, entries: total, published, inProgress: total - published });
  }

  /**
   * What is being built right now.
   *
   * A separate route from `/api/entries` rather than a `status=draft` filter on
   * it, because the two answer different questions and want different cache
   * behaviour: the board is a list somebody scrolls, and this is a thing that
   * changes every round and gets polled. Keeping them apart also means the
   * board's paging, sorting and facets never have to reason about a game that
   * has no scores and no screenshots yet.
   *
   * `stale` is computed here rather than in the browser so every surface agrees
   * on what counts as dead. A jam writes a heartbeat every round — roughly
   * every seven minutes — so twenty minutes of silence means the run is gone,
   * and saying "in progress" about it would be a claim rather than an omission.
   */
  if (path === "/api/live") {
    const now = Date.now();
    /*
     * `live`, not `status === "draft"`.
     *
     * Those meant the same thing until a team could submit a build mid-jam.
     * Now the good case — shipped `0.4.0` at round two and still building — is
     * `published`, and filtering on draft-ness dropped it from the panel
     * entirely: the run most worth watching was the one that disappeared. The
     * flag exists precisely to separate "the jam is still running" from "there
     * is something on the board".
     */
    const live = store.list({ includeDrafts: true, sort: "new", limit: 8 }).filter((e) => e.live);
    return json(res, 200, {
      live: live.map((entry) => {
        const since = now - Date.parse(entry.updatedAt || entry.createdAt);
        return {
          slug: entry.slug,
          title: entry.title ?? null,
          tagline: entry.tagline ?? null,
          theme: entry.theme,
          diversifier: entry.diversifier ?? null,
          rounds: entry.rounds,
          model: entry.model,
          seed: entry.seed,
          simVersion: entry.simVersion,
          registered: entry.registered,
          startedAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          elapsedMs: Math.max(0, now - Date.parse(entry.createdAt)),
          quietMs: Math.max(0, since),
          stale: since > 20 * 60 * 1000,
          metrics: entry.metrics,
          shot: existsSync(join(store.gameDir(entry.id), "shots", LIVE_SHOT)) ? LIVE_SHOT : null,
        };
      }),
    });
  }

  /**
   * One run, with what its agents have been saying and doing.
   *
   * Split from `/api/live` because the feed is much larger than the summary and
   * the board polls the summary every twenty seconds. `since` makes the detail
   * view cheap to keep open: it returns only what arrived after the id the
   * browser already has, so a two-hour watch does not re-send the transcript
   * every time it refreshes.
   */
  const liveOne = /^\/api\/live\/([^/]+)$/.exec(path);
  if (liveOne) {
    const entry = store.entryBySlug(liveOne[1]);
    if (!entry) return json(res, 404, { error: "no such run" });
    const since = Number(q.get("since") ?? 0);
    const all = store.activity(entry.id);
    const activity = Number.isFinite(since) && since > 0 ? all.filter((row) => row.id > since) : all;
    const now = Date.now();
    const quiet = now - Date.parse(entry.updatedAt || entry.createdAt);
    return json(res, 200, {
      run: {
        slug: entry.slug,
        title: entry.title ?? null,
        tagline: entry.tagline ?? null,
        theme: entry.theme,
        diversifier: entry.diversifier ?? null,
        rounds: entry.rounds,
        model: entry.model,
        seed: entry.seed,
        simVersion: entry.simVersion,
        brief: entry.brief,
        registered: entry.registered,
        status: entry.status,
        startedAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        elapsedMs: Math.max(0, now - Date.parse(entry.createdAt)),
        stale: entry.status === "draft" && quiet > 20 * 60 * 1000,
        metrics: entry.metrics,
        credits: entry.credits,
        shot: existsSync(join(store.gameDir(entry.id), "shots", LIVE_SHOT)) ? LIVE_SHOT : null,
      },
      activity,
      // The browser sends this back as `since`. Taken from the full feed rather
      // than the filtered one, or a poll that returns nothing would reset the
      // cursor and re-send everything on the following poll.
      cursor: all.length ? all[all.length - 1].id : since,
    });
  }

  if (path === "/api/config") {
    return json(res, 200, {
      categories: CATEGORIES,
      // Answered yes/no and never averaged. The form has to ask them or the
      // site and the offline scorecard drift, which is the exact failure the
      // single-source-of-truth in categories.ts exists to prevent.
      gates: GATES,
      claims: CLAIMS,
      genres: GENRES,
      gamesUrl,
      sorts: [
        { key: "overall", label: "Overall score" },
        ...CATEGORIES.map((c) => ({ key: c.key, label: c.name })),
        { key: "recent", label: "Date added (newest)" },
        { key: "oldest", label: "Date added (oldest)" },
        { key: "reviews", label: "Most reviewed" },
        { key: "title", label: "Title" },
      ],
    });
  }

  if (path === "/api/facets") return json(res, 200, store.facets());

  if (path === "/api/entries" && req.method === "GET") {
    const entries = store.list({
      sort: q.get("sort") ?? "recent",
      genre: q.get("genre") ?? undefined,
      model: q.get("model") ?? undefined,
      theme: q.get("theme") ?? undefined,
      brief: q.get("brief") ?? undefined,
      scenario: q.get("scenario") ?? undefined,
      q: q.get("q") ?? undefined,
      includeDrafts: q.get("drafts") === "1",
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    return json(res, 200, { entries });
  }

  const detail = /^\/api\/entries\/([^/]+)$/.exec(path);
  if (detail && req.method === "GET") {
    const entry = store.entryBySlug(detail[1]);
    if (!entry) return json(res, 404, { error: "no such game" });
    const reviewer = q.get("reviewer") ?? "";
    return json(res, 200, {
      entry: store.scored(entry.id),
      media: store.media(entry.id),
      reviews: store.reviews(entry.id),
      yourReview: reviewer ? (store.review(entry.id, reviewer) ?? null) : null,
      playUrl: `${gamesUrl}/play/${entry.slug}/`,
      // Build history, newest first. Absent `filesPath`: which directory on this
      // machine holds a build is provenance for the run, not something a page
      // needs, and a path is the kind of thing that ends up rendered by mistake.
      versions: store.versions(entry.id).map((v) => ({
        version: v.version,
        notes: v.notes,
        round: v.round,
        metrics: v.metrics,
        auto: v.auto,
        createdAt: v.createdAt,
      })),
    });
  }

  const review = /^\/api\/entries\/([^/]+)\/reviews$/.exec(path);
  if (review && req.method === "POST") {
    const entry = store.entryBySlug(review[1]);
    if (!entry) return json(res, 404, { error: "no such game" });
    const body = (await readBody(req)) as { reviewer?: string; scores?: Record<string, unknown>; notes?: string };
    try {
      const saved = store.saveReview(entry.id, String(body.reviewer ?? ""), body.scores ?? {}, body.notes);
      return json(res, 200, { review: saved, entry: store.scored(entry.id) });
    } catch (err) {
      return json(res, 400, { error: String((err as Error).message ?? err) });
    }
  }

  const download = /^\/api\/entries\/([^/]+)\/download$/.exec(path);
  if (download) {
    const entry = store.entryBySlug(download[1]);
    if (!entry?.downloadPath || !existsSync(entry.downloadPath)) {
      return json(res, 404, { error: "no archive for this game" });
    }
    const data = readFileSync(entry.downloadPath);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": data.length,
      "content-disposition": `attachment; filename="${entry.slug}.zip"`,
    });
    return void res.end(data);
  }

  const shot = /^\/shots\/([^/]+)\/(.+)$/.exec(path);
  if (shot) {
    const entry = store.entryBySlug(shot[1]);
    if (!entry) return json(res, 404, { error: "no such game" });
    return sendFile(res, join(store.gameDir(entry.id), "shots"), shot[2]);
  }

  const doc = /^\/artifact\/([^/]+)\/(brief|manifest|JUDGING)$/.exec(path);
  if (doc) {
    const entry = store.entryBySlug(doc[1]);
    if (!entry) return json(res, 404, { error: "no such game" });
    const file = doc[2] === "manifest" ? "manifest.json" : `${doc[2]}.md`;
    return sendFile(res, store.gameDir(entry.id), file);
  }

  /*
   * The team's own write-up, from inside the game rather than beside it.
   *
   * `submission.md` is the file the lead owns and is asked to write — title,
   * pitch, controls, how it uses the theme — and it is very often good even
   * when nobody filled in the arcade form. Every run that predates the arcade
   * is in exactly that state, and so is any run whose lead wrote the file and
   * forgot to register. Serving it lets the page show the real pitch instead of
   * "the team never wrote a description", labelled as what it is.
   */
  const writeup = /^\/artifact\/([^/]+)\/submission$/.exec(path);
  if (writeup) {
    const entry = store.entryBySlug(writeup[1]);
    if (!entry?.filesPath) return json(res, 404, { error: "no such game" });
    return sendFile(res, resolve(entry.filesPath), "/submission.md");
  }

  if (path.startsWith("/api/")) return json(res, 404, { error: "no such endpoint" });

  // Everything else is the single-page site. Unknown paths return the shell so
  // a deep link survives a reload; the client routes on the hash.
  const asset = path === "/" ? "index.html" : path.slice(1);
  const candidate = resolve(webRoot, `.${normalize(`/${asset}`)}`);
  if (existsSync(candidate) && statSync(candidate).isFile()) return sendFile(res, webRoot, asset);
  return sendFile(res, webRoot, "index.html");
}

/**
 * The games server. Serves one directory per published game and nothing else.
 *
 * The CSP is the second belt after the separate origin: `connect-src 'none'`
 * means a game cannot make a network request at all, to us or to anywhere. It
 * needs `unsafe-inline` and `unsafe-eval` because the artifacts are hand-written
 * pages with inline scripts and that is what they are supposed to be.
 */
function handleGame(req: IncomingMessage, res: ServerResponse, store: ArcadeStore): void {
  const url = new URL(req.url ?? "/", "http://arcade.local");
  const path = decodeURIComponent(url.pathname);

  // The browser asks for this by itself on a top-level navigation, and a 404
  // puts a red line in the console of a page whose console is the first place
  // anybody looks when judging whether a game runs clean. No content is the
  // honest answer: there is no favicon here.
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  const match = /^\/play\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) {
    json(res, 404, { error: "not a game" });
    return;
  }
  const entry = store.entryBySlug(match[1]);
  if (!entry || !entry.filesPath || !existsSync(entry.filesPath)) {
    json(res, 404, { error: "this game has no playable copy" });
    return;
  }
  const rest = match[2] && match[2] !== "/" ? match[2] : `/${entry.entryFile || "index.html"}`;
  sendFile(res, resolve(entry.filesPath), rest, {
    "content-security-policy":
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "connect-src 'none'; " +
      "form-action 'none'; " +
      "base-uri 'none'; " +
      "frame-ancestors http://127.0.0.1:* http://localhost:*",
  });
}
