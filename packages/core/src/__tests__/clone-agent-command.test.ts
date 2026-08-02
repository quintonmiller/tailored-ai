/**
 * `/clone-agent` — copy an agent's configuration to a new name, and nothing else.
 *
 * The command exists to make one action out of what was four steps by hand,
 * three of which were checks: copy the block under `agents:`, then confirm the
 * copy has no core memory, no sessions, no notes and no room subscriptions. The
 * failure worth guarding is the silent one — a "fresh" clone that inherited the
 * original's persona, or that woke up in the original's rooms.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { resolveAgent } from "../agent/agents.js";
import type { CloneAgentDeps } from "../channels/discord-clone-agent.js";
import { handleCloneAgentCommand } from "../channels/discord-clone-agent.js";
import { setCoreMemory } from "../db/core-memory-queries.js";
import { initDatabase } from "../db/schema.js";
import { createTools } from "../factories.js";
import { type AgentConfig, AgentRuntime } from "../index.js";
import type { AIProvider } from "../providers/interface.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat() {
      return { content: "", usage: { input: 0, output: 0 }, finishReason: "stop" as const };
    },
  };
}

let db: Database.Database;
let runtime: AgentRuntime;
let configPath: string;

/**
 * A real `AgentRuntime` over a temp config file, because this command writes
 * config: a double would prove the reply strings and none of the behaviour that
 * matters (the write choke point, the reload, the registry precedence).
 */
function buildRuntime(initialYaml: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "tai-clone-agent-"));
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, initialYaml, "utf-8");

  const defaults = {
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "",
    } as AgentConfig["agent"],
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } } as AgentConfig["providers"],
    tools: {} as AgentConfig["tools"],
  };

  const load = (): AgentConfig => {
    const parsed = YAML.parse(readFileSync(configPath, "utf-8")) as AgentConfig;
    parsed.agent ??= defaults.agent;
    parsed.providers ??= defaults.providers;
    parsed.agents ??= {};
    parsed.tools ??= defaults.tools;
    parsed.custom_tools ??= {};
    return parsed;
  };

  db = initDatabase(":memory:");
  runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmp, "context"),
      kbDir: join(tmp, "kb"),
      createTools: (c) => createTools(c, join(tmp, "context"), configPath),
      createProvider: () => ({ provider: fakeProvider(), model: "m" }),
    },
    load,
    load(),
  );
}

/** Built exactly as `DiscordChannel.cloneAgentDeps()` builds it — registry first, then config.yaml. */
function deps(): CloneAgentDeps {
  return {
    host: runtime,
    lookupAgent: (id) => {
      const fromRegistry = runtime.getAgentRegistry().get(id);
      if (fromRegistry) return { definition: fromRegistry, origin: "registry" };
      const fromConfig = runtime.getConfig().agents?.[id];
      return fromConfig ? { definition: fromConfig, origin: "config" } : undefined;
    },
    listAgents: () => {
      const ids = runtime
        .getAgentRegistry()
        .list()
        .map((r) => r.id);
      return [...new Set([...ids, ...Object.keys(runtime.getConfig().agents ?? {})])].sort();
    },
  };
}

function makeInteraction(opts: Record<string, string | null>) {
  const replies: string[] = [];
  const interaction = {
    commandName: "clone-agent",
    user: { id: "1", username: "alex" },
    deferred: false,
    replied: false,
    options: {
      getString: (name: string) => opts[name] ?? null,
    },
    reply: vi.fn(async (arg: { content: string }) => {
      if (interaction.deferred || interaction.replied) throw new Error("InteractionAlreadyReplied");
      interaction.replied = true;
      replies.push(arg.content);
    }),
    followUp: vi.fn(async (arg: { content: string }) => replies.push(arg.content)),
  };
  return { interaction, replies };
}

async function clone(from: string, to: string): Promise<string> {
  const { interaction, replies } = makeInteraction({ from, to });
  const handled = await handleCloneAgentCommand(interaction as any, deps(), runtime.getConfig());
  expect(handled).toBe(true);
  return replies.join("\n");
}

