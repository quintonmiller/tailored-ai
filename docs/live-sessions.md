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

Each agent's room is its own, and it starts out furnished. It is drawn from
the agent's name, so the same agent always gets the same room and no two
agents get the same one: 8 to 10 m wide and 6 to 8 m deep, in its own
colours, and one of several kinds (a study, a studio, a lounge, a workshop, a
reading nook, a garden room, a bedsit, a den). Furniture comes in groups that
belong together, set against the walls: a desk with its chair, lamp and a
shelf above it, a couch facing a TV, two armchairs by a fire, a bed between
bedside tables. A couple of islands stand out in the floor, like a round
table with chairs or beanbags on a rug, low enough to see past. Every room
has somewhere to sit, a desk to work at, a window, lamps, and a picture or a
painting for photos to hang in. The agent can change it (see
[A room the agent can change](#a-room-the-agent-can-change)). It is lit for
the time of day: daylight through the windows, the lamps on in the evening,
the lamps alone at night.

The view shows the whole room when that leaves the agent big enough to make
out. A bigger room is seen from close by instead, centred on the agent as
nearly as the room's edges allow, and the view drifts after the agent as it
moves about. Drag to look around the room, or press **Close up** to frame the
head and torso. The page remembers the choice. The furniture is built from
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
isn't stacked on whatever the talking clip had the arm doing. An agent walks
at its walk clip's own pace, so the feet don't slide. Something walking faster
than that (you, on a visit) plays the clip faster to keep up, and a run plays
a run clip (`Jog…`, `Run…` or `Sprint…` by name) when the library has one.

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
as `home:<agent>` in the agent's own scope. It is drawn from the agent's name
the first time anything asks for it. A room nobody has changed since it was
made is redrawn when the way rooms are drawn improves, which is how homes made
before rooms differed got one of their own. Once the agent, you, or anything
else has changed it, it is never redrawn. The record's history says who wrote
each version: a room is redrawn only when the places plugin made it, or the
agent's first look made it as the old starting room, and nothing but the
plugin has written it since. A redraw isn't the agent's to `undo`. Like any
record, every change says who made it, the history keeps every version, and
the **State** page shows it.
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
| `room` | the room's `width` (up to 16 m), `depth` (up to 12 m) and `height` (up to 4 m), `walls` colour, `floor` (wood, carpet, tile, concrete, or a colour), and `name` |
| `undo` | the last change, whoever made it, unless it was the system redrawing the room |

Where things go is said in words: `near` a thing or spot, on one `side` of it
(left, right, front or behind, as you face it), against a `wall`, in a
`corner`, or `on` a desk, table or shelf. The tool finds the nearest place
that fits. Things never overlap, nothing is put where the avatar needs to
stand, a tall bookcase won't go in front of a window, and only the back and
left walls are walls: the front and right are open to the camera. Seats put
near a TV or a fire turn to face it. When nothing fits, the tool says why, and
the agent can move or remove something and try again. Exact `x` and `z`, in
metres from the middle, work too.

What can be added: seats (couch, armchair, beanbag, bed, chair, stool),
tables (desk, table, round table, coffee table, side table, sideboard), a
bookshelf, TV, fireplace, easel, rugs (square or round), lamps, plants (a
plant, a tall plant, a cactus, a palm), things for the walls (window,
picture, painting, poster, clock, shelf, pegboard, task board), small things
for a surface (laptop, books, vase of flowers, small plant, mug, candle,
table lamp, aquarium), and blocks, balls and cylinders of any size and colour.
Seats, desks, the bookshelf, the TV, the fireplace, the easel and windows each
bring a spot: add an armchair, and the agent can sit in it, and so can a
click.

#### Shared places

A room can be shared. An agent makes one with `new` and a name ("the
lounge"), which starts furnished like a home (any kind but the bedsit), and
it goes there. Other agents join with `go` and `to: "the lounge"`, and anyone
goes back with `to: "home"`. `places` lists where an agent can go and who is in each place.
While an agent is in a shared place, the `place` tool changes that place, so
everyone there sees the change.

Where each agent is lives in world state too: a `whereabouts` record, one per
agent, in the global scope. No record means it is at home. A shared place is
a `place` record in the global scope, named `shared:<name>`. If one is
deleted, whoever was in it is home again.

The chat page shows the place the agent is in, with every other agent there
in its own body and a name label over its head. They wander on their own,
keep out of each other's spots, and look at the agent you are talking to.
When you send that agent to a spot someone is in, they make room. The agent
is told who is with it ("a small figure in a cozy room with planner"), and
can look or point at them. A photo includes everyone who is there.

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

Every photo is also hung in the room it was taken in: the place keeps its
last six (`photos`, newest first), and the pictures on its walls show them in
order on a white mount, the newest in the first picture, then the paintings
once the pictures are full. Every home starts with at least one of the two.
Hang more ("add a picture by the window") to show more of them.

Photos need Playwright with Chromium (`npm install playwright && npx
playwright install chromium`), as the browser tool does. Without it, the tool
says so and the agent can pass that on.

#### Getting around: the map, walking and flying

The **Map** button on the stage (or `M`) lists every place: the rooms agents
talk in, the shared places, and each agent's home, with who is in each and
a mark for anyone waiting on you (`!`), stuck (`?`) or asleep (`z`). Type to
find a place or an agent. Click one to go there.

You arrive in your own body ("you"), in a colour of its own. **Walk** with
WASD or the arrow keys, which move you the way the camera faces, at a brisk
2.75 metres a second; hold **Shift** to run at twice that. Click the floor to
walk there round the furniture, at the same walking pace. Drag to look round
and use the wheel to zoom. The camera moves with you every frame, so it keeps
up however fast you go. **Fly** puts your body away and lets the camera go
anywhere, faster again (6 metres a second, twice that with Shift): WASD to
move, `E` up, `Q` down, drag to turn. Agents keep their own calmer pace in
their rooms. Every speed is named in one place,
`packages/ui/src/avatar/travel.ts`. Agents look up as you come near, and wave
if they're free; standing next to one offers **Talk to** it, which switches
the chat to that agent. Click any agent for its menu as usual.
**Voices** (off until you switch it on) speaks what agents say near you: as
a line starts in an agent's bubble within a few metres of you, the page asks
`POST /api/live/say` for it in that agent's voice and plays it, quieter the
further you stand, one line at a time. It is off by default because each line
is a text-to-speech render, which may run on your GPU. **Back to** returns to
the agent's own view. While you visit, your body is
yours: the agent's turns still run, but its cues have nothing to move.

#### Who you are talking to

The top of the chat panel says who the conversation is with: their name, a
dot in their body's colour (the default agent has none), and what they are
doing right now, from their `activity` record. **Talk to** beside it switches
to someone else. The conversation follows who you are with:

- **Going to an agent's home**, on the map or any other way, talks to that
  agent. The conversation you left it in comes back; the first time you go to
  it since opening the page, your latest conversation with it does, or a new
  one starts.
- **Coming back**, with **Back to** or by picking on the map the place the
  agent you came from is in, talks to that agent again, where you left off.
- **The lobby and shared places** keep the conversation you had.
- **A reply on its way**, typed or spoken, is never cut off. The switch waits
  until it's done, and the panel says who is next meanwhile. Coming back
  before it's done, or picking the agent you're still with, calls the switch
  off.

Switching agents, from the panel, the toolbar or the floating chat, always
leaves the last agent's conversation. A new web conversation's key names its
agent (`web:<agent>:<time>`, and `web:default:<time>` for the default agent),
which is how your latest one with an agent is found, and how a conversation
you reopen knows who it is with. A key that doesn't name an agent
(`web:<time>`, from before keys did) is never picked up this way, since it
could be with anyone; it stays in **Sessions**. A link to the chat with such a
key and no conversation, like the Agents page's **Open in chat**, starts a new
conversation with that agent.

**In a meeting room** there is nobody in particular to talk to, so the panel
reads out the room's own conversation instead: who said what, and to whom,
newest at the bottom. It is read again every 15 seconds while it is on
screen, and not while you're talking to a member, the panel is hidden or the
browser tab is in the background. It is for reading only. Nobody's read
cursor moves, and you can't post into the room from here. The room's members
are tabs above it: pick one, or **Talk to** someone you're standing next to,
to talk to them, and **Room** to go back to reading.

#### Every place, and the rooms agents talk in

The plugin also answers for the whole world: every agent's home, the shared
places, and each room agents talk in (a Discord channel, a local room), with
who is in each. A room of conversation is drawn as a meeting room with a
seat for every member with a body: up to six round a round table, more at a
long one, and the room grows with them. Its members are all shown in it,
wherever their bodies are, because an agent can belong to several rooms at
once.

A meeting room is dressed for what the room is for, read from its name and
purpose: a trip or a vacation gets a beach (sand floor, sky-blue walls, palms
and an umbrella), a campaign a tavern (dark wood, a hearth, barrels, candles
on the table), a podcast a studio (an easel and posters), code a workshop (a
workbench under a pegboard, crates), research a library (shelves of books and
a reading chair). A room whose words match none is plain. Each comes in a
few colourings and wall arrangements, and the room's name picks one, so two
rooms of the same kind still look different.

#### Task boards and the lobby

A **task board** (`board`) hangs on the wall and shows tasks as sticky notes
in four columns (to do, doing, blocked, done): in a home, its owner's; in a
shared place or a meeting room, those of whoever is there. Every meeting room
has one on its back wall, some homes start with one, and an agent can put one
in its own room ("add a task board on the back wall").

**Click a note** to open that task's card, right there in the world. The card
shows the title, the details, the status, who has it, its project and tags,
who made it and when, when it last changed, and its latest few comments. From
the card you can:

- move it to another status with one click (to do, doing, in review,
  blocked, done);
- give it to an agent, or to nobody. Before you press **Assign**, the card
  says whether that wakes the agent: with the task watcher on
  (`taskWatcher.enabled`), the agent is woken to start on the task, unless
  it was the last agent the watcher started on that task (the watcher
  doesn't start the same agent on a task twice in a row); with it off, the
  card says nobody is woken and the task waits on the agent's list;
- edit the title and details (Escape while editing drops the edit);
- archive it, which takes it off the boards.

Every change shows on the board the moment it is saved, without waiting for
the board's half-minute refresh. **Open on the Tasks page** at the bottom of
the card is there for anything the card doesn't do.

**Click a board away from any note** to open the **task list**. Clicking in a
column opens it at that column; in a home it starts on the owner's tasks. The
list filters by status (open, to do, doing, blocked, done, archived, all, with
a count on each) and by whose tasks they are (anyone's, nobody's yet, or one
agent's), newest first. Click a row for its card, and **← All tasks** on the
card goes back to the list. **+ New task** opens the new-task form. The
**Tasks** button beside **Map** opens the same list from anywhere. The list
keeps the 300 most recently changed tasks; when there are more it says so,
and **Open the Tasks page** at the bottom has the rest.

These panels, and an agent's card (below), take the chat's column while they
are open: the chat steps aside, the scene stays in view beside the panel, and
closing the panel (× or Escape) brings the chat back. So does anything that
asks for the chat: the toolbar's **Chat** button, or **Chat with** on an
agent's menu. Escape on a panel only closes it: a reply on its way in the
hidden chat goes on. On a phone they open as a sheet over the lower part of
the screen, where the chat sits, and scroll inside. Keys pressed in a panel
are the panel's: typing never walks your body, and Space there presses the
button instead of starting to talk.

**The lobby** is first on the map, and the biggest room. Its three kiosks
start things. **New
agent** opens a fresh chat with the default agent, a request already written
for you to send ("I'd like a new agent. Ask me what it should do…"), so the
agent asks what it needs and sets it up. **New room** first says what will
happen: a message to the default agent is written into the chat and nothing
is sent until you send it; the agent asks the room's name, what it's for and
who should be in it; and the message asks it to say where the room will be
made and wait for your go-ahead, because rooms go on your default room
transport, and on Discord that is a new channel in your server. **Write the
message** puts it in the chat. **New task** opens a small form: a title,
details, and who should do it, saying as the card does whether the agent you
pick is woken to start on it. The lobby's board shows every open task.

The card asks `GET /api/task-watcher` whether the watcher is on and which
changes it reacts to (`created`, `updated`), as the server runs it now. Every
change goes through the project-tasks API (`PATCH /api/project-tasks/:id`),
the same one the Tasks page uses.

Rooms come from the built-in `builtin:places` plugin. It does nothing unless
some agent has a body. An agent with its own `tools:` list needs `place`
in it. The page asks for the room at `GET /api/ext/builtin:places/:agent`
(`default` for the default agent). Without the plugin, the page shows a
small fixed room, and the agent can't change it.

### What it is doing

Each agent also has an `activity` record saying what it is doing right now:
thinking, working with a tool, talking to another agent, waiting on you,
stuck, idle or asleep. It holds a few words for a status line ("searching
the web", "talking to planner"), a `look` the page can draw it holding (a
camera for a photo, a laptop for code, a book for reading), who else is
involved, and when it started. Open the State page to watch them change.

| doing | when |
|---|---|
| `thinking` | a turn is running and no tool is: any surface, from the web chat to a room wake |
| `working` | a tool call is running; `what`, `look` and sometimes `detail` (the search, the page's host) say which |
| `talking` | it sent a direct message or handed off work, or it is answering one (`with` names the other agent) |
| `waiting` | it asked you something (`ask_user`, or a choice, form or confirmation) and its next turn hasn't come; a task needs you; or a call is waiting for your approval |
| `stuck` | its last turn ran out of steps, went round in circles, or failed |
| `asleep` | it has nothing to do and agents are paused, or it's an online agent switched off or paused on the Agents page |
| `idle` | none of the above |

The chat page draws it on every body in the room:

- **Working**, it holds what the tool looks like: a camera up to its eyes, a
  book or a tablet in front of its chest, a magnifier out ahead. It reads in a
  free seat and codes at a free desk, where it puts the laptop down to type.
- **Thinking**, a thought cloud floats over it and it looks up and away.
- **Talking** to an agent in the same room, the two turn to face each other
  under speech bubbles; to one who isn't there, it's on the phone.
- **Waiting** on you, an amber `!` hangs over it and it waves once. **Stuck**,
  an orange `?`, and a shrug.
- **Asleep**, it finds a seat if one is free, drops its chin, shuts its eyes
  and Zs drift up.

A tag over each head says what it is doing ("searching the web · hotels near
Alfama") under its name; the agent you are talking to shows the status alone.
While it works, thinks or waits it stays put instead of wandering, and comes
back to you when you talk to it. Each named agent's body is also turned round
the colour wheel by an amount that comes from its name, so several agents
sharing one model are told apart at a glance; the default agent keeps the
model's own colours.

Everything comes off the event bus — turns starting and ending, tool calls,
approvals, stalls, the pause switch — so nothing here runs a model or slows a
turn. A quick call that settles back within a quarter of a second isn't
written at all, so a status line doesn't flicker. The records live in the
built-in `memory` state provider: gone on restart, and written by the plugin
alone.

Which tool looks like what is a table in the plugin. Say how your own tools
look, or change ours, in its config, by tool or `tool.action`:

```yaml
plugins:
  - module: builtin:activity
    config:
      tools:
        flights: { what: "looking up flights", look: "tablet" }
        place.photo: { what: "taking a picture" }
```

What agents say shows too. The plugin keeps a `speech` record per agent, the
last thing it said in a room or to another agent directly, and the page puts
it in a bubble over the speaker's head as it is said, mouth moving, for long
enough to read. Both halves of a direct message show, the answer just after
the question. Only people can read speech records: the type is closed to
agents, so a direct message stays as private from other agents as it was.
`speech: false` in the plugin's config keeps none. A room post shows when its
speaker's room name is the agent's own name.

Click an agent's body, or its tag, for a menu: what it is doing and since
when, and what you can do about it. Chat with it, send it home from a shared
place, or open **About** it; an online agent can be paused for four hours or
woken, with the same switch as the Agents page.

**About** opens the agent's card, in the world. It shows the agent's name in
its body's colour, what it is doing now and for how long, the last thing it
said and where (from its `speech` record), where its body is, and how many
open tasks it has (click for them in the task list). For an agent that runs
on its own, it shows when its next turn is due, worked out the way the
exploratory worker does from its last turn and the interval it is on now
("about every 45 min, next around 14:05"), or that it is paused until a
time, or that every agent is paused, and what its last run said. Its buttons chat with it, go to where its
body is, send it home from somewhere else, and pause it for four hours or
wake it. **Open its page** at the bottom goes to the Agents page. Wakes an
agent booked for itself with the `schedule` tool aren't shown: schedules have
no HTTP route yet (see [schedules](./schedules.md#known-limits)).

Activity comes from the built-in `builtin:activity` plugin, on by default. Like
places, it does nothing unless some agent has a body.

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
| `GET /api/ext/builtin:places/:agent` | the place the agent is in: `{type, id, version, place, company}`, its home drawn from its name on first use. `company` is everyone else there with a body: `{agent, name, avatar, animations}`. `404` for an agent with no body. Changes arrive on `GET /api/state/events` like any record's, and a `whereabouts` change means someone came or went |
| `GET /api/ext/builtin:places/map` | every place: `{places: [{id, name, kind, agents, owner?, purpose?}]}`. `kind` is `home` (one per agent with a body, `owner` its agent), `shared`, or `room` (a room agents talk in, `room:<backend>:<id>`). `agents` is who is in it: a body is in one home or shared place at a time, while a room lists every member with a body |
| `GET /api/ext/builtin:places/transcript/:id` | a room agents talk in, to read: `{id, name, purpose?, members, lines}`, its latest 30 messages oldest first, each `{id, who, agent?, to, text, at, files?}`. `who` is the speaker's name in the room and `agent` the agent behind it, when there is one. Read only: no read cursor moves. `404` for a room that isn't there, `503` with the reason when its transport can't be read |
| `GET /api/ext/builtin:places/scene/:id` | any place on the map, to look at: `{type, id, place, company}`, with everyone in it as `company`. A room agents talk in is a meeting room with a seat for each member, made fresh each time. `404` for a place that isn't there |
| `GET /api/live/avatar?agent=` | the avatar's model file (`model/gltf-binary`), revalidated by `ETag`; `404` with the reason when none is set or the file is missing |
| `GET /api/live/animations/:index?agent=` | one of the configured animation libraries, by its position in `live.avatar.animations`. Nothing else under the folder is reachable |
| `POST /api/live/say` | a line in an agent's voice: `{agent?, text}` → the audio, from the live text-to-speech stage with the agent's `voice.voice` (else `live.tts.voice`). Markdown is stripped first. `400` for an empty line or one over 400 characters, `409` when live sessions are off, `502` when the voice can't be made |
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
