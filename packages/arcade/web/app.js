/**
 * The arcade front end.
 *
 * Plain modules, no build step, no framework. The whole site is two views and
 * one form; a bundler here would add a compile step to a package whose entire
 * value is that you can start it and look at it. `packages/evals/viewer` made
 * the other choice and needs `esbuild` run before anything renders.
 *
 * The one rule worth stating: every string that came out of the database goes
 * through `text()` or a `textContent` assignment. Titles and descriptions here
 * are written by a language model, and a model that emits a `<script>` tag into
 * its own game title should produce a silly-looking card, not an execution.
 */

const view = document.getElementById("view");
const reviewerInput = document.getElementById("reviewer");
const footCount = document.getElementById("foot-count");

let config = { categories: [], genres: [], sorts: [], gamesUrl: "" };

// ------------------------------------------------------------------ helpers

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const api = async (path) => {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
  return res.json();
};

const reviewer = () => localStorage.getItem("arcade.reviewer") ?? "";

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

/** The hash carries the whole view state, so a filtered board is a shareable URL. */
function route() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  return { path, params: new URLSearchParams(query ?? "") };
}

function setParams(params) {
  const query = params.toString();
  location.hash = query ? `/?${query}` : "/";
}

// -------------------------------------------------------------------- board

async function renderBoard(params) {
  view.replaceChildren(el("p", { class: "loading", text: "Loading…" }));
  const search = new URLSearchParams(params);
  if (!search.get("sort")) search.set("sort", "recent");
  const [{ entries }, facets] = await Promise.all([
    api(`/api/entries?${search.toString()}`),
    api("/api/facets"),
  ]);

  const controls = el("div", { class: "controls" });

  const select = (name, label, options, value, extra = {}) => {
    const node = el("select", {
      ...extra,
      onchange: (event) => {
        const next = new URLSearchParams(params);
        if (event.target.value) next.set(name, event.target.value);
        else next.delete(name);
        setParams(next);
      },
    });
    for (const option of options) {
      node.append(el("option", { value: option.key, text: option.label, selected: option.key === value }));
    }
    return el("div", { class: "control" }, [el("label", { text: label }), node]);
  };

  const any = (label) => [{ key: "", label }];

  controls.append(
    select("sort", "Sort by", config.sorts, params.get("sort") ?? "recent"),
    select(
      "genre",
      "Category",
      any("all categories").concat(facets.genres.map((g) => ({ key: g, label: g }))),
      params.get("genre") ?? "",
    ),
    select(
      "model",
      "Model",
      any("all models").concat(facets.models.map((m) => ({ key: m, label: m }))),
      params.get("model") ?? "",
    ),
    select(
      "theme",
      "Theme",
      any("all themes").concat(facets.themes.map((t) => ({ key: t, label: t }))),
      params.get("theme") ?? "",
    ),
  );

  const searchBox = el("input", {
    type: "search",
    placeholder: "search titles and pitches",
    value: params.get("q") ?? "",
  });
  let debounce;
  searchBox.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (searchBox.value.trim()) next.set("q", searchBox.value.trim());
      else next.delete("q");
      setParams(next);
    }, 250);
  });
  controls.append(el("div", { class: "control grow" }, [el("label", { text: "Search" }), searchBox]));

  const grid = el("div", { class: "grid" });
  for (const entry of entries) grid.append(card(entry));

  view.replaceChildren(
    controls,
    entries.length ? grid : el("p", { class: "empty", text: "Nothing here yet. Run the jam." }),
  );
  footCount.textContent = `${entries.length} game${entries.length === 1 ? "" : "s"}`;
  void showLive();
}

/**
 * What is being built right now, above the board.
 *
 * A jam takes over two hours, so without this a board that has not changed
 * since breakfast looks exactly like a loop that died at breakfast. It began as
 * a chip in the footer reading "1 jam in progress", which answered *whether*
 * and nothing else — and "something is happening somewhere" is the least
 * interesting true thing the site can say.
 *
 * Fetched after the board rather than with it, and it replaces itself in place
 * on each poll: a board that waits on a live panel is a worse board, and a
 * panel that rebuilds the page around it is a worse panel.
 */
const LIVE_POLL_MS = 20_000;
let livePoll;