/** The agent block as it now sits on disk, which is the only copy that survives a restart. */
function onDisk(name: string): Record<string, unknown> | undefined {
  const raw = YAML.parse(readFileSync(configPath, "utf-8")) as { agents?: Record<string, never> };
  return raw.agents?.[name];
}

const IRIS = `
agents:
  iris:
    description: intern
    provider: openai_compatible
    model: qwen3.6-27b
    temperature: 0.7
    maxToolRounds: 12
    instructions: "You are an intern who mostly wants to have fun. You ask a lot of questions and write down what you learn."
    tools: [read, write, memory]
    worktree: true
`;

beforeEach(() => buildRuntime(IRIS));
afterEach(() => db.close());

describe("a faithful clone", () => {
  it("copies every field of the source definition, unchanged", async () => {
    await clone("iris", "juno");

    expect(onDisk("juno")).toEqual(onDisk("iris"));
    expect(onDisk("juno")).toMatchObject({
      description: "intern",
      provider: "openai_compatible",
      model: "qwen3.6-27b",
      temperature: 0.7,
      maxToolRounds: 12,
      tools: ["read", "write", "memory"],
      worktree: true,
    });
  });

  it("leaves the source alone", async () => {
    const before = onDisk("iris");

    await clone("iris", "juno");

    expect(onDisk("iris")).toEqual(before);
  });

  /** So the copy can be seen to be faithful without opening config.yaml. */
  it("reports the fields it carried over", async () => {
    const reply = await clone("iris", "juno");

    expect(reply).toContain("provider");
    expect(reply).toContain("qwen3.6-27b");
    expect(reply).toContain("temperature");
    expect(reply).toContain("0.7");
    // Long fields are described, not printed — instructions is routinely
    // thousands of characters and would push everything else off the message.
    expect(reply).toMatch(/`instructions`: \d+ chars/);
    expect(reply).toContain("3 — read, write, memory");
  });

  it("names what it deliberately did not copy", async () => {
    const reply = await clone("iris", "juno");

    expect(reply).toContain("Not copied");
    expect(reply).toContain("core memory");
    expect(reply).toContain("sessions");
    expect(reply).toContain("notes");
    expect(reply).toContain("room subscriptions");
  });

  it("clones an agent that sets no fields at all", async () => {
    buildRuntime("agents:\n  plain: {}\n");

    const reply = await clone("plain", "plain2");

    expect(onDisk("plain2")).toEqual({});
    expect(reply).toContain("no fields of its own");
  });
});

/**
 * The point of the command. Everything an agent has lived is keyed by its name;
 * a clone that inherited any of it would look fresh and behave like the
 * original, which is the failure nobody checks for.
 */
