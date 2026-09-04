/**
 * The `speak` tool, against a fake provider.
 *
 * No network and no audio engine: what is under test is the part that is
 * ours — how the two input shapes resolve, what gets refused before any
 * money is spent, and whether a dialogue actually ends up with different
 * voices in it. The provider is a seam precisely so this is testable.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  registerSpeechProvider,
  type SpeechProvider,
  SpeechProviderError,
  type SynthesizeRequest,
} from "../provider.js";
import { SpeakTool, type SpeakToolConfig } from "../speak.js";
import { concatWav } from "../wav.js";

function wavOf(samples: number, fill = 0): Buffer {
  const data = Buffer.alloc(samples, fill);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}

/** Records what it was asked for, so voice routing can be asserted. */
class FakeProvider implements SpeechProvider {
  readonly id = "fake";
  calls: SynthesizeRequest[] = [];
  constructor(readonly nativeMultiVoice = false) {}
  async synthesize(req: SynthesizeRequest) {
    this.calls.push(req);
    return { bytes: wavOf(480, this.calls.length), mimeType: "audio/wav" };
  }
}

class ExplodingProvider implements SpeechProvider {
  readonly id = "boom";
  readonly nativeMultiVoice = false;
  async synthesize(): Promise<never> {
    throw new SpeechProviderError("boom", 401, "401 from https://api.example/v1: bad key");
  }
}

/** Minimal in-memory stand-in for the media store. */
function fakeStore() {
  const puts: Array<{ bytes: Buffer; opts: Record<string, unknown> }> = [];
  return {
    puts,
    store: {
      put: async (bytes: Buffer, opts: Record<string, unknown>) => {
        puts.push({ bytes, opts });
        return { id: "a".repeat(64), mimeType: String(opts.mimeType), bytes: bytes.byteLength, name: opts.name };
      },
    },
  };
}

let provider: FakeProvider;

function tool(cfg: Partial<SpeakToolConfig> = {}, p: SpeechProvider = provider) {
  registerSpeechProvider(p.id, () => p);
  return new SpeakTool({ enabled: true, provider: p.id, ...cfg });
}

function ctx(store?: unknown) {
  return { sessionId: "s1", mediaStore: store } as never;
}

function mediaParts(output: unknown) {
  if (typeof output === "string" || output == null) return [];
  return ((output as { parts?: Array<{ type: string }> }).parts ?? []).filter((p) => p.type === "media");
}

