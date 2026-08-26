/**
 * The agent loop's event bus.
 *
 * `runAgentLoop` had no bus: it neither took one nor read one. That absence is
 * why the loop kept absorbing features that belong beside it — `prompt.ts`,
 * `context.ts`, `memory-inject.ts`, `chat-live-state.ts`, `watcher.ts` and
 * `load-skill.ts` each append their own block from inside, because there was no
 * way to subscribe to "a request is being assembled" and hand one back.
 *
 * This file asserts the seam itself, which is deliberately all there is so far:
 * the bus arrives, it is the runtime's own, and a loop built without one still
 * runs. Nothing dispatches on it yet — that lands separately, on its own
 * evidence, because it changes behaviour and this does not.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLoopOptions } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";

let db: Database.Database;
let home: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  // A fresh home per test: the runtime migrates `agents:` into
  // authored-resources on construction, so a shared directory makes the second
  // test read the first one's manifests.
  home = mkdtempSync(join(tmpdir(), "tai-loop-bus-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const noopTool: Tool = {
  name: "probe",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { success: true, output: "" };
  },
};

function silentProvider(): AIProvider {
  return {
    id: "openai_compatible",
    name: "test",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

function makeConfig(): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 3,
      maxHistoryTokens: 4000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents: { assistant: { tools: ["probe"] } },
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
}

function makeRuntime(config: AgentConfig, events?: TypedEventBus): AgentRuntime {
  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "context"),
      kbDir: join(home, "kb"),
      createTools: () => [noopTool],
      createProvider: () => ({ provider: silentProvider(), model: "x" }),
      ...(events ? { events } : {}),
    },
    () => config,
    config,
  );
}

describe("buildLoopOptions — events", () => {
  it("hands the loop the runtime's own bus", () => {
    const bus = new TypedEventBus();
    const runtime = makeRuntime(makeConfig(), bus);
    const session = newSession(db, "x", "openai_compatible", "s1");

    // Identity, not merely "some bus": a subscriber registers on
    // `runtime.events`, so a loop handed a different instance would dispatch
    // into a bus nobody is listening to — which looks exactly like a
    // subscriber that was never called.
    expect(runtime.buildLoopOptions({ session, agentName: "assistant" }).events).toBe(bus);
  });

  it("gives every caller the bus without the caller asking", () => {
    // The point of filling this in centrally: the many `buildLoopOptions`
    // callers (delegate, schedules, autopilot, the exploratory worker) get it
    // without one line changing at any of their call sites.
    const runtime = makeRuntime(makeConfig());
    const session = newSession(db, "x", "openai_compatible", "s1");

    const opts = runtime.buildLoopOptions({ session, agentName: "assistant" });
    expect(opts.events).toBeDefined();
    expect(opts.events).toBe(runtime.events);
  });

  it("stays optional, so a loop built by hand still typechecks", () => {
    // The benchmark harness and most tests build `AgentLoopOptions` by hand. A
    // required bus would break every one of them for a seam that, on its own,
    // changes nothing — so this is a compile-time assertion first: the
    // annotation is what fails if `events` ever stops being optional.
    const byHand: AgentLoopOptions = {
      provider: silentProvider(),
      session: newSession(db, "x", "openai_compatible", "s2"),
      db,
      tools: [noopTool],
      extraInstructions: "",
      maxToolRounds: 1,
      maxHistoryTokens: 1000,
      temperature: 0.3,
    };

    expect(byHand.events).toBeUndefined();
  });
});
