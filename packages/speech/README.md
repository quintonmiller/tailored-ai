# @tailored-ai/speech

A `speak` tool: text in, an audio attachment out.

```yaml
plugins:
  - "@tailored-ai/speech"

tools:
  speak:
    enabled: true
    baseUrl: http://127.0.0.1:8880/v1   # a local Kokoro
    model: kokoro
    voice: af_bella
    voices:
      host: af_bella
      guest: am_adam
```

```
speak(text: "Good morning. Three things need you today.")

speak(script: [
  { speaker: "host",  text: "Welcome back to the show." },
  { speaker: "guest", text: "Thanks for having me." },
])
```

The result is a media part, so it reaches Discord, Slack, the web UI and the
CLI by the same path a screenshot does. Nothing in core knows this package
exists.

## Choosing a provider

`provider` selects an implementation; everything else in the block is handed
to it untouched. One ships today — `openai_compatible`, which is the OpenAI
`/v1/audio/speech` wire format — and it covers both ends of the cost range:

| | `baseUrl` | `model` | Cost |
|---|---|---|---|
| Local Kokoro | `http://127.0.0.1:8880/v1` | `kokoro` | none |
| OpenAI | *(omit)* | `gpt-4o-mini-tts` | metered |

Switching is those two fields and an `apiKey`. No agent or prompt changes.

Kokoro-FastAPI serves the same route on CPU, at roughly 5× realtime, in about
a gigabyte of RAM — so it does not compete with a local LLM for VRAM:

```bash
docker run -d --name kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

## Dialogue

A `script` renders turn by turn and joins the results into one file. Each
speaker keeps one voice for the whole recording, resolved from the call's
`voices`, then the config's, then the single `voice`.

Two behaviours worth knowing:

- **A multi-speaker script with no voice map is refused.** Rendering it would
  produce one narrator reading every part — audio that succeeds and is
  useless, discoverable only by listening.
- **Locally joined dialogue is always `wav`**, whatever `format` says.
  Concatenated mp3 frames usually play, report the first turn's duration, and
  click at the seams.

A provider that renders several voices in one request sets `nativeMultiVoice`
and gets the whole script; nothing is joined locally and `format` is honoured.

## Guards

| Setting | Default | Why |
|---|---|---|
| `maxChars` | `4000` | Refuses — never truncates — a script over the cap, before any request is made. Half a podcast sounds finished. |
| `timeoutMs` | `120000` | Per request. A hung server fails the turn rather than hanging it. |
| `format` | `mp3` | `mp3`, `wav`, `opus`, `flac`, `aac`, `pcm`. |

`validateConfig` reports the ways this block can be configured, start
cleanly, and do nothing: an unregistered provider, an OpenAI endpoint with no
key, an unknown container, no voice anywhere.

## Adding a provider

```ts
import { registerSpeechProvider } from "@tailored-ai/speech";

registerSpeechProvider("elevenlabs", (opts) => ({
  id: "elevenlabs",
  nativeMultiVoice: false,
  async synthesize({ utterances, format }) {
    // → { bytes, mimeType }
  },
}));
```

The registry exists before the second implementation on purpose. `web_search`
hardcoded one vendor and there is an open issue to retrofit the seam.
