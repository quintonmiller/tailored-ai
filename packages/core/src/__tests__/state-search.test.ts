/**
 * Searching world state by meaning, and by words when meaning isn't available.
 *
 * What matters most is that search never shows anyone more than `query`
 * would: the index holds a vector for every searchable record, private ones
 * included, so a search that trusted the index over the store would leak
 * another agent's scope. After that, that the index stays honest: a vector
 * only counts while it describes the record's current text, a write is never
 * slowed or failed by the embedder, and a record waiting to be embedded is
 * still found.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import type { EmbeddingProvider, EmbedResult } from "../providers/embedding.js";
import { AgentRuntime } from "../runtime.js";
import { embedQuery, hashText, StateSearchIndex, searchText, wordScores, wordsOf } from "../state/search.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import { StateError, type StateTypeDef } from "../state/types.js";

/**
 * Words that mean the same thing land on the same axis, so a query can match a
 * record by meaning while sharing no word with it: "lodging in portugal" is
 * about the same thing as "where to stay in Lisbon".
 */
const AXES: Record<string, number> = {
  hotel: 0,
  lodging: 0,
  stay: 0,
  lisbon: 0,
  portugal: 0,
  trip: 0,
  dinner: 1,
  recipe: 1,
  recipes: 1,
  cook: 1,
  supper: 1,
  render: 2,
  renders: 2,
  queue: 2,
  queued: 2,
  pipeline: 2,
};

function meaning(text: string): Float32Array {
  const v = new Float32Array(4);
  v[3] = 0.05;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const axis = AXES[word];
    if (axis !== undefined) v[axis] += 1;
  }
  return v;
}

interface FakeEmbedder extends EmbeddingProvider {
  calls: string[][];
}

function fakeEmbedder(model = "fake-1", embed?: (inputs: string[]) => Promise<EmbedResult>): FakeEmbedder {
  const calls: string[][] = [];
  return {
    id: "fake",
    name: "fake",
    defaultModel: model,
    defaultDim: 4,
    calls,
    embed: async (inputs) => {
      calls.push(inputs);
      if (embed) return embed(inputs);
      return { vectors: inputs.map(meaning), model, dim: 4 };
    },
  };
}

const doc: StateTypeDef = {
  name: "doc",
  title: "title",
  search: { fields: ["title", "summary", "tags"] },
};
const commitment: StateTypeDef = {
  name: "commitment",
  scope: "agent",
  title: "goal",
  search: { fields: ["goal", "updates.text"] },
};
/** Not searchable: no `search`. */
const plan: StateTypeDef = { name: "plan", title: "name" };

const planner: StateCaller = {
  actor: { kind: "agent", name: "planner" },
  source: { tool: "state" },
  rooms: ["local:eng"],
};
const reviewer: StateCaller = { actor: { kind: "agent", name: "reviewer" }, source: { tool: "state" } };
const person: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };

const ids = (hits: { record: { type: string; id: string } }[]) => hits.map((h) => `${h.record.type}/${h.record.id}`);

