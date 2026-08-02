/**
 * `/memory` — read and edit what an agent remembers about itself.
 *
 * Core memory is per-agent, survives every session, and goes into the system
 * prompt on every turn. Until this command the only writer was the agent
 * itself and there was no reader outside the database: an agent could write
 * itself a persona that shaped every later answer, and nobody could see it.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCommandDeps } from "../channels/discord-memory-commands.js";
import { handleMemoryCommand } from "../channels/discord-memory-commands.js";
import type { AgentConfig } from "../config.js";
import { getCoreMemorySection, setCoreMemory } from "../db/core-memory-queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;
const CONFIG = { agents: {} } as unknown as AgentConfig;

beforeEach(() => {
  db = initDatabase(":memory:");
  setCoreMemory(db, {
    agent: "iris",
    project_id: null,
    section: "persona",
    content: "I am an intern who mostly wants to have fun.",
    updated_by: "iris",
  });
});

afterEach(() => db.close());

const deps = (): MemoryCommandDeps => ({ db, listAgents: () => ["iris", "planner"] });

function makeInteraction(sub: string, opts: Record<string, string | null>) {
  const replies: string[] = [];
  const interaction = {
    commandName: "memory",
    user: { id: "1", username: "alex" },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
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

// biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
const run = (i: unknown) => handleMemoryCommand(i as any, deps(), CONFIG);

const read = (section: "persona" | "active_threads") =>
  getCoreMemorySection(db, { agent: "iris", project_id: null }, section)?.content ?? "";

describe("/memory show", () => {
  it("reads a section, with who wrote it and when", async () => {
    const { interaction, replies } = makeInteraction("show", { agent: "iris", section: "persona" });

    await run(interaction);

    expect(replies[0]).toContain("mostly wants to have fun");
    // Who wrote it matters: almost all of these are self-authored.
    expect(replies[0]).toContain("iris");
  });

  it("reads every section when none is named", async () => {
    setCoreMemory(db, {
      agent: "iris",
      project_id: null,
      section: "active_threads",
      content: "onboarding",
      updated_by: "iris",
    });
    const { interaction, replies } = makeInteraction("show", { agent: "iris", section: null });

    await run(interaction);

    expect(replies[0]).toContain("persona");
    expect(replies[0]).toContain("active_threads");
  });

  it("says so when an agent has none", async () => {
    const { interaction, replies } = makeInteraction("show", { agent: "planner", section: null });

    await run(interaction);

    expect(replies[0]).toContain("no core memory");
  });
});

describe("/memory set", () => {
  it("replaces the section", async () => {
    const { interaction } = makeInteraction("set", { agent: "iris", section: "persona", content: "Focused now." });

    await run(interaction);

    expect(read("persona")).toBe("Focused now.");
  });

  /**
   * Core memory has no history table, so an overwrite would otherwise be
   * unrecoverable — the same reason `/room rewind` hides rather than deletes.
   */
  it("hands back what it replaced, so the change can be reversed", async () => {
    const { interaction, replies } = makeInteraction("set", {
      agent: "iris",
      section: "persona",
      content: "Focused now.",
    });

    await run(interaction);

    expect(replies[0]).toContain("What was there before");
    expect(replies[0]).toContain("mostly wants to have fun");
  });
});

describe("/memory append", () => {
  it("adds without losing what was there", async () => {
    const { interaction } = makeInteraction("append", { agent: "iris", section: "persona", content: "Also punctual." });

    await run(interaction);

    expect(read("persona")).toContain("mostly wants to have fun");
    expect(read("persona")).toContain("Also punctual.");
  });
});

describe("/memory clear", () => {
  it("empties the section and hands back the old text", async () => {
    const { interaction, replies } = makeInteraction("clear", { agent: "iris", section: "persona", content: null });

    await run(interaction);

    expect(read("persona")).toBe("");
    expect(replies[0]).toContain("mostly wants to have fun");
  });

  it("says so when already empty rather than pretending to work", async () => {
    const { interaction, replies } = makeInteraction("clear", { agent: "planner", section: "persona", content: null });

    await run(interaction);

    expect(replies[0]).toContain("already empty");
  });
});

describe("guards", () => {
  /** A typo would otherwise write core memory for an agent nothing ever reads. */
  it("refuses an unknown agent before writing anything", async () => {
    const { interaction, replies } = makeInteraction("set", { agent: "kiky", section: "persona", content: "x" });

    await run(interaction);

    expect(replies[0]).toContain("No agent named");
    expect(read("persona")).toContain("mostly wants to have fun");
  });

  it("refuses an unknown section and lists the real ones", async () => {
    const { interaction, replies } = makeInteraction("set", { agent: "iris", section: "vibes", content: "x" });

    await run(interaction);

    expect(replies[0]).toContain("is not a section");
    expect(replies[0]).toContain("persona");
    expect(read("persona")).toContain("mostly wants to have fun");
  });

  it("records the person as the author, not the agent", async () => {
    const { interaction } = makeInteraction("set", { agent: "iris", section: "persona", content: "Set by hand." });

    await run(interaction);

    const row = getCoreMemorySection(db, { agent: "iris", project_id: null }, "persona");
    expect(row?.updated_by).toBe("alex");
  });

  it("ignores interactions that are not /memory", async () => {
    const { interaction } = makeInteraction("show", { agent: "iris", section: null });
    interaction.commandName = "room";

    expect(await run(interaction)).toBe(false);
  });
});

/**
 * Found in use: `/memory show` clipped each section to 900 chars and the whole
 * reply to 1700, so the memories most worth reading came back as a third of
 * themselves — and asking for that one section did not help, because the
 * per-section clip applied either way. Core memory is the text that shapes
 * every one of an agent's turns; two thirds of it is worse than none, because
 * it reads as complete.
 */
describe("long memories", () => {
  const LONG = "x".repeat(2328); // the real size of default.persona

  beforeEach(() => {
    setCoreMemory(db, {
      agent: "iris",
      project_id: null,
      section: "persona",
      content: LONG,
      updated_by: "iris",
    });
  });

  it("sends the whole section, across as many messages as it takes", async () => {
    const { interaction, replies } = makeInteraction("show", { agent: "iris", section: "persona" });

    await run(interaction);

    expect(replies.length).toBeGreaterThan(1);
    const joined = replies.join("");
    expect(joined).toContain(LONG.slice(0, 500));
    expect(joined).toContain(LONG.slice(-500));
  });

  it("keeps every message within Discord's limit", async () => {
    const { interaction, replies } = makeInteraction("show", { agent: "iris", section: null });

    await run(interaction);

    for (const r of replies) expect(r.length).toBeLessThanOrEqual(2000);
  });

  /** The old behaviour's real sin was that the truncation was invisible. */
  it("says so when it could not show everything", async () => {
    setCoreMemory(db, {
      agent: "iris",
      project_id: null,
      section: "persona",
      content: "y".repeat(40_000),
      updated_by: "iris",
    });
    const { interaction, replies } = makeInteraction("show", { agent: "iris", section: "persona" });

    await run(interaction);

    expect(replies.join("")).toMatch(/more message\(s\) not shown/);
  });

  it("hands back the whole prior text on set, so it can actually be pasted back", async () => {
    const { interaction, replies } = makeInteraction("set", {
      agent: "iris",
      section: "persona",
      content: "short",
    });

    await run(interaction);

    expect(replies.join("")).toContain(LONG.slice(-300));
  });
});
