import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider, ChatParams, ChatResponse } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import {
  type Fixture,
  fixturePath,
  fixtureWriter,
  loadFixtures,
  ReplayMiss,
  recordingProvider,
  replayLayer,
  replayProvider,
  requestKey,
} from "../replay.js";

const params = (overrides: Partial<ChatParams> = {}): ChatParams => ({
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.3,
  ...overrides,
});

const response = (content: string): ChatResponse => ({
  content,
  usage: { input: 10, output: 5 },
  finishReason: "stop",
});

const upstream = (responses: ChatResponse[]): AIProvider & { calls: ChatParams[] } => {
  const calls: ChatParams[] = [];
  let i = 0;
  return {
    id: "fake",
    name: "Fake",
    supportsTools: true,
    calls,
    async chat(p: ChatParams) {
      calls.push(p);
      return responses[i++] ?? response("exhausted");
    },
  };
};

describe("requestKey", () => {
  it("is stable across identical requests", () => {
    expect(requestKey(params())).toBe(requestKey(params()));
  });

  it("changes when the prompt changes", () => {
    const a = requestKey(params());
    const b = requestKey(params({ messages: [{ role: "user", content: "hello!" }] }));
    expect(a).not.toBe(b);
  });

  it("changes when the tool set changes", () => {
    const withTool = params({
      tools: [{ name: "read", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(requestKey(params())).not.toBe(requestKey(withTool));
  });

  it("distinguishes different media, which are held in a Map", () => {
    const one = params({ media: new Map([["a", Buffer.from("x")]]) });
    const two = params({ media: new Map([["b", Buffer.from("x")]]) });
    // `Object.keys` on a Map yields [], which would make these hash the same.
    expect(requestKey(one)).not.toBe(requestKey(two));
  });

  it("ignores media bytes, keying on the reference", () => {
    const one = params({ media: new Map([["a", Buffer.from("small")]]) });
    const two = params({ media: new Map([["a", Buffer.from("a much larger payload")]]) });
    expect(requestKey(one)).toBe(requestKey(two));
  });
});

describe("recordingProvider", () => {
  it("passes the response through and records it", async () => {
    const written: Fixture[] = [];
    const live = upstream([response("answer")]);
    const provider = recordingProvider(live, (f) => written.push(f));

    const out = await provider.chat(params());

    expect(out.content).toBe("answer");
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe(requestKey(params()));
    expect(written[0].preview).toBe("hello");
    expect(live.calls).toHaveLength(1);
  });

  it("records each call as it happens, so a crash still leaves a usable recording", async () => {
    const written: Fixture[] = [];
    const live = upstream([response("one")]);
    const provider = recordingProvider(live, (f) => written.push(f));

    await provider.chat(params());
    expect(written).toHaveLength(1);

    await expect(
      provider.chat(params({ messages: [{ role: "user", content: "boom" }] })).then(() => {
        throw new Error("unreachable");
      }),
    ).rejects.toBeDefined();
    // The first call's fixture survives whatever happened to the second.
    expect(written).toHaveLength(2);
  });
});

describe("replayProvider", () => {
  const recorded = (): Fixture[] => [
    { key: requestKey(params()), model: "test-model", preview: "hello", response: response("recorded") },
  ];

  it("answers from the recording without touching the network", async () => {
    const provider = replayProvider(recorded());
    const out = await provider.chat(params());
    expect(out.content).toBe("recorded");
  });

  it("serves repeated identical requests in recording order", async () => {
    const key = requestKey(params());
    const provider = replayProvider([
      { key, model: "test-model", preview: "hello", response: response("first") },
      { key, model: "test-model", preview: "hello", response: response("second") },
    ]);

    // The same request legitimately produces different answers at a non-zero
    // temperature, so a run that asks twice should get both.
    expect((await provider.chat(params())).content).toBe("first");
    expect((await provider.chat(params())).content).toBe("second");
  });

  it("refuses an unrecorded request rather than falling through to a live call", async () => {
    const provider = replayProvider(recorded());
    const changed = params({ messages: [{ role: "user", content: "a different prompt" }] });

    await expect(provider.chat(changed)).rejects.toBeInstanceOf(ReplayMiss);
    await expect(provider.chat(changed)).rejects.toThrow(/the prompt has changed/);
  });

  it("names the divergence when the run makes more calls than the recording", async () => {
    const provider = replayProvider(recorded());
    await provider.chat(params());

    await expect(provider.chat(params())).rejects.toThrow(/diverged/);
  });

  it("reports the last message in a miss, so the divergence is diagnosable", async () => {
    const provider = replayProvider(recorded());
    await expect(
      provider.chat(params({ messages: [{ role: "user", content: "the message that missed" }] })),
    ).rejects.toThrow(/the message that missed/);
  });

  it("has no chatStream, so callers fall back to chat()", () => {
    expect(replayProvider(recorded()).chatStream).toBeUndefined();
  });
});

describe("fixture files", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "tai-replay-")), "run.jsonl");

  it("round-trips through a file", async () => {
    const path = tmp();
    const write = fixtureWriter(path);
    const provider = recordingProvider(upstream([response("answer")]), write);
    await provider.chat(params());

    const loaded = loadFixtures(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].response.content).toBe("answer");
    expect((await replayProvider(loaded).chat(params())).content).toBe("answer");
  });

  it("truncates on open, so a re-record replaces the previous run", async () => {
    const path = tmp();
    await recordingProvider(upstream([response("old")]), fixtureWriter(path)).chat(params());
    await recordingProvider(upstream([response("new")]), fixtureWriter(path)).chat(params());

    const loaded = loadFixtures(path);
    // Appending instead would leave two answers for one request and look like
    // divergence on the next replay.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].response.content).toBe("new");
  });

  it("returns nothing for a missing file", () => {
    expect(loadFixtures(join(tmpdir(), "definitely-not-here-12345.jsonl"))).toEqual([]);
  });

  it("skips a malformed line loudly rather than discarding the recording", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = tmp();
    const good = JSON.stringify({ key: "k", model: "m", preview: "p", response: response("kept") });
    writeFileSync(path, `${good}\nnot json\n${good}\n`);

    expect(loadFixtures(path)).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(":2 is not valid JSON"));
    warn.mockRestore();
  });

  it("writes one line per call", async () => {
    const path = tmp();
    const write = fixtureWriter(path);
    const provider = recordingProvider(upstream([response("a"), response("b")]), write);
    await provider.chat(params());
    await provider.chat(params({ messages: [{ role: "user", content: "second" }] }));

    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("replayLayer", () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), "tai-layer-"));

  it("returns the provider untouched when neither mode is on", () => {
    const live = upstream([]);
    expect(replayLayer(live, { scenarioId: "s1" })).toBe(live);
  });

  it("refuses both modes at once", () => {
    expect(() => replayLayer(upstream([]), { scenarioId: "s1", recordDir: "a", replayDir: "b" })).toThrow(
      /mutually exclusive/,
    );
  });

  it("records to one file per scenario", async () => {
    const dir = tmpDir();
    const provider = replayLayer(upstream([response("recorded")]), { scenarioId: "s1", recordDir: dir });
    await provider.chat(params());

    expect(loadFixtures(fixturePath(dir, "s1"))).toHaveLength(1);
    // Scenarios run in separate workers, so one shared file would interleave
    // two runs' calls and read back as divergence.
    expect(loadFixtures(fixturePath(dir, "s2"))).toHaveLength(0);
  });

  it("replays from a scenario's own recording", async () => {
    const dir = tmpDir();
    await replayLayer(upstream([response("from disk")]), { scenarioId: "s1", recordDir: dir }).chat(params());

    const replayed = replayLayer(upstream([response("live")]), { scenarioId: "s1", replayDir: dir });
    expect((await replayed.chat(params())).content).toBe("from disk");
  });

  it("refuses to run when the recording is missing, rather than going live", () => {
    const dir = tmpDir();
    // Falling through to a live call is the failure this exists to remove: the
    // run silently stops being deterministic and starts costing money.
    expect(() => replayLayer(upstream([]), { scenarioId: "never-recorded", replayDir: dir })).toThrow(
      /no recording for scenario "never-recorded"/,
    );
  });

  it("flattens a path-shaped scenario id into a plain filename", () => {
    const dir = tmpDir();
    const traversal = ["..", "..", "elsewhere"].join("/");
    expect(fixturePath(dir, traversal)).toBe(join(dir, ".._.._elsewhere.jsonl"));
  });
});