describe("what stays behind", () => {
  const count = (table: string, agent: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent = ?`).get(agent) as { n: number }).n;

  beforeEach(() => {
    setCoreMemory(db, {
      agent: "iris",
      project_id: null,
      section: "persona",
      content: "I am an intern who mostly wants to have fun.",
      updated_by: "iris",
    });
    db.prepare("INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, ?, ?)").run(
      "s1",
      "discord:iris",
      "m",
      "p",
    );
    db.prepare("INSERT INTO room_subscriptions (agent, room_ref) VALUES (?, ?)").run("iris", "discord:1");
  });

  it("creates no core memory, sessions, notes or room subscriptions for the clone", async () => {
    await clone("iris", "juno");

    expect(count("core_memory", "juno")).toBe(0);
    expect(count("room_subscriptions", "juno")).toBe(0);
    expect(count("notes", "juno")).toBe(0);
    // Sessions are keyed, not agent-columned: no new row at all is the check.
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
  });

  it("leaves the source's own memory and subscriptions untouched", async () => {
    await clone("iris", "juno");

    expect(count("core_memory", "iris")).toBe(1);
    expect(count("room_subscriptions", "iris")).toBe(1);
  });
});

describe("refusals — all before anything is written", () => {
  it("refuses an unknown source and lists the agents that exist", async () => {
    const before = readFileSync(configPath, "utf-8");

    const reply = await clone("irys", "juno");

    expect(reply).toContain("No agent named");
    expect(reply).toContain("iris");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it.each(["no spaces", "with.dot", "", "slash/name", "emoji✨"])("refuses the target name %j", async (bad) => {
    const before = readFileSync(configPath, "utf-8");

    const reply = await clone("iris", bad);

    expect(reply).toContain("not a usable agent name");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("refuses a target that already exists rather than overwriting it", async () => {
    await clone("iris", "juno");
    const after = onDisk("juno");

    const reply = await clone("iris", "juno");

    expect(reply).toContain("already exists");
    expect(onDisk("juno")).toEqual(after);
  });

  /** A registry-only agent has no config.yaml block, so a config-only check would miss it. */
  it("refuses a target that exists only in the registry", async () => {
    runtime.getAgentRegistry().registerBuiltin({ id: "ghost", definition: { model: "from-registry" } });

    const reply = await clone("iris", "ghost");

    expect(reply).toContain("already exists");
    expect(onDisk("ghost")).toBeUndefined();
  });
});

/**
 * `resolveAgent` reads the registry first and falls back to `config.agents`.
 * Cloning has to use the same precedence: an agent migrated to
 * `data/authored-resources/agent/<id>/manifest.yaml` keeps a stale block in
 * config.yaml, and copying that block clones what the agent used to be — wrong
 * in fields that still parse, so nothing complains.
 */
describe("source precedence", () => {
  it("copies the registry definition, not the stale config.yaml block", async () => {
    runtime.getAgentRegistry().registerBuiltin({
      id: "iris",
      definition: { model: "current-model", temperature: 0.1, instructions: "The migrated persona." },
    });

    const reply = await clone("iris", "juno");

    expect(onDisk("juno")).toEqual({
      model: "current-model",
      temperature: 0.1,
      instructions: "The migrated persona.",
    });
    expect(onDisk("juno")).not.toMatchObject({ model: "qwen3.6-27b" });
    expect(reply).toContain("authored-resource manifest");
  });

  it("says when it fell back to config.yaml", async () => {
    runtime.getAgentRegistry().unregister("iris");

    const reply = await clone("iris", "juno");

    expect(reply).toContain("`config.yaml` block");
  });
});

/**
 * Point of fact, verified rather than asserted in prose: `updateRawConfig`
 * reloads the runtime, and `resolveAgent` falls back to `config.agents`, so the
 * clone answers immediately. The agent REGISTRY is only populated from disk in
 * the `AgentRuntime` constructor, so the clone is not in it until a restart —
 * which changes nothing about whether it resolves.
 */
describe("usable without a restart", () => {
  it("resolves through the same path the agent loop uses", async () => {
    await clone("iris", "juno");

    const resolved = resolveAgent("juno", runtime.getConfig(), [], undefined, undefined, undefined, {
      resolveAgentDef: (id) => runtime.getAgentRegistry().get(id),
    });

    expect(resolved.model).toBe("qwen3.6-27b");
    expect(resolved.temperature).toBe(0.7);
    expect(resolved.maxToolRounds).toBe(12);
  });

  it("is in the live config straight away, and not yet in the registry", async () => {
    await clone("iris", "juno");

    expect(runtime.getConfig().agents.juno).toBeDefined();
    expect(runtime.getAgentRegistry().get("juno")).toBeUndefined();
  });

  it("says so, because the honest answer is what makes the command one action", async () => {
    const reply = await clone("iris", "juno");

    expect(reply).toContain("no restart needed");
  });
});

describe("dispatch", () => {
  it("ignores interactions that are not /clone-agent", async () => {
    const { interaction } = makeInteraction({ from: "iris", to: "juno" });
    interaction.commandName = "memory";

    expect(await handleCloneAgentCommand(interaction as any, deps(), runtime.getConfig())).toBe(false);
    expect(onDisk("juno")).toBeUndefined();
  });
});
