import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { parseFeed, RssPoller } from "../triggers/rss-poll.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Test Feed</title>
  <item>
    <title>First post</title>
    <link>https://example.test/1</link>
    <guid>tag:example,1</guid>
    <pubDate>Tue, 12 May 2026 09:00:00 +0000</pubDate>
    <description><![CDATA[Body of <b>first</b> post]]></description>
    <dc:creator>Alice</dc:creator>
  </item>
  <item>
    <title>Second post</title>
    <link>https://example.test/2</link>
    <guid>tag:example,2</guid>
    <pubDate>Tue, 12 May 2026 10:00:00 +0000</pubDate>
    <description>plain summary &amp; ok</description>
  </item>
</channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <id>urn:uuid:abc</id>
    <title>Atom one</title>
    <link href="https://example.test/atom/1" />
    <published>2026-05-12T09:00:00Z</published>
    <summary>Hello world</summary>
    <author><name>Bob</name></author>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS 2.0 items with CDATA + entities + dc:creator", () => {
    const entries = parseFeed(RSS_FEED);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "tag:example,1",
      title: "First post",
      link: "https://example.test/1",
      summary: "Body of <b>first</b> post",
      author: "Alice",
    });
    expect(entries[1].summary).toBe("plain summary & ok");
  });

  it("parses Atom entries with href attribute on <link>", () => {
    const entries = parseFeed(ATOM_FEED);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "urn:uuid:abc",
      title: "Atom one",
      link: "https://example.test/atom/1",
      summary: "Hello world",
      author: "Bob",
    });
  });

  it("returns empty when there are no items or entries", () => {
    expect(parseFeed("<rss><channel><title>empty</title></channel></rss>")).toEqual([]);
  });
});

describe("RssPoller", () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;
  let engine: WorkflowEngine;

  beforeEach(() => {
    db = initDatabase(":memory:");
    registry = new WorkflowRegistry();
    engine = new WorkflowEngine({ db, registry });
    registry.register({
      name: "rss-handler",
      steps: [
        // No executor is registered for tool_call — but the test doesn't run
        // the workflow body. We just confirm runWorkflow gets *called*.
        { name: "noop", type: "tool_call", tool: "noop_tool" },
      ],
    });
  });

  afterEach(() => {
    db.close();
  });

  it("primes seen set on registration and does not fire for existing entries", async () => {
    const spy = vi.spyOn(engine, "runWorkflow");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(RSS_FEED, { status: 200 }));

    const poller = new RssPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("rss-handler", { url: "https://example.test/feed.xml", intervalSeconds: 60 });

    // Wait for the prime call to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    poller.stop();
  });

  it("fires the workflow once per new entry, filtered by matchTitle", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({
      id: "wfrun_test",
      workflow_name: "rss-handler",
      status: "completed",
      trigger: "programmatic",
      input: {},
      output: null,
      error: null,
      started_at: "",
      finished_at: null,
      generation: 0,
    });

    const FEED_1 = RSS_FEED.replace("<item>", "<!-- placeholder --><item>");
    const FEED_2 = RSS_FEED.replace(
      "</channel>",
      `<item>
        <title>Match keyword report</title>
        <link>https://example.test/3</link>
        <guid>tag:example,3</guid>
        <pubDate>Tue, 12 May 2026 11:00:00 +0000</pubDate>
        <description>fresh</description>
      </item>
      <item>
        <title>Ignored entry</title>
        <link>https://example.test/4</link>
        <guid>tag:example,4</guid>
        <pubDate>Tue, 12 May 2026 12:00:00 +0000</pubDate>
        <description>nope</description>
      </item>
      </channel>`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(FEED_1, { status: 200 }))
      .mockResolvedValueOnce(new Response(FEED_2, { status: 200 }));

    const poller = new RssPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("rss-handler", {
      url: "https://example.test/feed.xml",
      intervalSeconds: 60,
      matchTitle: "keyword",
    });

    // Wait for prime.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Manually trigger a poll.
    await (poller as unknown as { poll: (r: unknown) => Promise<void> }).poll(
      (poller as unknown as { regs: unknown[] }).regs[0],
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe("rss-handler");
    expect((input as { title: string }).title).toBe("Match keyword report");
    poller.stop();
  });
});