async function showLive() {
  clearTimeout(livePoll);
  const data = await api("/api/live").catch(() => null);
  const running = (data?.live ?? []).filter((run) => !run.stale);

  const existing = document.getElementById("live");
  if (!running.length) {
    // No empty box. A section that says "nothing is running" is a section that
    // is wrong for most of the day.
    existing?.remove();
  } else {
    const panel = el("section", { class: "live panel", id: "live" }, [
      el("h2", {}, [
        el("span", { class: "pulse" }),
        running.length === 1 ? "Building now" : `Building now — ${running.length} jams`,
      ]),
      ...running.map(liveRow),
    ]);
    if (existing) existing.replaceWith(panel);
    else view.prepend(panel);
  }

  // Keep polling only while the tab is being looked at. A background tab
  // hitting this every twenty seconds for a day is pure waste.
  if (!document.hidden) livePoll = setTimeout(showLive, LIVE_POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void showLive();
});

// --------------------------------------------------------------- watch a jam

/**
 * One run, and what its agents are saying to each other.
 *
 * The panel on the board answers "how far along"; this answers "what is
 * happening". They are different questions and the second one is much heavier —
 * a couple of hundred messages, some of them essays — which is why it is a
 * route somebody chooses rather than something the board carries.
 *
 * Polls with a cursor, so a watch left open for two hours transfers each
 * message once instead of re-sending the transcript every eight seconds.
 */
const WATCH_POLL_MS = 8000;
let watchPoll;
let watchCursor = 0;

async function renderWatch(slug) {
  watchCursor = 0;
  view.replaceChildren(el("p", { class: "loading", text: "Loading…" }));
  const data = await api(`/api/live/${encodeURIComponent(slug)}`);
  const run = data.run;
  watchCursor = data.cursor ?? 0;

  const feed = el("div", { class: "feed", id: "feed" });
  if (data.activity.length === 0) {
    /*
     * Two different silences, and guessing wrong is worse than saying less.
     *
     * Before the first round is out, nobody has spoken yet and saying so is
     * useful. Deep into a run it means something else entirely — most likely a
     * jam that started before the feed existed — and "the first round is still
     * going" at round 3 is the page inventing a reason it does not have.
     */
    const early = (run.metrics?.roundsPlayed ?? 0) <= 1;
    feed.append(
      el("p", {
        class: "empty",
        text: early
          ? "Nothing said yet — the first round is still going."
          : "No transcript for this run. Jams that started before the feed existed do not have one.",
      }),
    );
  }
  for (const row of data.activity) feed.append(feedRow(row));

  const m = run.metrics ?? {};
  const round = Math.max(0, Math.min(run.rounds || 0, m.roundsPlayed ?? 0));

  view.replaceChildren(
    el("p", {}, [el("a", { class: "back", href: "#/", text: "← the board" })]),
    el("section", { class: "panel watch-head", id: "watch-head" }, [
      el("div", { class: "watch-title" }, [
        run.status === "draft" ? el("span", { class: "pulse" }) : null,
        el("h1", { text: run.title ?? "Untitled so far" }),
      ]),
      ...(run.tagline ? [el("p", { class: "live-tagline", text: run.tagline })] : []),
      el("div", { class: "chips" }, [
        el("span", { class: "chip theme", text: run.theme || "no theme" }),
        el("span", { class: "chip", text: `round ${round} of ${run.rounds}` }),
        el("span", { class: "chip", text: elapsed(run.elapsedMs) }),
        ...(run.model ? [el("span", { class: "chip", text: run.model })] : []),
        ...(run.status === "published" ? [el("span", { class: "chip flag", text: "finished" })] : []),
        ...(run.stale ? [el("span", { class: "chip flag", text: "no signal" })] : []),
      ]),
      el("div", { class: "live-bar" }, [
        el("div", {
          class: "live-bar-fill",
          style: `--fill:${run.rounds ? (round / run.rounds).toFixed(3) : 0}`,
        }),
      ]),
      watchFacts(run, m),
      ...(run.shot
        ? [
            el("div", { class: "watch-shot" }, [
              el("img", { src: `/shots/${encodeURIComponent(slug)}/${run.shot}?t=${Date.parse(run.updatedAt)}`, alt: "" }),
            ]),
          ]
        : []),
    ]),
    el("section", { class: "panel" }, [el("h2", { text: "What they are saying" }), feed]),
  );

  if (run.status === "draft" && !document.hidden) watchPoll = setTimeout(() => pollWatch(slug), WATCH_POLL_MS);
}

