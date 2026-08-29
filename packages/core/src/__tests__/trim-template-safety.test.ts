/**
 * What trimming is allowed to hand a provider.
 *
 * Both rules here were learned from a live model rather than from a spec, on
 * 2026-08-14, while benchmarking Qwen3.8 against Qwen3.6:
 *
 * 1. A `system` message anywhere but index 0 is not universally legal. Qwen3.6's
 *    chat template tolerates one; Qwen3.8's raises `System message must be at
 *    the beginning.` and the request 400s. Compaction was emitting exactly that,
 *    so every session long enough to compact died outright — 9 of 58 benchmark
 *    failures were this, and none of them reached the model.
 *
 * 2. The loop injects `[System: ...]` notices wearing the `user` role, because
 *    of rule 1. Anything asking "is a user message still here?" therefore gets a
 *    yes from a notice carrying no question. A live request arrived at the model
 *    consisting of precisely two messages — the drop marker and the tool-update
 *    notice — with the real question trimmed away.
 */

import { describe, expect, it } from "vitest";
import { markDroppedHistory, trimHistory, trimHistoryWithSummary } from "../agent/loop.js";
import type { AIProvider, Message } from "../providers/interface.js";

const userMsg = (content: string): Message => ({ role: "user", content });
const asstMsg = (content: string): Message => ({ role: "assistant", content });

/** A provider that only ever produces a summary, so the compaction path runs. */
const summariser = {
  id: "stub",
  chat: async () => ({ content: "they discussed the audit log schema", toolCalls: [] }),
} as unknown as AIProvider;

describe("a trimmed history is legal for any chat template", () => {
  it("never puts a system message after the first position", async () => {
    const history: Message[] = [
      userMsg("ORIGINAL TASK: migrate the audit log"),
      asstMsg("looking"),
      asstMsg("still looking"),
      userMsg("any progress?"),
      asstMsg("nearly"),
    ];

    const result = await trimHistoryWithSummary(history, 5, summariser, "stub-model");

    // The summary must exist — otherwise this passes for the wrong reason, by
    // never having taken the compaction path at all.
    expect(result.summary).toBeTruthy();
    expect(result.messages.length).toBeGreaterThan(0);
    for (const [i, m] of result.messages.entries()) {
      expect(m.role, `message ${i} is a system message inside the history`).not.toBe("system");
    }
  });

  it("returns the summary to the caller instead of hiding it in the history", async () => {
    const history: Message[] = [
      userMsg("ORIGINAL TASK: migrate the audit log"),
      asstMsg("looking"),
      asstMsg("still looking"),
      userMsg("any progress?"),
      asstMsg("nearly"),
    ];

    const result = await trimHistoryWithSummary(history, 5, summariser, "stub-model");

    expect(result.summary).toContain("audit log");
    // Nothing in the messages should carry the summary text — the caller folds
    // it into the system prompt, and two copies would be worse than none.
    const inMessages = result.messages.some((m) => (m.content ?? "").includes("Earlier conversation summary"));
    expect(inMessages).toBe(false);
  });
});

describe("the user-message safety net ignores the loop's own notices", () => {
  it("restores the real question when only a budget notice survives", () => {
    // A different injection site from the test below, because there are seven
    // of these and they are added by unrelated code paths. This one is the
    // tool-budget reminder; it is pushed into the *session history*, so it is
    // present at trim time and can satisfy a naive check.
    const notice = userMsg("[System: tool-budget check — 10/20 rounds used. Prefer committing progress now.]");
    const history: Message[] = [
      userMsg("what was the row count on the audit table?"),
      asstMsg("checking"),
      notice,
      asstMsg("still checking"),
      asstMsg("one moment"),
      asstMsg("nearly there"),
    ];

    const trimmed = markDroppedHistory(history, trimHistory(history, 5));

    const real = trimmed.filter((m) => m.role === "user" && !(m.content ?? "").startsWith("[System:"));
    expect(real.length, "the person's question has to survive a trim").toBeGreaterThan(0);
    expect(real[0].content).toContain("row count");
  });

  it("is not satisfied by a tool-update notice alone", () => {
    // The exact shape the loop pushes when the tool set changes mid-session.
    const notice = userMsg("[System: available tools have been updated. Current tools: memory, exec, read]");
    const history: Message[] = [
      userMsg("what was the row count on the audit table?"),
      asstMsg("checking"),
      notice,
      asstMsg("still checking"),
      asstMsg("one moment"),
      asstMsg("nearly there"),
    ];

    const trimmed = trimHistory(history, 5);
    const real = trimmed.filter((m) => m.role === "user" && !(m.content ?? "").startsWith("[System:"));
    expect(real.length, "a notice is not a question").toBeGreaterThan(0);
  });

  it("still adds nothing when the history genuinely has no question in it", () => {
    const history: Message[] = [asstMsg("a"), asstMsg("b"), asstMsg("c")];
    const trimmed = trimHistory(history, 1);
    expect(trimmed.every((m) => m.role !== "user")).toBe(true);
  });
});
