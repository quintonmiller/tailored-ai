# Speech synthesis

Giving an agent a voice: `@tailored-ai/speech` ships a `speak` tool that turns
text — or a multi-speaker script — into an audio attachment.

It is a plugin, not core. Core already has everything it needs: the tool puts
its bytes in `ToolContext.mediaStore` and returns a media part, which is the
same path a screenshot takes, so every surface carries the result without
knowing the package exists. **No core change was required to build this**,
which is the test a tier-2 feature should pass.

See [`packages/speech/README.md`](../packages/speech/README.md) for the config
block and the tool's shape. This document is the reasoning behind it.

## Choosing a backend

The survey below is from 2026-09-02. Prices move; the shape of the decision
does not.

### The decision is mostly local-vs-hosted, and local is cheap

Speech is not like text generation, where the local option trades away real
capability. A small TTS model is *good*, and the gap to the best hosted
service is much narrower than the price gap.

| | Kokoro (82M, local) | OpenAI `gpt-4o-mini-tts` | ElevenLabs |
|---|---|---|---|
| Cost per 1M characters | none | ~$15 | ~$180–300 |
| Speed | ~35–100× realtime on a mid GPU; ~5× on CPU | network-bound | network-bound |
| VRAM | ~1 GB, or none — it runs on CPU | — | — |
| Quality | good; not top of the leaderboard | very good | top tier |
| Multi-speaker | per-turn, joined locally | per-turn, joined locally | per-turn |

An hour of finished podcast is roughly 50–60k characters of script. That is
under a dollar at OpenAI rates, about fifteen at ElevenLabs, and nothing
locally. Where the cost actually bites is iteration: re-rendering the same
episode twenty times while tuning it.

### Why Kokoro is the default suggestion here

Three properties, in order of how much they matter:

1. **It speaks the OpenAI wire format.** Kokoro-FastAPI serves
   `POST /v1/audio/speech` with OpenAI's request body. So one provider
   implementation covers local and hosted, and switching is two config
   fields. This is the same trick core's `openai_compatible` model provider
   plays, for the same reason.
2. **It runs on CPU.** ~1 GB of RAM, no GPU. On a box where the GPU is
   already contested — a local LLM, or another process holding VRAM —
   this is the difference between "generate a podcast" and "evict the model
   first". A GPU-class TTS model like VibeVoice wants ~7 GB and would fight.
3. **It is free to iterate against.** The twentieth re-render costs what the
   first did.

The cost is quality: Kokoro is good, not best. For something going out to
other people, rendering the final take against a hosted provider is two
config fields away.

### Models built for dialogue

Several open models render a whole conversation in one pass rather than a turn
at a time, and handle the handoffs — pacing, interruption, tone — better than
concatenation can:

- **VibeVoice** (Microsoft) — up to 90 minutes, four speakers, ~7 GB VRAM.
  Built for exactly this. Batch, not streaming.
- **Higgs Audio v2** (~5.8B) — strong naturalness scores.
- **Dia** (Nari Labs) — `[S1]`/`[S2]` turn tags, plus non-verbal cues.

None is wired up here. Each is a `SpeechProvider` whose `nativeMultiVoice` is
`true`, and the tool already routes the whole script to such a provider in one
call — the seam is built and waiting. The reason to wait is that concatenation
is good enough to find out whether anyone actually wants podcasts, and these
models cost VRAM that is currently spoken for.

Hosted, **Gemini 2.5 TTS** renders two speakers natively in one request. It is
the shortest path to native multi-speaker without a local GPU, and it needs a
provider of its own because the wire format is not OpenAI's.

## Saying how, not just what

A turn takes an optional `direction` — plain words describing the delivery:

```
GM (flat, a count not a threat): The ledger's missing a page.
GM (louder, stepping in): Give it to me.
REX: I check the door (again) before I answer.
```

It rides to the provider as `instructions`, the field OpenAI's TTS and Breeze
both take per utterance, and is left out of the request entirely for providers
that would not know what to do with it. Breeze calls this *voice direction*:
the reference voice keeps its identity and the instruction steers tone, pace
and delivery.

