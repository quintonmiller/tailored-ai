/**
 * `eval watch` — a live view of a run that is still happening.
 *
 * The smallest thing that could work: a static file, an endpoint that returns
 * new trace events since a cursor, and a page that polls. No websockets, no
 * build step, no dependency — the viewer is one HTML file and this is ~90 lines
 * of `node:http`, which together are less machinery than a bundler config.
 *
 * Polling rather than pushing because the thing being watched writes to a file
 * at human speed. A turn takes twenty-odd seconds against a local model; a
 * page that checks every second and a half is indistinguishable from a live
 * stream and cannot get out of sync, wedge, or need reconnect logic.
 *
 * It also opens finished runs. A trace is the same artefact either way, so the
 * post-mortem view and the live view are the same page — which matters because
 * the post-mortem is where a 72-turn run actually gets read.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory } from "./history.js";
import { readTrace } from "./trace.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

/**
 * The newest trace on disk.
 *
 * The default because remembering a filename is exactly the friction that stops
 * anybody watching a run they have already started. `--trace <file>` overrides.
 */
export function newestTrace(dir = join(packageRoot, "results", "traces")): string | undefined {
  let entries: string[];
  try {
    // `.narration.ndjson` sits beside its trace and is written *after* it, so a
    // bare `.ndjson` filter makes the commentator's sidecar the newest file and
    // `watch` opens a run consisting entirely of narration. The sidecar is the
    // only companion file today; excluding by suffix keeps that a one-liner.
    entries = readdirSync(dir).filter((f) => f.endsWith(".ndjson") && !f.endsWith(".narration.ndjson"));
  } catch {
    return undefined;
  }
  const sorted = entries
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return sorted[0]?.path;
}

/** A file nobody has appended to for this long is a finished run, not a live one. */
const STALE_MS = 20_000;

export function serveWatch(tracePath: string | undefined, port: number, host = "127.0.0.1"): Promise<string> {
  // Read per request rather than once at startup. It is one small file and the
  // server is a dev tool: caching it means every edit to the viewer needs the
  // server restarted, which is exactly the loop you are in when you are working
  // on the viewer.
  const page = () => readFileSync(join(packageRoot, "viewer", "index.html"), "utf8");

  const traceDir = join(packageRoot, "results", "traces");
  // Rehearsals are read but never mixed in. They travel in their own list so
  // the record board can say where a run sits against the baseline ladder
  // without a bot ever becoming the record — which is the reason `rehearse`
  // writes to a different directory in the first place.
  const baselineDir = join(packageRoot, "results", "rehearsals");

  /**
   * Two pages over one data source.
   *
   * `/` is the developer viewer: dense, filterable, built to diagnose a run.
   * `/broadcast` is the show: a graphical stage meant to be watched by somebody
   * who is not debugging anything. They share the trace, the endpoint and the
   * server, and neither can break the other — which is the whole reason the
   * broadcast is a second page rather than a mode of the first one.
   */
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Past runs, for the scoreboard. Read per request like everything else here
    // — a run that finishes while the page is open should show up in it.
    if (url.pathname === "/history") {
      const scenario = url.searchParams.get("scenario") ?? undefined;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(readHistory(traceDir, scenario, Date.now(), { baselineDir })));
      return;
    }

    /**
     * Narration, if anybody has written any.
     *
     * A sidecar file beside the trace rather than events inside it, because the
     * narrator is a *model* and the run is a measurement. Writing its output
     * into the trace would put an observer's tokens inside the thing being
     * observed; keeping it alongside means a run is byte-identical whether or
     * not anybody was commentating on it.
     */
    if (url.pathname === "/narration") {
      const path = tracePath ?? newestTrace();
      const sidecar = path ? path.replace(/\.ndjson$/, ".narration.ndjson") : undefined;
      const since = Number(url.searchParams.get("since") ?? 0);
      const events = sidecar && existsSync(sidecar) ? readTrace(sidecar) : [];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ events: events.slice(since), total: events.length }));
      return;
    }

    // Static assets for the broadcast page. Confined to `viewer/` and resolved
    // through `resolve` so a `..` in the path cannot climb out of it.
    if (url.pathname.startsWith("/broadcast")) {
      const rest =
        url.pathname === "/broadcast" || url.pathname === "/broadcast/" ? "/broadcast/index.html" : url.pathname;
      const root = join(packageRoot, "viewer");
      const target = resolve(root, `.${rest}`);
      if (!target.startsWith(root)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      // The broadcast is a compiled bundle, and `dist/` is not committed. Say so
      // in the page rather than serving a shell that silently renders nothing —
      // a blank broadcast with a 404 in the console is the least diagnosable
      // failure this server can produce.
      if (!existsSync(target)) {
        if (rest.endsWith("broadcast.js")) {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(
            `document.body.innerHTML = '<pre style="color:#e8edf6;font:14px ui-monospace;padding:32px;line-height:1.6">` +
              `The broadcast bundle has not been built.\n\n  pnpm --filter @tailored-ai/evals run build:viewer\n\n` +
              `The developer viewer at / needs no build and is unaffected.</pre>';`,
          );
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const ext = target.slice(target.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(target));
      return;
    }

    if (url.pathname === "/events") {
      // Resolved per request rather than once at startup: `watch` is routinely
      // started before the run it is going to watch, and re-reading means the
      // page picks up a trace that did not exist when the server did.
      const path = tracePath ?? newestTrace();
      const since = Number(url.searchParams.get("since") ?? 0);
      const events = path ? readTrace(path) : [];
      let live = false;
      try {
        live = path ? Date.now() - statSync(path).mtimeMs < STALE_MS : false;
      } catch {
        live = false;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          // A shorter file than the client has already seen means a different
          // run started under the same name. Say so rather than appending one
          // run's events to another's.
          reset: events.length < since,
          events: events.length < since ? events : events.slice(since),
          live,
          file: path ? path.replace(`${packageRoot}/`, "") : "no trace found",
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page());
  });

  return new Promise((ok, fail) => {
    server.on("error", fail);
    server.listen(port, host, () => ok(`http://${host}:${port}`));
  });
}
