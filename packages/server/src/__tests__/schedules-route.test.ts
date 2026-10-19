/**
 * `GET /api/schedules`: the wakes agents booked with the `schedule` tool that
 * are still to come, soonest first, everyone's or one agent's; and when each
 * cron job next runs on `GET /api/cron`. Read only: the calendars in the 3D
 * world are drawn from them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase, ScheduleStore } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: ["created", "updated"] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    time: { timezone: "UTC" },
  };
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let cfg: AgentConfig;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "schedules-route-"));
  db = initDatabase(":memory:");
  cfg = buildConfig();
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, "", "utf-8");
  runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function get(path: string) {
  const { app } = createServer({ runtime });
  const res = await app.fetch(new Request(`http://t${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

describe("GET /api/schedules", () => {
  it("lists every agent's wakes still to come, soonest first, with their times as ISO instants", async () => {
    const store = new ScheduleStore(db);
    store.create({
      agent: "writer",
      note: "send the draft",
      kind: "once",
      source: "in 5 hours",
      nextRunAt: inHours(5),
      targetKind: "session",
      target: "s1",
    });
    store.create({
      agent: "planner",
      note: "morning sweep",
      kind: "repeat",
      cron: "0 9 * * 1-5",
      source: "weekdays at 9am",
      nextRunAt: inHours(2),
      targetKind: "room",
      target: "local:trip",
    });
    const gone = store.create({
      agent: "planner",
      note: "never mind",
      kind: "once",
      source: "in 1 hour",
      nextRunAt: inHours(1),
      targetKind: "session",
      target: "s2",
    });
    store.cancel("planner", [gone.id]);

    const { status, body } = await get("/api/schedules");
    expect(status).toBe(200);
    const schedules = body.schedules as Record<string, unknown>[];
    expect(schedules.map((s) => [s.agent, s.note])).toEqual([
      ["planner", "morning sweep"],
      ["writer", "send the draft"],
    ]);
    expect(schedules[0]).toMatchObject({
      kind: "repeat",
      every: "weekdays at 9am",
      target_kind: "room",
      target: "local:trip",
      run_count: 0,
      last_run_at: null,
    });
    expect(schedules[1].every).toBeNull();
    expect(Math.abs(Date.parse(String(schedules[0].next_run_at)) - inHours(2).getTime())).toBeLessThan(2000);
    expect(String(schedules[0].next_run_at)).toMatch(/Z$/);
  });

  it("gives one agent's with ?agent=, and no more than ?limit=", async () => {
    const store = new ScheduleStore(db);
    for (const [agent, h] of [
      ["planner", 3],
      ["writer", 1],
      ["planner", 2],
    ] as const)
      store.create({
        agent,
        note: `${agent} at ${h}`,
        kind: "once",
        source: `in ${h} hours`,
        nextRunAt: inHours(h),
        targetKind: "session",
        target: "s",
      });
    const mine = (await get("/api/schedules?agent=planner")).body.schedules as { note: string }[];
    expect(mine.map((s) => s.note)).toEqual(["planner at 2", "planner at 3"]);
    const first = (await get("/api/schedules?limit=1")).body.schedules as { note: string }[];
    expect(first.map((s) => s.note)).toEqual(["writer at 1"]);
  });
});

describe("GET /api/cron", () => {
  it("says when each job next runs, in the runtime's timezone", async () => {
    cfg.cron = {
      enabled: true,
      jobs: [
        { name: "digest", schedule: "every day at 9am", prompt: "Write the digest.", agent: "planner" },
        { name: "off", schedule: "0 9 * * *", prompt: "Nothing.", enabled: false },
      ],
    } as AgentConfig["cron"];
    const jobs = (await get("/api/cron")).body.jobs as { name: string; next_run: string | null }[];
    const digest = jobs.find((j) => j.name === "digest");
    expect(digest?.next_run).toMatch(/T09:00:00\.000Z$/);
    const at = Date.parse(String(digest?.next_run));
    expect(at).toBeGreaterThan(Date.now());
    expect(at - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(jobs.find((j) => j.name === "off")?.next_run).toBeNull();
  });

  it("says none while cron is off", async () => {
    cfg.cron = {
      enabled: false,
      jobs: [{ name: "digest", schedule: "0 9 * * *", prompt: "Write the digest." }],
    } as AgentConfig["cron"];
    const jobs = (await get("/api/cron")).body.jobs as { next_run: string | null }[];
    expect(jobs[0].next_run).toBeNull();
  });
});
