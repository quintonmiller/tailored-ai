/**
 * What the arcade has to get right.
 *
 * Three things, roughly in order of how expensive they would be to discover
 * late: the write scope (an agent may only touch its own row), the arithmetic
 * (an overall score that quietly means the wrong thing invalidates every
 * comparison ever drawn from it), and the file serving (a game is untrusted
 * code and the server hands out files next to it).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitCommand, stripSeparator } from "../args.js";
import { CATEGORIES, CATEGORY_KEYS, cleanScore, normaliseGenre, overallScore } from "../categories.js";
import { publishRun } from "../publish.js";
import { createArcadeServer, listen } from "../server.js";
import { ArcadeStore, type EntryProvenance, type ScoredEntry, slugify, sortEntries } from "../store.js";
import { crc32, zip } from "../zip.js";

const temps: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "arcade-test-"));
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function provenance(overrides: Partial<EntryProvenance> = {}): EntryProvenance {
  return {
    runId: "arcade-1-2026-08-21-00-00-00",
    scenario: "the-workshop",
    brief: "arcade",
    theme: "IT GROWS",
    themeId: "it-grows",
    rounds: 20,
    seed: 1,
    artifactPath: "/nowhere",
    entryFile: "index.html",
    taiVersion: "0.1.10",
    simVersion: "workshop-1",
    gitSha: "abc1234",
    model: "qwen3.8-27b",
    provider: "openai_compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    modelMeta: { contextTokens: 131072, thinking: "medium" },
    credits: { lead: "lead", builder: "builder" },
    ...overrides,
  };
}

describe("categories", () => {
  it("has five, each with both anchors", () => {
    expect(CATEGORIES).toHaveLength(5);
    for (const category of CATEGORIES) {
      expect(category.low.length).toBeGreaterThan(4);
      expect(category.high.length).toBeGreaterThan(4);
      expect(category.question.endsWith("?")).toBe(true);
    }
  });

  it("averages the category means, not every score handed in", () => {
    // Two reviewers on `theme`, one on `gameplay`. Averaging all three numbers
    // equally would give 3.0; per category it is (2+4)/2 = 3 then (3+4)/2 = 3.5.
    const overall = overallScore({
      theme: { mean: 3, count: 2 },
      gameplay: { mean: 4, count: 1 },
    });
    expect(overall).toBe(3.5);
  });

  it("reports null rather than zero when nobody has judged it", () => {
    expect(overallScore({})).toBeNull();
    expect(overallScore({ theme: { mean: 4, count: 0 } })).toBeNull();
  });

  it("refuses scores off the scale and rounds the rest", () => {
    expect(cleanScore(0)).toBeNull();
    expect(cleanScore(6)).toBeNull();
    expect(cleanScore("nonsense")).toBeNull();
    expect(cleanScore("4")).toBe(4);
    expect(cleanScore(3.4)).toBe(3);
  });

  it("files an unknown genre under other rather than refusing it", () => {
    expect(normaliseGenre("Puzzle")).toBe("puzzle");
    expect(normaliseGenre("metroidvania roguelike")).toBe("other");
    expect(normaliseGenre(undefined)).toBe("other");
  });
});

describe("slugs", () => {
  it("survives punctuation, unicode and emptiness", () => {
    expect(slugify("Grow!! The  Tower™", "fallback")).toBe("grow-the-tower");
    expect(slugify("???", "fallback")).toBe("fallback");
    expect(slugify("", "fallback")).toBe("fallback");
  });
});

describe("store", () => {
  let store: ArcadeStore;

  beforeEach(() => {
    store = new ArcadeStore(tempHome());
  });

  afterEach(() => store.close());

  it("opens one draft per run, however many times it is asked", () => {
    const first = store.createEntry(provenance());
    const second = store.createEntry(provenance());
    expect(second.id).toBe(first.id);
    expect(store.list({ includeDrafts: true })).toHaveLength(1);
  });

  it("keeps drafts off the board until they are published", () => {
    const entry = store.createEntry(provenance());
    expect(store.list()).toHaveLength(0);
    store.publish(entry.id, {});
    expect(store.list()).toHaveLength(1);
  });

  it("writes only the registration fields, whatever else it is handed", () => {
    const entry = store.createEntry(provenance());
    store.register(entry.id, {
      title: "Grow The Tower",
      tagline: "one block at a time",
      genre: "puzzle",
      // Provenance smuggled in through the same call. TypeScript would refuse
      // this; a tool argument arriving as JSON would not.
      ...({ model: "gpt-hacked", gitSha: "deadbeef", status: "published" } as unknown as Record<string, never>),
    });
    const after = store.entry(entry.id);
    expect(after?.title).toBe("Grow The Tower");
    expect(after?.model).toBe("qwen3.8-27b");
    expect(after?.gitSha).toBe("abc1234");
    expect(after?.status).toBe("draft");
    expect(after?.registered).toBe(true);
  });

  it("follows the title with the slug while a draft, and freezes it once published", () => {
    const entry = store.createEntry(provenance());
    store.register(entry.id, { title: "First Name" });
    expect(store.entry(entry.id)?.slug).toBe("first-name");
    store.publish(entry.id, {});
    store.register(entry.id, { title: "Second Name" });
    expect(store.entry(entry.id)?.slug).toBe("first-name");
    expect(store.entry(entry.id)?.title).toBe("Second Name");
  });

  it("gives two games with the same title different URLs", () => {
    const a = store.createEntry(provenance({ runId: "run-a" }));
    const b = store.createEntry(provenance({ runId: "run-b" }));
    store.register(a.id, { title: "Ascend" });
    store.register(b.id, { title: "Ascend" });
    expect(store.entry(a.id)?.slug).toBe("ascend");
    expect(store.entry(b.id)?.slug).toBe("ascend-2");
  });

  it("replaces a person's review rather than counting them twice", () => {
    const entry = store.createEntry(provenance());
    store.publish(entry.id, {});
    store.saveReview(entry.id, "quinton", { theme: 2 });
    store.saveReview(entry.id, "quinton", { theme: 5 });
    expect(store.reviews(entry.id)).toHaveLength(1);
    expect(store.scored(entry.id)?.scores.theme).toEqual({ mean: 5, count: 1 });
  });

  it("lets a category be cleared, and ignores one nobody scored", () => {
    const entry = store.createEntry(provenance());
    store.publish(entry.id, {});
    store.saveReview(entry.id, "quinton", { theme: 4, gameplay: 3 });
    store.saveReview(entry.id, "quinton", { theme: 4 });
    const scored = store.scored(entry.id);
    expect(scored?.scores.gameplay).toBeUndefined();
    expect(scored?.overall).toBe(4);
  });

  it("refuses a review with no reviewer", () => {
    const entry = store.createEntry(provenance());
    expect(() => store.saveReview(entry.id, "   ", { theme: 4 })).toThrow(/reviewer/);
  });

  it("averages across reviewers per category", () => {
    const entry = store.createEntry(provenance());
    store.publish(entry.id, {});
    store.saveReview(entry.id, "a", { theme: 2, gameplay: 4 });
    store.saveReview(entry.id, "b", { theme: 4, gameplay: 4 });
    const scored = store.scored(entry.id);
    expect(scored?.scores.theme).toEqual({ mean: 3, count: 2 });
    expect(scored?.overall).toBe(3.5);
    expect(scored?.reviewCount).toBe(2);
  });

  it("filters by genre, model and theme", () => {
    const a = store.createEntry(provenance({ runId: "a", model: "qwen3.8-27b", theme: "IT GROWS" }));
    const b = store.createEntry(provenance({ runId: "b", model: "other-model", theme: "ONLY ONE" }));
    store.register(a.id, { title: "A", genre: "puzzle" });
    store.register(b.id, { title: "B", genre: "shooter" });
    store.publish(a.id, {});
    store.publish(b.id, {});
    expect(store.list({ genre: "puzzle" }).map((e) => e.title)).toEqual(["A"]);
    expect(store.list({ model: "other-model" }).map((e) => e.title)).toEqual(["B"]);
    expect(store.list({ theme: "IT GROWS" }).map((e) => e.title)).toEqual(["A"]);
    expect(store.list({ q: "b" }).map((e) => e.title)).toEqual(["B"]);
  });

  it("reports the facets that exist rather than the ones that could", () => {
    const a = store.createEntry(provenance({ runId: "a" }));
    store.register(a.id, { title: "A", genre: "puzzle" });
    store.publish(a.id, {});
    const facets = store.facets();
    expect(facets.genres).toEqual(["puzzle"]);
    expect(facets.models).toEqual(["qwen3.8-27b"]);
  });
});

describe("sorting", () => {
  const entry = (overrides: Partial<ScoredEntry>): ScoredEntry =>
    ({
      id: "x",
      slug: "x",
      title: "x",
      overall: null,
      reviewCount: 0,
      scores: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }) as ScoredEntry;

  it("puts unjudged games last rather than treating them as zero", () => {
    const rows = sortEntries(
      [entry({ slug: "unjudged" }), entry({ slug: "bad", overall: 1.2 }), entry({ slug: "good", overall: 4.4 })],
      "overall",
    );
    expect(rows.map((r) => r.slug)).toEqual(["good", "bad", "unjudged"]);
  });

  it("sorts by one category independently of the overall", () => {
    const rows = sortEntries(
      [
        entry({ slug: "pretty", overall: 2, scores: { visuals: { mean: 5, count: 1 } } }),
        entry({ slug: "solid", overall: 4, scores: { visuals: { mean: 2, count: 1 } } }),
      ],
      "visuals",
    );
    expect(rows.map((r) => r.slug)).toEqual(["pretty", "solid"]);
  });

  it("orders by date both ways", () => {
    const rows = [
      entry({ slug: "old", publishedAt: "2026-01-01T00:00:00.000Z" }),
      entry({ slug: "new", publishedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(sortEntries(rows, "recent").map((r) => r.slug)).toEqual(["new", "old"]);
    expect(sortEntries(rows, "oldest").map((r) => r.slug)).toEqual(["old", "new"]);
  });

  it("covers every category key it advertises", () => {
    for (const key of CATEGORY_KEYS) {
      const rows = sortEntries(
        [entry({ slug: "a", scores: { [key]: { mean: 5, count: 1 } } }), entry({ slug: "b" })],
        key,
      );
      expect(rows[0].slug).toBe("a");
    }
  });
});

describe("zip", () => {
  it("round-trips through its own central directory", () => {
    const files = [
      { name: "game/index.html", data: Buffer.from("<!doctype html><p>hi</p>") },
      { name: "game/engine.js", data: Buffer.from("const x = 1;\n".repeat(200)) },
    ];
    const archive = zip(files);

    // End of central directory: signature, and one record per file.
    const eocd = archive.length - 22;
    expect(archive.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(archive.readUInt16LE(eocd + 10)).toBe(2);

    // Walk the local headers back out and inflate them.
    let offset = 0;
    for (const file of files) {
      expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
      const crc = archive.readUInt32LE(offset + 14);
      const compressed = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
      const body = archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + compressed);
      expect(name).toBe(file.name);
      expect(crc).toBe(crc32(file.data));
      expect(inflateRawSync(body).toString()).toBe(file.data.toString());
      offset += 30 + nameLength + compressed;
    }
  });

  it("matches a known CRC32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("publishing a run", () => {
  function artifact(): string {
    const dir = tempHome();
    mkdirSync(join(dir, "workspace"), { recursive: true });
    writeFileSync(join(dir, "workspace", "index.html"), "<!doctype html><canvas id=c></canvas>");
    writeFileSync(join(dir, "workspace", "engine.js"), "const state = {};\n");
    writeFileSync(join(dir, "brief.md"), "# GAME JAM\n");
    writeFileSync(join(dir, "manifest.json"), '{"brief":"arcade"}');
    for (let round = 0; round < 5; round += 1) {
      const shots = join(dir, "playtests", `round-${String(round).padStart(3, "0")}`);
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, "01-opened.png"), `opened-${round}`);
      writeFileSync(join(shots, "04-playing.png"), `playing-${round}`);
    }
    return dir;
  }

  it("copies the workspace, the shots, the reel and an archive", () => {
    const store = new ArcadeStore(tempHome());
    const source = artifact();
    const entry = store.createEntry(provenance({ artifactPath: source }));
    store.register(entry.id, { title: "Grow" });
    const result = publishRun(store, entry.id, { artifactPath: source, metrics: { writes: 9 } });

    expect(result.entry.status).toBe("published");
    expect(result.entry.metrics.writes).toBe(9);
    expect(result.files).toBe(2);
    expect(result.shots).toBe(2);
    expect(result.reel).toBe(5);
    expect(existsSync(join(store.gameDir(entry.id), "files", "index.html"))).toBe(true);
    expect(existsSync(join(store.gameDir(entry.id), "brief.md"))).toBe(true);
    expect(readFileSync(result.entry.downloadPath as string).length).toBeGreaterThan(50);

    // The reel takes the mid-play frame of every round, so it shows the game
    // changing rather than five copies of a title screen.
    const reel = store.media(entry.id).filter((m) => m.kind === "reel");
    expect(reel.map((m) => m.caption)).toEqual(["round 1", "round 2", "round 3", "round 4", "round 5"]);
    expect(reel.every((m) => m.file.includes("playing"))).toBe(true);
    store.close();
  });

  it("publishes a run nobody ever playtested", () => {
    const store = new ArcadeStore(tempHome());
    const source = tempHome();
    mkdirSync(join(source, "workspace"), { recursive: true });
    writeFileSync(join(source, "workspace", "index.html"), "<!doctype html>");
    const entry = store.createEntry(provenance({ artifactPath: source }));
    const result = publishRun(store, entry.id, { artifactPath: source });
    expect(result.shots).toBe(0);
    expect(store.scored(entry.id)?.thumb).toBeNull();
    store.close();
  });
});

describe("the server", () => {
  it("answers the API, serves shots, and refuses to walk out of a directory", async () => {
    const store = new ArcadeStore(tempHome());
    const source = tempHome();
    mkdirSync(join(source, "workspace"), { recursive: true });
    writeFileSync(join(source, "workspace", "index.html"), "<!doctype html><p>playable</p>");
    mkdirSync(join(source, "playtests", "round-000"), { recursive: true });
    writeFileSync(join(source, "playtests", "round-000", "04-playing.png"), "PNGDATA");
    // A secret next to the served directory, which is what traversal is for.
    writeFileSync(join(store.home, "arcade.db-secret"), "do not serve me");

    const entry = store.createEntry(provenance({ artifactPath: source }));
    store.register(entry.id, { title: "Grow The Tower", tagline: "up", genre: "puzzle" });
    publishRun(store, entry.id, { artifactPath: source });

    const server = createArcadeServer({ store, port: 0, gamesPort: 0 });
    await listen(server, { port: 0, gamesPort: 0 });
    const base = `http://127.0.0.1:${(server.site.address() as { port: number }).port}`;
    const games = `http://127.0.0.1:${(server.games.address() as { port: number }).port}`;

    try {
      const config = await (await fetch(`${base}/api/config`)).json();
      expect(config.categories).toHaveLength(5);

      const board = await (await fetch(`${base}/api/entries?sort=overall`)).json();
      expect(board.entries).toHaveLength(1);
      expect(board.entries[0].thumb).toMatch(/playing/);

      const detail = await (await fetch(`${base}/api/entries/grow-the-tower`)).json();
      expect(detail.entry.title).toBe("Grow The Tower");
      expect(detail.media.length).toBeGreaterThan(0);
      expect(detail.yourReview).toBeNull();

      const posted = await fetch(`${base}/api/entries/grow-the-tower/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer: "quinton", scores: { theme: 5, gameplay: 4 }, notes: "keeps going up" }),
      });
      expect(posted.status).toBe(200);
      expect((await posted.json()).entry.overall).toBe(4.5);

      const mine = await (await fetch(`${base}/api/entries/grow-the-tower?reviewer=quinton`)).json();
      expect(mine.yourReview.scores.theme).toBe(5);
      expect(mine.yourReview.notes).toBe("keeps going up");

      const shot = await fetch(`${base}/shots/grow-the-tower/${detail.media[0].file}`);
      expect(shot.status).toBe(200);
      expect(await shot.text()).toBe("PNGDATA");

      const traversal = await fetch(`${base}/shots/grow-the-tower/..%2f..%2farcade.db-secret`);
      expect(traversal.status).toBe(404);

      const download = await fetch(`${base}/api/entries/grow-the-tower/download`);
      expect(download.headers.get("content-type")).toBe("application/zip");

      // The playable copy is on the other origin, with a policy that forbids it
      // calling anything at all.
      const play = await fetch(`${games}/play/grow-the-tower/`);
      expect(await play.text()).toContain("playable");
      expect(play.headers.get("content-security-policy")).toContain("connect-src 'none'");

      const missing = await fetch(`${base}/api/entries/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
      store.close();
    }
  });
});

describe("command line", () => {
  /**
   * `pnpm run arcade -- list` forwards the separator to the script.
   *
   * Without stripping it, `--` is argv[0], the command sniffer sees a dash,
   * falls back to `serve`, and the user gets `EADDRINUSE: 127.0.0.1:4321` —
   * a failure that reads as "the port is busy" rather than "your subcommand
   * was never parsed". Found by running the documented command.
   */
  it("drops the separator a package manager forwards", () => {
    expect(stripSeparator(["--", "list"])).toEqual(["list"]);
    expect(stripSeparator(["import", "/dir", "--model", "x"])).toEqual(["import", "/dir", "--model", "x"]);
    // Only the first. A second is a real end-of-options marker.
    expect(stripSeparator(["--", "list", "--", "-weird-name"])).toEqual(["list", "--", "-weird-name"]);
  });

  it("finds the command through the separator, and defaults to serve", () => {
    expect(splitCommand(["--", "list"])).toEqual({ command: "list", rest: [] });
    expect(splitCommand(["--", "import", "/dir", "--min-rounds", "10"])).toEqual({
      command: "import",
      rest: ["/dir", "--min-rounds", "10"],
    });
    expect(splitCommand([])).toEqual({ command: "serve", rest: [] });
    // A leading flag is not a command.
    expect(splitCommand(["--port", "5000"])).toEqual({ command: "serve", rest: ["--port", "5000"] });
    expect(splitCommand(["--", "--port", "5000"])).toEqual({ command: "serve", rest: ["--port", "5000"] });
  });
});
