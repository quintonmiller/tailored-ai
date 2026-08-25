import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider, ChatParams, ChatResponse } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import {
  beginRecording,
  type Fixture,
  fixturePath,
  loadRecording,
  openRun,
  ReplayMiss,
  recordedTokens,
  recordingProvider,
  recordingWriter,
  replayLayer,
  replayProvider,
  requestKey,
  runId,
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
  const tmpDir = () => mkdtempSync(join(tmpdir(), "tai-replay-"));
  const tmp = () => beginRecording(tmpDir(), "run", {});

  it("round-trips through a file", async () => {
    const path = tmp();
    const write = recordingWriter(path);
    const provider = recordingProvider(upstream([response("answer")]), write);
    await provider.chat(params());

    const loaded = loadRecording(path).fixtures;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].response.content).toBe("answer");
    expect((await replayProvider(loaded).chat(params())).content).toBe("answer");
  });

  it("truncates when a run starts, so a re-record replaces the previous run", async () => {
    const dir = tmpDir();
    await recordingProvider(upstream([response("old")]), recordingWriter(beginRecording(dir, "run", {}))).chat(
      params(),
    );
    await recordingProvider(upstream([response("new")]), recordingWriter(beginRecording(dir, "run", {}))).chat(
      params(),
    );

    const loaded = loadRecording(fixturePath(dir, "run")).fixtures;
    // Appending instead would leave two answers for one request and look like
    // divergence on the next replay.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].response.content).toBe("new");
  });

  // The bug: a writer that truncated whenever it was constructed. A provider is
  // not built once per run — the runtime rebuilds it on `reload()`, which the
  // `admin` tool triggers mid-turn — so the second writer threw away every call
  // recorded before the rebuild. The call it lost was the one whose response
  // *caused* the reload, so on replay the run's first request was the one
  // request missing from its own recording.
  it("keeps earlier calls when the provider is rebuilt mid-run", async () => {
    const dir = tmpDir();
    const path = beginRecording(dir, "run", {});

    await recordingProvider(upstream([response("before reload")]), recordingWriter(path)).chat(params());
    // A second provider over the same recording — what `reload()` produces.
    await recordingProvider(upstream([response("after reload")]), recordingWriter(path)).chat(
      params({ messages: [{ role: "user", content: "second" }] }),
    );

    const loaded = loadRecording(path).fixtures;
    expect(loaded.map((f) => f.response.content)).toEqual(["before reload", "after reload"]);
  });

  it("returns nothing for a missing file", () => {
    expect(loadRecording(join(tmpdir(), "definitely-not-here-12345.jsonl")).fixtures).toEqual([]);
  });

  it("skips a malformed line loudly rather than discarding the recording", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = tmp();
    const good = JSON.stringify({ kind: "call", key: "k", model: "m", preview: "p", response: response("kept") });
    writeFileSync(path, `${good}\nnot json\n${good}\n`);

    expect(loadRecording(path).fixtures).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(":2 is not valid JSON"));
    warn.mockRestore();
  });

  it("writes one line per call, after the witness header", async () => {
    const path = tmp();
    const write = recordingWriter(path);
    const provider = recordingProvider(upstream([response("a"), response("b")]), write);
    await provider.chat(params());
    await provider.chat(params({ messages: [{ role: "user", content: "second" }] }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).kind).toBe("tokens");
    expect(lines.slice(1).map((l) => JSON.parse(l).kind)).toEqual(["call", "call"]);
  });
});