describe("state search", () => {
  let db: Database.Database;
  let config: { state: StateConfig };
  let embedder: FakeEmbedder | undefined;
  let service: StateService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(":memory:");
    config = { state: { backend: "sqlite", types: [doc, commitment, plan] } };
    embedder = fakeEmbedder();
    service = new StateService({ getConfig: () => config, db, getEmbedder: () => embedder });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await service.close();
    warn.mockRestore();
  });

  const rows = () =>
    db.prepare("SELECT type, id, scope, model, text_hash FROM state_search ORDER BY type, id").all() as {
      type: string;
      id: string;
      scope: string;
      model: string;
      text_hash: string;
    }[];

  describe("by words, with no embedder", () => {
    beforeEach(async () => {
      await service.close();
      // A database the state service has never been given an embedder for.
      db = new Database(":memory:");
      embedder = undefined;
      service = new StateService({ getConfig: () => config, db });
    });

    it("finds records sharing the query's words, closest first, and leaves out the ones that share none", async () => {
      await service.put(person, {
        type: "doc",
        id: "travel",
        data: { title: "Travel preferences", summary: "Window seats, and hotels near the old town." },
      });
      await service.put(person, {
        type: "doc",
        id: "hotels",
        data: { title: "Hotel shortlist", summary: "Three hotels in the old town of Lisbon." },
      });
      await service.put(person, { type: "doc", id: "dinner", data: { title: "Weeknight dinners" } });

      const hits = await service.search(person, { text: "hotel in Lisbon old town" });
      expect(ids(hits)).toEqual(["doc/hotels", "doc/travel"]);
      expect(hits.every((h) => h.how === "words")).toBe(true);
      expect(hits[0].score).toBe(1);
      expect(hits[1].score).toBeGreaterThan(0);
      expect(hits[1].score).toBeLessThan(1);
    });

    it("keeps no index at all", async () => {
      await service.put(person, { type: "doc", id: "travel", data: { title: "Travel preferences" } });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'state_search'").get();
      expect(table).toBeUndefined();
    });
  });

  describe("by meaning", () => {
    beforeEach(async () => {
      await service.put(person, {
        type: "doc",
        id: "lisbon",
        data: { title: "Where to stay in Lisbon", summary: "Hotels by the river." },
      });
      await service.put(person, { type: "doc", id: "dinners", data: { title: "Weeknight recipes", tags: ["cook"] } });
      await service.put(person, {
        type: "doc",
        id: "renders",
        data: { title: "How renders are queued", tags: ["pipeline"] },
      });
      await service.whenIndexed();
    });

    it("ranks the record about the same thing first, though it shares no word with the query", async () => {
      const hits = await service.search(person, { text: "lodging portugal" });
      expect(ids(hits)[0]).toBe("doc/lisbon");
      expect(hits[0].how).toBe("meaning");
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      // The same query by words finds nothing: the match is the embedder's.
      expect(wordScores("lodging portugal", ["Where to stay in Lisbon\nHotels by the river."])).toEqual([0]);
    });

    it("embeds each record once, in a batch, from its search fields only", async () => {
      expect(embedder?.calls[0]).toEqual([
        "Where to stay in Lisbon\nHotels by the river.",
        "Weeknight recipes\ncook",
        "How renders are queued\npipeline",
      ]);
      expect(rows().map((r) => [r.id, r.model])).toEqual([
        ["dinners", "fake:fake-1"],
        ["lisbon", "fake:fake-1"],
        ["renders", "fake:fake-1"],
      ]);
    });

    it("finds a record written a moment ago by words while it waits to be embedded", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      embedder = fakeEmbedder("fake-1", async (inputs) => {
        if (inputs.length === 1 && inputs[0] === "supper")
          return { vectors: [meaning("supper")], model: "fake-1", dim: 4 };
        await gate;
        return { vectors: inputs.map(meaning), model: "fake-1", dim: 4 };
      });
      await service.put(person, { type: "doc", id: "supper", data: { title: "Supper club menu" } });

      const waiting = await service.search(person, { text: "supper" });
      expect(waiting.find((h) => h.record.id === "supper")?.how).toBe("words");

      release();
      await service.whenIndexed();
      const embedded = await service.search(person, { text: "supper" });
      expect(embedded[0]).toMatchObject({ record: { id: "supper" }, how: "meaning" });
    });

    it("never matches a record by its old vector once its text has changed", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      embedder = fakeEmbedder("fake-1", async (inputs) => {
        if (inputs.length === 1 && inputs[0] === "lodging portugal") {
          return { vectors: [meaning(inputs[0])], model: "fake-1", dim: 4 };
        }
        await gate;
        return { vectors: inputs.map(meaning), model: "fake-1", dim: 4 };
      });
      await service.patch(person, { type: "doc", id: "lisbon" }, { title: "Supper spots", summary: "By the river." });

      // The old vector, about somewhere to stay, is still in the index while the new one is made.
      const hits = await service.search(person, { text: "lodging portugal" });
      expect(hits.find((h) => h.record.id === "lisbon")).toBeUndefined();
      release();
      await service.whenIndexed();
    });

    it("re-embeds a record when its searched text changes, and not when another field does", async () => {
      const before = embedder?.calls.length ?? 0;
      await service.patch(person, { type: "doc", id: "lisbon" }, { reviewedAt: "2026-10-01" });
      await service.whenIndexed();
      expect(embedder?.calls.length).toBe(before);

      await service.patch(
        person,
        { type: "doc", id: "lisbon" },
        { title: "Supper spots", summary: "Dinner by the river." },
      );
      await service.whenIndexed();
      expect(embedder?.calls.at(-1)).toEqual(["Supper spots\nDinner by the river."]);
      expect(rows().find((r) => r.id === "lisbon")?.text_hash).toBe(hashText("Supper spots\nDinner by the river."));

      // It is about supper now, not somewhere to stay.
      const hits = await service.search(person, { text: "lodging portugal" });
      expect(hits.find((h) => h.record.id === "lisbon")?.score).toBeLessThan(0.1);
    });

    it("re-embeds everything after the embedder's model changes, matching words until it has", async () => {
      embedder = fakeEmbedder("fake-2");
      const stale = await service.search(person, { text: "where to stay" });
      expect(stale[0]).toMatchObject({ record: { id: "lisbon" }, how: "words" });

      await service.whenIndexed();
      expect(rows().map((r) => r.model)).toEqual(["fake:fake-2", "fake:fake-2", "fake:fake-2"]);
      const fresh = await service.search(person, { text: "lodging portugal" });
      expect(fresh[0]).toMatchObject({ record: { id: "lisbon" }, how: "meaning" });
    });

    it("matches words for every record when embedding the query fails", async () => {
      embedder = fakeEmbedder("fake-1", async () => {
        throw new Error("embedder down");
      });
      const hits = await service.search(person, { text: "renders queued" });
      expect(hits.map((h) => [h.record.id, h.how])).toEqual([["renders", "words"]]);
    });
  });

  describe("visibility", () => {
    beforeEach(async () => {
      await service.put(reviewer, { type: "commitment", id: "mine", data: { goal: "Find a hotel in Lisbon" } });
      await service.put(planner, { type: "commitment", id: "planners", data: { goal: "Lisbon hotel budget" } });
      await service.put(person, {
        type: "doc",
        id: "ops-hotels",
        scope: "room:local:ops",
        data: { title: "Hotel contacts in Lisbon" },
      });
      await service.put(person, {
        type: "doc",
        id: "eng-hotels",
        scope: "room:local:eng",
        data: { title: "Hotel for the Lisbon offsite" },
      });
      await service.whenIndexed();
    });

    for (const how of ["meaning", "words"] as const) {
      it(`never shows an agent another agent's private record or an unwoken room's, by ${how}`, async () => {
        if (how === "words") embedder = undefined;
        const hits = await service.search(planner, { text: "hotel in Lisbon" });
        expect(ids(hits).sort()).toEqual(["commitment/planners", "doc/eng-hotels"]);
        expect(hits.every((h) => h.how === how)).toBe(true);

        // Every one of them has a vector, so this is the store's scoping at work, not a gap in the index.
        if (how === "meaning") expect(rows()).toHaveLength(4);
        const everything = await service.search(person, { text: "hotel in Lisbon" });
        expect(ids(everything).sort()).toEqual([
          "commitment/mine",
          "commitment/planners",
          "doc/eng-hotels",
          "doc/ops-hotels",
        ]);
      });
    }

    it("narrows to one scope the caller can see, and refuses one it can't", async () => {
      const room = await service.search(planner, { text: "hotel Lisbon", scope: "room:local:eng" });
      expect(ids(room)).toEqual(["doc/eng-hotels"]);
      await expect(service.search(planner, { text: "hotel", scope: "agent:reviewer" })).rejects.toThrow(
        'You cannot use scope "agent:reviewer".',
      );
    });

    it("hides a type the caller cannot read, exactly as a query does", async () => {
      config.state.types = [doc, commitment, plan, { ...doc, name: "secret", access: { read: ["reviewer"] } }];
      await service.put(reviewer, { type: "secret", id: "s", data: { title: "Hotel in Lisbon, secretly" } });
      expect(ids(await service.search(planner, { text: "hotel Lisbon" }))).not.toContain("secret/s");
      await expect(service.search(planner, { text: "hotel", types: ["secret"] })).rejects.toThrow(
        'There is no state type called "secret".',
      );
    });
  });

  describe("types", () => {
    it("never returns a record of a type without `search`, and says so when one is named", async () => {
      await service.put(person, { type: "plan", id: "trip", data: { name: "Hotel in Lisbon" } });
      await service.put(person, { type: "doc", id: "trip", data: { title: "Hotel in Lisbon" } });
      await service.whenIndexed();

      expect(ids(await service.search(person, { text: "hotel Lisbon" }))).toEqual(["doc/trip"]);
      expect(rows().map((r) => r.type)).toEqual(["doc"]);
      await expect(service.search(person, { text: "hotel", types: ["plan"] })).rejects.toThrow(
        new StateError("plan records are not searchable. Searchable types: commitment, doc."),
      );
    });

    it("narrows to the types named", async () => {
      await service.put(person, { type: "doc", id: "d", data: { title: "Hotel in Lisbon" } });
      await service.put(person, { type: "commitment", id: "c", scope: "global", data: { goal: "Hotel in Lisbon" } });
      expect(ids(await service.search(person, { text: "hotel", types: ["commitment"] }))).toEqual(["commitment/c"]);
    });

    it("needs something to look for", async () => {
      await expect(service.search(person, { text: "  " })).rejects.toThrow("Say what to look for with `text`.");
    });
  });

  describe("archived records", () => {
    beforeEach(async () => {
      await service.put(person, { type: "doc", id: "old", data: { title: "Hotel in Lisbon, 2024" } });
      await service.whenIndexed();
      await service.archive(person, { type: "doc", id: "old" }, "out of date");
    });

    for (const how of ["meaning", "words"] as const) {
      it(`leaves them out unless asked for, by ${how}`, async () => {
        if (how === "words") embedder = undefined;
        expect(await service.search(person, { text: "hotel Lisbon" })).toEqual([]);
        const hits = await service.search(person, { text: "hotel Lisbon", includeArchived: true });
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ how, record: { id: "old", archiveReason: "out of date" } });
      });
    }

    it("keeps an archived record's vector, so bringing it back costs no embedding", async () => {
      const calls = embedder?.calls.length;
      expect(rows().map((r) => r.id)).toEqual(["old"]);
      await service.unarchive(person, { type: "doc", id: "old" });
      await service.whenIndexed();
      expect(embedder?.calls.length).toBe(calls);
      expect((await service.search(person, { text: "lodging" }))[0]).toMatchObject({ how: "meaning" });
    });
  });

  describe("keeping the index honest", () => {
    it("follows a record into a new scope without embedding it again", async () => {
      await service.put(person, { type: "doc", id: "d", data: { title: "Hotel in Lisbon" } });
      await service.whenIndexed();
      const calls = embedder?.calls.length;
      await service.put(person, { type: "doc", id: "d", scope: "agent:reviewer", data: { title: "Hotel in Lisbon" } });
      await service.whenIndexed();
      expect(rows().map((r) => [r.id, r.scope])).toEqual([["d", "agent:reviewer"]]);
      expect(embedder?.calls.length).toBe(calls);
      expect(await service.search(planner, { text: "hotel Lisbon" })).toEqual([]);
      expect(ids(await service.search(reviewer, { text: "hotel Lisbon" }))).toEqual(["doc/d"]);
    });

    it("drops a record's vector when it is deleted or erased", async () => {
      await service.put(person, { type: "doc", id: "a", data: { title: "Hotel in Lisbon" } });
      await service.put(person, { type: "doc", id: "b", data: { title: "Hotel in Porto" } });
      await service.whenIndexed();
      expect(rows()).toHaveLength(2);

      await service.delete(person, { type: "doc", id: "a" });
      expect(rows().map((r) => r.id)).toEqual(["b"]);
      await service.purge(person, { type: "doc", id: "b" });
      expect(rows()).toEqual([]);
    });

    it("never brings a deleted record back as a vector when its embedding lands late", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      embedder = fakeEmbedder("fake-1", async (inputs) => {
        await gate;
        return { vectors: inputs.map(meaning), model: "fake-1", dim: 4 };
      });
      await service.put(person, { type: "doc", id: "brief", data: { title: "Hotel in Lisbon" } });
      await vi.waitFor(() => expect(embedder?.calls).toHaveLength(1));
      await service.delete(person, { type: "doc", id: "brief" });
      release();
      await service.whenIndexed();
      expect(rows()).toEqual([]);
    });

    it("drops a record that no longer has any text to search", async () => {
      await service.put(person, { type: "doc", id: "d", data: { title: "Hotel in Lisbon" } });
      await service.whenIndexed();
      await service.put(person, { type: "doc", id: "d", data: { reviewedAt: "2026-10-01" } });
      expect(rows()).toEqual([]);
    });

    it("backfills what was written before embeddings were on, and drops entries for records that are gone", async () => {
      embedder = undefined;
      await service.put(person, { type: "doc", id: "a", data: { title: "Hotel in Lisbon" } });
      await service.put(person, { type: "doc", id: "b", data: { title: "Weeknight recipes" } });
      await service.put(person, { type: "plan", id: "p", data: { name: "Not searchable" } });
      db.prepare(
        "INSERT INTO state_search (type, id, scope, model, vector, text_hash, indexed_at) VALUES ('doc', 'gone', 'global', 'fake:fake-1', x'00000000', 'x', 'now')",
      ).run();
      expect(await service.backfillSearch()).toBe(0);

      embedder = fakeEmbedder();
      expect(await service.backfillSearch()).toBe(2);
      await service.whenIndexed();
      expect(rows().map((r) => r.id)).toEqual(["a", "b"]);
      // Nothing left to do: a second pass queues nothing.
      expect(await service.backfillSearch()).toBe(0);
    });
  });

  describe("an embedder that fails", () => {
    let changes: RuntimeEventPayload<"state.changed">[];
    let events: TypedEventBus;

    beforeEach(async () => {
      await service.close();
      events = new TypedEventBus();
      changes = [];
      events.on("state.changed", (c) => {
        changes.push(c);
      });
      service = new StateService({ getConfig: () => config, db, events, getEmbedder: () => embedder });
    });

    it("never fails or holds up a write, and the record is still found by words", async () => {
      embedder = fakeEmbedder("fake-1", async () => {
        throw new Error("embedder down");
      });
      const record = await service.put(person, { type: "doc", id: "d", data: { title: "Hotel in Lisbon" } });
      expect(record.version).toBe(1);
      expect(changes.map((c) => c.op)).toEqual(["create"]);
      await service.whenIndexed();
      expect(rows()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("embedder down"));

      const hits = await service.search(person, { text: "hotel Lisbon" });
      expect(hits.map((h) => [h.record.id, h.how])).toEqual([["d", "words"]]);
    });

    it("never fails a write when the embedder throws before it even returns a promise", async () => {
      embedder = {
        ...fakeEmbedder(),
        embed: () => {
          throw new Error("not configured");
        },
      };
      await expect(
        service.put(person, { type: "doc", id: "d", data: { title: "Hotel in Lisbon" } }),
      ).resolves.toMatchObject({ version: 1 });
      await service.whenIndexed();
      expect(changes).toHaveLength(1);
    });
  });
});

