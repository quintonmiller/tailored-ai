/**
 * The room roster carries each agent's description, not just its name.
 *
 * A name cannot be routed to. Measured on a three-agent scenario: a lead told to
 * get a manifest filed worked out correctly that the hatch was shut, and then
 * asked the *owner* to unlock it — while sitting in a room with an agent whose
 * description reads "Power and access. Runs `breaker` and `unlock` on the
 * vault". It could not have known. The roster said
 *
 *     Known participants: rus, vay, quinton.
 *
 * and the word "unlock" appeared nowhere in the prompt. The scenario went from
 * 0/6 to 5/6 with this change and one other, and the mean number of state
 * transitions the team achieved went from 0.0 to 4.8.
 *
 * TAI already has the descriptions — they are what `delegate` routes on — and
 * simply never showed them to the agents who share a room with each other.
 *
 * Also pinned here: the standing instruction to report only what a tool actually
 * returned. In a room a fabrication does not stay with the agent that made it;
 * it becomes the next agent's input and then the report to the owner.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;

const AGENTS = {
  lead: { description: "Coordinates work across the team." },
  rus: { description: "Power and access. Runs `breaker` and `unlock` on the vault." },
  vay: { description: "Records. Reads documents and files them with `file <id>`." },
};

function makeRuntime(agents: Record<string, { description?: string }> = AGENTS): AgentRuntime {
  const config = {
    agents,
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 50, maxAgentTurns: 6, identities: { quinton: "1234" } },
  };
  return {
    db,
    getConfig: () => config,
    getOwnerId: () => "1234",
    isAgentsPaused: () => false,
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName }: { agentName?: string }) => ({ toolContextExtras: { agentName } }),
  } as unknown as AgentRuntime;
}

/** The prompt the watcher handed to the loop. */
function wakePrompt(): string {
  const [prompt] = runAgentLoopMock.mock.calls.at(-1) ?? [];
  return typeof prompt === "string" ? prompt : "";
}

async function wake(runtime: AgentRuntime, agents: string[] = ["lead", "rus", "vay"]): Promise<void> {
  await backend.createRoom({ name: "ops" });
  for (const agent of agents) store.subscribe({ agent, roomRef: "local:ops", deliver: "poll", wakeOn: "all" });
  const watcher = new RoomWatcher({ runtime, store });
  await backend.post("ops", { speaker: "quinton", to: ["lead"], body: "get the vault manifest filed" });
  await watcher.pollOnce("lead", "local:ops");
}

beforeEach(() => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  runAgentLoopMock.mockReset();
  runAgentLoopMock.mockResolvedValue("noted");
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("the roster of a room", () => {
  it("names what each participant does, not only what it is called", async () => {
    await wake(makeRuntime());

    const prompt = wakePrompt();
    expect(prompt).toContain("rus — Power and access. Runs `breaker` and `unlock` on the vault.");
    expect(prompt).toContain("vay — Records. Reads documents and files them with `file <id>`.");
  });

  it("leaves a participant with no description as a bare name", async () => {
    // Humans have no `agents` entry, and an agent may simply not have one. A
    // dangling separator would read as a description that failed to render.
    await wake(makeRuntime({ lead: AGENTS.lead, rus: {}, vay: AGENTS.vay }));

    const prompt = wakePrompt();
    const line = prompt.split("\n").find((l) => l.startsWith("Known participants:")) ?? "";
    expect(line).toContain("rus;");
    expect(line).not.toContain("rus —");
    expect(line).toContain("quinton");
  });

  it("does not describe the agent being woken to itself", async () => {
    await wake(makeRuntime());

    const line =
      wakePrompt()
        .split("\n")
        .find((l) => l.startsWith("Known participants:")) ?? "";
    expect(line).not.toContain("lead —");
  });

  it("keeps a self-important description to one short line", async () => {
    // A roster is scaffolding. An agent that writes three paragraphs about
    // itself must not be able to push the transcript out of the window, and
    // every other agent in the room pays for it on every turn.
    const verbose = "A".repeat(400);
    await wake(makeRuntime({ lead: AGENTS.lead, rus: { description: `${verbose}\nsecond line` }, vay: AGENTS.vay }));

    const line =
      wakePrompt()
        .split("\n")
        .find((l) => l.startsWith("Known participants:")) ?? "";
    expect(line).toContain("…");
    expect(line).not.toContain("second line");
    expect(line.length).toBeLessThan(400);
  });

  it("still lists each participant once", async () => {
    // The roster merges room subscribers with declared humans, and the dedupe
    // used to run over plain strings. Comparing objects instead would list an
    // agent that is also a declared identity twice.
    await wake(makeRuntime());

    const line =
      wakePrompt()
        .split("\n")
        .find((l) => l.startsWith("Known participants:")) ?? "";
    expect(line.match(/\brus\b/g) ?? []).toHaveLength(1);
  });
});

describe("what a room turn is allowed to claim", () => {
  it("tells the agent to state only what a tool actually returned", async () => {
    // The measured failure: asked to read a file and file its id, three agents
    // produced a complete, confident transcript — "the ID is VAULT-001" /
    // "Filed." / "Done." — having made zero tool calls, with the file untouched.
    // Every text-shaped check in the benchmark passes that; only the machinery
    // knew, and by then the fiction was in the report to the owner.
    await wake(makeRuntime());

    expect(wakePrompt()).toContain("Only state values, results or outcomes you actually got back from a tool");
  });

  it("phrases it as a prohibition rather than an escape hatch", async () => {
    // "Say you cannot if you cannot" is the shape a small model over-applies
    // into declining work it could have done — the same failure as a
    // conditional response token. "Do not state what you did not get" has no
    // such reading.
    await wake(makeRuntime());
    const prompt = wakePrompt();

    expect(prompt).not.toMatch(/if you (cannot|can't) do (it|this), (just )?say/i);
    expect(prompt).toContain("say so instead of guessing");
  });
});
