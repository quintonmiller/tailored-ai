/**
 * Live sessions, the core half: hearing, speaking, the session's limits, voice
 * mode, and one spoken turn end to end.
 *
 * The property the design rests on is the stable prompt prefix: in voice mode
 * the system prompt and tool schemas must be byte-identical from one turn to
 * the next, or every exchange is a cold one and misses the two-second budget.
 * The last test proves it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSession, newSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { getSessionMessages } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { Body } from "../live/cues.js";
import { SentenceSplitter, speakable } from "../live/sentences.js";
import { LiveSessionError, LiveSessions } from "../live/session.js";
import {
  openAICompatibleSpeechToText,
  openAICompatibleTextToSpeech,
  speechToTextRegistry,
  textToSpeechRegistry,
} from "../live/stages.js";
import { runVoiceTurn, startLiveSession } from "../live/turn.js";
import { DEFAULT_VOICE_INSTRUCTIONS, DEFAULT_VOICE_INSTRUCTIONS_WITH_BODY, voiceMode } from "../live/voice-mode.js";
import type { AIProvider, ChatParams, ChatStreamEvent } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";

describe("SentenceSplitter", () => {
  it("hands back each sentence as the stream completes it, joining ones too short to say alone", () => {
    const s = new SentenceSplitter();
    expect(s.push("Sure. I can do ")).toEqual([]);
    expect(s.push("that for you. The price is 3.")).toEqual(["Sure. I can do that for you."]);
    expect(s.push("5 dollars! Anything else")).toEqual(["The price is 3.5 dollars!"]);
    expect(s.flush()).toBe("Anything else");
  });

  it("holds a short sentence that ends the stream so far, rather than saying it alone", () => {
    const s = new SentenceSplitter();
    expect(s.push("Sure thing. ")).toEqual([]);
    expect(s.push("I noted the plants. ")).toEqual(["Sure thing. I noted the plants."]);
    const t = new SentenceSplitter();
    expect(t.push("Okay. ")).toEqual([]);
    expect(t.flush()).toBe("Okay.");
  });

  it("reads markdown, links and emoji as speech would", () => {
    expect(speakable("**Done!** See [the doc](https://x.y) 🎉\n- first")).toBe("Done! See the doc first");
  });
});

describe("speech stages over the OpenAI audio API", () => {
  let server: Server;
  let base: string;
  const seen: { path: string; type: string; body: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        seen.push({ path: req.url ?? "", type: req.headers["content-type"] ?? "", body });
        if (req.url === "/v1/audio/transcriptions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: " water the plants ", duration: 1.5 }));
        } else if (req.url === "/v1/audio/speech") {
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(Buffer.from("RIFFfake"));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "nope" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("sends recorded speech as a multipart upload and reads the transcript back", async () => {
    const stt = openAICompatibleSpeechToText({ baseUrl: `${base}/`, model: "small", language: "en" });
    expect(await stt.transcribe(Buffer.from("webm-bytes"), { mimeType: "audio/webm;codecs=opus" })).toEqual({
      text: "water the plants",
      durationMs: 1500,
    });
    expect(seen[0].type).toMatch(/^multipart\/form-data/);
    expect(seen[0].body).toContain('filename="speech.webm"');
    expect(seen[0].body).toContain("small");
    expect(seen[0].body).toContain("webm-bytes");
  });

  it("asks for speech in the stage's format and voice", async () => {
    const tts = openAICompatibleTextToSpeech({ baseUrl: base, model: "kokoro", format: "wav", voice: "af_heart" });
    const audio = await tts.synthesize("Hello there.", {});
    expect(audio).toEqual({ bytes: Buffer.from("RIFFfake"), mimeType: "audio/wav" });
    expect(JSON.parse(seen[0].body)).toEqual({
      model: "kokoro",
      input: "Hello there.",
      voice: "af_heart",
      response_format: "wav",
    });
  });

  it("says which setting is missing, and passes the server's reason on", async () => {
    expect(() => openAICompatibleSpeechToText({})).toThrow("live.stt.options.baseUrl is not set");
    const broken = openAICompatibleSpeechToText({ baseUrl: `${base}/broken` });
    await expect(broken.transcribe(Buffer.from("x"), { mimeType: "audio/webm" })).rejects.toThrow(
      "speech-to-text failed",
    );
  });
});

describe("LiveSessions", () => {
  const limits = { maxMinutes: 30, idleMinutes: 5, maxTurns: 2 };

  it("counts turns and ends a session at its turn limit, saying why", () => {
    const sessions = new LiveSessions();
    const s = sessions.start({ transport: "web", sessionId: "s1", limits });
    sessions.beginTurn(s.id);
    sessions.beginTurn(s.id);
    expect(() => sessions.beginTurn(s.id)).toThrow("it reached its limit of 2 turns");
    expect(sessions.get(s.id)?.endedAt).toBeDefined();
  });

  it("ends a session left idle, or one past its length, the next time it is looked at", () => {
    let now = Date.parse("2026-10-18T10:00:00Z");
    const sessions = new LiveSessions(() => new Date(now));
    const idle = sessions.start({ transport: "web", sessionId: "s1", limits });
    now += 6 * 60_000;
    expect(sessions.get(idle.id)?.endReason).toBe("nothing was said for 5 minutes");
    expect(() => sessions.beginTurn(idle.id)).toThrow(LiveSessionError);

    const long = sessions.start({ transport: "web", sessionId: "s2", limits: { ...limits, idleMinutes: 999 } });
    now += 31 * 60_000;
    expect(sessions.get(long.id)?.endReason).toBe("it reached its limit of 30 minutes");
  });
});

describe("voiceMode", () => {
  const tool = (name: string): Tool => ({
    name,
    description: name,
    parameters: {},
    execute: async () => ({ success: true, output: "" }),
  });
  const base = {
    tools: [tool("state"), tool("exec"), tool("web_search")],
    getTools: () => [tool("state"), tool("exec"), tool("web_search")],
    extraInstructions: "You are a planner.",
    thinking: "high",
    maxTokens: 4000,
    injectMemory: true,
  } as never;

  it("keeps the agent's identity, swaps in the spoken style and a slim tool set, every round", () => {
    const v = voiceMode(base, { tools: ["state"] });
    expect(v.tools.map((t) => t.name)).toEqual(["state"]);
    expect(v.getTools?.().map((t) => t.name)).toEqual(["state"]);
    expect(v.extraInstructions).toBe(`${DEFAULT_VOICE_INSTRUCTIONS}\n\nYou are a planner.`);
    expect(v).toMatchObject({ thinking: "off", maxTokens: 300, injectMemory: false });
  });

  it("uses the agent's own voice prompt when it has one, and no tools unless it names them", () => {
    const v = voiceMode(base, { instructions: "Talk like a pilot.", maxTokens: 120 });
    expect(v.tools).toEqual([]);
    expect(v.extraInstructions).toBe("Talk like a pilot.");
    expect(v.maxTokens).toBe(120);
  });

  it("with a body, offers what the body can do and teaches its cues last", () => {
    const body: Body = { gestures: ["wave"] };
    const v = voiceMode(base, {}, body);
    expect(v.extraInstructions.startsWith(`${DEFAULT_VOICE_INSTRUCTIONS_WITH_BODY}\n\nYou are a planner.\n\n`)).toBe(
      true,
    );
    expect(v.extraInstructions).toContain("your tools and your body let you do");
    expect(v.extraInstructions.endsWith("Use a cue only when it fits; most replies need none or one.")).toBe(true);
  });

  it("teaches the body's cues after the agent's own voice prompt too", () => {
    const v = voiceMode(base, { instructions: "Talk like a pilot." }, { gestures: ["wave"] });
    expect(v.extraInstructions).toMatch(/^Talk like a pilot\.\n\nYou have a body the person can see\./);
  });
});

describe("runVoiceTurn", () => {
  let db: Database.Database;
  const requests: ChatParams[] = [];
  const spoken: string[] = [];
  const timeline: string[] = [];
  const DEFAULT_REPLY = "Done. I added water the plants to tomorrow's list. Anything else?";
  let reply = DEFAULT_REPLY;

  const streaming: AIProvider = {
    name: "fake",
    chat: async () => ({ content: reply, usage: { input: 0, output: 0 }, finishReason: "stop" }),
    async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
      requests.push(params);
      for (const piece of reply.match(/.{1,7}/g) ?? []) {
        yield { type: "delta", content: piece };
        await new Promise((r) => setTimeout(r, 2));
      }
      timeline.push("model finished");
      yield { type: "done", response: { content: reply, usage: { input: 0, output: 0 }, finishReason: "stop" } };
    },
  } as never;

  beforeEach(() => {
    db = initDatabase(":memory:");
    reply = DEFAULT_REPLY;
    requests.length = 0;
    spoken.length = 0;
    timeline.length = 0;
    speechToTextRegistry.register("fake-stt", () => ({
      transcribe: async () => ({ text: "remind me to water the plants" }),
    }));
    textToSpeechRegistry.register("fake-tts", () => ({
      synthesize: async (text: string, opts: { voice?: string }) => {
        spoken.push(`${opts.voice}:${text}`);
        return { bytes: Buffer.from(text), mimeType: "audio/wav" };
      },
    }));
  });

  afterEach(() => {
    speechToTextRegistry.unregister("fake-stt");
    textToSpeechRegistry.unregister("fake-tts");
    db.close();
  });

  function runtimeWith(agentVoice?: Record<string, unknown>) {
    const config = {
      server: { port: 3000, host: "127.0.0.1" },
      database: { path: ":memory:" },
      providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
      agent: {
        defaultProvider: "openai_compatible",
        maxToolRounds: 2,
        maxHistoryTokens: 5000,
        temperature: 0.3,
        extraInstructions: "",
      },
      agents: { planner: { instructions: "You keep plans tidy.", ...(agentVoice ? { voice: agentVoice } : {}) } },
      channels: {},
      tools: {},
      custom_tools: {},
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
      permissions: { allow: [], deny: [], ask: [] },
      workflows: { directory: "./workflows" },
      projects: { enabled: false, directory: "./data/projects" },
      tasks: { backend: "native" as const },
      live: { enabled: true, stt: { provider: "fake-stt" }, tts: { provider: "fake-tts", voice: "af_heart" } },
    } as unknown as AgentConfig;
    return new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: "/tmp",
        kbDir: "/tmp",
        createTools: () => [],
        createProvider: () => ({ provider: streaming, model: "x" }),
      },
      () => config,
      config,
    );
  }

  function liveSession(runtime: AgentRuntime, body?: Body) {
    const session = newSession(db, "x", "openai_compatible");
    return runtime.getLiveSessions().start({
      agent: "planner",
      transport: "web",
      sessionId: session.id,
      limits: { maxMinutes: 30, idleMinutes: 10, maxTurns: 50 },
      ...(body ? { body } : {}),
    });
  }

  it("takes a body's cues out of the reply and hands each over with the sentence it comes before", async () => {
    reply = 'Hi there, good to see you! <wave/> I\'ll head over now. <go to="couch"/>';
    const body: Body = {
      gestures: ["wave"],
      aimed: [{ verb: "go", prep: "to", does: "walk somewhere", targets: ["the couch"] }],
    };
    const runtime = runtimeWith();
    const live = liveSession(runtime, body);
    const events: string[] = [];
    let shown = "";
    const result = await runVoiceTurn(
      runtime,
      live,
      { text: "Come sit down." },
      {
        text: (d) => {
          shown += d;
        },
        audio: (a) => events.push(`audio:${a.seq}:${a.text}`),
        cue: (c) => events.push(`cue:${c.seq}:${c.name}${c.target ? `:${c.target}` : ""}`),
      },
    );
    // The wave lands on the second sentence; the walk comes after the speech.
    expect(events.filter((e) => e.startsWith("cue"))).toEqual(["cue:1:wave", "cue:2:go:the couch"]);
    expect(events.filter((e) => e.startsWith("audio"))).toEqual([
      "audio:0:Hi there, good to see you!",
      "audio:1:I'll head over now.",
    ]);
    // Nothing of a cue is spoken or shown; history keeps them, so the agent sees its own.
    expect(spoken.join(" ")).not.toMatch(/[<>]/);
    expect(shown).not.toMatch(/[<>]/);
    expect(result.reply).toBe("Hi there, good to see you! I'll head over now.");
    const history = getSessionMessages(db, live.sessionId);
    expect(String(history.at(-1)?.content)).toContain("<wave/>");
    // The body is taught in the instructions, which stay the same turn to turn.
    const system = String(requests[0]?.messages[0]?.content);
    expect(system).toContain("your tools and your body let you do");
    expect(system).toContain('To walk somewhere: <go to="the couch"/>.');
  });

  it("passes text through untouched when the surface has no body", async () => {
    reply = "Use <b>bold</b> sparingly, and *really* mean it.";
    const runtime = runtimeWith();
    let shown = "";
    const result = await runVoiceTurn(runtime, liveSession(runtime), { text: "Tips?" }, { text: (d) => (shown += d) });
    expect(shown).toBe(reply);
    expect(result.reply).toBe(reply);
  });

  it("hears, runs the turn, and speaks each sentence in order while the reply streams", async () => {
    const runtime = runtimeWith({ voice: "am_adam" });
    const events: string[] = [];
    const result = await runVoiceTurn(
      runtime,
      liveSession(runtime),
      { audio: { bytes: Buffer.from("x"), mimeType: "audio/webm" } },
      {
        transcript: (t) => events.push(`transcript:${t}`),
        audio: (a) => events.push(`audio:${a.seq}:${a.text}`),
      },
    );
    expect(result.transcript).toBe("remind me to water the plants");
    expect(result.reply).toBe(reply);
    expect(events).toEqual([
      "transcript:remind me to water the plants",
      "audio:0:Done. I added water the plants to tomorrow's list.",
      "audio:1:Anything else?",
    ]);
    expect(spoken[0]).toMatch(/^am_adam:/);
    expect(result.timings.firstAudioMs).toBeDefined();
  });

  it("starts speaking the first sentence before the model has finished the reply", async () => {
    const runtime = runtimeWith();
    await runVoiceTurn(
      runtime,
      liveSession(runtime),
      { text: "Remind me to water the plants." },
      {
        audio: (a) => timeline.push(`audio ${a.seq}`),
      },
    );
    expect(timeline.indexOf("audio 0")).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("audio 0")).toBeLessThan(timeline.indexOf("model finished"));
  });

  it("takes no turn when nothing was heard", async () => {
    speechToTextRegistry.unregister("fake-stt");
    speechToTextRegistry.register("fake-stt", () => ({ transcribe: async () => ({ text: "" }) }));
    const runtime = runtimeWith();
    const result = await runVoiceTurn(runtime, liveSession(runtime), {
      audio: { bytes: Buffer.from("x"), mimeType: "audio/webm" },
    });
    expect(result).toMatchObject({ transcript: "", reply: "" });
    expect(requests).toEqual([]);
  });

  it("opens a session only when live sessions are on, with the configured limits over the defaults", () => {
    const runtime = runtimeWith();
    const config = runtime.getConfig() as AgentConfig & { live: Record<string, unknown> };
    config.live.limits = { maxTurns: 5 };
    const live = startLiveSession(runtime, { agent: "planner", transport: "web" });
    expect(live).toMatchObject({
      agent: "planner",
      transport: "web",
      limits: { maxMinutes: 30, idleMinutes: 10, maxTurns: 5 },
    });
    expect(loadSession(db, live.sessionId)).toBeDefined();

    config.live.enabled = false;
    expect(() => startLiveSession(runtime, { transport: "web" })).toThrow("Live sessions are off");
  });

  it("keeps the prompt prefix byte-identical from one turn to the next", async () => {
    const runtime = runtimeWith();
    const live = liveSession(runtime);
    await runVoiceTurn(runtime, live, { text: "What's on today?" });
    reply = "Nothing urgent. Just the plants.";
    await runVoiceTurn(runtime, live, { text: "And tomorrow?" });

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first.messages[0].role).toBe("system");
    expect(second.messages[0].content).toBe(first.messages[0].content);
    expect(JSON.stringify(second.tools ?? [])).toBe(JSON.stringify(first.tools ?? []));
    // And it is the voice prompt, not the text one.
    expect(String(first.messages[0].content)).toContain("You are talking with the person out loud");
    expect(first.thinking ?? "off").toBe("off");
  });
});