describe("the search index's pacing", () => {
  it("embeds a backlog in batches, with a pause between calls", async () => {
    const db = new Database(":memory:");
    const at: number[] = [];
    const embedder = fakeEmbedder("fake-1", async (inputs) => {
      at.push(Date.now());
      return { vectors: inputs.map(meaning), model: "fake-1", dim: 4 };
    });
    const index = new StateSearchIndex({ db, getEmbedder: () => embedder, batchSize: 2, pauseMs: 40 });
    for (const id of ["a", "b", "c", "d", "e"]) {
      index.queue(
        { type: "doc", id, scope: "global", text: `hotel ${id}`, hash: hashText(`hotel ${id}`) },
        "fake:fake-1",
      );
    }
    await index.whenIdle();
    expect(embedder.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(35);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(35);
    await index.close();
    db.close();
  });

  it("writes nothing after it is closed", async () => {
    const db = new Database(":memory:");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedder = fakeEmbedder("fake-1", async (inputs) => {
      await gate;
      return { vectors: inputs.map(meaning), model: "fake-1", dim: 4 };
    });
    const index = new StateSearchIndex({ db, getEmbedder: () => embedder, pauseMs: 0 });
    index.queue({ type: "doc", id: "a", scope: "global", text: "hotel", hash: hashText("hotel") }, "fake:fake-1");
    await vi.waitFor(() => expect(embedder.calls).toHaveLength(1));
    const closed = index.close();
    release();
    await closed;
    expect(db.prepare("SELECT COUNT(*) AS n FROM state_search").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("an embedder that never answers", () => {
  /** Ignores its abort signal too, as a careless plugin might. */
  const hung = () => fakeEmbedder("fake-1", () => new Promise<EmbedResult>(() => {}));

  it("holds a search's query for ten seconds at most, then the search matches words", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = embedQuery(hung(), "hotel");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no answer in 10s"));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("doesn't keep the index from closing", async () => {
    const db = new Database(":memory:");
    const embedder = hung();
    const index = new StateSearchIndex({ db, getEmbedder: () => embedder, pauseMs: 0 });
    index.queue({ type: "doc", id: "a", scope: "global", text: "hotel", hash: hashText("hotel") }, "fake:fake-1");
    await vi.waitFor(() => expect(embedder.calls).toHaveLength(1));
    const closed = await Promise.race([
      index.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(closed).toBe("closed");
    db.close();
  });
});

describe("search text and words", () => {
  it("reads top-level and dotted fields, through arrays and objects, and skips what holds no text", () => {
    const text = searchText(["goal", "updates.text", "owner", "tags", "missing", "done"], {
      goal: "Lisbon trip",
      updates: [{ text: "Shortlisted 3 hotels", at: "2026-10-01" }, { text: "Asked about dates" }],
      owner: { name: "planner", rooms: ["eng"] },
      tags: ["travel", 2026],
      done: false,
    });
    expect(text).toBe("Lisbon trip\nShortlisted 3 hotels\nAsked about dates\nplanner\neng\ntravel\n2026");
  });

  it("folds case and accents, drops stopwords, and meets plurals halfway", () => {
    expect(wordsOf("The Hotels of São Paulo, and an address")).toEqual(["hotel", "sao", "paulo", "address"]);
  });

  it("counts rare words for more than common ones", () => {
    const [lisbon, trip] = wordScores("lisbon trip", ["lisbon", "trip", "trip", "trip"]);
    expect(lisbon).toBeGreaterThan(trip);
  });
});

describe("search through the runtime", () => {
  it("uses the embedder the runtime builds, and the new one after a reload", async () => {
    const db = initDatabase(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "state-search-"));
    let model = "fake-1";
    const built: FakeEmbedder[] = [];
    const cfg = {
      server: { port: 0, host: "127.0.0.1" },
      providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
      agent: { defaultProvider: "openai_compatible", extraInstructions: "", maxToolRounds: 1, temperature: 0.3 },
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      tools: {},
      state: { backend: "sqlite", types: [doc] },
    } as never;
    const runtime = new AgentRuntime(
      {
        configPath: join(dir, "config.yaml"),
        db,
        contextDir: join(dir, "context"),
        kbDir: join(dir, "kb"),
        createTools: () => [],
        createProvider: () => ({ provider: { name: "fake", chat: async () => ({}) } as never, model: "fake" }),
        createEmbedder: () => {
          const e = fakeEmbedder(model);
          built.push(e);
          return e;
        },
      },
      () => cfg,
      cfg,
    );
    const service = runtime.getStateService();
    await service.put(person, { type: "doc", id: "lisbon", data: { title: "Where to stay in Lisbon" } });
    await service.whenIndexed();
    expect((await service.search(person, { text: "lodging portugal" }))[0]).toMatchObject({ how: "meaning" });
    expect(built[0].calls.length).toBeGreaterThan(0);

    model = "fake-2";
    runtime.reload();
    expect(await service.backfillSearch()).toBe(1);
    await service.whenIndexed();
    expect(built.at(-1)?.calls[0]).toEqual(["Where to stay in Lisbon"]);
    expect(db.prepare("SELECT model FROM state_search").pluck().all()).toEqual(["fake:fake-2"]);
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
