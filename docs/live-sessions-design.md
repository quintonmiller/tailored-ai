# Live sessions — Design

> Status: sketch, accepted; numbers pending a measurement spike. Third of three
> linked designs: [world state](./world-state-design.md), [agent
> interfaces](./agent-interfaces-design.md), and this one. Supersedes the
> cloud-realtime shape in
> [#601](https://github.com/quintonmiller/tailored-ai/issues/601).

## Goal

An agent can hold a live conversation: you talk, it answers out loud within a
couple of seconds, it can be interrupted, and it can act while you talk. It
updates [world state](./world-state-design.md), and what it is doing shows up as
[interfaces](./agent-interfaces-design.md) on your screen while the call runs.

## The constraint that shapes everything

**It has to work entirely on local models.** A cloud speech-to-speech model
(OpenAI Realtime, Gemini Live) is allowed as an optional plugin, never as the
baseline. Where local hardware cannot match a cloud model, the design gives
something up rather than depending on the cloud.

The reference hardware is one 32 GB GPU and 30 GB of system RAM, already
running a 27B language model.

### What that hardware has to work with

| Stage | Local candidate | What we know |
|---|---|---|
| Speech-to-text | faster-whisper | `small` int8 already runs on CPU on the reference hardware, deliberately off the GPU; larger models fit on the GPU in a few GB |
| Language model | Qwen 27B, 4-bit | ~20 GiB resident, prefix caching on |
| Text-to-speech | Kokoro (82M) | ~35–100× faster than real time on a mid GPU, under 1 GiB |
| Text-to-speech | Breeze | **ruled out**: renders at 1.7× slower than real time, so it cannot keep up with a conversation |

The language model is the slow stage and the one everything else has to fit
around. The numbers that decide the design are **not measured yet**, which is
why the first step is a spike, below.

## The shape: a pipeline, not one speech model

```
mic ─► voice activity ─► speech-to-text ─► voice agent turn ─► text-to-speech ─► speaker
          detection          (streaming)     (local LLM)        (per sentence)
             ▲                                                        │
             └──────────────── stop playback on barge-in ◄────────────┘
```

Each stage is a registry with a local default, so a deployment can swap any of
them (a different STT model, a cloud TTS) without touching the rest.

### What we give up to make it work locally

| Sacrifice | Why | Later |
|---|---|---|
| **Half duplex.** One side talks at a time; a pause of roughly half a second ends your turn | full duplex needs a speech-to-speech model; local ones are not good enough yet | revisit when a local one is |
| **Headphones for interruption in v1.** Barge-in stops playback and cancels generation, but only reliably without speaker echo | echo cancellation is its own project | browser AEC, then server-side |
| **The voice agent is not the full agent.** A slim prompt, two or three tools, reasoning off, short replies | a 27B model with a full prompt and forty tools cannot answer in two seconds | see below |
| **Kokoro's stock voices**, no cloning | the local cloning engines tried so far are too slow for live use | faster cloning models |
| **English first** | small whisper models are weakest outside English | larger STT model if VRAM allows |

### Fast talker, slow thinker

The biggest sacrifice is also the main idea. The voice agent's job is to keep
the conversation moving, not to do the work. When something needs real work
("find me a flight", "reconcile these two lists"), it hands it to an ordinary
agent in the background, says it is on it, and carries on talking.

When the background work finishes, its result arrives in two places:

- **in the call**, spoken at the next natural gap,
- **on the screen**, as a component, a card or a list bound to state, so the
  detail is something to look at rather than something to listen to.

That split is what makes a local model viable: the voice turn stays small and
fast, and the slow, capable agent never sits in the audio path. It also makes
world state and interfaces part of the voice experience rather than separate
features.

### Each spoken turn is an ordinary agent turn

With a pipeline, one exchange is: a transcript in, a normal agent turn, text
out. That reuses the agent loop, its tools, limits, guardrails and history,
instead of a separate component calling tools from outside a turn.

This changes the dependency on
[#600](https://github.com/quintonmiller/tailored-ai/issues/600). The
cloud-realtime shape needed tools invoked outside a turn with the agent's
identity; this one may not. Whether a full loop turn is fast enough is one of
the things the spike measures. If it is not, #600 comes back as the way to run
a lighter turn.

## The session

```ts
interface LiveSession {
  id: string;
  agent: string;                 // the voice agent
  participants: Participant[];
  transport: string;             // open string: "web", later "discord-voice", "phone"
  startedAt: string;
  limits: { maxMinutes: number; idleMinutes: number; maxTurns: number };
  state: StateRef;               // a `live_session` record in world state
}
```

- **Transport** is a plugin. The first is the web UI: browser microphone over a
  WebSocket, no native dependencies, and it is where interfaces render. Discord
  voice and phone come later and bring native dependencies with them.
- **Limits** replace the per-turn ceilings that do not apply to a call. On local
  hardware the cost is GPU time rather than money, but an unbounded session is
  still a bug.
- **Memory.** The transcript becomes the voice agent's session history, with a
  rolling summary so the prompt stays small. Decisions and notes made during
  the call are written to world state as they happen.

### Sharing the GPU

While a session is live, speech-to-text and Kokoro stay resident beside the
language model, and anything else that wants the card (image generation, a slow
TTS render) waits. A simple session-scoped lock is enough for v1; a general GPU
scheduler is a separate idea.

## Step 0: the spike

Before any of this is built, one script on the reference hardware, with all
three models resident at once, measures:

1. VRAM in use and KV cache left for the language model,
2. speech-to-text latency from end of speech to final transcript,
3. language model time to first token with a slim voice prompt, prefix cache
   warm and cold, and tokens per second,
4. text-to-speech time to first audio for one sentence,
5. the overhead of running one exchange as a full agent loop turn versus a bare
   model call.

**Target:** under 1.5 seconds from the end of your sentence to the first audio
of the reply, at the median, for a short answer. If the spike misses it, the
table of sacrifices grows before any code is written.

## Where it lives

| Tier | Owns |
|---|---|
| Core | the session model and lifecycle, limits, the stage registries, the turn bridge, session-scoped GPU lock |
| Built-in plugin | the web transport; faster-whisper and Kokoro stage adapters (talking to local servers, as `speak` does today) |
| Optional plugin | cloud speech-to-speech providers; Discord voice; phone |

## Phases

| # | Slice |
|---|---|
| 0 | Measurement spike on the reference hardware |
| 1 | Session model, web transport, push-to-talk, STT → turn → TTS, no barge-in |
| 2 | Voice activity detection replaces push-to-talk; barge-in with headphones |
| 3 | Fast talker / slow thinker: background delegation, results spoken and shown as components |
| 4 | Transcript into history, rolling summary, notes into state |
| 5 | Discord voice transport |

## Decisions

Settled in review:

1. **Voice is a mode on any agent**, not a separate agent definition. The mode
   swaps in a slim prompt and tool set, so the voice and the text agent share
   one identity and one history.
2. **A background result is spoken at the next point the user finishes a
   turn**, never mid-sentence.
3. **Push-to-talk stays as a permanent option.** It costs nothing to keep and is
   the most reliable mode in a noisy room.
