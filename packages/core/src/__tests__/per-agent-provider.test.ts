/**
 * An agent that names its own `provider:` must run on it.
 *
 * The field parsed, `validateConfig` checked it against `config.providers`,
 * and `findOrCreateSession` wrote it into the session row — but
 * `buildLoopOptions` passed `this._provider` unconditionally, so every agent
 * ran on `agent.defaultProvider` no matter what it declared. The symptom is
 * indirect: the agent's model name is sent to the default provider's endpoint,
 * which answers 404 for a model that exists somewhere else.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { resolveAgent } from "../agent/agents.js";
import { type AgentConfig, AgentRuntime } from "../index.js";
import type { AIProvider } from "../providers/interface.js";

function fakeProvider(id: string): AIProvider {
  return {
    id,
    name: id,
    supportsTools: false,
    async chat() {
      return { content: id, usage: { input: 0, output: 0 }, finishReason: "stop" as const };
    },
  };
}

const YAML_CONFIG = [
  "agent:",
  "  defaultProvider: local",
  "providers:",
  "  local:",
  "    baseUrl: http://127.0.0.1:8000/v1",
  "    defaultModel: local-model",
  "  remote:",
  "    apiKey: k",
  "    defaultModel: vendor/remote-model",
  "agents:",
  "  onDefault:",
  "    description: uses the deployment default",
  "  onRemote:",
  "    description: names its own provider",
  "    provider: remote",
  "  onMissing:",
  "    description: names a provider nothing registers",
  "    provider: nowhere",
  "  onChainWithGap:",
  "    description: a fallback chain whose first rung cannot be built",
  "    models:",
  "      - provider: nowhere",
  "        model: ghost-model",
  "      - provider: remote",
  "        model: vendor/remote-model",
].join("\n");

let runtime: AgentRuntime;
let built: string[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tai-per-agent-provider-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, YAML_CONFIG, "utf-8");
  const cfg = YAML.parse(YAML_CONFIG) as AgentConfig;
  cfg.agent.temperature ??= 0.3;
  cfg.agent.maxToolRounds ??= 5;
  cfg.agent.maxHistoryTokens ??= 2000;
  cfg.agent.extraInstructions ??= "";
  cfg.tools ??= {} as AgentConfig["tools"];
  cfg.custom_tools ??= {};

  built = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});

  runtime = new AgentRuntime(
    {
      configPath,
      db: undefined as never,
      contextDir: join(dir, "context"),
      kbDir: join(dir, "kb"),
      createTools: () => [],
      createProvider: (_config, providerId) => {
        const id = providerId ?? "local";
        built.push(id);
        // Stands in for "no plugin registers this id".
        if (id === "nowhere") throw new Error(`No provider factory registered for "${id}"`);
        return { provider: fakeProvider(id), model: id === "remote" ? "vendor/remote-model" : "local-model" };
      },
    },
    () => cfg,
    cfg,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const providerFor = (agentName: string) =>
  runtime.buildLoopOptions({ session: { id: `s-${agentName}` } as never, agentName }).provider;

describe("per-agent provider", () => {
  it("uses the deployment default when the agent names none", () => {
    expect(providerFor("onDefault").id).toBe("local");
  });

  it("uses the provider the agent names", () => {
    expect(providerFor("onRemote").id).toBe("remote");
  });

  it("builds the agent's provider only once, then reuses it", () => {
    providerFor("onRemote");
    providerFor("onRemote");

    expect(built.filter((id) => id === "remote")).toHaveLength(1);
  });

  /**
   * Falling back rather than throwing: the plugin that would register it may
   * simply not be installed, and taking the agent offline is a worse answer
   * than running it with a named fallback. But the fallback must be audible —
   * silence here is what made the original bug present as a bare 404.
   */
  it("falls back to the default and says so when the provider cannot be built", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(providerFor("onMissing").id).toBe("local");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/onMissing.*nowhere/);
  });

  it("warns once per agent+provider, not once per turn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    providerFor("onMissing");
    providerFor("onMissing");
    providerFor("onMissing");

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("nowhere"))).toHaveLength(1);
  });

  /**
   * One unbuildable provider is one problem, and must read as one. The chain
   * resolver and the degrade-to-default path both have something true to say
   * about it, and saying both made a single missing plugin look like two
   * failures — with the less useful half ("skipping it") printed first.
   */
  it("reports an unbuildable rung once, and only as a skip when a rung survives", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = providerFor("onChainWithGap");

    // The surviving rung answers; nothing degraded to the deployment default.
    expect(provider.id).toBe("remote");
    const about = warn.mock.calls.filter((c) => String(c[0]).includes("nowhere"));
    expect(about).toHaveLength(1);
    expect(String(about[0][0])).toContain("skipping it");
    expect(String(about[0][0])).not.toContain("Falling back to");
  });

  it("explains the degrade rather than the skip when no rung survives", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(providerFor("onMissing").id).toBe("local");
    const about = warn.mock.calls.filter((c) => String(c[0]).includes("nowhere"));
    expect(about).toHaveLength(1);
    // "Skipping it" would be a lie here: there is nothing to skip to.
    expect(String(about[0][0])).toContain("Falling back to");
    expect(String(about[0][0])).not.toContain("skipping it");
  });

  it("re-resolves through getProvider so a hot reload can swap it", () => {
    const opts = runtime.buildLoopOptions({ session: { id: "s1" } as never, agentName: "onRemote" });

    expect(opts.getProvider?.()?.id).toBe("remote");
  });
});

