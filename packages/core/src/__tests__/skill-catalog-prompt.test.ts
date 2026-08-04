/**
 * The catalog block has to tell an agent that skills are NOT loaded.
 *
 * The previous wording — "Activate one with load_skill(...)" — was an offer, and
 * an agent that believes it already knows the task has no reason to accept one.
 * Observed live: `notion-manager` was woken for Notion work with the notion
 * skill in its catalog, made zero `load_skill` calls, and worked from its own
 * session history instead — repeating a broken `2>&1 | jq` pipeline that the
 * skill explicitly warns against, twice, in a warning it never read.
 *
 * The failure is silent: nothing logs "the agent skipped its skill", and the
 * answer looks fine because the agent recovers by trial and error.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function capturingProvider(seen: ChatParams[]): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

async function systemPromptWith(catalog: Array<{ id: string; description: string }>) {
  const seen: ChatParams[] = [];
  await runAgentLoop("go", {
    provider: capturingProvider(seen),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 1,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    skillCatalog: catalog,
  });
  return seen[0].messages[0].content ?? "";
}

describe("skill catalog block", () => {
  it("states that the skills are not loaded", async () => {
    const prompt = await systemPromptWith([{ id: "notion", description: "Read and write Notion." }]);

    expect(prompt).toContain("## Available skills");
    expect(prompt).toMatch(/not loaded/i);
    expect(prompt).toContain("load_skill(name: <id>)");
  });

  it("tells the agent to load one even when it thinks it knows how", async () => {
    // The specific failure mode: confidence from session history beating a
    // catalog line. The prompt has to speak to that directly.
    const prompt = await systemPromptWith([{ id: "notion", description: "Read and write Notion." }]);

    expect(prompt).toMatch(/already know/i);
  });

  it("still lists each skill with its description", async () => {
    const prompt = await systemPromptWith([
      { id: "notion", description: "Read and write Notion." },
      { id: "daily-briefing", description: "Assemble the morning briefing." },
    ]);

    expect(prompt).toContain("- notion: Read and write Notion.");
    expect(prompt).toContain("- daily-briefing: Assemble the morning briefing.");
  });

  it("emits nothing when the agent has no progressive skills", async () => {
    const prompt = await systemPromptWith([]);
    expect(prompt).not.toContain("Available skills");
  });
});
