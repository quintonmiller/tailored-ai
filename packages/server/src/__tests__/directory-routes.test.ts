/**
 * The directory plugin's routes, mounted by the real server: what the agent
 * pages read. The plugin is imported and loaded the way the CLI loads a
 * `builtin:` module, against a real runtime, so these go through the same
 * registration and the same auth gate as any plugin route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  type ChatParams,
  type ChatResponse,
  createPluginContext,
  initDatabase,
  type LoadedPlugin,
  loadPlugins,
  type RuntimeEventPayload,
  type StateCaller,
  toolFactoryRegistry,
  type Wake,
} from "@tailored-ai/core";
import { nextTend, TEND_TICK_MS } from "@tailored-ai/core/plugins/places-tend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../index.js";

/** What the model answers, call by call; "ok" once the script runs out. Every call it gets is kept. */
let script: ((params: ChatParams) => ChatResponse | Promise<ChatResponse>)[];
let chats: ChatParams[];

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async (params: ChatParams) => {
      chats.push(params);
      const next = script.shift();
      return next ? next(params) : { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

/** A model reply that calls one tool. */
function calls(name: string, args: Record<string, unknown>): (params: ChatParams) => ChatResponse {
  return () => ({
    content: null,
    toolCalls: [{ id: `call-${chats.length}`, name, arguments: args }],
    usage: { input: 0, output: 0 },
    finishReason: "tool_calls",
  });
}

let pluginConfig: Record<string, unknown>;
/** Tool rounds every agent is configured for. */
let agentRounds: number;
/** Agents beyond the two every test has. */
let moreAgents: Record<string, unknown>;
/** Each agent's wakes an hour, turns nobody asked for, shared by everything that wakes it. */
let maxWakes: number;

function buildConfig(authToken?: string): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1", ...(authToken ? { authToken } : {}) },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: agentRounds,
    },
    agents: {
      planner: { description: "Plans the week." },
      "trip-planner": { description: "Plans trips." },
      ...moreAgents,
    },
    rooms: { maxWakesPerHour: maxWakes },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    state: { backend: "sqlite" },
    plugins: [{ module: "builtin:directory", enabled: true, config: pluginConfig }],
  } as unknown as AgentConfig;
}

const person: StateCaller = { actor: { kind: "user", name: "owner" } };

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let plugins: LoadedPlugin[];
let tmpDir: string;
let originalHome: string | undefined;

async function start(authToken?: string) {
  const cfg = buildConfig(authToken);
  runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      // The directory's tools, as the CLI's walk of the factory registry builds them once the plugin is loaded.
      createTools: (config, _contextDir, _configPath, tctx) =>
        ["directory", "commitment", "writeup"].flatMap((name) => toolFactoryRegistry.get(name)?.(config, tctx) ?? []),
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  // The CLI's importer maps `builtin:<name>` to this subpath of core.
  plugins = await loadPlugins(cfg, (name) => import(`@tailored-ai/core/plugins/${name.slice("builtin:".length)}`), {
    context: createPluginContext({ runtime, events: runtime.events }),
  });
  expect(plugins.map((p) => [p.module, p.ok, p.shape])).toEqual([["builtin:directory", true, "register"]]);
  runtime.syncToolFactories();
  const service = runtime.getStateService();
  await service.put(person, {
    type: "profile",
    id: "trip-planner",
    scope: "global",
    data: { owner: "trip-planner", purpose: "Plans trips end to end." },
  });
  await service.put(person, {
    type: "commitment",
    id: "trip-planner-lisbon",
    scope: "global",
    data: { owner: "trip-planner", goal: "Lisbon trip prep", status: "open" },
  });
  await service.put(person, {
    type: "commitment",
    id: "trip-planner-gift",
    scope: "agent:trip-planner",
    data: { owner: "trip-planner", goal: "Gift", status: "waiting" },
  });
  return createServer({ runtime }).app;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "directory-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  plugins = [];
  script = [];
  chats = [];
  pluginConfig = {};
  agentRounds = 1;
  moreAgents = {};
  maxWakes = 12;
});

