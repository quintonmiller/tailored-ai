# Live sessions

Talk with an agent out loud: you speak, it answers in its own voice within a
couple of seconds. Everything runs on local models: speech-to-text, the agent
on your local model, then text-to-speech. A cloud service can stand in for any
stage, but none is needed. The design, with the measurements behind it, is in
[live-sessions-design.md](./live-sessions-design.md).

> **Status:** phase 1 works end to end: push-to-talk in the web UI, speech-to-text,
> an agent turn in voice mode, and the reply spoken a sentence at a time, with
> an optional avatar that moves on its own. Interrupting the agent mid-reply,
> hands-free voice detection, gestures the agent chooses, and Discord voice
> come later.

## Setting it up

You need two local servers that speak the OpenAI audio API, plus the
language model you already run:

- **Speech-to-text:** any `/v1/audio/transcriptions` server, for example a
  faster-whisper wrapper. faster-whisper `small` on the GPU transcribes a
  sentence in about 0.1 s; on the CPU it takes 1.5–2.5 s, which works but
  is slow.
- **Text-to-speech:** any `/v1/audio/speech` server. Kokoro-FastAPI runs on
  the CPU and says a short sentence in about 0.2 s.

```yaml
live:
  enabled: true
  stt:
    options: { baseUrl: http://127.0.0.1:8900/v1, model: small, language: en }
  tts:
    options: { baseUrl: http://127.0.0.1:8880/v1, model: kokoro, format: mp3 }
    voice: af_heart
  limits: { maxMinutes: 30, idleMinutes: 10, maxTurns: 200 }   # the defaults
```

`stt.provider` and `tts.provider` default to `openai_compatible`. A plugin can
register another stage (`registerSpeechToText`, `registerTextToSpeech`) and
name it there. `apiKey` in a stage's options is sent as a bearer token.

## Talking in the web UI

Open **Talk** in the sidebar, pick an agent and press **Start talking**. Allow
the microphone when the browser asks. Then:

- Hold the button, or Space, while you speak, and let go to send.
- What you said appears, then the agent's reply as it is written, and its
  voice plays a sentence at a time while the rest is still being made.
- Holding the button again while it speaks cuts it off. Barge-in that works
  hands-free comes in a later phase.
- No microphone? Type into the box under the button: it is the same turn.
- Under the button: how long hearing you took, and how long until the first
  word.

Measured on the reference machine, with speech-to-text on the CPU: first word
about 1.7 s after you let go. Speech-to-text on the GPU saves about half a
second of that.

## Voice mode

Voice is a mode on an agent, not a separate agent. In a live session the agent
keeps its identity and history, and gets a smaller, faster turn:

- its `voice.instructions`, or else a short guide to talking ("one to three
  short spoken sentences, nothing that can't be read aloud") followed by its
  own instructions
- only the tools named in `voice.tools`, none by default
- reasoning off, replies capped at `voice.maxTokens` (300 by default), and no
  injected memory

```yaml
agents:
  planner:
    instructions: You keep plans tidy.
    voice:
      tools: [state]        # what it can still do while talking
      voice: am_adam        # its own voice; otherwise live.tts.voice
```

A spoken turn is an ordinary agent turn, with the same loop, tools, limits,
guardrails and history. The reply is spoken a sentence at a time while the
model is still writing, so the first words come out before the reply is done.

## Why the prompt has to stay the same

The model answers quickly only when it has the start of the prompt cached: on
the reference machine the first word takes ~25 ms with a cached prefix, and
~470 ms for a 2,000-token prompt without one. Voice mode keeps the system
prompt and tool list byte-identical from turn to turn, and a test checks it.
Anything that changes each turn (live state, recalled memory, pinned state)
goes after the conversation, where it doesn't break the cache. If you
customise `systemPrompt.order`, keep those layers in the tail.

## An avatar

Give the agent a body on the Talk page: a 3D model, standing in a small room,
that breathes and blinks, leans in while you talk, looks up and away while it
thinks, and moves its mouth with its voice.

```yaml
live:
  avatar:
    model: robot.vrm   # under <TAI_HOME>/avatars/, or an absolute path
```

The model is a [VRM](https://vrm.dev/en/) file, the open format for humanoid
avatars. Any VRM works without setup, because the skeleton, mouth shapes and
blink follow one standard. Make one in VRoid Studio, or start from a
collection published under CC0, such as 100Avatars. Many models, free ones
included, carry licences that limit sharing the file, so keep yours in your
own instance.

The room is furnished: a couch, a desk with a laptop, a bookshelf, a window
and a floor lamp. It is lit for the time of day: daylight through the window,
the lamp on in the evening, the lamp alone at night. Drag to look around the
room, or press **Close up** to frame the head and torso. The page remembers
the choice. The furniture is built from simple shapes, so there are no files
to download, and every piece and spot in the room has a name. When the agent
later moves around, it will say "by the couch", never coordinates.

None of this asks the model for anything. The moments come from the turn the
page is already following, and the mouth from the loudness of the audio, so
the avatar adds no tokens and no delay. It is drawn in the browser with
three.js, loaded only when an avatar is set, and it moves far less when the
browser asks for reduced motion.

Gestures and expressions the agent picks itself, written inline in its reply,
come next.

## HTTP API

| route | does |
|---|---|
| `GET /api/live` | what the Talk page needs before a session: `{avatar?}`, the URL of the avatar's model file when one is set |
| `GET /api/live/avatar` | the avatar's model file (`model/gltf-binary`), revalidated by `ETag`; `404` with the reason when none is set or the file is missing |
| `POST /api/live/sessions` | start: `{agent?}`; `201` with the session and its limits; `409` when live sessions are off |
| `GET /api/live/sessions/:id` | the session, with `endedAt` and `endReason` once it has ended |
| `DELETE /api/live/sessions/:id` | end it |
| `POST /api/live/sessions/:id/turn` | one turn. The body is the recorded audio (its `Content-Type` names the format), or `{"text": "..."}`. The reply is a server-sent stream: `transcript` `{text}`, `text` `{delta}` as the reply is written, `audio` `{seq, text, mimeType, data}` (base64, one per sentence, in order), then `done` `{transcript, reply, timings}`, or `error` `{message}`. `409` once the session has ended |

## Limits

A session ends itself after `maxMinutes`, after `idleMinutes` without a turn,
or at `maxTurns`, and says which. On local hardware the cost is GPU time
rather than money, but a forgotten tab shouldn't hold the speech stages
forever.