/**
 * Append what arrived since the last poll.
 *
 * Appends rather than re-renders, which is what makes it readable: rebuilding
 * the feed would throw away the reader's scroll position every eight seconds,
 * on the one view somebody is reading rather than scanning.
 */
async function pollWatch(slug) {
  clearTimeout(watchPoll);
  const data = await api(`/api/live/${encodeURIComponent(slug)}?since=${watchCursor}`).catch(() => null);
  if (!data) {
    watchPoll = setTimeout(() => pollWatch(slug), WATCH_POLL_MS);
    return;
  }
  watchCursor = data.cursor ?? watchCursor;
  const feed = document.getElementById("feed");
  if (feed) {
    if (data.activity.length) feed.querySelector(".empty")?.remove();
    // Only scroll if they were already at the bottom. Yanking somebody back
    // down while they are reading round four is worse than a stale view.
    const atBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;
    for (const row of data.activity) feed.append(feedRow(row));
    if (atBottom && data.activity.length) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
  if (data.run.status === "draft" && !document.hidden) {
    watchPoll = setTimeout(() => pollWatch(slug), WATCH_POLL_MS);
  }
}

/** The same numbers the board panel shows, built by the same function. */
function watchFacts(run, m) {
  const facts = el("dl", { class: "live-facts" });
  for (const [label, value] of liveFacts(run, m)) {
    facts.append(el("div", { class: "live-fact" }, [el("dt", { text: label }), el("dd", { text: value })]));
  }
  return facts;
}

function feedRow(row) {
  const when = row.at ? new Date(row.at).toLocaleTimeString(undefined, { timeStyle: "short" }) : "";
  if (row.kind === "did") {
    return el("div", { class: "feed-did" }, [
      el("span", { class: "feed-when", text: when }),
      el("span", { class: "feed-agent", text: row.agent || "" }),
      el("span", { class: "feed-what", text: row.room || "" }),
      el("span", { class: "feed-detail", text: row.body || "" }),
    ]);
  }
  return el("div", { class: "feed-post" }, [
    el("div", { class: "feed-meta" }, [
      el("span", { class: "feed-agent", text: row.agent || "someone" }),
      el("span", { class: "chip room", text: row.room || "" }),
      el("span", { class: "feed-when", text: `round ${row.round ?? 0} · ${when}` }),
    ]),
    // textContent, not innerHTML: every one of these was written by a model.
    el("p", { class: "feed-body", text: row.body || "" }),
  ]);
}

function liveRow(run) {
  const m = run.metrics ?? {};
  const round = Math.max(0, Math.min(run.rounds || 0, m.roundsPlayed ?? 0));
  const pct = run.rounds ? Math.round((round / run.rounds) * 100) : 0;

  const href = `#/live/${encodeURIComponent(run.slug)}`;

  const shot = run.shot
    ? el("a", { class: "live-shot", href }, [
        // The cache-buster is the point: the filename never changes, so without
        // it the browser shows round three's screen for the rest of the run.
        el("img", { src: `/shots/${encodeURIComponent(run.slug)}/${run.shot}?t=${Date.parse(run.updatedAt)}`, alt: "" }),
      ])
    : el("a", { class: "live-shot blank", href }, [
        el("span", { text: round ? "not playtested yet" : "just started" }),
      ]);

  const heading = el("h3", { class: run.title ? "live-title" : "live-title untitled" }, [
    el("a", { href, text: run.title ?? "Untitled so far" }),
  ]);

  const chips = el("div", { class: "chips" }, [
    el("span", { class: "chip theme", text: run.theme || "no theme" }),
    el("span", { class: "chip", text: `round ${round} of ${run.rounds}` }),
    el("span", { class: "chip", text: elapsed(run.elapsedMs) }),
    ...(run.model ? [el("span", { class: "chip", text: run.model })] : []),
  ]);

  const bar = el("div", { class: "live-bar" }, [
    el("div", { class: "live-bar-fill", style: `--fill:${(pct / 100).toFixed(3)}` }),
  ]);

  // Each label/value pair is one grid item. As bare `dt`+`dd` siblings they are
  // two, so the grid pairs a label with the *next* fact's value and the whole
  // row reads as nonsense.
  const facts = el("dl", { class: "live-facts" });
  for (const [label, value] of liveFacts(run, m)) {
    facts.append(el("div", { class: "live-fact" }, [el("dt", { text: label }), el("dd", { text: value })]));
  }

  return el("div", { class: "live-run" }, [
    shot,
    el("div", { class: "live-body" }, [
      heading,
      ...(run.tagline ? [el("p", { class: "live-tagline", text: run.tagline })] : []),
      chips,
      bar,
      facts,
      el("p", { class: "live-note" }, [
        el("a", { href, class: "watch-link", text: "Watch what they are saying →" }),
      ]),
    ]),
  ]);
}

/** The handful of numbers worth watching while it happens. */
function liveFacts(run, m) {
  const out = [
    ["Files", String(m.filesPresent ?? 0)],
    ["Lines", (m.linesInWorkspace ?? 0).toLocaleString()],
    ["Edits", String((m.writes ?? 0) + (m.patches ?? 0))],
    ["Playtests", String(m.playtestsRun ?? 0)],
  ];
  /*
   * "Nobody has run it", "ran it and nothing moved" and "nobody told us" are
   * three different facts, and only the middle one is a verdict.
   *
   * The store writes -1 for never-run, so anything below zero — and anything
   * absent, which is what an older heartbeat carries — means unknown. Rendering
   * unknown as "static, no response" states a defect the game may not have,
   * which is the one thing a live panel must not do.
   */
  const animates = m.playtestAnimates;
  const responds = m.playtestResponds;
  if ((m.playtestsRun ?? 0) > 0 && animates >= 0 && responds >= 0) {
    const bits = [];
    if (animates === 1) bits.push("animates");
    if (responds === 1) bits.push("responds");
    if (m.playtestErrors > 0) bits.push(`${m.playtestErrors} error${m.playtestErrors === 1 ? "" : "s"}`);
    out.push(["On screen", bits.length ? bits.join(", ") : "static, no response"]);
  }
  if (m.framesShown > 0) out.push(["Frames seen", String(m.framesShown)]);
  return out;
}

function elapsed(ms) {
  const mins = Math.floor((ms ?? 0) / 60000);
  if (mins < 60) return `${mins}m in`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m in`;
}

function card(entry) {
  const shot = entry.slug && entry.thumb ? `/shots/${entry.slug}/${entry.thumb}` : null;
  const link = `#/g/${encodeURIComponent(entry.slug)}`;

  const thumb = shot
    ? el("a", { class: "thumb", href: link }, [el("img", { src: shot, alt: "", loading: "lazy" })])
    : el("a", { class: "thumb blank", href: link, text: "no screenshot" });

  const bars = el("div", { class: "bars" });
  for (const category of config.categories) {
    const score = entry.scores[category.key];
    bars.append(
      el("span", { text: category.name.split(" ")[0].toLowerCase() }),
      el("div", { class: "bar-track" }, [
        el("div", {
          class: "bar-fill",
          style: `width:${score ? ((score.mean - 1) / 4) * 100 : 0}%`,
        }),
      ]),
      el("span", { class: "bar-value", text: score ? score.mean.toFixed(1) : "–" }),
    );
  }

  return el("div", { class: "card" }, [
    thumb,
    el("div", { class: "card-body" }, [
      el("div", { class: "card-head" }, [
        el("a", { class: "card-title", href: link, text: entry.title || entry.slug }),
        entry.overall === null
          ? el("span", { class: "score-big none", text: "unjudged" })
          : el("span", { class: "score-big", text: entry.overall.toFixed(2) }),
      ]),
      entry.tagline ? el("p", { class: "tagline", text: entry.tagline }) : null,
      el("div", { class: "chips" }, [
        entry.theme ? el("span", { class: "chip theme", text: entry.theme }) : null,
        entry.genre ? el("span", { class: "chip", text: entry.genre }) : null,
        entry.model ? el("span", { class: "chip", text: entry.model }) : null,
        el("span", { class: "chip", text: fmtDate(entry.publishedAt ?? entry.createdAt) }),
        entry.registered ? null : el("span", { class: "chip flag", text: "never registered" }),
      ]),
      bars,
    ]),
  ]);
}

// ------------------------------------------------------------------- detail

async function renderDetail(slug) {
  view.replaceChildren(el("p", { class: "loading", text: "Loading…" }));
  const who = reviewer();
  const data = await api(`/api/entries/${encodeURIComponent(slug)}?reviewer=${encodeURIComponent(who)}`);
  const { entry, media, reviews, yourReview, playUrl, versions } = data;

  const shots = media.filter((m) => m.kind === "shot");
  const reel = media.filter((m) => m.kind === "reel");

  view.replaceChildren(
    el("a", { class: "back", href: "#/", text: "← all games" }),
    el("div", { class: "detail-head" }, [
      el("div", {}, [
        el("h1", { text: entry.title || entry.slug }),
        entry.tagline ? el("p", { class: "tagline", text: entry.tagline }) : null,
        el("div", { class: "chips" }, [
          entry.theme ? el("span", { class: "chip theme", text: `theme: ${entry.theme}` }) : null,
          entry.genre ? el("span", { class: "chip", text: entry.genre }) : null,
          el("span", { class: "chip", text: `${entry.rounds} rounds` }),
          el("span", { class: "chip", text: fmtDate(entry.publishedAt ?? entry.createdAt) }),
          entry.registered ? null : el("span", { class: "chip flag", text: "never registered" }),
          // A team that shipped a build and kept going. The board only ever
          // showed finished games before versions existed, so this state needs
          // saying out loud or it reads as an ordinary entry.
          entry.live ? el("span", { class: "chip live", text: "still building" }) : null,
          versions && versions.length > 1
            ? el("span", { class: "chip", text: `${versions.length} builds` })
            : null,
        ]),
      ]),
      el("div", { class: "overall-box" }, [
        entry.overall === null
          ? el("div", { class: "n none", text: "not yet judged" })
          : el("div", { class: "n", text: entry.overall.toFixed(2) }),
        el("div", {
          class: "of",
          text:
            entry.overall === null
              ? "be the first"
              : `overall · ${entry.reviewCount} review${entry.reviewCount === 1 ? "" : "s"}`,
        }),
      ]),
    ]),
    el("div", { class: "columns" }, [
      el("div", { id: "left" }, [
        stagePanel(entry, playUrl, shots, reel),
        textPanel("How to play", entry.instructions, "The team never wrote instructions."),
        textPanel("About", entry.description, "The team never wrote a description."),
      ]),
      el("div", {}, [reviewPanel(entry, yourReview), buildsPanel(versions), reviewsPanel(reviews), metaPanel(entry)]),
    ]),
  );
  footCount.textContent = entry.title || entry.slug;

  // The team's own write-up, when the arcade form is empty and the file is not.
  // Appended after the first paint rather than awaited, so a missing file costs
  // nothing and the page does not wait on it.
  if (!entry.description && !entry.instructions) void showWriteup(entry.slug);
}

/**
 * `submission.md`, shown when nobody filled in the arcade form.
 *
 * Every run that predates the arcade is in that state, and so is any run whose
 * lead wrote the file and forgot to register — which is a thing that happens
 * and is worth being able to read rather than being told "the team never wrote
 * a description" about a team that plainly did. Labelled as coming from the
 * file, because where a pitch came from is part of what a judge is looking at.
 */
async function showWriteup(slug) {
  const res = await fetch(`/artifact/${encodeURIComponent(slug)}/submission`).catch(() => null);
  if (!res?.ok) return;
  const body = (await res.text()).trim();
  if (!body) return;
  document.getElementById("left")?.append(
    el("section", { class: "panel" }, [
      el("h2", { text: "The team's write-up" }),
      el("p", {
        class: "crit-q",
        text: "From submission.md in the workspace. They never registered it on the arcade.",
      }),
      markdownish(body),
    ]),
  );
}

/**
 * Enough markdown to read a jam pitch, rendered as nodes rather than HTML.
 *
 * Headings, bullets, numbered lists, `**bold**` and `` `code` ``, which is all
 * a `submission.md` has ever used. Everything else stays literal.
 *
 * Never `innerHTML`. This text was written by a language model and is displayed
 * on the same origin as the review API; building nodes and setting
 * `textContent` means a `<script>` in a pitch is a funny-looking pitch. The
 * cost of the safe version is about twenty lines and no dependency.
 */
function markdownish(source) {
  const root = document.createDocumentFragment();
  let list = null;

  const inline = (text, into) => {
    // One pass over the two spans that matter. The capture groups alternate, so
    // odd indices are the delimited runs and even ones are the literal text.
    for (const [index, part] of text.split(/\*\*(.+?)\*\*|`(.+?)`/g).entries()) {
      if (part === undefined || part === "") continue;
      if (index % 3 === 1) into.append(el("strong", { text: part }));
      else if (index % 3 === 2) into.append(el("code", { text: part }));
      else into.append(document.createTextNode(part));
    }
    return into;
  };

  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) root.append((list = el("ul", { class: "prose-list" })));
      list.append(inline(bullet[1], el("li")));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      root.append(el(heading[1].length <= 2 ? "h3" : "h4", { class: "prose-head", text: heading[2] }));
      continue;
    }
    root.append(inline(line, el("p", { class: "prose-para" })));
  }
  return root;
}

