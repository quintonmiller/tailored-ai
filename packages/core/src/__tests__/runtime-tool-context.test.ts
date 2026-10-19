/**
 * What tool factories are handed, at every point tools are built. The
 * construction walk used to write its context out by hand and left
 * `deliverAgentMessage` out, so `room`'s direct messages answered "not wired
 * up" from every start until the first config reload.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let home: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-tool-context-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const provider: AIProvider = {
  id: "openai_compatible",
  name: "test",
  supportsTools: true,
  async chat() {
    return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
  },
};

const config = {
  server: { port: 3000, host: "127.0.0.1" },
  database: { path: ":memory:" },
  providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
  agent: { defaultProvider: "openai_compatible", maxToolRounds: 3, maxHistoryTokens: 4000, temperature: 0.3 },
  agents: {},
  channels: {},
  tools: {},
  custom_tools: {},
  cron: { enabled: false, jobs: [] },
  context: { directory: "./data/context", kbDirectory: "./data/kb" },
  prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
  permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
  workflows: { directory: "./workflows" },
  tasks: { backend: "native" as const },
} as unknown as AgentConfig;

type Context = Record<string, unknown>;

describe("the context tool factories are handed", () => {
  it("is the same at startup, for late factories, and on reload: direct messages included", async () => {
    const seen: Context[] = [];
    const runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: join(home, "context"),
        kbDir: join(home, "kb"),
        createTools: (_config, _dir, _path, ctx) => {
          seen.push((ctx ?? {}) as Context);
          return [];
        },
        createProvider: () => ({ provider, model: "x" }),
      },
      () => config,
      config,
    );
    runtime.applyPendingToolFactories();
    await runtime.reload();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const ctx of seen) {
      expect(typeof ctx.deliverAgentMessage).toBe("function");
      expect(Object.keys(ctx).sort()).toEqual(Object.keys(seen[0]).sort());
    }
  });
});
