import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscordChannel } from "../channels/discord.js";
import { createProject } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import { AgentRuntime } from "../runtime.js";
import type { AgentConfig } from "../config.js";
import type { AIProvider } from "../providers/interface.js";
import type { Tool } from "../tools/interface.js";

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

function makeRuntime(projectMappings?: AgentConfig["channels"]["discord"]["projectMappings"]): AgentRuntime {
  const config = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: { defaultProvider: "openai_compatible", maxToolRounds: 1, maxHistoryTokens: 2000, temperature: 0.3, extraInstructions: "" },
    agents: {},
    channels: {
      discord: {
        enabled: false,
        token: "x",
        respondToDMs: true,
        respondToMentions: true,
        projectMappings,
      },
    },
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
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

interface FakeMsg {
  channelId: string;
  guild: object | null;
  author: { id: string };
}

function fakeMessage(opts: { channelId: string; isDM?: boolean; userId?: string }): FakeMsg {
  return {
    channelId: opts.channelId,
    guild: opts.isDM ? null : { id: "g1" },
    author: { id: opts.userId ?? "user1" },
  };
}

describe("DiscordChannel — project mappings", () => {
  it("returns null when no mappings are configured", () => {
    const runtime = makeRuntime();
    const ch = new DiscordChannel({ runtime });
    const result = (ch as unknown as { resolveMessageProject: (msg: FakeMsg) => unknown }).resolveMessageProject(
      fakeMessage({ channelId: "c1" }),
    );
    expect(result).toBeNull();
  });

  it("matches a guild channel mapping", () => {
    const proj = createProject(db, { title: "P", path: "/p" });
    const runtime = makeRuntime([{ channel: "c1", project: proj.id }]);
    const ch = new DiscordChannel({ runtime });
    const result = (ch as unknown as {
      resolveMessageProject: (msg: FakeMsg) => { id: string; path: string } | null;
    }).resolveMessageProject(fakeMessage({ channelId: "c1" }));
    expect(result?.id).toBe(proj.id);
    expect(result?.path).toBe("/p");
  });

  it("matches a DM mapping only for DMs", () => {
    const proj = createProject(db, { title: "DMs", path: "/dms" });
    const runtime = makeRuntime([{ dm: true, project: proj.id }]);
    const ch = new DiscordChannel({ runtime });
    const fn = (ch as unknown as {
      resolveMessageProject: (msg: FakeMsg) => { id: string } | null;
    }).resolveMessageProject;

    expect(fn.call(ch, fakeMessage({ channelId: "c1", isDM: true }))?.id).toBe(proj.id);
    expect(fn.call(ch, fakeMessage({ channelId: "c1", isDM: false }))).toBeNull();
  });

  it("first matching entry wins", () => {
    const a = createProject(db, { title: "A", path: "/a" });
    const b = createProject(db, { title: "B", path: "/b" });
    const runtime = makeRuntime([
      { channel: "c1", project: a.id },
      { channel: "c1", project: b.id },
    ]);
    const ch = new DiscordChannel({ runtime });
    const result = (ch as unknown as {
      resolveMessageProject: (msg: FakeMsg) => { id: string } | null;
    }).resolveMessageProject(fakeMessage({ channelId: "c1" }));
    expect(result?.id).toBe(a.id);
  });

  it("returns null and warns when mapping references unknown project", () => {
    const runtime = makeRuntime([{ channel: "c1", project: "proj_ghost" }]);
    const ch = new DiscordChannel({ runtime });
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      const result = (ch as unknown as {
        resolveMessageProject: (msg: FakeMsg) => unknown;
      }).resolveMessageProject(fakeMessage({ channelId: "c1" }));
      expect(result).toBeNull();
      expect(warnings.some((w) => w.includes("proj_ghost"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("returns null when the mapped project has no path", () => {
    const proj = createProject(db, { title: "PathLess" }); // no path
    const runtime = makeRuntime([{ channel: "c1", project: proj.id }]);
    const ch = new DiscordChannel({ runtime });
    const orig = console.warn;
    console.warn = () => {};
    try {
      const result = (ch as unknown as {
        resolveMessageProject: (msg: FakeMsg) => unknown;
      }).resolveMessageProject(fakeMessage({ channelId: "c1" }));
      expect(result).toBeNull();
    } finally {
      console.warn = orig;
    }
  });
});
