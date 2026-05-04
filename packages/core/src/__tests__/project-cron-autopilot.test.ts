import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronJobConfig } from "../config.js";
import { CronScheduler } from "../cron/scheduler.js";
import { createProject } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";
import type { AIProvider } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const fakeProvider: AIProvider = {
  name: "fake",
  chat: async () => ({ message: { role: "assistant", content: "" } }),
} as never;
const fakeTool: Tool = {
  name: "fake",
  description: "fake",
  parameters: {},
  execute: async () => ({ success: true, output: "" }),
};

function makeRuntime(): AgentRuntime {
  const config = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { ollama: { baseUrl: "http://x", defaultModel: "x" } },
    agent: { defaultProvider: "ollama", maxToolRounds: 1, maxHistoryTokens: 2000, temperature: 0.3, extraInstructions: "" },
    agents: {},
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: true, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { allow: [], deny: [], ask: [] },
    workflows: { directory: "./workflows" },
    projects: { enabled: true, directory: "./data/projects" },
    tasks: { backend: "native" as const },
  } as never;
  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: "/tmp",
      kbDir: "/tmp",
      createTools: () => [fakeTool],
      createProvider: () => ({ provider: fakeProvider, model: "x" }),
    },
    () => config,
    config,
  );
}

describe("CronScheduler — project binding", () => {
  it("upsertJobRow writes project_id from job.project", () => {
    const runtime = makeRuntime();
    const scheduler = new CronScheduler({ runtime });
    const proj = createProject(db, { title: "P", path: "/p" });

    const job: CronJobConfig = {
      name: "scoped",
      schedule: "* * * * *",
      prompt: "hi",
      project: proj.id,
    };
    // upsertJobRow is private but exercised by start(); call via any:
    (scheduler as unknown as { upsertJobRow: (j: CronJobConfig) => void }).upsertJobRow(job);

    const row = db.prepare("SELECT name, project_id, session_key FROM cron_jobs WHERE name = ?").get("scoped") as {
      name: string;
      project_id: string;
      session_key: string;
    };
    expect(row.project_id).toBe(proj.id);
    expect(row.session_key).toBe(`cron:${proj.id}:scoped`);
  });

  it("upsertJobRow leaves project_id null for global jobs", () => {
    const runtime = makeRuntime();
    const scheduler = new CronScheduler({ runtime });
    const job: CronJobConfig = { name: "global", schedule: "* * * * *", prompt: "hi" };
    (scheduler as unknown as { upsertJobRow: (j: CronJobConfig) => void }).upsertJobRow(job);

    const row = db.prepare("SELECT project_id, session_key FROM cron_jobs WHERE name = ?").get("global") as {
      project_id: string | null;
      session_key: string;
    };
    expect(row.project_id).toBeNull();
    expect(row.session_key).toBe("cron:global");
  });

  it("resolveJobProject returns null and warns for unknown project ids", () => {
    const runtime = makeRuntime();
    const scheduler = new CronScheduler({ runtime });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const fn = (scheduler as unknown as { resolveJobProject: (j: CronJobConfig) => unknown }).resolveJobProject;
      const result = fn.call(scheduler, { name: "x", schedule: "* * * * *", prompt: "p", project: "proj_ghost" });
      expect(result).toBeNull();
      expect(warnings.some((w) => w.includes("proj_ghost"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("resolveJobProject returns a context with the registered path", () => {
    const runtime = makeRuntime();
    const scheduler = new CronScheduler({ runtime });
    const proj = createProject(db, { title: "Mine", path: "/repos/mine" });

    const fn = (scheduler as unknown as {
      resolveJobProject: (j: CronJobConfig) => { id: string; name: string; path: string } | null;
    }).resolveJobProject;
    const result = fn.call(scheduler, { name: "x", schedule: "* * * * *", prompt: "p", project: proj.id });
    expect(result?.id).toBe(proj.id);
    expect(result?.path).toBe("/repos/mine");
    expect(result?.name).toBe("Mine");
  });
});

describe("buildLoopOptions — per-call project override", () => {
  it("uses the call's project.path as cwd, ignoring the runtime's active project", () => {
    const runtime = makeRuntime();

    // Set a runtime-active project
    runtime.setActiveProject({
      id: "proj_active",
      name: "Active",
      path: "/host/active",
      overlayPath: "",
      overlay: {},
    });

    const session = { id: "s1", model: "x", provider: "ollama" };
    const optsHost = runtime.buildLoopOptions({ session });
    expect(optsHost.cwd).toBe("/host/active");

    const optsScoped = runtime.buildLoopOptions({
      session,
      project: {
        id: "proj_call",
        name: "Call",
        path: "/host/call",
        overlayPath: "",
        overlay: {},
      },
    });
    expect(optsScoped.cwd).toBe("/host/call");
  });

  it("project: null on a call clears the cwd even when the runtime has an active project", () => {
    const runtime = makeRuntime();
    runtime.setActiveProject({
      id: "proj_active",
      name: "Active",
      path: "/host/active",
      overlayPath: "",
      overlay: {},
    });
    const session = { id: "s1", model: "x", provider: "ollama" };
    const opts = runtime.buildLoopOptions({ session, project: null });
    expect(opts.cwd).toBeUndefined();
  });
});