describe("model defaulting", () => {
  const config = YAML.parse(YAML_CONFIG) as AgentConfig;

  /**
   * An agent that names a provider and no model gets THAT provider's default
   * model. Falling through to the global default sent one vendor's model name
   * to another's endpoint — a 404 for a model that exists, just not there.
   */
  it("takes the model from the provider the agent named", () => {
    expect(resolveAgent("onRemote", config, []).model).toBe("vendor/remote-model");
  });

  it("leaves an agent on the global default model when it names no provider", () => {
    expect(resolveAgent("onDefault", config, []).model).toBe("local-model");
  });

  it("still lets an explicit model win over the provider's default", () => {
    const withModel = YAML.parse(YAML_CONFIG) as AgentConfig;
    withModel.agents.onRemote.model = "vendor/something-else";

    expect(resolveAgent("onRemote", withModel, []).model).toBe("vendor/something-else");
  });
});

/**
 * The other half of the same bug. The loop sends `session.model`, and every
 * server route creates the session with the deployment defaults before it
 * knows which agent will handle the turn. Once an agent could select its own
 * provider, the mismatch became visible in the worst way: the request reached
 * the agent's provider carrying the *global* model name.
 */
describe("session model follows the agent", () => {
  const staleSession = () => ({ id: "s-stale", model: "local-model", provider: "local" }) as never;

  it("sends the agent's model, not the one stamped on the session", () => {
    const opts = runtime.buildLoopOptions({ session: staleSession(), agentName: "onRemote" });

    expect(opts.session.model).toBe("vendor/remote-model");
    expect(opts.session.provider).toBe("remote");
  });

  it("leaves a session alone when it already matches", () => {
    const session = { id: "s-ok", model: "local-model", provider: "local" } as never;
    const opts = runtime.buildLoopOptions({ session, agentName: "onDefault" });

    expect(opts.session).toBe(session);
  });

  it("keeps the rest of the session intact", () => {
    const opts = runtime.buildLoopOptions({
      session: { id: "s-keep", model: "local-model", provider: "local", projectId: "p1" } as never,
      agentName: "onRemote",
    });

    expect(opts.session.id).toBe("s-keep");
    expect((opts.session as { projectId?: string }).projectId).toBe("p1");
  });
});