The parenthesis sits *before* the colon, and the position is load-bearing.
Everything after the colon belongs to the engine, and what a parenthesis means
there depends on which engine is running: Kokoro reads it out, and Breeze
treats it as a **vocal event** — `(laugh)`, `(sigh)`, `(cough)`,
`(clears throat)` are performed rather than spoken. So a direction written
inside the line is either read to the listener or silently reinterpreted, and
neither is what the writer meant. Before the colon it is unambiguous.

That also makes vocal events a feature of the text rather than of this tool:

```
OTTO (tired, not looking up): (sigh) Fine. I'll do it.
```

Nothing in `speak` needs to know about them — they travel as text — but a
script written for Kokoro and rendered on Breeze will perform its parentheses,
and one written for Breeze and rendered on Kokoro will read them aloud.

This is the one lever that stops a multi-voice recording sounding like several
people reading at one pitch, so it is worth using where a line would otherwise
land flat — and worth leaving off everywhere else. A direction on every line is
a script that has stopped trusting its own words.

One consequence for the parser: consecutive lines from the same speaker are
still merged into a single utterance, but no longer across a change of
direction. Merging two deliveries renders the second in the first's voice, and
because the text still reads correctly, nothing but listening reveals it.

## Why concatenation, and what it costs

Rendering each turn separately and joining the audio is the portable approach:
it works against every provider, including ones that only ever emit one voice.
What it cannot do is make the turns *react* to each other. Speakers do not
overlap, pauses between turns are uniform, and nobody's intonation anticipates
the next line. It sounds like alternating narration, because that is what it
is.

That is an acceptable first version and a real ceiling. Native multi-speaker
is how you get past it.

Two implementation notes that are easy to get wrong:

**Joining is WAV-only.** mp3 frames can be concatenated and will usually play,
but the file reports the first turn's duration in most players and clicks at
the seams in some. Both defects survive any test that checks "did we get
audio" and are found by listening to the end. So `format` is overridden to
`wav` whenever the tool has to join — and honoured when a provider renders the
script itself.

**The header is not 44 bytes.** Real encoders emit `LIST`/`fact` chunks before
`data`. Slicing at a fixed offset turns metadata into a burst of noise at the
top of every turn. `wav.ts` walks the chunk list, and refuses inputs whose
`fmt` chunks disagree — joining a 24 kHz turn onto a 48 kHz one plays the
second at the wrong pitch and speed.

## What is deliberately not solved

- **Duration is in the text, not the record.** `MediaRef` has `width` and
  `height` and no time axis ([#596](https://github.com/quintonmiller/tailored-ai/issues/596)),
  so `[audio: dialogue.wav …]` reads identically for four seconds and forty
  minutes. The tool computes duration and puts it in its reply, which helps
  the agent that just called it and nothing downstream.
- **mp3 is not sniffed.** Core's `sniffMedia` knows ogg and wav and falls back
  to the declared type otherwise — also #596. The provider declares its
  container, so this works; it would not if the declaration were dropped.
- **A long render cannot be cancelled.** `ToolContext` carries no abort signal
  ([#631](https://github.com/quintonmiller/tailored-ai/issues/631)), so a
  script already half-rendered runs to the end. Each request bounds itself
  with a timeout, so a hung server fails the turn rather than hanging it.
  `SynthesizeRequest.signal` exists and is unused, ready for the day there is
  one to pass.
- **Cost is capped by characters, not money.** `maxChars` is a blunt guard
  that works the same locally and against a metered API. A spend-aware
  version needs per-provider pricing, which is a bigger question than this
  tool.

## Voices are opaque strings

`af_bella`, `nova`, and a 20-character ElevenLabs id have nothing in common
but being strings. There is no normalising layer over them and there should
not be one — it would be fiction, and it would break the moment a provider
added a voice. The config names voices per speaker; the provider resolves
them; a bad name comes back as the provider's own error text.