afterEach(async () => {
  for (const p of plugins) await p.stop?.();
  await runtime.getStateService().close();
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the directory routes", () => {
  it("lists every agent with its profile or description and its counts", async () => {
    const app = await start();
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents"));
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: Record<string, unknown>[] };
    expect(agents).toEqual([
      {
        name: "planner",
        profile: null,
        description: "Plans the week.",
        commitments: { open: 0, waiting: 0, done: 0 },
        docs: 0,
      },
      {
        name: "trip-planner",
        profile: { owner: "trip-planner", purpose: "Plans trips end to end." },
        description: "Plans trips.",
        commitments: { open: 1, waiting: 1, done: 0 },
        docs: 0,
      },
    ]);
  });

  it("gives one agent's records, private ones included, and 404s an unknown agent", async () => {
    const app = await start();
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; profile: { id: string }; commitments: { id: string }[] };
    expect(body.name).toBe("trip-planner");
    expect(body.profile.id).toBe("trip-planner");
    expect(body.commitments.map((c) => c.id).sort()).toEqual(["trip-planner-gift", "trip-planner-lisbon"]);
    const missing = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/ghost"));
    expect(missing.status).toBe(404);
  });

  it("gives an agent's page layout with its records", async () => {
    const app = await start();
    const before = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    expect(((await before.json()) as { page: unknown }).page).toBeNull();
    await runtime.getStateService().put(person, {
      type: "page",
      id: "trip-planner",
      scope: "global",
      data: { owner: "trip-planner", note: "I plan trips.", hide: ["docs"] },
    });
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    const body = (await res.json()) as { page: { data: Record<string, unknown> } };
    expect(body.page.data).toEqual({ owner: "trip-planner", note: "I plan trips.", hide: ["docs"] });
  });

  it("hands an agent a commitment from its page, written as the person", async () => {
    const app = await start();
    const res = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Book the dentist", doneWhen: "On the calendar" }),
      }),
    );
    expect(res.status).toBe(201);
    const { commitment, inPrompt } = (await res.json()) as { commitment: { id: string }; inPrompt: boolean };
    expect(commitment.id).toBe("planner-book-the-dentist");
    expect(inPrompt).toBe(true);
    const made = await runtime.getStateService().get(person, { type: "commitment", id: "planner-book-the-dentist" });
    expect(made?.data).toMatchObject({ owner: "planner", status: "open", from: "a person" });
    expect(made?.updatedBy).toEqual({ kind: "user", name: "owner" });

    const empty = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doneWhen: "x" }),
      }),
    );
    expect(empty.status).toBe(400);
  });

  it("sits behind the server's bearer token like every other API route", async () => {
    const app = await start("secret");
    expect((await app.fetch(new Request("http://t/api/ext/builtin:directory/agents"))).status).toBe(401);
    const ok = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents", { headers: { Authorization: "Bearer secret" } }),
    );
    expect(ok.status).toBe(200);
    const handOver = () =>
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        body: JSON.stringify({ goal: "Sneak in" }),
      });
    expect((await app.fetch(handOver())).status).toBe(401);
  });

  describe("rooms", () => {
    const api = (path: string, init?: RequestInit) =>
      new Request(`http://t/api/ext/builtin:directory/${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
    const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

    async function withRooms() {
      pluginConfig = { leads: { travel: "trip-planner" } };
      const app = await start();
      const rooms = runtime.getRoomStore();
      rooms.upsertRoom({ ref: { backend: "local", id: "travel" }, name: "travel", purpose: "Family trips." }, "alex");
      rooms.subscribe({ agent: "trip-planner", roomRef: "local:travel" });
      rooms.subscribe({ agent: "planner", roomRef: "local:travel" });
      rooms.upsertRoom({ ref: { backend: "local", id: "garden" }, name: "garden" }, "planner");
      await runtime.getStateService().put(person, {
        type: "commitment",
        id: "room-travel-ferry",
        scope: "room:local:travel",
        data: {
          owner: "room:local:travel",
          room: "local:travel",
          goal: "Ferry tickets",
          status: "open",
          nextStep: "Compare crossings",
          updates: [{ at: new Date(Date.now() - 20 * 86_400_000).toISOString(), text: "Opened.", by: "planner" }],
        },
      });
      return app;
    }

    it("lists each room with its lead and counts, and gives one room's records, members and lead", async () => {
      const app = await withRooms();
      const list = await app.fetch(api("rooms"));
      expect(list.status).toBe(200);
      expect(((await list.json()) as { rooms: unknown[] }).rooms).toEqual([
        {
          ref: "local:garden",
          name: "garden",
          purpose: null,
          lead: "planner",
          leadFrom: "creator",
          members: ["planner"],
          commitments: { open: 0, waiting: 0, done: 0 },
          docs: 0,
        },
        {
          ref: "local:travel",
          name: "travel",
          purpose: "Family trips.",
          lead: "trip-planner",
          leadFrom: "config",
          members: ["planner", "trip-planner"],
          commitments: { open: 1, waiting: 0, done: 0 },
          docs: 0,
        },
      ]);
      const one = await app.fetch(api("rooms/travel"));
      const room = (await one.json()) as Record<string, unknown>;
      expect(room).toMatchObject({
        ref: "local:travel",
        name: "travel",
        createdBy: "alex",
        archived: false,
        profile: null,
        lead: { agent: "trip-planner", source: "config" },
        members: ["planner", "trip-planner"],
        agents: ["planner", "trip-planner"],
        held: {},
      });
      expect((room.commitments as { id: string }[]).map((c) => c.id)).toEqual(["room-travel-ferry"]);
      expect((await app.fetch(api("rooms/attic"))).status).toBe(404);
    });

    it("hands the lead something, changes the lead, and keeps a person's edits, as the person", async () => {
      const app = await withRooms();
      const handed = await app.fetch(api("rooms/travel/commitments", json("POST", { goal: "Find a dog sitter" })));
      expect(handed.status).toBe(201);
      const { commitment, lead } = (await handed.json()) as { commitment: { id: string; data: unknown }; lead: string };
      expect(lead).toBe("trip-planner");
      expect(commitment.data).toMatchObject({ owner: "trip-planner", room: "local:travel", from: "a person" });

      const chose = await app.fetch(api("rooms/travel/lead", json("PUT", { lead: "planner" })));
      expect(((await chose.json()) as { lead: unknown }).lead).toEqual({
        agent: "planner",
        source: "person",
        configured: "trip-planner",
        fallback: { agent: "trip-planner", source: "config" },
      });
      await app.fetch(api("rooms/travel/lead", json("PUT", { lead: null })));

      const profile = await app.fetch(
        api("rooms/travel/profile", json("PATCH", { purpose: "Trips for everyone.", note: "Ask us." })),
      );
      expect(profile.status).toBe(200);
      const edit = await app.fetch(
        api("rooms/travel/commitments/room-travel-ferry", json("PATCH", { nextStep: "Wait for the timetable" })),
      );
      expect(edit.status).toBe(200);
      const room = (await (await app.fetch(api("rooms/travel"))).json()) as Record<string, unknown>;
      expect(room.held).toEqual({ "room:local:travel": ["note", "purpose"], "room-travel-ferry": ["nextStep"] });
      expect((await app.fetch(api("rooms/travel/commitments/nope", json("PATCH", { nextStep: "x" })))).status).toBe(
        400,
      );
    });

    it("gives the lead the room in its upkeep turn, where it can't overwrite what a person set", async () => {
      const app = await withRooms();
      await app.fetch(
        api("rooms/travel/commitments/room-travel-ferry", json("PATCH", { nextStep: "Wait for the timetable" })),
      );
      script = [calls("commitment", { action: "update", id: "room-travel-ferry", nextStep: "Book the early boat" })];
      expect((await app.fetch(api("agents/trip-planner/upkeep", { method: "POST" }))).status).toBe(202);
      // Until the turn has finished and kept its record, so nothing is still writing when the test ends.
      for (let i = 0; i < 200; i++) {
        const res = await app.fetch(api("agents/trip-planner"));
        const { upkeep } = (await res.json()) as { upkeep: { running: boolean; at?: string } };
        if (!upkeep.running && upkeep.at) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const first = chats[0].messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      expect(first).toContain("and the travel room you lead");
      expect(first).toContain("The travel room, which you lead");
      // The person's edit moved the commitment on, so what's left to see is the room's missing note.
      expect(first).toContain("- The travel room's page has no note for people.");
      // The test config's history is small enough to trim the tool's answer from the next request; it's in the session.
      const answer = (
        db.prepare("SELECT content FROM messages WHERE role = 'tool'").all() as { content: string }[]
      ).map((m) => m.content);
      expect(answer.join("\n")).toContain(
        "A person set nextStep on room-travel-ferry, so it stays as they left it. Ask them if it should change.",
      );
      const ferry = await runtime.getStateService().get(person, { type: "commitment", id: "room-travel-ferry" });
      expect(ferry?.data.nextStep).toBe("Wait for the timetable");
    });

    it("sits behind the bearer token", async () => {
      pluginConfig = {};
      const app = await start("secret");
      expect((await app.fetch(api("rooms"))).status).toBe(401);
      expect((await app.fetch(api("rooms/travel/lead", json("PUT", { lead: "planner" })))).status).toBe(401);
    });
  });

  describe("tidying up now", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const upkeep = (name: string) =>
      new Request(`http://t/api/ext/builtin:directory/agents/${name}/upkeep`, { method: "POST" });
    type View = { running: boolean; at?: string; changed?: Record<string, number>; error?: string; every?: string };
    async function view(app: { fetch: (r: Request) => Response | Promise<Response> }, name: string): Promise<View> {
      const res = await app.fetch(new Request(`http://t/api/ext/builtin:directory/agents/${name}`));
      return ((await res.json()) as { upkeep: View }).upkeep;
    }
    async function finished(app: { fetch: (r: Request) => Response | Promise<Response> }, name: string) {
      for (let i = 0; i < 200; i++) {
        const v = await view(app, name);
        if (!v.running && (v.at || v.error)) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`${name}'s upkeep never finished`);
    }
    async function finishedLongAgo() {
      await runtime.getStateService().put(person, {
        type: "commitment",
        id: "trip-planner-transfer",
        scope: "global",
        data: {
          owner: "trip-planner",
          goal: "Airport transfer",
          status: "done",
          updates: [{ at: daysAgo(12), text: "Done." }],
        },
      });
    }

    it("runs the agent's upkeep at once, in its own session, and the page sees what it changed", async () => {
      const app = await start();
      await finishedLongAgo();
      script = [calls("commitment", { action: "archive", id: "trip-planner-transfer", reason: "Long done." })];
      expect(await view(app, "trip-planner")).toEqual({ running: false });

      const res = await app.fetch(upkeep("trip-planner"));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ started: true });
      const done = await finished(app, "trip-planner");
      expect(done).toMatchObject({ running: false, changed: { archived: 1, reviewed: 0, updated: 0, closed: 0 } });
      expect(done.error).toBeUndefined();

      // The model got the evidence, counted, in the agent's upkeep session.
      const first = chats[0].messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      expect(first).toContain("Time to look after what you own");
      expect(first).toContain('- trip-planner-transfer "Airport transfer": done 12 days ago and still not archived');
      const archived = await runtime.getStateService().get(person, { type: "commitment", id: "trip-planner-transfer" });
      expect(archived?.archivedAt).toBeTruthy();
      const session = db.prepare("SELECT key FROM sessions WHERE key LIKE 'upkeep:%'").all() as { key: string }[];
      expect(session).toEqual([{ key: "upkeep:trip-planner" }]);
    });

    it("keeps the turn to its budget of tool rounds, or the agent's own when that is fewer", async () => {
      pluginConfig = { upkeep: { maxRounds: 2 } };
      agentRounds = 10;
      const app = await start();
      await finishedLongAgo();
      // A model that would list commitments forever.
      script = Array.from({ length: 10 }, () => calls("commitment", { action: "list" }));
      expect((await app.fetch(upkeep("trip-planner"))).status).toBe(202);
      await finished(app, "trip-planner");
      // Two rounds with tools; whatever the loop asks after that, it asks without them.
      expect(chats.filter((c) => c.tools?.length).length).toBe(2);
      const ran = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get() as { n: number };
      expect(ran.n).toBe(2);
    });

    it("gives an agent configured for fewer rounds no more than its own", async () => {
      pluginConfig = { upkeep: { maxRounds: 4 } };
      agentRounds = 1;
      const app = await start();
      await finishedLongAgo();
      script = Array.from({ length: 10 }, () => calls("commitment", { action: "list" }));
      expect((await app.fetch(upkeep("trip-planner"))).status).toBe(202);
      await finished(app, "trip-planner");
      expect(chats.filter((c) => c.tools?.length).length).toBe(1);
    });

    it("goes through the waker: its tools see an upkeep, the bus hears it, and it counts toward the agent's hour", async () => {
      maxWakes = 2;
      const app = await start();
      await finishedLongAgo();
      const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
      runtime.events.on("agent.woken", (e) => {
        woken.push(e);
      });
      const seen: Array<Wake | undefined> = [];
      runtime.events.onWaterfall("agent.pre_tool_use", (p, next) => {
        seen.push(p.wake);
        return next(p);
      });
      script = [calls("commitment", { action: "archive", id: "trip-planner-transfer", reason: "Long done." })];

      expect((await app.fetch(upkeep("trip-planner"))).status).toBe(202);
      await finished(app, "trip-planner");

      const wake = { kind: "upkeep", ref: "upkeep/trip-planner" };
      expect(woken).toEqual([{ agent: "trip-planner", wake, targetKind: "session", target: "upkeep:trip-planner" }]);
      expect(seen).toEqual([wake]);
      // One of its two wakes this hour went on tidying up.
      const other = { prompt: "x", sessionKey: "watch:trip-planner", wake: { kind: "watch" } };
      expect(await runtime.wakeAgent("trip-planner", other)).toBe("ran");
      expect(await runtime.wakeAgent("trip-planner", other)).toBe("at-ceiling");
    });

    it("answers at once when the agent is at its hourly wake ceiling, says so, and runs nothing", async () => {
      maxWakes = 1;
      const app = await start();
      await finishedLongAgo();
      const other = { prompt: "x", sessionKey: "watch:trip-planner", wake: { kind: "watch" } };
      expect(await runtime.wakeAgent("trip-planner", other)).toBe("ran");
      chats = [];

      const res = await app.fetch(upkeep("trip-planner"));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "trip-planner can't tidy up now: it's at its wake ceiling: 1 wake in the last hour. Try again later.",
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(chats).toEqual([]);
      // Nothing started, so the page has no turn to show, and no failure either.
      expect(await view(app, "trip-planner")).toEqual({ running: false });
      // Another agent's hour is its own.
      expect((await app.fetch(upkeep("planner"))).status).toBe(202);
      await finished(app, "planner");
    });

    it("skips a scheduled upkeep at the hourly ceiling before reading its evidence, and runs it at its next time", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const HOUR = 3_600_000;
      pluginConfig = { upkeep: { every: "1h", agents: ["trip-planner"] } };
      maxWakes = 1;
      const app = await start();
      await finishedLongAgo();
      const due = nextTend("trip-planner", HOUR, Date.now(), "upkeep");
      // Its one wake for the hour goes on something else, a minute before its upkeep comes round.
      await vi.advanceTimersByTimeAsync(due - Date.now() - 60_000);
      const other = { prompt: "x", sessionKey: "watch:trip-planner", wake: { kind: "watch" } };
      expect(await runtime.wakeAgent("trip-planner", other)).toBe("ran");
      chats = [];

      await vi.advanceTimersByTimeAsync(60_000 + TEND_TICK_MS);
      expect(chats).toEqual([]);
      const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      expect(said).toContain(
        "[directory] trip-planner's upkeep skipped: it's at its wake ceiling: 1 wake in the last hour",
      );
      expect(await view(app, "trip-planner")).toEqual({ running: false, every: "hour" });

      // Its next time, an hour on, the hour has room: it runs, with the evidence it would have had.
      await vi.advanceTimersByTimeAsync(HOUR);
      const done = await finished(app, "trip-planner");
      expect(done.at).toBeTruthy();
      const first = chats[0].messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      expect(first).toContain('- trip-planner-transfer "Airport transfer": done 12 days ago and still not archived');
    });

    it("refuses while agents are paused, while it's already running, and for an agent with nothing to tidy with", async () => {
      moreAgents = { writer: { description: "Writes things up.", tools: ["writeup"] } };
      const app = await start();
      runtime.setAgentsPaused({ paused: true, by: "test" });
      const paused = await app.fetch(upkeep("trip-planner"));
      expect(paused.status).toBe(409);
      expect(await paused.json()).toEqual({ error: "trip-planner can't tidy up now: agents are paused." });
      runtime.setAgentsPaused({ paused: false });

      // A model that takes its time, so the second ask comes while the first runs.
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      script = [
        async () => {
          await gate;
          return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
        },
      ];
      expect((await app.fetch(upkeep("trip-planner"))).status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
      expect((await view(app, "trip-planner")).running).toBe(true);
      const again = await app.fetch(upkeep("trip-planner"));
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "trip-planner is already tidying up." });
      release();
      await finished(app, "trip-planner");

      expect((await app.fetch(upkeep("ghost"))).status).toBe(404);
      const toolless = await app.fetch(upkeep("writer"));
      expect(toolless.status).toBe(409);
      expect(await toolless.json()).toEqual({ error: "writer has no commitment tool, so it has no upkeep to do." });
      expect(await view(app, "writer")).toBeNull();
    });
  });
});