/**
 * The play area, which starts as a screenshot.
 *
 * Deliberately not an autoplaying iframe. These are animation-loop games with
 * no pause; ten of them running behind a browser tab is a fan-spinning way to
 * find out that a list page should not boot every entry it shows.
 */
function stagePanel(entry, playUrl, shots, reel) {
  const stage = el("div", { class: "stage" });
  const caption = el("p", { class: "crit-q", style: "margin:8px 0 0" });

  /*
   * One strip, two halves: the finished game first, then the build in order.
   *
   * They are different kinds of picture and the difference is worth keeping.
   * The shots are the last playtest — what the reviewer is about to score. The
   * reel is one frame per round, and playing it is the only view in this whole
   * package that shows a game getting *worse* between round nine and round
   * fourteen, which has happened and was invisible in every counter.
   */
  const frames = [...shots, ...reel];
  const reelStart = shots.length;
  let current = 0;

  const showFrame = (index) => {
    current = ((index % frames.length) + frames.length) % frames.length;
    const frame = frames[current];
    stage.replaceChildren(el("img", { src: `/shots/${entry.slug}/${frame.file}`, alt: frame.caption }));
    caption.textContent = `${current < reelStart ? "final playtest" : "build reel"} — ${frame.caption}`;
    for (const [i, thumb] of [...strip.children].entries()) thumb.classList.toggle("on", i === current);
  };

  const strip = el("div", { class: "filmstrip" });
  for (const [index, frame] of frames.entries()) {
    strip.append(
      el("img", {
        src: `/shots/${entry.slug}/${frame.file}`,
        alt: frame.caption,
        title: `${index < reelStart ? "final playtest" : "build reel"} — ${frame.caption}`,
        style: index === reelStart && reelStart > 0 ? "margin-left:14px;border-left:2px solid var(--line)" : null,
        onclick: () => {
          stopReel();
          showFrame(index);
        },
      }),
    );
  }

  let timer = null;
  const stopReel = () => {
    if (timer) clearInterval(timer);
    timer = null;
    reelButton.textContent = "▶ Play the reel";
  };
  // The reel loops within its own range rather than running off the end into
  // the shots, which would make the build look like it restarted.
  const reelButton = el("button", {
    text: "▶ Play the reel",
    onclick: () => {
      if (timer) return stopReel();
      if (!reel.length) return;
      reelButton.textContent = "❚❚ Stop";
      if (current < reelStart) showFrame(reelStart);
      timer = setInterval(() => {
        const next = current + 1;
        showFrame(next >= frames.length ? reelStart : next);
      }, 700);
    },
  });

  const playButton = el("button", {
    class: "primary",
    text: "▶ Play in browser",
    onclick: () => {
      stopReel();
      stage.replaceChildren(
        el("iframe", {
          src: playUrl,
          title: `${entry.title ?? entry.slug} — playable`,
          allow: "autoplay",
        }),
      );
      // The game owns the keyboard from here; focus it so arrow keys reach it
      // rather than scrolling the page behind it.
      stage.querySelector("iframe")?.focus();
    },
  });

  // Open on the last *shot* — the finished game — not the last frame overall,
  // which is the end of the reel and shows the same thing at lower fidelity.
  if (frames.length) showFrame(reelStart > 0 ? reelStart - 1 : frames.length - 1);
  else stage.append(el("span", { class: "thumb blank", text: "no screenshots — nobody ever ran it" }));

  return el("div", {}, [
    stage,
    el("div", { class: "stage-actions" }, [
      entry.filesPath ? playButton : el("span", { class: "prose empty-note", text: "no playable copy" }),
      reel.length > 1 ? reelButton : null,
      el("a", {
        class: "chip",
        href: `/api/entries/${encodeURIComponent(entry.slug)}/download`,
        text: "⭳ download .zip",
      }),
      el("a", { class: "chip", href: `/artifact/${encodeURIComponent(entry.slug)}/brief`, target: "_blank", text: "brief" }),
      el("a", {
        class: "chip",
        href: `/artifact/${encodeURIComponent(entry.slug)}/manifest`,
        target: "_blank",
        text: "manifest",
      }),
    ]),
    frames.length ? caption : null,
    frames.length > 1 ? strip : null,
  ]);
}

