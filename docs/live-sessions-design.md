# Live sessions — Design

> Status: sketch, accepted; measured on the reference hardware 2026-10-18 (see
> [Step 0](#step-0-what-the-spike-measured)). Third of three
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

### What that hardware does

Measured with every stage running at once (details in
[Step 0](#step-0-what-the-spike-measured)):

| Stage | What runs | Measured |
|---|---|---|
| Speech-to-text | faster-whisper `small`, fp16, on the GPU | **71–123 ms** for 2–6 s of speech; +1.1 GB VRAM. On the CPU (int8) the same clips took 1.6–2.5 s, the whole budget on their own |
| Language model | Qwen3.8 27B, NVFP4, reasoning off | first token **22–34 ms** with the prompt prefix cached; ~55 tokens/s; ~23 GB resident |
| Text-to-speech | Kokoro (82M), on the CPU | first sentence in **~200 ms**, 8–11× faster than real time, no VRAM |
| Text-to-speech | Breeze | **ruled out**: renders slower than real time, so it cannot keep up with a conversation |

No stage is the bottleneck. The number that decides whether this works is
whether the prompt prefix is cached, below.

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
| **No vision during a call.** The vision tower comes off while a session is live | it costs ~4 GB; with it on, the language model and speech-to-text leave under 1 GB free | a smaller vision tower, or a bigger card |

### The rule the numbers impose: a stable prompt prefix

Time to the first token, by how much of the prompt the server has cached:

| Prompt | Prefix not cached | Prefix cached |
|---|---|---|
| ~2k tokens | 468 ms | 25 ms |
| ~8k tokens | 864 ms | 28 ms |
| ~16k tokens | 1,818 ms | 34 ms |

A cached prefix makes prompt size almost free; an uncached one costs up to the
whole budget. So the voice agent's prompt must keep everything that does not
change (system prompt, persona, tool schemas) at the front and byte-identical
from turn to turn, with the conversation after it. Anything that rewrites the
top of the prompt each turn — a clock in the system prompt, injected memory,
a reordered tool list — turns every exchange into a cold one. Voice mode has
to guarantee this, and a test should prove it.

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

The spike settled whether that is fast enough. Through TAI's own `/api/chat`,
a full agent turn reached its first word in a median of **58 ms** (483 ms on
the first turn, while the cache filled), against 22–34 ms for a bare model
call. The whole loop — prompt assembly, history, the database — adds about
25–35 ms.

So [#600](https://github.com/quintonmiller/tailored-ai/issues/600) is not a
dependency for voice. The cloud-realtime shape needed tools invoked outside a
turn; the local pipeline runs ordinary turns, and they are fast enough.

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

While a session is live, speech-to-text (1.1 GB) stays resident beside the
language model, Kokoro runs on the CPU and needs no VRAM, the vision tower is
off, and anything else that wants the card (image generation, a slow TTS
render) waits. Measured: ~28 GB of 32.6 GB in use with all of it running,
including ~4 GB the desktop holds. A simple session-scoped lock is enough for
v1; a general GPU scheduler is a separate idea.

## Step 0: what the spike measured

Run 2026-10-18 on the reference hardware, every stage resident at once: the
language model in NInfer without the vision tower, faster-whisper on the GPU,
Kokoro in its CPU container.

| Measured | Result |
|---|---|
| VRAM | ~28 GB of 32.6 GB in use, of which ~4 GB is the desktop |
| Speech-to-text, end of speech to transcript | 71 ms (1.9 s clip), 123 ms (4.5 s), 122 ms (5.7 s); transcripts exact |
| Language model, first token | 22 ms cached, 53 ms not, on a tiny prompt; see the prefix table above for real sizes |
| Language model, speed | ~55 tokens/s; a two-sentence reply in 160–195 ms |
| Text-to-speech, first sentence | ~200 ms for a short sentence, ~565 ms for a long one |
| A full TAI turn vs a bare call | 58 ms vs 22–34 ms to the first word |

### The budget, end of your sentence to first audio

| Step | Time |
|---|---|
| Noticing you stopped (silence before the turn ends) | ~500 ms: a setting, and the largest single item |
| Speech-to-text | ~100 ms |
| Agent turn, to the end of its first sentence (~15 tokens) | ~60 ms to the first token + ~220 ms |
| Text-to-speech of that sentence | ~200 ms |
| **Total** | **~1.1 s**, against a 1.5 s target |

With the prompt prefix not cached, add ~0.45 s for a 2k-token prompt: ~1.55 s,
a miss. That is why the stable prefix is a rule rather than an optimisation.

### What these numbers do not cover

- Speech-to-text was given clean, synthetic speech. A real microphone in a room
  is noisier, slower to detect the end of, and less accurate.
- One machine, one model, and a slim agent with one tool (2.0–2.3k prompt
  tokens). A bigger tool set lengthens the prompt, which costs little while the
  prefix stays cached.
- The model server failed its first start on a CUDA graph memory allowance and
  succeeded on retry. That is startup, not per turn, but a session cannot
  assume the model is already up.

## Where it lives

| Tier | Owns |
|---|---|
| Core | the session model and lifecycle, limits, the stage registries, the turn bridge, session-scoped GPU lock |
| Built-in plugin | the web transport; faster-whisper and Kokoro stage adapters (talking to local servers, as `speak` does today) |
| Optional plugin | cloud speech-to-speech providers; Discord voice; phone |

## Phases

| # | Slice |
|---|---|
| 0 | Measurement spike on the reference hardware — **done**, see Step 0 |
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
