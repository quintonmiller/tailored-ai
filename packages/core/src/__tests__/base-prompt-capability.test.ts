/**
 * The base prompt should describe the agent it is addressed to.
 *
 * It was a flat string constant, so every agent was told "You are a
 * self-modifying agent … creating new tools, adjusting settings" — including
 * `travel-researcher` and `email-checker`, which hold no tool that can do any
 * of it. That instruction plus a writable `custom_tools.`/`permissions.` is the
 * path by which an agent authored `temp: 0.3` into its own config.
 *
 * And it said context files were "ground truth", which is how a two-month-old
 * question in `inbox.md` got reported as live outstanding work.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBaseSystemPrompt, canSelfModify } from "../agent/prompt.js";
import { newSession, type Session } from "../agent/session.js";
import { resolveBase } from "../agent/system-prompt.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createMetaTools } from "../factories.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";

const tool = (name: string): Tool =>
  ({ name, description: "", parameters: {}, execute: async () => ({ success: true, output: "" }) }) as Tool;

let db: Database.Database;
let home: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-base-prompt-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function makeRuntimeWithAgents(agents: Record<string, unknown>): { runtime: AgentRuntime; session: Session } {
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
    agents,
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./c", kbDirectory: "./k" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: "./w" },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;

  const runtime = new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "c"),
      kbDir: join(home, "k"),
      createTools: () => [tool("probe")],
      createProvider: () => ({ provider: { name: "f", chat: async () => ({}) } as never, model: "x" }),
    },
    () => config,
    config,
  );
  // The real meta tools, so `admin` really is present on every agent — which is
  // the whole point of the regression these tests pin.
  runtime.setMetaTools(createMetaTools(runtime, join(home, "c"), join(home, "k")));
  return { runtime, session: newSession(db, "x", "openai_compatible", "s1") };
}

describe("canSelfModify", () => {
  it("is true only when the agent declared a config-writing tool", () => {
    expect(canSelfModify([tool("admin")])).toBe(true);
    expect(canSelfModify([tool("resource_admin")])).toBe(true);
    expect(canSelfModify([tool("read"), tool("web_search")])).toBe(false);
    expect(canSelfModify([])).toBe(false);
  });
});

describe("buildBaseSystemPrompt", () => {
  it("omits the self-modification paragraph by default", () => {
    expect(buildBaseSystemPrompt()).not.toContain("self-modifying");
  });

  it("includes it for an agent that can carry it out", () => {
    expect(buildBaseSystemPrompt({ selfModifying: true })).toContain("self-modifying");
  });

  it("keeps identity and memory guidance in both shapes", () => {
    for (const p of [buildBaseSystemPrompt(), buildBaseSystemPrompt({ selfModifying: true })]) {
      expect(p).toContain("personal AI assistant");
      expect(p).toContain("memory tool");
    }
  });

  it("no longer calls context files ground truth", () => {
    const p = buildBaseSystemPrompt();
    expect(p).not.toContain("ground truth");
    // The replacement has to actually say the thing, not merely drop the claim:
    // a snapshot the model treats as current is the failure being fixed.
    expect(p).toContain("not a live feed");
    expect(p).toContain("trust the tool over the file");
  });

  it("is not larger than the prompt it replaces", () => {
    // The history budget is maxHistoryTokens - systemPromptTokens, so growth
    // here evicts conversation. The old prompt was ~1487 chars.
    expect(buildBaseSystemPrompt({ selfModifying: true }).length).toBeLessThanOrEqual(1487);
  });
});

describe("resolveBase — capability plumbing", () => {
  it("passes the flag through to the built-in base", () => {
    expect(resolveBase(undefined, { selfModifying: true })).toContain("self-modifying");
    expect(resolveBase(undefined, { selfModifying: false })).not.toContain("self-modifying");
  });

  it("returns an explicit base override verbatim", () => {
    // A deployment that wrote its own base owns every sentence in it. Appending
    // a paragraph it did not write would be the same surprise this fixes.
    expect(resolveBase({ base: "mine" }, { selfModifying: true })).toBe("mine");
  });
});

describe("buildLoopOptions — which set the flag is read from", () => {
  /**
   * The regression this guards. `admin` and `resource_admin` are meta tools
   * appended to every agent, so reading the *final* tool set makes the flag
   * true for all of them and the paragraph is dropped for nobody — a guard
   * that does not guard. It has to come from the declared list.
   */
  it("is false for an agent that declares tools without admin, despite holding admin at run time", () => {
    const { runtime, session } = makeRuntimeWithAgents({
      researcher: { tools: ["probe"] },
    });

    const opts = runtime.buildLoopOptions({ session, agentName: "researcher" });

    expect(opts.tools.map((t) => t.name)).toContain("admin"); // it really is there
    expect(opts.selfModifying).toBe(false); // and it is still not what the agent is for
    expect(opts.tools.length).toBeGreaterThan(1);
  });

  it("is true for an agent that names admin itself", () => {
    const { runtime, session } = makeRuntimeWithAgents({
      boss: { tools: ["probe", "admin"] },
    });

    expect(runtime.buildLoopOptions({ session, agentName: "boss" }).selfModifying).toBe(true);
  });

  it("is true for an agent that declares no tools at all, having opted into everything", () => {
    const { runtime, session } = makeRuntimeWithAgents({ wideopen: {} });

    expect(runtime.buildLoopOptions({ session, agentName: "wideopen" }).selfModifying).toBe(true);
  });
});