function textPanel(title, body, emptyNote) {
  return el("section", { class: "panel" }, [
    el("h2", { text: title }),
    body
      ? el("p", { class: "prose", text: body })
      : el("p", { class: "prose empty-note", text: emptyNote }),
  ]);
}

/**
 * The scorecard.
 *
 * Pre-filled from the reviewer's previous review when there is one, which is
 * the difference between "score this game" and "here is what you said last
 * time" — and the reason the reviewer name is stored at all.
 */
function reviewPanel(entry, existing) {
  const chosen = { ...(existing?.scores ?? {}) };
  const card = el("div", { class: "scorecard" });

  for (const category of config.categories) {
    const pips = el("div", { class: "pips" });
    const paint = () => {
      for (const [index, pip] of [...pips.children].entries()) {
        pip.classList.toggle("on", chosen[category.key] === index + 1);
      }
    };
    for (let score = 1; score <= 5; score += 1) {
      pips.append(
        el("div", {
          class: "pip",
          text: String(score),
          title: score === 1 ? category.low : score === 5 ? category.high : "",
          onclick: () => {
            chosen[category.key] = chosen[category.key] === score ? undefined : score;
            paint();
          },
        }),
      );
    }
    paint();
    card.append(
      el("div", { class: "criterion" }, [
        el("div", { class: "crit-head" }, [el("span", { class: "crit-name", text: category.name })]),
        el("p", { class: "crit-q", text: category.question }),
        pips,
        el("div", { class: "anchors" }, [
          el("span", { text: `1 — ${category.low}` }),
          el("span", { text: `5 — ${category.high}` }),
        ]),
      ]),
    );
  }

  const notes = el("textarea", {
    placeholder: "Would you keep it? What would you change first?",
    value: existing?.notes ?? "",
  });
  notes.value = existing?.notes ?? "";

  const status = el("span", {
    class: "saved-note",
    text: existing ? `you reviewed this ${fmtDateTime(existing.updatedAt)}` : "",
  });

  const save = el("button", {
    class: "primary",
    text: existing ? "Update my review" : "Save my review",
    onclick: async () => {
      const who = reviewer().trim();
      if (!who) {
        status.textContent = "put a name in “reviewing as” first";
        reviewerInput.focus();
        return;
      }
      save.disabled = true;
      try {
        const res = await fetch(`/api/entries/${encodeURIComponent(entry.slug)}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviewer: who, scores: chosen, notes: notes.value }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
        renderDetail(entry.slug);
      } catch (err) {
        status.textContent = String(err.message ?? err);
        save.disabled = false;
      }
    },
  });

  return el("section", { class: "panel" }, [
    el("h2", { text: existing ? "Your review" : "Review this game" }),
    card,
    el("div", { style: "margin-top:12px" }, [notes]),
    el("div", { class: "stage-actions" }, [save, status]),
  ]);
}

/**
 * Every build the team put up, newest first.
 *
 * Worth a panel rather than a line because it is the only view that shows a
 * team's judgement about its own work — when they thought it was worth showing,
 * how often they came back, and what they said had changed. One build is not a
 * history, so it does not get a panel.
 */
function buildsPanel(versions) {
  if (!versions || versions.length < 2) return null;
  const list = el("div", {});
  versions.forEach((v, i) => {
    list.append(
      el("div", { class: `build-item${i === 0 ? " current" : ""}` }, [
        el("div", { class: "build-head" }, [
          el("span", { class: "build-v", text: v.version }),
          v.round === null ? null : el("span", { class: "build-round", text: `round ${v.round + 1}` }),
          i === 0 ? el("span", { class: "chip", text: "judged" }) : null,
          // A checkpoint is not a decision the team took, and a page that let
          // the two look alike would be describing a choice nobody made.
          v.auto ? el("span", { class: "chip", text: "auto" }) : null,
        ]),
        v.notes ? el("p", { class: "build-notes", text: v.notes }) : null,
      ]),
    );
  });
  return el("section", { class: "panel" }, [el("h2", { text: `Builds (${versions.length})` }), list]);
}

function reviewsPanel(reviews) {
  if (!reviews.length) return null;
  const list = el("div", {});
  for (const review of reviews) {
    const scores = config.categories
      .filter((category) => review.scores[category.key])
      .map((category) => `${category.key} ${review.scores[category.key]}`)
      .join("  ·  ");
    list.append(
      el("div", { class: "review-item" }, [
        el("div", { class: "by" }, [
          el("span", { text: review.reviewer }),
          el("span", { text: fmtDate(review.updatedAt) }),
        ]),
        scores ? el("div", { class: "rs", text: scores }) : null,
        review.notes ? el("p", { class: "prose", text: review.notes }) : null,
      ]),
    );
  }
  return el("section", { class: "panel" }, [
    el("h2", { text: `All reviews (${reviews.length})` }),
    list,
  ]);
}

function metaPanel(entry) {
  const meta = entry.modelMeta ?? {};
  const rows = [
    ["Model", entry.model],
    ["Provider", entry.provider],
    ["Endpoint", entry.baseUrl],
    ["Context window", meta.contextTokens ? `${Number(meta.contextTokens).toLocaleString()} tokens` : ""],
    ["Reasoning effort", meta.thinking],
    ["Max output tokens", meta.maxTokens],
    ["Temperature", meta.temperature],
    ["Tool rounds per turn", meta.maxToolRounds],
    ["Scenario", entry.scenario],
    ["Brief", entry.brief],
    ["Theme", entry.theme],
    ["Rounds", entry.rounds],
    ["Seed", entry.seed],
    ["TAI version", entry.taiVersion],
    ["Simulation version", entry.simVersion],
    ["Commit", entry.gitSha],
    ["Built", fmtDateTime(entry.createdAt)],
    ["Published", fmtDateTime(entry.publishedAt)],
  ];

  const credits = Object.entries(entry.credits ?? {});
  const counters = Object.entries(entry.metrics ?? {});

  const table = el("table", { class: "meta" });
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    table.append(el("tr", {}, [el("th", { text: label }), el("td", { text: String(value) })]));
  }
  if (credits.length) {
    table.append(
      el("tr", {}, [
        el("th", { text: "Built by" }),
        el("td", { text: credits.map(([role, agent]) => `${role}: ${agent}`).join("\n") }),
      ]),
    );
  }

  const panels = [el("section", { class: "panel" }, [el("h2", { text: "Provenance" }), table])];

  if (counters.length) {
    const runTable = el("table", { class: "meta" });
    for (const [key, value] of counters) {
      runTable.append(
        el("tr", {}, [
          el("th", { text: key.replace(/([A-Z])/g, " $1").toLowerCase() }),
          el("td", { text: String(value) }),
        ]),
      );
    }
    panels.push(
      el("section", { class: "panel" }, [
        el("h2", { text: "What the run did" }),
        el("p", { class: "crit-q", text: "Activity, not achievement. None of these is a score." }),
        runTable,
      ]),
    );
  }
  return el("div", {}, panels);
}

// -------------------------------------------------------------------- boot

async function render() {
  const { path, params } = route();
  // Leaving a view must stop its timers. Both the live panel and the watch view
  // poll, and a hashchange that only swapped the DOM would leave the old one
  // running against elements that are no longer on the page.
  clearTimeout(livePoll);
  clearTimeout(watchPoll);
  try {
    const game = /^\/g\/(.+)$/.exec(path);
    const watch = /^\/live\/(.+)$/.exec(path);
    if (watch) await renderWatch(decodeURIComponent(watch[1]));
    else if (game) await renderDetail(decodeURIComponent(game[1]));
    else await renderBoard(params);
  } catch (err) {
    view.replaceChildren(el("p", { class: "empty", text: String(err.message ?? err) }));
  }
}

reviewerInput.value = reviewer();
reviewerInput.addEventListener("change", () => {
  localStorage.setItem("arcade.reviewer", reviewerInput.value.trim());
  render();
});

window.addEventListener("hashchange", render);

config = await api("/api/config");
await render();
