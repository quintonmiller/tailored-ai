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