describe("openRun and replayLayer", () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), "tai-layer-"));

  it("returns the provider untouched when neither mode is on", () => {
    const live = upstream([]);
    expect(replayLayer(live, openRun({ id: "s1" }))).toBe(live);
  });

  it("refuses both modes at once", () => {
    expect(() => openRun({ id: "s1", recordDir: "a", replayDir: "b" })).toThrow(/mutually exclusive/);
  });

  it("records to one file per run", async () => {
    const dir = tmpDir();
    const provider = replayLayer(upstream([response("recorded")]), openRun({ id: "s1", recordDir: dir }));
    await provider.chat(params());

    expect(loadRecording(fixturePath(dir, "s1")).fixtures).toHaveLength(1);
    // Scenarios run in separate workers, so one shared file would interleave
    // two runs' calls and read back as divergence.
    expect(loadRecording(fixturePath(dir, "s2")).fixtures).toHaveLength(0);
  });

  it("replays from a run's own recording", async () => {
    const dir = tmpDir();
    await replayLayer(upstream([response("from disk")]), openRun({ id: "s1", recordDir: dir })).chat(params());

    const replayed = replayLayer(upstream([response("live")]), openRun({ id: "s1", replayDir: dir }));
    expect((await replayed.chat(params())).content).toBe("from disk");
  });

  it("refuses to run when the recording is missing, rather than going live", () => {
    const dir = tmpDir();
    // Falling through to a live call is the failure this exists to remove: the
    // run silently stops being deterministic and starts costing money.
    expect(() => openRun({ id: "never-recorded", replayDir: dir })).toThrow(/no recording for run "never-recorded"/);
  });

  // A run does not build one provider: `reload()` rebuilds it mid-turn, which
  // the `admin` tool triggers. Both halves of record/replay were wrong when
  // their state lived on the provider rather than the run.
  it("keeps appending to one recording across a provider rebuild", async () => {
    const dir = tmpDir();
    const run = openRun({ id: "s1", recordDir: dir });

    await replayLayer(upstream([response("before reload")]), run).chat(params());
    await replayLayer(upstream([response("after reload")]), run).chat(
      params({ messages: [{ role: "user", content: "second" }] }),
    );

    const loaded = loadRecording(fixturePath(dir, "s1")).fixtures;
    expect(loaded.map((f) => f.response.content)).toEqual(["before reload", "after reload"]);
  });

  it("keeps its place in the recording across a provider rebuild", async () => {
    // The subtle half. Two identical requests legitimately get different
    // answers at a non-zero temperature, and are replayed in recorded order —
    // but a rebuilt provider started that order again from zero, so the run
    // was handed the first answer twice. Not an error; a quietly wrong replay.
    const dir = tmpDir();
    const record = openRun({ id: "s1", recordDir: dir });
    const recorder = replayLayer(upstream([response("one"), response("two")]), record);
    await recorder.chat(params());
    await recorder.chat(params());

    const run = openRun({ id: "s1", replayDir: dir });
    expect((await replayLayer(upstream([]), run).chat(params())).content).toBe("one");
    // A second provider over the same run — what `reload()` produces.
    expect((await replayLayer(upstream([]), run).chat(params())).content).toBe("two");
  });

  it("flattens a path-shaped run id into a plain filename", () => {
    const dir = tmpDir();
    const traversal = ["..", "..", "elsewhere"].join("/");
    expect(fixturePath(dir, traversal)).toBe(join(dir, ".._.._elsewhere.jsonl"));
  });
});

describe("witnesses", () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), "tai-witness-"));

  // The bug this covers: a scenario mints fresh unguessable values every run and
  // substitutes them into the prompt, so a replay that minted its own would send
  // a different request and miss every fixture it had just recorded. Sixteen of
  // the twenty scenario files declare witnesses, so without this "replay" only
  // covers the minority that has none.
  it("round-trips through the recording so a replay can reuse them", async () => {
    const dir = tmpDir();
    const tokens = { secret: "k7m2xqvz", who: "Pelsodra" };
    await replayLayer(upstream([response("recorded")]), openRun({ id: "s1", recordDir: dir, tokens })).chat(params());

    expect(recordedTokens(dir, "s1")).toEqual(tokens);
  });

  it("keeps them out of the fixtures, which are calls only", async () => {
    const dir = tmpDir();
    await replayLayer(upstream([response("a")]), openRun({ id: "s1", recordDir: dir, tokens: { x: "1" } })).chat(
      params(),
    );

    const recording = loadRecording(fixturePath(dir, "s1"));
    expect(recording.fixtures).toHaveLength(1);
    expect(recording.fixtures[0]).not.toHaveProperty("kind");
    expect(recording.fixtures[0].response.content).toBe("a");
  });

  it("records an empty map for a scenario that declares none", async () => {
    const dir = tmpDir();
    await replayLayer(upstream([response("a")]), openRun({ id: "s1", recordDir: dir })).chat(params());

    expect(recordedTokens(dir, "s1")).toEqual({});
  });

  it("reports a missing recording rather than replaying with fresh values", () => {
    // Read before the run starts, so the message has to name the run rather
    // than blame the prompt for a file that was never made.
    expect(() => recordedTokens(tmpDir(), "never-recorded")).toThrow(/no recording for run "never-recorded"/);
  });

  it("survives a witness value that would otherwise break the file format", async () => {
    const dir = tmpDir();
    const tokens = { odd: 'quote" newline\n backslash\\' };
    await replayLayer(upstream([response("a")]), openRun({ id: "s1", recordDir: dir, tokens })).chat(params());

    expect(recordedTokens(dir, "s1")).toEqual(tokens);
  });
});

describe("runId", () => {
  // Computed in two places — the worker needs the witnesses before the run, the
  // harness needs the file during it — so it lives in one function. Drift here
  // would record to one file and replay from another, reported as a recording
  // that was never made.
  it("names a run by scenario and seed", () => {
    expect(runId("answers-in-the-room", 1000)).toBe("answers-in-the-room-seed1000");
  });

  it("drops the seed when seeding is off, so the pair still lines up", () => {
    expect(runId("answers-in-the-room", null)).toBe("answers-in-the-room");
    expect(runId("answers-in-the-room", undefined)).toBe("answers-in-the-room");
  });

  it("gives each repeat its own file", () => {
    // `--repeats 3` runs seeds n, n+1, n+2. One file per scenario would have
    // each repeat truncate the last.
    const ids = [1000, 1001, 1002].map((seed) => runId("s", seed));
    expect(new Set(ids).size).toBe(3);
  });
});
