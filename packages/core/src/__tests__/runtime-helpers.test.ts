/**
 * Tests for the runtime helpers added to decouple channels from `runtime.db`
 * — see [#38](https://github.com/quintonmiller/tailored-ai/issues/38). The
 * boundary contract: a channel author can route a message and find/create
 * a session without ever importing `getProject` or `findOrCreateSession`
 * from `@tailored-ai/core` or reaching into `runtime.db`.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { createProject } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
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

function makeRuntime(): AgentRuntime {
  const config = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 1,
      maxHistoryTokens: 2000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents: {},
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { allow: [], deny: [], ask: [] },
    workflows: { directory: "./workflows" },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;
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

describe("runtime.getResolvableTools", () => {
  const metaTool: Tool = {
    name: "admin",
    description: "meta",
    parameters: {},
    execute: async () => ({ success: true, output: "" }),
  };

  it("includes meta tools, which an agent's tools: list is allowed to name", () => {
    // `buildLoopOptions` appends meta tools AFTER resolving the agent, so
    // `admin` and `delegate` are always present at run time but were invisible
    // to the allowlist that runs first. Naming one threw `references unknown
    // tool "admin"` and, in a room, the agent just stopped answering.
    const runtime = makeRuntime();
    runtime.setMetaTools([metaTool]);

    expect(runtime.getTools().map((t) => t.name)).not.toContain("admin");
    expect(
      runtime
        .getResolvableTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["admin", "fake"]);
  });

  it("survives a reload, because reload swaps the registry and not the meta tools", () => {
    const runtime = makeRuntime();
    runtime.setMetaTools([metaTool]);
    runtime.reload();

    expect(runtime.getResolvableTools().map((t) => t.name)).toContain("admin");
  });

  it("does not list a name twice when a meta tool shadows a registered one", () => {
    const runtime = makeRuntime();
    runtime.setMetaTools([{ ...metaTool, name: "fake" }]);

    expect(runtime.getResolvableTools().map((t) => t.name)).toEqual(["fake"]);
  });
});

describe("runtime.getProjectByName", () => {
  it("returns a ProjectRef for a registered project with a path", () => {
    createProject(db, { id: "p1", title: "First", path: "/tmp/p1" });
    const runtime = makeRuntime();
    const ref = runtime.getProjectByName("p1");
    expect(ref).toEqual({ id: "p1", name: "First", path: "/tmp/p1" });
  });

  it("returns undefined for an unknown project", () => {
    const runtime = makeRuntime();
    expect(runtime.getProjectByName("nope")).toBeUndefined();
  });

  it("returns undefined when the project has no registered path", () => {
    createProject(db, { id: "p2", title: "No Path", path: "" });
    const runtime = makeRuntime();
    expect(runtime.getProjectByName("p2")).toBeUndefined();
  });
});

describe("runtime.findOrCreateSession", () => {
  it("creates a session keyed by the supplied key", () => {
    const runtime = makeRuntime();
    const s = runtime.findOrCreateSession({ key: "channel:user-1" });
    expect(s.id).toBeDefined();
    expect(s.projectId).toBeNull();
  });

  it("returns the same session on a second call with the same key", () => {
    const runtime = makeRuntime();
    const a = runtime.findOrCreateSession({ key: "channel:user-1" });
    const b = runtime.findOrCreateSession({ key: "channel:user-1" });
    expect(b.id).toBe(a.id);
  });

  it("scopes the session to a project when one is supplied", () => {
    createProject(db, { id: "p1", title: "First", path: "/tmp/p1" });
    const runtime = makeRuntime();
    const project = runtime.getProjectByName("p1");
    expect(project).toBeDefined();
    const s = runtime.findOrCreateSession({ key: "channel:p1:user-1", project });
    expect(s.projectId).toBe("p1");
  });

  it("treats a missing project as null", () => {
    const runtime = makeRuntime();
    const s = runtime.findOrCreateSession({ key: "x", project: null });
    expect(s.projectId).toBeNull();
  });
});
