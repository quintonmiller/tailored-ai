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

Talking happens on the **Chat** page, in the same conversation as typing.
Pick an agent, then hold **Talk** beside the message box (or hold Space when
you're not typing) and let go to send. Allow the microphone the first time.

- What you said and the agent's reply appear in the chat as it is written,
  and its voice plays a sentence at a time while the rest is still being made.
- Spoken and typed turns are one history: say something, type the next
  thing, and the agent has both. A new chat gets its conversation on its
  first spoken turn.
- Holding Talk again while it speaks cuts it off. Barge-in that works
  hands-free comes in a later phase.
- Old links to `#/talk` open the chat.

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

Give the agent a body on the Chat page: a 3D model, standing in a small room,
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

The room starts out furnished: a couch, a desk with a laptop, a bookshelf, a
window and a floor lamp. The agent can change it (see
[A room the agent can change](#a-room-the-agent-can-change)). It is lit for the
time of day: daylight through the window, the lamp on in the evening, the lamp
alone at night. Drag to look around the room, or press **Close up** to frame
the head and torso. The page remembers the choice. The furniture is built from
simple shapes, so there are no files to download.

The avatar moves around the room on its own. Between sessions it wanders:
it sits on the couch, types at the desk, looks out of the window, browses
the bookshelf, and stays a while at each. When you start a session it walks
back to the middle to face you, and stays there until the session ends.
Click a piece of furniture to send it there yourself. The close-up follows
it as it goes.

Every piece of furniture and every spot in the room has a name, and the
avatar walks round the furniture to get between spots. The way is found on a
grid of the floor with each piece grown by the avatar's width, then
straightened into as few legs as stay clear, so it works in any room the
agent has furnished. When the agent moves the avatar, it names a spot
("on the couch"), never coordinates.

### Animation files

Code-driven motion is the fallback. For real movement, give the avatar
animation libraries: glTF files of humanoid animation from any rig.

```yaml
live:
  avatar:
    model: robot.vrm
    animations:
      - animations/library-1.glb   # paths as for model
      - animations/library-2.glb
```

Each clip is adapted to the avatar the first time it plays. Bones are matched
by name for the common rigs (Rigify, Unreal mannequin, Mixamo). Each bone's
movement away from the library's T-pose becomes the same movement on the
avatar, corrected where a limb points differently at rest. Clips are chosen
by their usual names: an idle, a talking idle, a walk, sitting and talking
while seated, arms folded, a head shake and a dance. A moment with no clip
keeps the code-driven motion. Gestures with no clip, such as a wave, a point,
a hand to the chin or a shrug, take over the arm while they play, so a wave
isn't stacked on whatever the talking clip had the arm doing. Walking speed
follows the walk clip's own pace, so the feet don't slide.

Free libraries exist. Quaternius's Universal Animation Library is CC0, with
glTF versions. As with models, keep the files in your own instance.

Whatever plays, the avatar's arms are fitted to its body. A pose made for a
slim figure puts a stocky figure's hands through its hips, so the stage
measures how wide the body is at hand height and swings the arms out just
far enough to clear it.

The close-up looks for a clear view. When the avatar arrives somewhere, the
close-up finds its best angle again, unless you turned the view yourself in
the last few seconds. It never puts a wall or a shelf between you and the
avatar.

None of this asks the model for anything. The moments come from the turn the
page is already following, and the mouth from the loudness of the audio, so
the avatar adds no tokens and no delay. It is drawn in the browser with
three.js, loaded only when an avatar is set, and it moves far less when the
browser asks for reduced motion.

### On the chat page

When the agent has a body, its room fills the chat page and the conversation
becomes a panel laid over it, on the right on a wide screen and at the bottom
on a phone. The camera frames the room in the part the panel leaves clear.
**3D** in the toolbar turns the scene off and on, and the page remembers the
choice. **Chat** hides the panel when you want the whole room; the message
box stays. An agent without a body has no 3D button, just the chat.

During a conversation the avatar stays where it is, or where it was sent.
The first turn after three quiet minutes calls it back to face you.

Between conversations the agent decides what its body does. Every two to
four quiet minutes, while the page is in view, the page asks it: where it is
and the time of day go to the agent's own model, in voice mode with its body,
and the cues it writes back are played. It might go sit on the couch, look
out of the window, or stay where it is. The ask is one small completion
(60 tokens, reasoning off), and nothing is written to any conversation. The
server takes at most one ask per agent every 45 seconds, whatever pages are
open. With live sessions off, or when the ask fails, the avatar wanders on
its own instead.

### Each agent its own body

The `live.avatar` block is every agent's body by default. An agent can wear
its own, or none:

```yaml
agents:
  greeter:
    avatar:
      model: fox.vrm          # its own model; still plays the shared animations
  analyst:
    avatar: false             # no body, no 3D view
```

Paths work as they do under `live.avatar`. An agent that names a model but
no animations plays the shared libraries, since any library fits any model.
Its voice is set by `voice.voice`, as before.

### A room the agent can change

Each agent with a body has a room of its own, and it can furnish it. Ask for
a reading chair by the window, and the chair appears on the page while the
agent is still answering.

The room is a [world-state](./world-state.md) record of type `place`, kept
as `home:<agent>` in the agent's own scope. It is made from the starting room
the first time anything asks for it. Like any record, every change says who
made it, the history keeps every version, and the **State** page shows it.
The chat page redraws the room as soon as the record changes, whoever changed
it. Something new grows in, and a moved couch takes the avatar sitting on it
along.

The agent changes it with the `place` tool:

| action | does |
|---|---|
| `look` | the room in words: its size and colours, each thing and where it is, the spots to go to, and what can be added |
| `add` | a new thing: `kind`, and optionally `name`, `color`, `scale` (0.5 to 2), or `size` for a shape |
| `move` | a thing to somewhere new, or turned where it stands with only `facing` |
| `change` | a thing's `name`, `color`, `scale` or `size` |
| `remove` | a thing, and whatever stands on it |
| `room` | the room's `width`, `depth` and `height`, `walls` colour, `floor` (wood, carpet, tile, concrete, or a colour), and `name` |
| `undo` | the last change, whoever made it |

Where things go is said in words: `near` a thing or spot, on one `side` of it
(left, right, front or behind, as you face it), against a `wall`, in a
`corner`, or `on` a desk, table or shelf. The tool finds the nearest place
that fits. Things never overlap, nothing is put where the avatar needs to
stand, a tall bookcase won't go in front of a window, and only the back and
left walls are walls: the front and right are open to the camera. Seats put
near a TV or a fire turn to face it. When nothing fits, the tool says why, and
the agent can move or remove something and try again. Exact `x` and `z`, in
metres from the middle, work too.

What can be added: seats (couch, armchair, beanbag, bed, chair), tables (desk,
table, coffee table, side table), a bookshelf, TV, fireplace, lamp and plant,
things for the walls (window, picture, clock, shelf), small things for a
surface (laptop, books, vase of flowers, small plant, mug, candle, aquarium),
and blocks, balls and cylinders of any size and colour. Seats, desks, the
bookshelf, the TV, the fireplace and windows each bring a spot: add an
armchair, and the agent can sit in it, and so can a click.

#### Photos and selfies

The agent can take a picture of its room and send it: `photo` with `view`
`room` for the whole room or `selfie` for a portrait close-up, `at` a spot to
be there ("the couch"), and a `gesture` to strike ("wave"). Ask on Discord for
a selfie from the couch, and the reply arrives with one attached. On the chat
page, the picture shows under the reply. Pictures any tool makes in a turn
show there now, as Discord already attached them.

The photo is the room as the page draws it, lit for the time of day.
The server renders the page's bare `#/snapshot` view in headless Chromium and
takes a screenshot: about five seconds a picture, on the CPU, with no
GPU needed. The browser stays open for two minutes after a picture in case
another follows. The page loads through the server's usual auth with a header
the server makes at start, keeps in memory, and accepts for reads only. The
camera adds it to requests for the server and refuses every other request the
page makes.

Photos need Playwright with Chromium (`npm install playwright && npx
playwright install chromium`), as the browser tool does. Without it, the tool
says so and the agent can pass that on.

Rooms come from the built-in `builtin:places` plugin. It does nothing unless
some agent has a body. An agent with its own `tools:` list needs `place`
in it. The page asks for the room at `GET /api/ext/builtin:places/:agent`
(`default` for the default agent). Without the plugin, the page shows the
starting room, and the agent can't change it.

## Cues: the agent moves its own body

A page that shows the agent with a body says what that body can do when it
starts a session: its gestures, and the moves it can aim at something, such
as walking to a place or looking at a thing. The agent learns this in one
line at the end of its voice instructions. That line stays the same for the
whole session, so the prompt stays cached. The agent then writes **cues**
inline, right where the move should happen:

```
<wave/> Hi! Good to see you.
Sure. <go to="the couch"/> Heading over.
```

The turn takes cues out of the reply before anything is spoken or shown. A
cue goes to the page with the sentence it comes before, so the wave lands on
"Hi". A cue after the last sentence plays once the speech is done. A cue the
body can't do is dropped, never read aloud. A model that writes a stage
direction instead, such as `*waves*` or `*walks to the couch*`, is understood
too, and `*smiles*` is dropped. The reply the person reads has no cues in it.
The conversation's history keeps them, so the agent sees its own.

Why tags and not stage directions: measured on a 27B local model, with 40
single turns and a 10-turn conversation in each format:

| | `<wave/>` tags | `*waves*` directions | no body described |
|---|---|---|---|
| asked to walk somewhere, did | 9 of 10 | 8 of 10 | 0 of 10 (refused 7) |
| replies left with nothing to say | 4 | 11 | 0 |
| moves it made up | 0 | 1 | 0 |
| malformed cues | 0 | 0 | — |
| first words, median | 106 ms | 106 ms | 80 ms |

With no body described, the agent told people it was "just a voice", even
though they were looking at it. The voice style line changes with a body
too: "only offer what your tools let you do" stopped it walking anywhere;
"what your tools and your body let you do" did not.

Typed turns work the same way: while the chat page shows the body, each
message carries it, the agent's instructions get the same line, and the
reply's cues come back as `cue` events before the text is shown.

Cues need no configuration: the chat page declares its body. The avatar
offers six gestures (wave, nod, shake, shrug, think, bow), walking to any
spot in its room, and looking or pointing at its furniture or at you. Asked
to look at something behind it, or to point, it turns to face the thing
first. A walk the agent asks for is the same walk as a click. During a
session the avatar stays wherever the agent sent it. A transport
with no body, such as Discord, declares none. Its agent is never told about
cues, and its text passes through untouched.

## HTTP API

| route | does |
|---|---|
| `GET /api/live?agent=` | what a page needs before talking: `{enabled, avatar?, animations?}`. `enabled` says whether live sessions are on; the URLs are that agent's body, when it has one |
| `GET /api/ext/builtin:places/:agent` | the agent's room: `{type, id, version, place}`, made from the starting room on first use; `404` for an agent with no body. Changes arrive on `GET /api/state/events` like any record's |
| `GET /api/live/avatar?agent=` | the avatar's model file (`model/gltf-binary`), revalidated by `ETag`; `404` with the reason when none is set or the file is missing |
| `GET /api/live/animations/:index?agent=` | one of the configured animation libraries, by its position in `live.avatar.animations`. Nothing else under the folder is reachable |
| `POST /api/live/idle` | what the agent does with a quiet moment: `{agent?, body, here?, hour?}` → `{cues}`. `429` within 45 s of the last ask for that agent; `400` for a body that can't go in a prompt |
| `POST /api/live/sessions` | start: `{agent?, body?, sessionKey?}`. With `sessionKey`, its turns go into that chat's conversation, otherwise a fresh one; the session's `conversation` names it; `201` with the session and its limits; `400` when the body is not one that can go in a prompt (names must be short plain words); `409` when live sessions are off. `body` is `{looks?, gestures, aimed?}`, where each `aimed` move is `{verb, prep, does, targets}`, e.g. `{"verb": "go", "prep": "to", "does": "walk somewhere", "targets": ["the couch"]}` |
| `GET /api/live/sessions/:id` | the session, with `endedAt` and `endReason` once it has ended |
| `DELETE /api/live/sessions/:id` | end it |
| `POST /api/live/sessions/:id/turn` | one turn. The body is the recorded audio (its `Content-Type` names the format), or `{"text": "..."}`. The reply is a server-sent stream: `transcript` `{text}`, `text` `{delta}` as the reply is written, `audio` `{seq, text, mimeType, data}` (base64, one per sentence, in order), `cue` `{seq, name, target?}` with the `seq` of the sentence it comes before, then `done` `{transcript, reply, timings}`, or `error` `{message}`. `409` once the session has ended |

## Limits

A session ends itself after `maxMinutes`, after `idleMinutes` without a turn,
or at `maxTurns`, and says which. On local hardware the cost is GPU time
rather than money, but a forgotten tab shouldn't hold the speech stages
forever.