function textOf(output: unknown): string {
  if (typeof output === "string") return output;
  const parts = (output as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

beforeEach(() => {
  provider = new FakeProvider();
});

describe("single voice", () => {
  it("attaches the audio and says how long it is", async () => {
    const { store, puts } = fakeStore();
    const r = await tool({ voice: "af_bella" }).execute({ text: "Good morning." }, ctx(store));

    expect(r.success).toBe(true);
    expect(mediaParts(r.output)).toHaveLength(1);
    expect(provider.calls[0].utterances).toEqual([{ text: "Good morning.", voice: "af_bella" }]);
    expect(puts[0].opts.mimeType).toBe("audio/wav");
    // Duration, not just a byte count — the media placeholder cannot say this.
    expect(textOf(r.output)).toMatch(/\d+s/);
  });

  it("lets the call override the configured voice", async () => {
    const { store } = fakeStore();
    await tool({ voice: "af_bella" }).execute({ text: "hi", voice: "am_adam" }, ctx(store));
    expect(provider.calls[0].utterances[0].voice).toBe("am_adam");
  });

  it("uses the configured container", async () => {
    const { store } = fakeStore();
    await tool({ voice: "v", format: "mp3" }).execute({ text: "hi" }, ctx(store));
    expect(provider.calls[0].format).toBe("mp3");
  });
});

describe("dialogue", () => {
  const script = [
    { speaker: "host", text: "Welcome back." },
    { speaker: "guest", text: "Glad to be here." },
    { speaker: "host", text: "Let's begin." },
  ];

  it("renders each turn with that speaker's voice", async () => {
    const { store } = fakeStore();
    const r = await tool({ voices: { host: "af_bella", guest: "am_adam" } }).execute({ script }, ctx(store));

    expect(r.success).toBe(true);
    expect(provider.calls.map((c) => c.utterances[0].voice)).toEqual(["af_bella", "am_adam", "af_bella"]);
  });

  it("joins the turns into one attachment", async () => {
    const { store, puts } = fakeStore();
    const r = await tool({ voices: { host: "a", guest: "b" } }).execute({ script }, ctx(store));

    expect(mediaParts(r.output)).toHaveLength(1);
    expect(puts).toHaveLength(1);
    // Three 480-byte turns, one header.
    expect(puts[0].bytes.byteLength).toBe(44 + 480 * 3);
    expect(textOf(r.output)).toContain("3 turns");
  });

  it("forces wav when it has to join locally, whatever the config says", async () => {
    const { store } = fakeStore();
    await tool({ voices: { host: "a", guest: "b" }, format: "mp3" }).execute({ script }, ctx(store));
    // mp3 concatenation produces a file that plays and lies about its length.
    expect(provider.calls.every((c) => c.format === "wav")).toBe(true);
  });

  it("sends the whole script in one call when the provider renders voices natively", async () => {
    const { store } = fakeStore();
    const native = new FakeProvider(true);
    await tool({ voices: { host: "a", guest: "b" }, format: "mp3" }, native).execute({ script }, ctx(store));

    expect(native.calls).toHaveLength(1);
    expect(native.calls[0].utterances).toHaveLength(3);
    // Nothing is joined locally, so the configured container survives.
    expect(native.calls[0].format).toBe("mp3");
  });

  it("refuses a multi-speaker script with no voices rather than making everyone sound alike", async () => {
    const { store } = fakeStore();
    const r = await tool().execute({ script }, ctx(store));

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no voice for/);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses unmapped speakers even when a default voice exists — the shipping config", async () => {
    // The regression that got here: `voice` set, `voices` set, and a model
    // that invented its own speaker names. Falling back to `voice` gave three
    // turns in one voice and a cheerful success. The default voice is present
    // in every real config, so this is the ordinary case, not the edge.
    const { store } = fakeStore();
    const r = await tool({ voice: "af_bella", voices: { host: "af_bella", guest: "am_adam" } }).execute(
      {
        script: [
          { speaker: "sam", text: "one" },
          { speaker: "riley", text: "two" },
        ],
      },
      ctx(store),
    );

    expect(r.success).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(r.error).toMatch(/"sam", "riley"/);
    // The message has to be actionable in the same turn, so it names the
    // speakers the config already knows about.
    expect(r.error).toContain("host, guest");
  });

  it("accepts a script whose speakers are all mapped at call time", async () => {
    const { store } = fakeStore();
    const r = await tool({ voice: "af_bella", voices: { host: "af_bella" } }).execute(
      {
        script: [
          { speaker: "sam", text: "one" },
          { speaker: "riley", text: "two" },
        ],
        voices: { sam: "af_bella", riley: "am_adam" },
      },
      ctx(store),
    );

    expect(r.success).toBe(true);
    expect(provider.calls.map((c) => c.utterances[0].voice)).toEqual(["af_bella", "am_adam"]);
  });

  it("still lets a single-speaker script fall back to the default voice", async () => {
    // One voice cannot be confused with another, so the fallback is right here
    // and only here.
    const { store } = fakeStore();
    const r = await tool({ voice: "af_bella" }).execute(
      {
        script: [
          { speaker: "narrator", text: "Once upon a time." },
          { speaker: "narrator", text: "The end." },
        ],
      },
      ctx(store),
    );

    expect(r.success).toBe(true);
    expect(provider.calls.map((c) => c.utterances[0].voice)).toEqual(["af_bella", "af_bella"]);
  });

  it("allows one speaker with no voice map, since there is nobody to confuse them with", async () => {
    const { store } = fakeStore();
    const r = await tool().execute({ script: [{ speaker: "narrator", text: "Once upon a time." }] }, ctx(store));
    expect(r.success).toBe(true);
  });
});

describe("refusals", () => {
  it("refuses before calling the provider when the text is over the cap", async () => {
    const { store } = fakeStore();
    const r = await tool({ voice: "v", maxChars: 20 }).execute({ text: "x".repeat(21) }, ctx(store));

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/21 characters and the limit is 20/);
    // The point of the cap is the call that never happens.
    expect(provider.calls).toHaveLength(0);
  });

  it("counts the whole script against the cap, not each turn", async () => {
    const { store } = fakeStore();
    const r = await tool({ voices: { a: "x", b: "y" }, maxChars: 10 }).execute(
      {
        script: [
          { speaker: "a", text: "123456" },
          { speaker: "b", text: "789012" },
        ],
      },
      ctx(store),
    );
    expect(r.success).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("says so when there is no media store", async () => {
    const r = await tool({ voice: "v" }).execute({ text: "hi" }, ctx(undefined));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no media store/);
  });

  it("names an unregistered provider instead of failing obscurely", async () => {
    const { store } = fakeStore();
    const r = await new SpeakTool({ enabled: true, provider: "nope", voice: "v" }).execute({ text: "hi" }, ctx(store));
    expect(r.error).toMatch(/no speech provider registered as "nope"/);
  });

  it("passes the provider's own words through", async () => {
    const { store } = fakeStore();
    const r = await tool({ voice: "v" }, new ExplodingProvider()).execute({ text: "hi" }, ctx(store));
    expect(r.success).toBe(false);
    expect(r.error).toContain("bad key");
  });

  it("refuses text and script together rather than guessing", async () => {
    const { store } = fakeStore();
    const r = await tool({ voice: "v" }).execute({ text: "hi", script: [{ speaker: "a", text: "b" }] }, ctx(store));
    expect(r.error).toMatch(/not more than one/);
  });

  it("refuses an empty call", async () => {
    const { store } = fakeStore();
    expect((await tool({ voice: "v" }).execute({}, ctx(store))).error).toMatch(/nothing to say/);
  });

  it("names the offending turn in a malformed script", async () => {
    const { store } = fakeStore();
    const r = await tool({ voice: "v" }).execute(
      { script: [{ speaker: "a", text: "ok" }, { speaker: "b" }] },
      ctx(store),
    );
    expect(r.error).toMatch(/script\[1\]/);
  });
});

describe("joining is exact", () => {
  it("produces the same bytes as concatWav on the rendered turns", async () => {
    const { store, puts } = fakeStore();
    await tool({ voices: { a: "x", b: "y" } }).execute(
      {
        script: [
          { speaker: "a", text: "one" },
          { speaker: "b", text: "two" },
        ],
      },
      ctx(store),
    );
    // The fake fills each turn with its call index, so a dropped or reordered
    // turn changes the bytes.
    expect(puts[0].bytes.equals(concatWav([wavOf(480, 1), wavOf(480, 2)]))).toBe(true);
  });
});

describe("scriptFile", () => {
  const write = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "speak-"));
    const file = join(dir, "show.txt");
    writeFileSync(file, body);
    return file;
  };

  it("renders a script read off disk, with only the voices supplied", async () => {
    const file = write(
      "ACT 1 - THE JOB\nGM: You are in a back room.\nREX: So what's the job?\nGM: The case is warm.\n",
    );
    const { store } = fakeStore();
    const r = await tool({ voices: { GM: "v1", REX: "v2" } }).execute({ scriptFile: file }, ctx(store));
    expect(r.success).toBe(true);
    expect(provider.calls.map((c) => c.utterances[0].text)).toEqual([
      "You are in a back room.",
      "So what's the job?",
      "The case is warm.",
    ]);
  });

  it("refuses a file with no dialogue rather than recording silence", async () => {
    const file = write("Just some notes.\nNothing spoken.\n");
    const { store } = fakeStore();
    const r = await tool().execute({ scriptFile: file }, ctx(store));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no dialogue lines/);
  });

  it("says which file it could not read", async () => {
    const { store } = fakeStore();
    const r = await tool().execute({ scriptFile: "/nope/missing.txt" }, ctx(store));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not read \/nope\/missing\.txt/);
  });

  it("still refuses an uncast speaker, the same as an inline script", async () => {
    const file = write("GM: hello.\nMYSTERY: who am I?\n");
    const { store } = fakeStore();
    const r = await tool({ voices: { GM: "v1" } }).execute({ scriptFile: file }, ctx(store));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/MYSTERY/);
  });
});
