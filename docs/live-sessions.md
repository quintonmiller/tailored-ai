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

- What you said and the agent's reply appear as it is written, beside the
  agent when it has a body and in the chat otherwise, and its voice plays a
  sentence at a time while the rest is still being made.
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
reading nook, a garden room, a bedsit, a den). Which kind suits what the agent
is for, when that can be read (see
[What an agent is for](#what-an-agent-is-for-its-home-and-what-it-wears)). Furniture comes in groups that
belong together, set against the walls: a desk with its chair, lamp and a
shelf above it, a couch facing a TV, two armchairs by a fire, a bed between
bedside tables. A couple of islands stand out in the floor, like a round
table with chairs or beanbags on a rug, low enough to see past. Every room
has somewhere to sit, a desk to work at, a window, lamps, and a picture or a
painting for photos to hang in. The agent can change it (see
[A room the agent can change](#a-room-the-agent-can-change)). It is lit for
the time of day: daylight through the windows, the lamps on in the evening,
the lamps at night, reaching further than in the evening, with enough
moonlight left to tell a body or a couch from the floor across the room. That
cosy dark is for homes and shared places. The
lobby, the office and the meeting rooms are public, somewhere anyone may be at
any hour, so after dark their lights overhead stay on and they stay bright;
only the windows say it is night. The town outdoors has a sky instead (see
[The town, and its doors](#the-town-and-its-doors)).

The view frames the part of the room the agent is in, near enough that the
agent stands about a quarter of the picture tall, and drifts after it as it
moves about, as far as the room's edges allow. A room small enough to see
whole from there is seen whole. The wheel, or a pinch on a touch screen,
brings the view nearer or takes it back as far as the whole room, and the
page keeps that while it is open. Drag to look around the room, or press
**Close up** to frame the head and torso. The page remembers the choice. The
furniture is built from simple shapes, so there are no files to download.

Something tall standing between the camera and anyone in the room, a palm at
the front of a meeting room or a bookshelf you walked behind, fades to a
ghost of itself until the view is clear again. On a visit you can turn the
view all the way round; a wall the camera goes behind fades the same way,
with whatever hangs on it, so you see into the room rather than its back.

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
("on the couch"), never coordinates. On a visit, your own body counts as in
the way too: an agent heading somewhere walks round you with a step to
spare, and finds a new way if you step into its path. It never cuts through
the furniture to do it: setting off from right beside you, or with you
standing in the only way through, it goes round the furniture alone.

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

When the agent has a body, its room fills the chat page, and your
conversation is in the room with it: beside the agent, the last few things
you said to each other, its words in white bubbles like the ones over its
head and yours in your own colour, with the box to type in underneath (see
[Your conversation in the world](#your-conversation-in-the-world)). The
camera frames the agent with room beside it for that, and on a phone the
conversation is a sheet along the bottom with the agent framed above it.
**Chat** in the toolbar opens the whole conversation in a column down the
right, as the chat page always had it; while that is open, your
conversation in the room steps aside, since the column has it. **3D** turns
the scene off and on, and the page remembers the choice. An agent without a
body has no 3D button, just the chat.

During a conversation the avatar stays where it is, or where it was sent.
The first turn after three quiet minutes calls it back to face you.

Between conversations the agent decides what its body does. Every two to
four quiet minutes, while the page is in view, the page asks it: where it is
and the time of day go to the agent's own model, in voice mode with its body,
and the cues it writes back are played. It might go sit on the couch, look
out of the window, or stay where it is. The ask is one small completion
(60 tokens, reasoning off), and nothing is written to any conversation. The
server takes at most one ask per agent every 45 seconds, whatever pages are
open. Wherever its choice takes it, it does something there: a book at the
shelf, a coffee on the couch (see [Passing the time](#passing-the-time)).
With live sessions off, or when the ask fails, it picks something to do from
its room on its own instead.

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

Agents sharing one model are told apart first by colour: each body is the
model turned round the colour wheel by an amount drawn from the agent's
name, and the dot by its name on its card, in the chat, on the map, in the
needs list and on boards and calendars is the same colour, the one it chose
once it chooses. The default agent keeps the model's own colours. An agent can
choose a colour of its own, and another of the models the deployment has, as
can you on its card (see [An agent in charge of its body](#an-agent-in-charge-of-its-body)).

### What an agent is for: its home, and what it wears

Forty bodies in one colour scheme still look alike from across a hall, so
the world reads what each agent is for and shows it. The reading is words
alone, no model call, and it starts from the agent's name and its
`description`: an agent has a role only when one of those says it. `coder`
or `debugger` reads as a coder, and so does "Fixes bugs in the repo";
`podcast-producer`, or "Turns each session into a podcast episode", as a
producer. The name counts over everything else. The start of its
`instructions` and the tools in its `tools:` list only choose between roles
the name or description already says, so "Handles the mail and the podcast"
is a clerk if its tools are the mail's. They never give a role on their
own: instructions mention all sorts in passing, and most agents are given
the same exec, edit and web search. Words that often mean something else
are left out: a DM is usually a direct message, not a dungeon master, and
"health" is as often an agent's as a person's. When two roles score the
same, the more particular one wins: a trip planner is a travel agent before
it is a planner, a code reviewer a reviewer before a coder. An agent whose
name and description say nothing has no role.

| role | home | something in it for the work | wears |
|---|---|---|---|
| coder | workshop or study | two server racks, their lights on day and night | headset, glasses |
| operator (deploys, backups, outages) | workshop | server racks | headset, tool belt |
| reviewer (reviews, audits, judges) | study or workshop | | glasses, lanyard |
| producer (podcast, audio, voice-overs) | studio | a mixing desk with a microphone on a stand, acoustic panels, no easel | headset, scarf |
| travel agent | lounge | a globe, a map of the world, a suitcase | adventurer hat, satchel |
| bookkeeper (budget, bills, accounts) | study | a bureau with ledgers on it, and a safe | bow tie, glasses |
| game master | den | a game table with a chessboard and the rule books | wizard hat |
| player | den | the game table | adventurer hat, tool belt |
| writer | reading nook or study | | beret, scarf |
| artist (graphic design, drawing, photography) | studio | | beret, satchel |
| researcher | study or reading nook | | glasses, satchel |
| reporter (news, digests) | study or studio | | cap, satchel |
| tutor | reading nook | | glasses, scarf |
| coach (fitness, workouts, sleep) | garden room | | cap, lanyard |
| clerk (mail, inbox) | study | | bow tie, lanyard |
| housekeeper (chores, groceries, the garden) | garden room or lounge | | tool belt, scarf |
| concierge | lounge | | bow tie |
| builder | workshop | | cap, tool belt |
| planner (calendar, to-dos, assistant) | study or lounge | | lanyard |

Where a role suits two kinds of home, the agent's name picks one, and the
name still draws everything else: the size, the colours, which way each
group of furniture runs. Two coders live in two different workshops. The
thing for the work takes the place of something the room can do without (a
sideboard, a shelf of plants), and a crowded wall drops anything else before
it. A home nobody has changed is redrawn this way the next time it is asked
for, under the same rule as any redraw (see
[A room the agent can change](#a-room-the-agent-can-change)); a home anyone
has changed keeps what it has. An agent with no role gets the room its name
draws, as before.

**What a body wears** is a few simple shapes fixed to its bones: a headset
with a microphone, glasses, a beret, a cap, a wizard hat, an adventurer hat,
a scarf, a bow tie, a lanyard with a badge, a satchel, a tool belt. Each is
sized from the body itself, measured once as the model loads: the head from
the skin its head bone moves, the face at the eyes, the neck, the chest and
the hips. So a robot with a big head gets a big hat, and glasses sit on the
face wherever its eyes are. Things on the head go with the head, a scarf or
a bow tie with the chest, a belt and the satchel's bag with the hips, so
they follow the body walking, sitting, asleep or holding something up. They
come in the agent's own colour, deeper than the body so they stand out
against it, with pale stripes and trims. One thing goes on each part of the
body (one hat, one thing at the neck), at most four at once. Photos and
selfies show them too, in the body's own colours. The shapes and colours are
made once and shared by every body, so a room full of dressed agents costs
little more than one.

An agent wears what suits its role until it, or you, chooses otherwise. The
agent chooses with the `body` tool's `change` action and `wear`:
`"glasses, scarf"`, `"none"`, or `"default"` for what suits its role again.
The `place` tool's `room` action takes the same `wear`, for an agent given
`place` but not `body`, and `look` says what it wears. **On its card** (see
[What it is doing](#what-it-is-doing)), **change** under **Wears** opens a
row of chips, each putting a thing on or taking it off, in place of whatever
was in its place, and **back to what suits** goes back to the role's. Either way the choice is the
`wear` of the agent's `body` record (see
[An agent in charge of its body](#an-agent-in-charge-of-its-body)), kept apart
from the home so that choosing a hat never counts as changing the room. No
`wear` there means what suits its role. The page redraws the body the moment
the record changes, whoever changed it.

What a body wears used to be a `wear` record of its own. One left from
before is still read until the body record says what the agent wears, and
is taken away the first time the agent, or you, chooses again, so an old
choice can never come back. Nothing writes one now.

**The map and the card say the role in a word**, beside the agent's name and
its colour: "trip-planner · travel agent". Where the name says it already
(`coder`, `podcast-producer`), the word is left out and the colour stays.
Typing a role in the map's search finds every agent of it.

### An agent in charge of its body

An agent with the `body` tool chooses how its body looks and carries itself,
makes a gesture when it wants to, and goes where it likes. Name `body` in
the `tools:` list of an agent that has one, as for any tool; an agent that
never uses it looks and moves exactly as it did.

```
body action="look"
body action="change" color="teal" wear="cap, scarf" size=1.2
body action="change" idle="sleepy" posture="slouched" walk="stroll" errands="naps, reading"
body action="emote" emote="dance" for="30s"
body action="go" to="sit on the couch" for="20 min"
```

- **`look`** says where it is, what it looks like, what it wears and how it
  carries itself, whether it is staying somewhere, every choice it has, and
  the spots in the place it is in.
- **`change`** sets any of: `color`, a colour name (`"teal"`, `"dark red"`)
  or `#rrggbb`; `model`, one of the deployment's models by name; `size`, 0.6
  to 1.4 of its model as made; `wear`; `idle`, `posture` and `walk`; and
  `errands`, what it likes doing when idle. `"default"` takes any of them
  back to how it always was. Every part is checked first, so a change with
  one wrong part changes nothing, and says what was wrong.
- **`emote`** makes a gesture now, once, or for a while with `for` (`"20s"`,
  at most five minutes). With `at`, it turns to someone or something in the
  room first; without, to you on the agent's own view, or to whoever is next
  to it. It turns back to what it was doing after. A gesture kept going
  lasts as long as it was asked to: the wave a body gives someone walking
  up, or the stretch it makes on getting somewhere, waits until it is over.
- **`go`** walks to a spot in the place it is in, said in words: `"the
  couch"`, `"by the window"`, `"sit on the couch"`, `"by the plant"` (a thing
  with no spot of its own: it stands by it). It stays there until it chooses
  otherwise (`to="anywhere"`), or for as long as `for` says (`"30 min"`,
  `"an hour"`). Words that name no spot here are a place, as for the
  `place` tool's `go`: home, a shared place, or the meeting room of a room it
  talks in, said plainly or as `"go to the lounge"`; with `for`, it comes
  home when the time runs out.

| choice | what it does |
|---|---|
| `idle: calm` | fidgets less, stays longer at each thing, drawn to the window, the fire, a book and a seat |
| `idle: lively` | sways more, moves on sooner, stretches, makes coffee, waters the plants, chin up |
| `idle: focused` | keeps still and long at the desk, the task board and a book, head a little forward |
| `idle: sleepy` | its head droops, it naps wherever it can sit, its idle plays slower |
| `posture` | `upright`, `slouched`, `proud` (chin up, chest out), `shy` (head down, arms in), `arms folded` (while its arms have nothing else to do) |
| `walk` | `brisk` (a third faster, leaning in), `stroll` (slower, easy), `bouncy` (a bob in each step), `sneak` (slow, crouched), `march` (high knees, arms swinging), `swagger` (a sway in the shoulders) |
| `errands` | up to six of: coffee, reading, the window, plants, the task board, the fire, TV, painting, tidying, naps, stretching, the fish, pictures, sitting. Each comes up three times as often as it would |

The gestures are wave, nod, shake, cheer, clap, dance, bow, shrug, think,
point, salute, stretch, jump and laugh. With animation files, a gesture plays
the library's own clip when it has one by the usual name (`Dance_Loop` is
the dance; a nod, a head shake, a wave, a clap, a cheer, a bow, a salute or
a laugh are found the same way), and the code's own move otherwise, which
takes the arms over from whatever the files were doing. Gestures are written
for a model made in a T-pose; on one made in an A-pose, with its arms hanging
part way down, an arm a gesture takes over is turned as the T-pose's would
be, so a wave is up, a stretch overhead and a clap's hands meet in front. A walk of
another kind plays the library's when there is one: a crouched walk
(`Crouch_Fwd_Loop`) for a sneak, a formal one (`Walk_Formal_Loop`) for a
march; arms folded plays its folded-arms idle.

**What comes first.** A spot it chose holds only when nothing else has the
body: a conversation face to face with someone in the room comes first, then
its work (a turn sends it to its desk, a book to a seat), then you talking to
it on the page, and only then the spot. Work done, it walks back. A spot
holds in the place it was chosen in; gone somewhere else, the agent is
about its own business there. A stay with a time ends when the time runs
out, and the plugin lets the spot go, so the agent's own `look` and its card
never say it is staying somewhere it has left.

**Staying somewhere** isn't standing still. At its spot, a body does what
the spot offers, one thing after another: a coffee on the couch, then a
book; a look out of the window. Each lasts as long as it would on an errand,
longer or shorter as its idle style has it, and something else follows. A
one-off like a stretch isn't made over and over; with nothing else to do
there, it stands, and its tag says where it is staying ("staying in the
middle of the room").

**Two bodies, one spot.** A body about its own routine makes room for one
that chose the spot it stands at. One that chose the same spot, works there,
or is talking keeps it, and the other waits nearby until it is free, so a
visitor that chose "the desk" never pulls the owner off it mid-turn.

**The models to choose from** are every model the config names (the
deployment's, and each agent's own) and every `.vrm` file in
`<TAI_HOME>/avatars/`, by file name. Drop another model in that folder and
agents can be drawn in it. A model that is gone since an agent chose it
draws the agent in its own again.

**On its card**, a **Body** row says how it looks and carries itself in a
few words ("teal, 1.2× · lively, proud, brisk"); **change** opens the same
choices: colours to pick at a touch and any other from a picker, its model
when there is more than one, a size slider, its idle style, posture and
walk, what it likes doing, a gesture to make now, and, while it is staying
somewhere, where, with **let it roam**. Each choice shows on its body the
moment it is made, wherever it is drawn: on its own view, on your visit, in
anyone's company. A colour from the picker is saved once, when you close
it. A change that can't be saved shows on the card as it was before, with
the reason.

Everything chosen is one `body` world-state record per agent
(`/api/state/body/<agent>`), in the agent's own scope, kept like any record,
so a restart keeps it, and every change has an author and a history. A part
nothing chose is as it always was, and nothing chosen is no record. A
gesture is an `emote` record (`/api/state/emote/<agent>`: `{name, at,
until?, target?}`), kept in memory: it lasts seconds, and a restart forgets
it. A page that opens after a gesture has run its course doesn't make it
again.

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
| `add` | a new thing: `kind`, and optionally `name`, `color`, `scale` (0.5 to 2), or `size` for a shape. A model an agent made, or a ready-made one, by its name (see [Things agents make](#things-agents-make)) |
| `move` | a thing to somewhere new, or turned where it stands with only `facing` |
| `change` | a thing's `name`, `color`, `scale` or `size` |
| `remove` | a thing, and whatever stands on it |
| `room` | the room's `width` (up to 16 m), `depth` (up to 12 m) and `height` (up to 4 m), `walls` colour, `floor` (wood, carpet, tile, concrete, or a colour), `name`, `theme` and `purpose` (see [A theme and a purpose](#a-theme-and-a-purpose)), and `area` (see [The town, and its doors](#the-town-and-its-doors)); and `wear`, what the agent's body wears, wherever it is (see [What an agent is for](#what-an-agent-is-for-its-home-and-what-it-wears)) |
| `undo` | the last change, whoever made it, unless it was the system redrawing the room. In a meeting room, undoing the first change brings back the room as it was drawn |

Where things go is said in words: `near` a thing or spot, on one `side` of it
(left, right, front or behind, as you face it), against a `wall`, in a
`corner`, or `on` a desk, table or shelf. The tool finds the nearest place
that fits. Things never overlap, nothing is put where the avatar needs to
stand, a tall bookcase won't go in front of a window, and only the back and
left walls are walls: the front and right are open to the camera. Seats put
near a TV or a fire turn to face it. When nothing fits, the tool says why, and
the agent can move or remove something and try again. Exact `x` and `z`, in
metres from the middle, work too. Every room keeps a spot for a door, and the
floor in front of it is kept clear, as far in as you come through it: nothing
new goes there or hangs over it. `look` says where the door is, and whether
the place is in town or on a plot of its own at the edge of it. "Near the door" puts
something beside it, back to its wall where there's room, never in the way in.

What can be added: seats (couch, armchair, beanbag, bed, chair, stool),
tables (desk, table, round table, coffee table, side table, sideboard), a
bookshelf, TV, fireplace, easel, rugs (square or round), lamps, plants (a
plant, a tall plant, a cactus, a palm), things for the walls (window,
picture, painting, poster, clock, shelf, pegboard, task board, screen,
calendar, a map, and a sign that shows its name), a bench, a globe, a
microphone stand, a server rack, small things for a surface (laptop, books,
vase of flowers, small plant, mug, candle, table lamp, aquarium, ledger,
chessboard), and blocks, balls and cylinders of any size and colour.
Seats, desks, the bookshelf, the TV, the fireplace, the easel, windows, a
globe and a server rack each bring a spot: add an armchair, and the agent can sit in it, and so can a
click.

#### Shared places

A room can be shared. An agent makes one with `new` and a name ("the
lounge"), which starts furnished like a home (any kind but the bedsit), and
it goes there. With `area` too, the new place is in that area from the start. Other agents join with `go` and `to: "the lounge"`, and anyone
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

The photo is the room as the page draws it, lit for the time of day the way
anyone walking in sees it: a meeting room bright after dark, a home cosy.
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

The **Map** button on the stage (or `M`) draws the town from above, beside a
list for finding someone (see [The town, and its doors](#the-town-and-its-doors)
for the drawing). The list leads with people and rooms: who is busy, then
every agent, the meeting rooms, the shared places and any plots. The town and
the town hall come after them, and the office's floors last, folded away
under **Office floors** until you open them. Agents are listed by name, as many to a row as fit, so with forty of
them the meeting rooms are still near the top. Each has a dot in the colour of
what it is doing: green working, blue thinking or talking, orange waiting on
you, red stuck, violet asleep, grey idle. They are the colours a door's light
and the sign over a head use, and every dot on the map means the same. A busy
agent has the word for it beside its name too ("working", "waiting on you"),
and every agent what it is for, by a small dot in its body's colour
("trip-planner · travel agent").
Click an agent to go into its home; when its body is somewhere else, "in
#trip" beside its name goes there instead. Rooms and places show who is in
each, with a mark for anyone waiting on you (`!`), stuck (`?`) or asleep (`z`).
The map asks the server again each time it opens, so an agent or a room made
since you last looked is on it.

Typing filters the list as you go: agents by name or role, rooms by name or what they
are for, places and plots by name (a plot by what is on it too), and the
office's floors, which open up while you search and fold back as they were when you clear it. `Enter` goes to the first thing left, which
is marked `↵`; `Esc` closes the map. So `M`, a few letters of a name, `Enter`
takes you to anyone. You can also walk from place to place, out of one door
and into another (see [The town, and its doors](#the-town-and-its-doors)).

**Where you are** shows under the stage's buttons, from the town down: "Town
› Maple Lane › analyst's home", or "Town › The Avenue › Office › #standup".
Each step is a click: "Town" goes to the square, a street takes you out of
the door on to it (out of analyst's home on to Maple Lane, out of the office
on to the avenue), and a floor of the office to that floor.

**Busy now**, at the top, lists every agent that is doing something, most
pressing first: waiting on you, then stuck, then talking, working and
thinking. Each line says what it is doing and where its body is ("writing
code · in the commons", "has a question for you · in #trip"); click it to go
straight there. Two agents messaging each other are talking for as long as
the conversation lasts, in the words of how they talk: "on the phone with
writer · at home", or "talking with reviewer · in the lounge" for two in the
same place (see [Near and far](#near-and-far)). When nobody is
busy it says so, which tells you a
quiet world is idle rather than broken. It steps aside while you search.
Among the rooms and places, those where something is happening come first,
with a coloured edge and a word for the most pressing thing there and how
many are doing it, then how many others are busy ("waiting on you · 2 more
busy", "2 working").

You arrive in your own body ("you"), in a colour of its own. **Walk** with
WASD or the arrow keys, which move you the way the camera faces, at a brisk
2.75 metres a second (1.6 times that outdoors, where the streets are long);
hold **Shift** to run at twice that. Click the floor to
walk there round the furniture, at the same walking pace. Drag to look round.
The camera moves with you every frame, so it keeps up however fast you go.

**Zoom** with the wheel, or a pinch on a touch screen, from close behind you
out to an overview of the whole lobby. It starts wide enough to see
a good part of the room round you, about 4.5 metres either side, and the page
keeps whatever you set for as long as it is open: through doors, by the map,
and back. A small home stops zooming out sooner than the lobby, but the lobby
still opens out as far as you left it. Outdoors the zoom is kept apart: it
starts a street or two round you (11 metres either side), opens out to a good
part of the town (36), and stays how you left it each time you come out. The zoom is measured in the part of
the stage you can see: with the chat or a panel open over the right of it,
or along the bottom on a phone, the camera backs off so you see as much round
you as with it closed, and you stay in the middle of what is left. A panel opening or closing slides the
picture over rather than jumping.

**Fly** puts your body away and lets the camera go
anywhere, faster again (6 metres a second, twice that with Shift): WASD to
move, `E` up, `Q` down, drag to turn, and the wheel moves you the way you look.
Agents keep their own calmer pace in
their rooms. Every speed is named in one place,
`packages/ui/src/avatar/travel.ts`, with how far the camera can zoom (`REACH`).
Agents look up as you come near, and wave
if they're free; standing next to one offers **Talk to** it, which switches
the chat to that agent. Click any agent for its menu as usual.
**Voices** (off until you switch it on) speaks what agents say near you: as
a line starts in an agent's bubble within a few metres of you, the page asks
`POST /api/live/say` for it in that agent's voice and plays it, quieter the
further you stand, one line at a time. Two agents talking face to face are
both heard as they speak. Stand by an agent on the phone and you hear its side
plainly, and the other side faintly out of its phone, as a voice sounds down a
telephone line: only the band a phone carries, squeezed flat, quieter than
someone in the room. You hear the far side only near the one holding the
phone. An agent's answer to something you said out loud with **Talk** is not
played a second time: the talk itself already played it. It is off by default
because each line is a text-to-speech render, which may run on your GPU. **Back to** returns to
the agent's own view. While you visit, your body is
yours: the agent's turns still run, but its cues have nothing to move.

#### The town, and its doors

The places are joined up in a **town** you walk round outdoors. In the
middle is **the square**: paving round a fountain, benches and lamps, a
**café** on its south-east side (a coffee cart under a striped awning, and
three tables with a chair either side under umbrellas), and the **town
hall** along its north side, facing you as you arrive. The kiosks
stand in front of it, under the big screen on its front, with the task
board and the calendar beside its door: what the lobby has, out on the
square, and they work the same (see [Task boards and the
lobby](#task-boards-and-the-lobby)). The town hall's door goes into the
lobby, which keeps its own.

The **avenue** runs east and west through the square. Off it run **lanes of
homes**: every agent's home is a house of its own, facing its lane, up to 12
to a lane, a lane north of the avenue and one south of it, west of the
square first, then east, then further out. Lanes are filled in name order
and cut where the first letter changes, so a new agent only changes the lane
its name falls in, unless that lane was full. Each lane's name ("Maple Lane",
"Willow Way") is on a sign at its corner.

A house looks like its owner. Its walls are washed in the agent's colour, the
one its body and its dot on the map show, with its door, shutters and
letterbox in that colour itself; its roof, its storeys and its chimney are
its own. What the agent does stands by it: a satellite dish on a reporter's
roof, an easel by an artist's door, a cabinet of blinking lights beside a
coder's, a garden for a housekeeper, a telescope for a researcher, a signpost
for a travel agent (see [What an agent is
for](#what-an-agent-is-for-its-home-and-what-it-wears)). Its windows say
whether anyone is in and up: lit after dark while the agent is home and
awake, dark once it is asleep or while it is out, and lit by day while it is
at work, so a busy street reads at a glance. Any other building (the office,
those on Main Street, a hut) is lit while someone is in it, by day too, and
dark at night once it is empty; the town hall is lit every evening. The light by its front door shows what the agent is doing, as every
home's door does.

East of the square, on the avenue, is **the office**, where the rooms agents
talk in are. Inside is an atrium: a directory by the way in, which opens
the map with every room listed, and the meeting rooms' doors round its walls and standing along its open right side, up to
14 to a floor. More rooms take more floors, with stairs between them, cut by
first letter as lanes are. A meeting room dressed as a tavern, a studio, a
workshop or a library has **a building of its own on Main Street**, which
runs south from the square past the **shared places**. A beach room is **a
hut on the sand** at the end of Main Street, where the town meets the sea.
Behind the office is a park with a pond, a stream comes down the west side
of town to the sea under a bridge where the avenue crosses it, and woods
are all round. Every bench in town seats two, side by side, on the square
and round the pond.

**Going in and out.** Every building has its door in the middle of its
front. Walk into it, or click it, to go in; click a building anywhere else
and you walk up to its door. Inside, the door you came in by says what
street it opens on ("Maple Lane", "The square"), and going out through it
puts you on that street outside the door, facing away from it.

**Outdoors** you walk faster and see further (see [Getting
around](#getting-around-the-map-walking-and-flying)). The town has a sky:
the sun by day, high in the south behind you as you face the town hall, low
and orange in the evening, and at night the moon, the stars and the street
lamps, the four nearest you lighting the street and the rest glowing. Shadows
fall away from the sun and are drawn round you as you go. The sea and the
stream stop you at the water's edge; you cross the stream at its bridges. A building
between the camera and you fades to a ghost so you can see past it, as a
tall thing in a room does.

**Bodies going by.** You only see the bodies in the place you're in, and the
town is nobody's place. But while you're out in it, an agent whose body goes
from one place to another (into a meeting room to talk, home again after a
quiet spell) walks the streets, its name over its head, from the door it
left by to the door it goes in by, and is gone once it gets there.

A door on the back or left wall of a room is a door in the wall, with a name plate over
it: the agent's name, the room's `#name`, or the street it opens on. A long name
is drawn smaller to fit, and a name too long for that at a size worth reading
goes on two lines, broken at a hyphen, a space or an underscore
(`#quarterly-` / `planning-and-review`), so a name is never cut off. On the open
front and right sides, where the wall is cut away so the camera can see in,
the door is cut away too: a low gate with the plate across it, readable from
either side, that never stands between you and the room. A door to a home has
a light by its dark plate, and a lit strip along it, that says what that agent
is doing, from its `activity` record, in the colours the map uses: green
working, blue thinking or talking, orange waiting on you, red stuck, grey idle,
and dim violet asleep. You can see who needs you from the street, before you
knock.

**Point at a door** and it lights up, an edge of light round the doorway and
its mat, and a label by the pointer says where it goes: "to analyst's home",
"out to Maple Lane", "to #trip". The pointer turns into a hand. It keeps up
as you walk or the view moves under a still pointer: once the door has slid
out from under it, the light and the label go.

**Walk into a door**, or click it, to go through. Up against the wall in
front of a door, keep pressing toward it. The picture fades, the place behind
it loads, and you're standing just inside the matching door, facing into the
room: a little further in through a gate, so its plate doesn't hide you, and
past anything that stands just inside. Your body, and walking or flying, carry
on as they were. A click goes to whatever is nearest under the pointer, so a
chair in front of a door is still a chair. You
stop on the threshold: a key you held through the door waits until you let it
go, since the view faces the same way on the other side and holding `W` would
otherwise walk you straight back out. Going into an
agent's home through its door switches the chat to that agent, the same as
going there on the map. From an agent's own view, clicking a door starts a
visit: you come out of that door on the other side, in your own body.

**Areas.** A home or a shared place can be somewhere else: the `place` tool's
`room` action takes `area` ("the summer house"), and so does `new`. The
places of an area are on **a plot of their own at the edge of town**, fenced,
its name at the gate, at one end of the avenue or the other where a path goes
on to it. Each plot keeps its end of the avenue when another is added, and
holds its places in two rows facing the path through it, growing wider as
they come.
They are a walk away like everywhere else, each with its door out on to the
plot. An agent can build itself a summer house with two rooms this way, or
move its home out to a cabin with the places it made there. `area` "main"
puts a place back on the streets.

Rooms agents talk in always stay in town: in the office, or in a building of
their own when their theme has one. A meeting room is a room of
conversation that several agents share, not anyone's own place to move, so
`area` is refused there.

**The map** draws the town from above, beside its list: the square, the
streets and their names, the stream, the park and the shore, and every
building, each a button that takes you into it. A house is in its owner's
colour, with a dot when its owner is at work or waiting on you; a building
anyone else is in has a dot for them; the one you're in is ringed, and out
in the town a dot marks where you stand. The list puts each plot under
**Plots**, with what is on it.

How it works: the town is worked out on every read from the places there
are, by `places-town.ts` and `places-world.ts` in the places plugin. It is
pure, so the same places always make the same town, and nothing about it is
stored: an agent's own changes to its room stay its own, and a home nobody
has changed is still redrawn as rooms improve. The town is the place `town`,
and the office's floors are `office`, `office:2` and so on, all drawn fresh,
so neither can be rearranged. The server sends the town's plan with it
(`place.town`), and the page builds it for the frame rate: each building is
one mesh in its own colours and one for its windows, so it can still fade on
its own; the roads, the ground, the trees and the lamps are a draw each; and
a building's door is drawn in full only within 24 metres of where the camera
looks, with one painted on its front from further off. Outdoors, you walk on
a coarser grid than in a room, so a walk across town is still found at once.
A room's own door goes wherever it keeps a clear stretch of the back or left
wall, at the end nearest the open side, which is where the rooms the world
starts with keep their doorway. A room whose walls an agent has filled gets
its door as a gate at the open front or right instead. Since the door
depends on what is in the room, the page asks for it again after each
change, and moves it if it moved. The lobby's door out on to the square is
in the middle of its open front.

#### Who you are talking to

Your conversation in the world is headed by who it is with, in their body's
colour, and it stands beside their body, or is a phone in your hand when
they are somewhere else. With the whole chat open, its top says the same:
their name, a dot in their body's colour (the default agent has none), and
what they are doing right now, from their `activity` record, with **Talk to**
beside it to switch to someone else. The conversation follows who you are
with:

- **Going to an agent's home**, on the map or any other way, talks to that
  agent. The conversation you left it in comes back; the first time you go to
  it since opening the page, your latest conversation with it does, or a new
  one starts.
- **Coming back**, with **Back to** or by picking on the map the place the
  agent you came from is in, talks to that agent again, where you left off.
- **The town, the lobby and shared places** keep the conversation you had.
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
long one, and the room grows with them, until a member changes it (below).

Bodies go where the talk is. When an agent says something in a room, its
body leaves where it was and takes a seat at that room's meeting table, so
the bubbles of a conversation show up round the table it is having. Each
thing it says there, and each time the room wakes it while it is there,
keeps it a while longer; other people's messages don't. Being woken alone
moves nobody, so an agent that reads a room and keeps quiet stays where it
was. After a quiet spell (10 minutes) it goes back where it lives: home,
the shared place it was in, or a meeting room it went into to change. While it is away, its home is empty and the map
shows it in the room. Round the table, everyone turns to whoever speaks. A
room nobody is in shows on the map when it last talked, and how many members
it has ("talked 20 min ago · 3 members", or "quiet" when nothing is known).

**A meeting room shows its conversation.** A whiteboard hangs as near its
task board as there is wall, with the room's last four lines on it: who said
each, in the colour their body and their dot are drawn in, and how each
began, its first eight words or so, never the whole message ("planner: Flights
to Lisbon are booked for the 14th…"), and how long ago the room last talked.
Up close it is live, like a task board; from across the room it is a picture
of the same. A card pinned on the meeting room's door, at eye height, says the
same "talked 20 min ago", and so does the label by the pointer when you point
at the door. Nothing asks a model and nothing is posted: the plugin keeps a
`chatter` record per room from what the room hears (below), which only
people can read, as with the `speech` records. A room nothing has been heard
from since the server started reads its last four lines once, the first time
anyone looks at its meeting room. A meeting room its members rearranged keeps
its own walls: add a `whiteboard` with the `place` tool and it shows the same.

The agent you are chatting with is the exception on your own page: it stays
in its own room with you while you talk, even while its body is at a
meeting. The map, **Busy now** and anyone visiting see it at the table, and
if you go to that meeting room you'll find it there too.

A body that turns up while you are there walks in through the room's door
and on to a free seat; one that goes walks out through it, standing up first
if it was seated. Whoever is already there when you arrive is simply about.
The same goes for anyone coming or going anywhere else: an agent back from a
meeting walks in at its own door.

A visit is a `visit` record, one per agent, naming the place and an `until`.
It lives in the built-in `memory` state provider, apart from the
`whereabouts` record that says where the agent lives. So a visit never
changes where it lives, leaves no history behind, and ends on restart. Every
20 seconds the plugin clears visits that have run out, so a page watching
sees the body go. The `place` tool still works on the place the agent lives
in (its home, a shared place, or a meeting room it went into) while its body
is away, and moving with the `place` tool ends the visit. Sending it home
from the menu ends the visit early too; its next message brings it back.
Change the quiet spell, or keep bodies where they are with `0`:

```yaml
plugins:
  - module: builtin:places
    config:
      quietMinutes: 5        # meeting rooms; 0: bodies stay put while their agents talk
```

A meeting room is dressed for what the room is for, read from its name and
purpose: a trip or a vacation gets a beach (sand floor, sky-blue walls, palms
and an umbrella), a campaign a tavern (dark wood, a hearth, barrels, candles
on the table), a podcast a studio (an easel and posters), code a workshop (a
workbench under a pegboard, crates), research a library (shelves of books and
a reading chair). A room whose words match none is plain. Each comes in a
few colourings and wall arrangements, and the room's name picks one, so two
rooms of the same kind still look different. A theme a member chooses beats
the guess.

#### Near and far

When one agent messages another directly (the `room` tool's `dm`), nobody
walks anywhere. How they talk depends on where their bodies are:

- **Near**: both in the same place, the same home, shared place or meeting
  room. They turn to each other, and talk face to face under speech bubbles,
  with the talk sign over their heads. In a big room, if they are more than
  three metres apart, the one who spoke first walks over to stand with the
  other; one sitting about gets up when it comes over, unless it is at a
  meeting table, where everyone keeps their seat and turns in it.
- **Far**: anywhere else. Each holds a phone to its ear while it speaks and
  listens, with a phone over its head where the talk sign would be. The arm
  is fitted to the body, so a robot with a big head and short arms still
  brings the phone up against the side of its own head. Its tag says "on the
  phone with writer" with a small phone before it, and each bubble it says
  down the line has a small phone by the name. Whoever is with one end hears
  the other end too: the far side's words come out of the phone, in a bubble
  over the one holding it, edged in dashes and named for who said them. Only
  what is said down the call comes out of it: what the far side says in a
  room, or to someone else, while the call is on, doesn't.

The two are talking from the moment the message is sent, so a slow answer
keeps them on the line while it comes, and for 40 seconds after the last
exchange, long enough to read what was said. A conversation that goes back
and forth stays on. Where their bodies are is looked at again at each
exchange, so two who end up in the same place (both called to the same
meeting, say) are face to face from then on. A message that doesn't go
through hangs up: one that fails, and one turned back before it is sent, say
because its arguments are the wrong kind (`to` given as a name, not a list)
or a person refuses the approval. A message an agent sends itself is no
talk; one to an agent without a body puts the sender on the phone to it. A
message sent on to a desk room (`rooms.desks`) is said in that room instead,
so the body goes to that room's meeting room, as for anything said in a room.
Talking in a room of conversation still takes the body to its meeting room
(above), where the members there are near each other.

The map's **Busy now**, the tags and an agent's card all say it the same
way: "on the phone with writer" or "talking with writer".

**You count too.** On a visit in your own body, talking to an agent (typing,
or holding **Talk**) works the same way. With its body in the place you are
in, it turns to face you, walking over if you are far apart, and stays with
you rather than going off to its desk to think. What you say shows in a
bubble over your head, and its answer over its own, and your conversation
stands beside it. With its body anywhere else, it holds a phone to its ear
where it is, and so do you: your words show over you with a small phone at
the top, its answer comes out of your phone, and your conversation is the
phone in your hand, marked as a call. In the agent's own view nothing
changes: it faces you there as before.

Each talk is a `talk` record, one per agent, naming who it is `with`, whether
it is on the `phone`, whether it `started` the conversation, and an `until`.
The places plugin writes agents' talks, so every page shows the same thing; a
talk with you is written by the page you talk on, with `with: you`, since only
that page knows where you are, and taken away as you leave the visit or turn
to talk to someone else; a page closed in the middle of a talk leaves it to
run out. Like a visit it lives in the `memory` provider, ends on restart, and
is cleared every 20 seconds once it has run out.

#### Changing a meeting room

A room's members can change its meeting room. An agent goes there with `go`
and the room's name (`to: "trip"`, or `"#trip"`), and from then on its `place`
tool works on the meeting room, as it does in a shared place: `look`, `add`,
`move`, `change`, `remove`, `room`, `undo` and `photo`. `places` lists the
meeting rooms an agent can go to, after the shared places.

The first change keeps the room. It becomes a `place` record,
`room:<backend>:<id>` in the global scope, starting from the room as it was
drawn, and the room is drawn from that record from then on. Nothing redraws
it over someone's change, not even more members joining: they stand where
there is room. Undoing that first change deletes the record, and the room is
drawn from its name again. A meeting room keeps its door and stays in town,
in the office or in a building of its own by its theme, so `area` is refused there.

Only members go in. Anyone else is told whose room it is and who can change
it: "#trip's meeting room is for the members of #trip: guest and host can go
in and change it." An agent that leaves the room is home again. You can
rearrange any meeting room yourself with **Edit room** (see below), and your
first change keeps it in the same way.

#### A theme and a purpose

`room` with `theme` dresses a place: `beach`, `tavern`, `studio`,
`workshop`, `library`, or `none` for plain. A chosen theme stays chosen,
whatever the room's name suggests. A meeting room nobody has changed yet is
drawn again in it, through and through: choose `library` for a room called
"vacation", and it gets shelves of books where it had palms. A room someone
has already furnished keeps everything where it is. It is repainted in one of
the theme's colourings, and gets the one thing that says it (a palm, a
fireplace, an easel, a pegboard or a bookshelf) when it has none and there is
room.

`purpose` says what the place is for, in a line: "planning the Lisbon trip".
`look` reads it out, and the map shows it under the place's name, in place of
a meeting room's own purpose. Until a member gives one, a meeting room's card
and `look` read out its room's own purpose, as the map does. `purpose: none`
clears it. The room's `name` is
what it is called inside; the map and the door plates keep a home as
"planner's room" and a meeting room by its room's name.

#### Rooms that follow the work

Nothing makes an agent look at its room unless something asks it to. The
places plugin can, now and then, for the agents you name:

```yaml
plugins:
  - module: builtin:places
    config:
      tend:
        every: 24h                  # 30 minutes, 12h, 2 days; at least a minute
        agents: [planner, writer]   # or: all
```

Each agent's turn comes round once every `every`, at a time of its own: its
name sets where in the interval it falls, so forty agents on `24h` are spread
across the day instead of woken together, and a restart moves nobody's time.
When the turn comes, the agent gets one message in its own `tend:<agent>`
session:

- what it did in the last interval, counted from what TAI keeps anyway: the
  tools it called in its sessions, most used first; the tasks assigned to it
  that it finished; the rooms it talked in; the photos it took;
- its room, as `look` describes it, and the meeting rooms it can change too;
- an invitation to change the room with the `place` tool if something it has
  been doing should show there, or to leave it as it is.

```
Time to look at your room in the light of what you've been doing. People see it in the 3D world.

In the last day, you:
- called tools 41 times: web_search 14, edit 9, exec 6, tasks 5, place 3, read 2, and 2 other calls
- finished 2 tasks: "Draft the itinerary", "Book the hotel"
- talked in #trip-planning and #budget

Your room, as the place tool's look shows it:
…
```

A reply in that session reaches nobody, and the message says so: what the
agent changes in the room is what people see. An agent that did nothing in
the interval isn't woken, since there is nothing new for its room to show.
One tend runs at a time, even across a config reload, so never two for one
agent. A turn that comes round
while agents are paused, or while an agent's own switch on the Agents page has
it switched off or paused, is skipped, not saved up, so lifting a pause wakes
nobody at once. An agent without the `place` tool is skipped too, and the log
says so. Leave `tend` out and nothing changes.

You can also ask an agent yourself, whenever you like: see below.

#### Seeing a change happen

When an agent changes the place you are looking at, you see it happen.
Something new, or made over in another colour or size, grows in; something
moved glides there from where it stood; and a line over the agent's head
says what it did: "Added the reading chair by the bookshelf."

The **Room** button, beside **Map** and **Tasks** in a home, a shared place,
a meeting room or the lobby, opens the place's card: what it is for, its theme, who can
change it, and its recent changes, newest first, each with who made it and
when. A place keeps its last 8 changes made with the `place` tool or with
**Edit room**, in its record's `changes`, each cut short past 160
characters; the **State** page
has the full history, including
changes made there. In a home whose owner has the `place` tool, the card has
**Ask planner to make it fit its work**, which opens a chat with the agent
with "Have a look at your room and make it reflect what you've been working
on." written for you to send. **Redo its room** on the agent's own card does
the same. In a meeting room, it takes you out of reading the room's own
conversation and into a chat with that agent. An agent whose `tools:` list
leaves out `place` can't change a room, and the card says so instead of
offering, with a link to the agent's page, where you can add the tool.

#### Rearranging a room yourself

You can move the furniture too. **Edit room**, beside **Room** over the
scene, works in a home, a shared place, a meeting room and the lobby; the
town and the office's floors are laid out from what there is, so they have none. The camera steps back to
take in the whole room, the walking keys rest, and the buttons over the
scene become **Done**, **Undo**, **Redo** and **Add things**. Drag the
floor to look round, drag with the right button to slide the view, and use
the wheel or a pinch to come nearer. Escape or **Done** takes you back to
where you were.

- **Pick a thing** by clicking or tapping it. A box goes round it and a bar
  over the foot of the scene names it, with buttons to turn it, copy it,
  remove it and repaint it.
- **Drag it** across the floor. It snaps to a 10 cm grid; hold Shift to
  place it freely. What hangs on a wall slides along it, and over to the
  other wall, and a small thing like a laptop or a mug goes from one top to
  another. Where it fits, it shows green; where it doesn't, red, and the bar
  says why: "It would bump into the floor lamp.", "It would block the way
  through the door.", "It would be where someone stands to use the couch."
  Let go somewhere red and it goes back.
- **Turn it** with R, or Shift+R the other way, a quarter turn at a time;
  the buttons turn it by a quarter or by 15°. A turn with no room shows red,
  for you to drag it somewhere it fits.
- **Remove** it with Delete or Backspace, or **Copy** it: the copy goes
  beside it, in the same colour and size. The lobby's kiosks and its task
  board stay, wherever you move them: they're where you make agents, tasks
  and rooms and see the tasks from inside the world, and nothing in the
  catalogue stands in for one.
- **Repaint** it from the swatches: the room's own colours first (its walls,
  its floor, what is in it), then a few that go with most rooms.
- **Add things** opens the catalogue docked at the right of the stage, with
  the room framed beside it (on a phone, a sheet over the lower half):
  everything an
  agent can place, grouped as seating, tables, storage, lights, plants,
  decor, things for the walls, and boards and screens, but a kiosk, which
  only does something as one of the lobby's. Pick one and it goes somewhere
  free near the middle, picked, ready to drag where you want it. A task
  board you add shows the tasks and opens them, like the ones rooms come
  with. Above them all, **Made by agents** lists the models agents have made,
  newest first, by name and whose each is (see
  [Things agents make](#things-agents-make)): first those of the agent whose
  home it is and of any agent whose model is in the room already, and
  everyone else's behind **More by other agents**. One you add is the
  agent's, faces and all, and keeps its parts' own colours, so the swatches
  rest while it is picked.

Whether a thing fits is the server's to say, by the checks the agents'
`place` tool uses for its own changes: inside the room, clear of the rest,
not hiding a window, not standing where someone stands to use something, and
nothing in a doorway or on the floor in front of it (in the lobby, any of its
doorways). So a room you arrange is one the tool would have made. While you
drag, the colour comes once the server answers, which on a slow connection
is a moment after the thing moves.

Each change is saved as you make it, to the place's record through the
world-state API, as yours. It goes at the top of the room's recent changes
under the name agents know you by in rooms (`rooms.ownerLabel`, "owner" if
unset): the **Room** card shows it as "You moved the couch", and the agent
whose room it is reads "owner moved the couch" the next time it looks. Moving
the same thing again within a couple of minutes counts as one change. A home
you changed is never given a newer room by the redraw of untouched homes, and
an agent's `undo` won't take back what you did: that's yours to undo. A
change you took back with **Undo** counts for nothing: the home still gets
newer rooms, and the agent can still undo its own change from before yours. A
meeting room or the lobby is drawn fresh until it is first changed, by a
member or by you; your first change keeps it as a record the same way a
member's does, and the lobby's is `place/lobby` in the global scope. A
meeting room's purpose stays its room's until someone gives it one.

**Undo** and **Redo** (Ctrl+Z, Ctrl+Shift+Z) take back and make again the
changes you made in this place, as long as you stay; undoing the first
change of a meeting room or the lobby lets it be drawn fresh again. If an
agent changed the room while you were at it, nothing is written over its
change, by a change, an undo or a redo: you're told who changed it, the room
comes back as it is now, and what you were about to undo is let go. A change
you make after an agent's starts your undo afresh, so it never reaches back
past theirs. No model is called while you rearrange.

#### Panels in the world

What you open in the world opens in the world, next to what it is about,
rather than in the chat's column. Each is a card laid over the stage, kept
beside its thing as the camera and the thing move, with a small tail
pointing at it:

- **An agent's card**, and **what it waits on you for** (its question, or
  the tool call it wants your OK on), float by its shoulder, edged in its
  colour, and follow it if it walks off. Approve or deny right there, by the
  agent that asked.
- **A task's card**, the **task list** and the **new-task form** are pinned
  to the wall beside the board they came from, a pin through the top. The
  new-task form opens beside the lobby's kiosk; the dashboard and a
  calendar's full list beside their screen and calendar.
- **The room's card** hangs on its plaque. A home, shared place or meeting
  room with a door in its back or left wall has a small brass-edged plaque
  on the wall beside it, clear of anything else on that wall, with "About
  this room" under what the trail over the stage calls the place ("planner's
  home", "#budget"), or a name its agent gave it: click it, or the **Room**
  button, and the card opens there. Where the only door is at the open front
  (the town hall's, onto the square), there is no plaque, and the card is
  held in front of you.
- **The map** and the **Needs you** list are held in front of you, like a
  tablet, a clip at the top. They sit in the middle of what can be seen,
  low down, clear of faces and of the buttons over the stage where they can
  be; the keys hint along the foot steps aside while one is held.
- **The catalogue** you rearrange a room from is docked at the right, out of
  the room's way.

A card goes on whichever side of its thing has room, and the camera stays
where it is. It moves only where there is no room beside: while you read a
board up close, the board slides left so its card fits on the right; while
you rearrange, the room is framed beside the catalogue; and on a stage
narrower than 1000 pixels, the scene slides left to leave room on the right.
A card never covers the face of the agent it is about, its name or what it
is saying, nor the thing it is pinned to, the buttons over the stage, the
keys hint along its foot, or your own head: where the first place it tries
would, it slides along that side of its thing until it is clear. It keeps
off everyone else's faces and names where it can, two panels never
overlap, and none is wider than what can be seen beside the whole chat when
that is open. A card whose thing is off the screen is held in front of you
instead. An agent's card keeps to what the agent is doing, has said and
when it runs, with **change** under **Wears** opening the chips for what it
wears. **Escape** or **×** closes a card, and so does walking away: about
the width of a room further than you stood when it opened. An agent walking
off with its card open doesn't count, even as you take a step, and nor does
following it: the card goes with it. Going through a door closes anything
opened beside something in the place you left; the **Needs you** list,
which you hold, comes along. The menu that opens where you click a body,
and the label by the pointer over a door or the plaque, show over the
panels.

The cards are ordinary page elements, so Tab, focus and screen readers work
in them as anywhere on the page, and keys pressed in one are its own: typing
never walks your body, and Space presses the button you are on instead of
starting to talk. Your conversation isn't a card: after a click on one of
its buttons, the walking keys still walk you and Space still talks, as in
the chat's own bar, and Send becoming **Stop** is a new button, so a Space
meant for talking never stops the reply you just sent. On a phone, or a stage narrower than 600 pixels, there is
no room beside anything: what opens is a sheet along the bottom, one at a
time, and the camera frames the room above it.

#### Your conversation in the world

Talking to an agent shows beside it, as a dialogue: the last four things you
said to each other, its words in white bubbles as over its head and yours in
your own colour, a long one cut to its first few lines. A reply comes in as
it is written, with a caret where the next words go; while the agent is
still thinking, or using a tool, a line under it says so in the words its
sign uses ("Calling web_search…"), and its body shows the same over its
head. Tool calls waiting on your OK show here too, to approve or reject. The
box to type in is underneath, with **+** to attach a file, **Talk** to hold
and speak (Space still works when you aren't typing) and **Send** or
**Stop**, and files dropped on it are attached: everything the chat's bar
does. **Whole chat** opens the full conversation in the column. A screen
reader reads a reply out once, when it has all come in, rather than again
with every few words, and reads what the agent is doing when that changes,
not each second it has been at it.

Talking to an agent whose body isn't where you are is a call: the same
conversation, in a phone in your hand, headed "On the phone with planner",
its words edged in dashes as a call's are over a head (see [Near and
far](#near-and-far)). With nobody to stand beside in the agent's own view,
it docks at the side. While a card has most of the room, the conversation
shows only your last exchange and keeps out of the card's way, docked at the
side if it has to be; it steps aside altogether while the agent's own card
is open, while you hold the map, while you rearrange the room, and while the
whole chat is open. A meeting room's own conversation is read in the whole
chat, which opens for it as you arrive; pick someone to talk to and it goes
again, unless you opened it yourself. Until the world is on screen, the
chat's own bar at the foot is the box to type in; and where the world can't
be shown at all (no WebGL, or the avatar won't load), the whole chat stays
open.

##### How panels in the world work, for work on the world

The page hands the stage each panel's element and what it is beside, and the
stage places it every frame (`stage.anchorPanel(el, anchor, opts)`, which
returns a function that lets it go):

```ts
const off = stage.anchorPanel(el, { thing: "board-2" }, { rank: 2, onAway: close });
// or { agent: "planner" }, { plaque: true }, { you: true }, { held: "front" | "dock" }
```

What it is beside is worked out on the stage each frame: a body's box from
its crown to its feet, and its head with what floats over it as the part
never to cover; a thing's box from what was built. Where each panel goes is
pure and tested (`avatar/anchors.ts`): `layoutPanels` tries each side of its
thing, slid along that side past whatever must stay clear, and the screen's
edges, scores what each would cover (a face, the controls, the keys hint,
your head, another panel, the edge of the stage), and places the higher
ranked first so the rest keep out of their way; `follow` eases a panel to
its new place so a breathing body never shakes it; `walkedAway` says when
you have left; `stripTaken` says when the strip kept for panels is taken
from the scene's framing; `anchorFor` and `talkAnchor` say which panel goes
beside what, and `plaqueSpot` where the plaque hangs, clear of things on
its wall by their width. The stage writes each panel's place as a
transform, the side it went to as `data-side`, where its tail meets its
edge as `--tail`, and how much of the stage can be seen as `--room-h` and
`--view-w`, so a panel's look is all CSS. The Avatar component draws the
page's panels (`panels`, each with an `anchor`, a `node`, a `look`, a rank
and the `color` of the agent it is about), offers `panelRoom` pixels on the
right for them, tells the stage what its plaque says (`plaque`), and tells
the page when the stage is on screen (`onShown`) and when its panels are
sheets (`onSheets`, by the stage's own width).

#### Surfaces: using what hangs on the walls

The task boards, screens, calendars and kiosk faces in a room are real web
pages laid on the wall, not pictures of one. Up close their words are as
sharp as the rest of the page, their buttons press, their lists scroll, and
a body or a chair standing in front of one hides the part behind it.

**Click a board, a screen or a calendar**, or face one and press **F**, and
the camera flies to it and holds it head-on, as large as fits between the
tools at the top of the stage and the chat's bar at the foot. Now you use it
like a screen: click what is on it, scroll it, Tab through its buttons. The
walking keys rest while you read, and keys go to what you are reading: Space
presses the button you are on rather than starting to talk. The
Walk and Fly switch and the trail step aside, and **← Step back** takes their
place. **Escape**, **F** again, **← Step back** or a click anywhere off it
puts it down and flies you back to where you were. Escape closes a panel
open beside it first (a task's card, say), and puts the surface down the
next time. A kiosk's button is the one thing you press without bringing it
up first, and F never brings one up; while you read something else, the
kiosks don't take clicks, so a click off what you read only steps back.
With the pointer over something you can bring up, its edge lights and a
label by the pointer says so ("Use the task board · click or F"). Reading
something high on a wall, the wall goes on up past the top of the stage
rather than leaving the dark over the room showing above it.

A surface is live only while it is big enough on the stage to read: about
44 pixels tall, and up to eight at once, the biggest first. Further off,
turned away, or on a wall faded to show someone behind it, it shows a
picture drawn of it instead, which costs nothing to keep. Seen from across a
room, a live one shows less, and larger: a board shows how many tasks each
column has, in figures you can read from the door, with a bar of the
column's colour for each note; a calendar shows the next wake, its time big,
with whose it is and what for. Come close and everything is there. In a
photo nothing is live: screens are dark and calendars show only the date.

On a phone, reading a surface fills the part of the stage above the chat,
and the tools over the stage step aside until you step back. Swipe up and
down to scroll a long column; swipe a screen sideways, or tap the arrows by
its dots, to turn its page.

##### How surfaces work, for work on the world

Surfaces live in a layer under the 3D picture (`avatar/surface-layer.ts`).
The browser places each one's HTML where its plane is, every frame, with a
3D transform (three.js's `CSS3DRenderer`), and the picture is drawn with a
clear hole where each live surface is, so the HTML shows through and anything
nearer the camera still draws over it. The pointer goes to the picture until
it is over a surface in use (a kiosk, or the one being read), and then to the
HTML. The faces themselves are React components (`avatar/Faces.tsx`), drawn
into each surface through a portal, so they use the page's components, hooks
and styles and read the page's data. What can be worked out without a page
(how tall a surface shows, which are live, where the camera stands to read
one, which one you face, which bodies are in the way, where a pointer is on
one, which column a note is dropped in) is in `avatar/surfaces.ts` and
`avatar/boards.ts`, with tests.

To put a surface of your own in the room, give the stage one:

```ts
const remove = stage.addSurface({
  id: "notes:fridge", // the same id is the same surface: a room rebuilt round it keeps it as it was
  anchor: { at: [1.2, -3.4], elevation: 1.3, facing: 0 }, // or a THREE.Object3D: its x-y face, centred, facing +z
  size: [0.8, 0.5], // metres
  label: "the fridge notes", // what a screen reader calls it, and the label by the pointer
  render: () => <FridgeNotes />, // drawn through a portal, inside the page's providers
  use: "focus", // brought up to read before it is used; "direct" works there and then
  live: "near", // live while near enough to read; "always" keeps it live anywhere
});
```

Lay a face out at 640 CSS pixels a metre (`SURFACE_PX`): a 0.8 by 0.5 metre
surface is a 512 by 320 pixel page, and a surface made bigger shows the same
page larger. To lay a small one out denser, anchor it to an object scaled down
and give it the size in that object's units, as a model's faces do
(`faceDensity` in `avatar/models.ts`). In place of `render`, a surface can take
`component`, an agent interface's spec, and the page draws it with the chat's
own interface renderer: that is all a model's face is. `stage.onSurfaces(views => ...)` hears which surfaces are live
(the page draws into each `view.el`), `stage.focusSurface(id)` brings one up
and `focusSurface(null)` puts it down, and `stage.surfacePoint(id, event)`
says where a pointer is on one, in its own pixels, for dragging. A surface
you add belongs to the place on the stage when you add it, and going to
another place takes it down. The function `addSurface` returns takes down
only the surface that call laid: once the same id is laid again, an older
remover does nothing. The room's furniture is built afresh each time the
room changes (an agent moving a lamp, say), so a surface anchored to
something in it goes with the old furniture; lay it again on the new one. An
anchor at a place in the room (`{ at, elevation, facing }`) stays until you
take it down or leave. Inside a face, `inert` holds until the surface is in
use, so a click on it brings it up rather than pressing a button; while one
surface is read, every other is inert, kiosks included.

Two things bit while this was built. Chrome loses track of what is under the
pointer in an element that is both turned in 3D and clipped, so a surface's
own element is never `overflow: hidden` (the face inside it is). And laid out
in metres, everything sits so near the browser's eye that its sums for what
is under the pointer come apart, so the layer's copy of the room is scaled up
to pixels, camera and all.

#### Things agents make

An agent can make things for the world out of simple parts, and give a part a
face you use in the room: a to-do list you tick, a card with a button, a
table. Turn it on in the places plugin:

```yaml
plugins:
  - module: builtin:places
    config:
      build: true
```

That offers agents the `build` tool. Leave it off and no agent pays for its
schema; the ready-made models below still work through `place`. An agent with
its own `tools:` list needs `build` named in it, like any tool.

| action | does |
|---|---|
| `list` | your models, and the ready-made ones |
| `show` | one model, part by part, numbered |
| `make` | a model from `parts`, with a `name`, a `mount` and an `about` line; a model that exists is made again whole |
| `add` | more `parts` to one |
| `remove` | parts by number: `part: [3, 4]` |
| `copy` | a model, yours or a ready-made one, `as` a new name |
| `delete` | a model |

A part is a `shape` (box, cylinder, sphere, cone, torus, capsule or plane), a
`size` (width, height and depth in metres: the box it fills), where its middle
is (`at`: x to its right, y up, z toward its front), an optional `turn` in
degrees about x, y and z, a `color` (a name like "sage" or "dark blue", or
#rrggbb) and a `finish` (matte, glossy, metal, glass or glowing). `mount` says
where the model goes: `floor`, `wall`, or `on` a desk, table or shelf.

```
build(action: "make", name: "plant_stand", mount: "floor", parts: [
  { shape: "cylinder", size: [0.4, 0.04, 0.4], at: [0, 0.62, 0], color: "walnut" },
  { shape: "cylinder", size: [0.05, 0.6, 0.05], at: [0, 0.3, 0], color: "gold", finish: "metal" },
  { shape: "sphere", size: [0.4, 0.35, 0.4], at: [0, 0.82, 0], color: "sage" } ])
```

The tool checks everything and says what is wrong in a sentence naming the
part ("Part 2: each side is 0.01 to 3 m."). A model has at most 40 parts and 4
faces; each side of a part is 1 cm to 3 m; and a whole model is at most
4 × 3.5 × 4 m on the floor, 3 × 2.4 × 0.6 m on a wall, and 1.2 × 1 × 1.2 m on
a desk. It is moved to stand where a room expects it, foot on the floor and
middle at its origin (back against the wall, for one that hangs), and the tool
says how big it came out.

Then `place` adds it like anything else: `place(action: "add", kind:
"plant_stand", near: "the window")`. The room lays it out by the box it fills,
so it never overlaps the rest, blocks a door or goes through a wall. `scale`
makes it bigger or smaller; its colours are its parts', changed with `build`,
not `place`. Made again, it shows as it is now wherever it stands, fitted to
the box it was placed in with its shape kept (one on a wall by its width and
height, so made deeper it stands out further rather than shrinking). Where it
goes stays what it was made for: to have it somewhere else, make one under
another name. Deleted, it leaves an empty frame
until someone takes it away. The page draws each model cheaply: every part of
one colour and finish is one mesh in one shared material, so a bookcase of
thirty parts is a handful of draw calls.

**Faces.** A box or a plate can carry a `face`, laid on its front: an
[agent interface](./agent-interfaces.md) bound to world state. A `list` shows
the records a query matches, with ticks; a `card` shows one record, with
buttons, and its binding can name which of the record's fields it shows
(`fields`) and one to show as its text (`body`); a `table` shows records as
rows.

```
{ shape: "box", size: [0.9, 0.6, 0.02], at: [0, 1.4, 0.05], color: "ivory",
  face: { kind: "list", title: "Chores", bind: { type: "chore", where: { room: "kitchen" } },
          check: { field: "done" } } }
```

When the model is saved, each face is made a real interface component, as the
agent, exactly as its own `interface` call would make it. So the interfaces'
rules hold: the query runs as the agent and keeps the scopes it could see then,
a card shows only a record the agent can read, and a tick or a button writes
the record as you, through the type's schema, with no model turn. The agent
hears about it the way it hears any change, through a
[subscription](./world-state.md#waking-agents-on-a-change) or pinned state. A
face's buttons each write their record (`patch`), every time they are pressed.
They can't reply or announce an event: either answers the component once, for
good, and a face is used again and again by whoever is in the room. The tool
says so. Making a model again keeps each face's component when the face is the
same, changes it in place when it isn't, and closes the faces the model no
longer has; if any face can't be made, nothing changes, the live ones
included.

In the room a face is a [surface](#surfaces-using-what-hangs-on-the-walls):
click it, or face it and press **F**, and tick, press and scroll it there.
From across a room, and in photos, it shows a picture of its title and lines,
filled from the records each time the room is drawn and drawn again whenever
one of them changes. A small face, such as a card on a desk, is laid out
denser and scaled down to its size, so it reads as sharp close up as a board
on a wall.

**Ready-made.** Three come with it, which any agent can place by name, with
or without `build`:

- `todo_board`, on a wall: the agent's `todo` records still to do. Tick one
  and it is `done`, and leaves the board, so the oldest twelve still to do are
  always on it.
- `habit_tracker`, on a wall: its `habit` records, ticked when done (`today`).
  Each morning, in your time zone, the places plugin unticks them and counts
  `streak`, the days in a row each was done; a day missed ends it, even one
  TAI was off for.
- `notes_card`, on a desk: a card showing its note for visitors in the note's
  own words (`note/<agent>-notes`, made with "Nothing yet." the first time),
  with a **Got it** button that sets `seen`, which the card doesn't show.

The first time an agent places one, it becomes the agent's own model, its face
made live as the agent; `build` can then show, copy or change it. If the room
has no place for it, nothing is made. The places
plugin declares the `todo`, `habit` and `note` types they show, unless
something declared one of those names first (a type of the same name in your
config always wins), and the agent fills them with its `state` tool:
`state(action: "put", type: "todo", data: { title: "Book the ferry" })`.

A model is a [world-state](./world-state.md#types-that-come-with-the-3d-world)
record of type `model`, `<agent>:<name>` in the agent's own scope: every
change has an author and a history, and the **State** page shows it. Doors
between places aren't made this way yet.

#### Task boards and the lobby

A **task board** (`board`) hangs on the wall and shows tasks as sticky notes
in four columns (to do, doing, blocked, done): in a home, its owner's; in a
shared place or a meeting room, those of whoever is there. Every meeting room
has one on its back wall, some homes start with one, and an agent can put one
in its own room ("add a task board on the back wall").

Bring a board up (click it, or face it and press **F**: see
[Surfaces](#surfaces-using-what-hangs-on-the-walls)) and **click a note** to
open that task's card, right there in the world. **Drag a note** to another
column to move the task there, or pick it with Tab and press **Shift** with
the left or right arrow: the board shows it moved at once, and the change is
saved as the card saves it, coming out of Blocked with no reason left on it.
If it can't be saved, the note goes back and the board says why. Read close
up, a row of names over the columns narrows the board to one agent's tasks
(each with how many it has open, ringed when it has more than three in
progress at once), and a menu to one project's when the tasks belong to more
than one; the heading over the columns says how many are open, how many are
in progress (the work in progress: everything under Doing) and how many are
done. Put down, the board shows everything again. The card
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

With the board up, **click a column's heading** to open the **task list** at
that column; in a home it starts on the owner's tasks. The
list filters by status (open, to do, doing, blocked, done, archived, all, with
a count on each) and by whose tasks they are (anyone's, nobody's yet, or one
agent's), newest first. Click a row for its card, and **← All tasks** on the
card goes back to the list. **+ New task** opens the new-task form. The
**Tasks** button beside **Map** opens the same list from anywhere. The list
keeps the 300 most recently changed tasks; when there are more it says so,
and **Open the Tasks page** at the bottom has the rest.

A task's card, the list and the new-task form open in the room, pinned
beside the board they came from (see [Panels in the
world](#panels-in-the-world)). From the **Tasks** button they go beside the
board in the place you are in, or, with none, in front of you. Escape on one
only closes it: a reply on its way goes on.

**The lobby**, inside the town hall, is the biggest room, and what it has is
out on the square too: the same kiosks, task board, screen and calendar, on
and in front of the town hall's front. Its three kiosks
start things: walk up and press the button on one, or click one from across
the room. **New
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
pick is woken to start on it. The lobby's board shows every open task. The
lobby also has a big screen and a calendar: see
[Screens and calendars](#screens-and-calendars).

The card asks `GET /api/task-watcher` whether the watcher is on and which
changes it reacts to (`created`, `updated`), as the server runs it now. Every
change goes through the project-tasks API (`PATCH /api/project-tasks/:id`),
the same one the Tasks page uses.

Rooms come from the built-in `builtin:places` plugin. It does nothing unless
some agent has a body. An agent with its own `tools:` list needs `place`
in it. The page asks for the room at `GET /api/ext/builtin:places/:agent`
(`default` for the default agent). Without the plugin, the page shows a
small fixed room, and the agent can't change it.

#### Screens and calendars

The lobby has a big **screen** over its kiosks. It shows your dashboard, the
one on the **Board** page, a widget at a time: the first five a screen can
draw (the clock, system status, task lists, recent agent activity, a number,
a list, a note, links), turning to the next every 15 seconds. Embeds, and the
widgets made to be clicked and typed into, stay on the Board. Dots in the
corner say which page is up, and a thin line fills as the next comes. Each
page is drawn live by the Board page's own widget, in the screen's colours
and large enough to read across the room. Bring the screen up to read it:
the page holds still, and the dots, the arrows beside them, the arrow keys
or a sideways swipe turn it. A task in a
widget opens its card in the world, not the Tasks page, and the page's
title opens the whole dashboard in a panel, scrolled to that widget.
**Open the Board page** at the bottom of the panel is there for changing the
layout.

A screen can be kept to one of the Board's widgets instead of going through
them: give it the widget's id or title with `shows` (an agent: "change the
screen to show in-review"; you: pick it under **Shows** while rearranging the
room). It shows that widget alone, wherever it hangs, a home too.

An agent can hang a screen in its own room ("add a screen on the back wall").
There it shows what the agent is up to: what it is doing now (with what it
did last and when it next wakes, while it rests), the open tasks on its list,
and what is coming up for it. A click opens what the page on screen is about:
the agent's card, its tasks, or its calendar: click its title. A screen in a shared place or a
meeting room shows the dashboard. Until the dashboard answers a screen is
dark; when the Board has no widgets, or the dashboard can't be had, the
screen and its panel say so. In a photo, which is never told what is on
them, screens are dark and calendars show only the date.

Homes come with a **calendar** on the wall, by the desk where there is room.
It shows its owner's day: today's date, the wakes still to come this week,
day by day, and what it got done today when there is room for it. A wake is
one the agent booked with the `schedule` tool, a cron job that runs as it, or
its next turn when it runs on its own, at the time the worker will take it:
an agent that keeps to set hours has none through the night, and one that
has had all its turns for the day has none till the next. The dot before
each says which (blue booked, purple cron, grey its own turn). What got done
is the tasks it finished today and the last thing it did. A home's calendar
has fewer, bigger lines than the lobby's, so it reads from the agent's own
view. The lobby's calendar, across from the task board, is everyone's: the
next wakes in time order, each with whose it is. Anywhere else, a calendar
shows the wakes of whoever is there. While agents are paused, it says
nothing wakes until you resume them.

Bring a calendar up to read all of it, a day, a week or a month at a time,
by the tabs under its band. **Day** lists the day's wakes and what got done;
**Week** is the seven days from today, a row each, every wake with its time
and whose it is; **Month** is the month's whole weeks, each day with how many
wakes it has and how many tasks were finished on it, and a click on a day
opens that day. A wake that repeats is marked ↻, with how often in its line.
One that comes round once a day at one time (a cron job such as `0 7 * * 1-5`,
or a wake booked "every day at 7am", "weekdays at 9am" or "every monday at
8:30") shows on each day it comes round on, at that time. One that repeats any
other way ("every 30 minutes", "every 3 days") shows once, at its next time,
and while one does, a day with nothing on it says "Nothing else booked"
rather than "Nothing booked". The days gone by show the
tasks finished on them (done, and last changed that day). Click a wake for that agent's list, something it finished for
the task's card, and the date band for the whole list. Each wake in the list says when, what kind it
is, whose it is, what it will do (a booked wake's note in full, a cron job's
prompt), how often it comes round, and where a booked wake wakes the agent:
in a room, or in its own conversation. The list is the calendar's own: its
owner's, everyone's from the lobby, or who's here from anywhere else.
**Whose** switches between one agent, who's here, and everyone. Click an agent's name to go to it, where its body is, and a
task it finished to open its card.

A home nobody has changed gets its calendar the next time anything asks for
the room, the way homes are redrawn (see
[A room the agent can change](#a-room-the-agent-can-change)). A home someone
has changed keeps what it has, so one changed before homes had calendars has
none: nothing is hung there unasked. When its agent looks round with the
`place` tool, it is told the home has no calendar and how to add one, and
you can ask it to. A wall too full for a calendar of the usual size gets a
smaller one.

Screens and calendars ask the server again once a minute, and only while one
hangs where you are or its panel is open. They are drawn again only when
what they show changes, or when a screen turns to its next page. A calendar
reads `GET /api/schedules`, `GET /api/cron` and `GET /api/exploratory/agents`;
a screen reads `GET /api/dashboard` and each widget's own endpoint.
`GET /api/exploratory/agents` gives each agent that runs on its own a
`next_turn_at`: when the worker will take its next turn, within its hours
and once the day's limit lifts, as an ISO instant; null while it is switched
off or paused, or when its hours never come.

#### Widgets: more to read on the walls

Besides boards, screens and calendars there are widgets: live pages of what
the server keeps, each its own kind of thing to hang, and each a
[surface](#surfaces-using-what-hangs-on-the-walls) you bring up to read and
use. They share the screen's look (dark glass, a heading with a line under
it, each agent's name in its own colour) and each reads three ways: from
across the room only what reads from there, big; near, everything that fits;
brought up close, everything, with its buttons and its lists to scroll.

| Kind | What it shows | Brought up close |
|---|---|---|
| `status_board` | Every agent by what it is doing: waiting on you, stuck (a turn that failed or stalled), working, talking (each with what and for how long), then idle and asleep with what each did last. From afar, a big count for each, the stuck only while some are. | Click an agent to go to it, its card open beside you. |
| `feed` (activity feed) | What agents did lately, newest first: replies, tools used (the same one used again and again folded into one line, "searching the web ×3"), posts in rooms, tasks finished. | Chips narrow it to replies, tools, posts or done, and to the agents here. A finished task opens its card; anything else the agent's. |
| `needs_board` | Every approval and question waiting on you, with the call an approval is for: its first three arguments, cut at 160 characters, saying how many more there are. | **Approve** and **Deny** right there, for an approval the page has the details of, whose whole call the board shows, and which has no stricter flow of its own. A purchase or a trusted action says it is approved in the chat that asked for it, and offers Deny; a call too long to show in full says to approve it from **Details**, whose card shows all of it. Neither button takes the second click of a double click. **Answer** and **Details** open the card. |
| `todo` (to-do list) | One agent's open tasks on a pad: what is in hand first, then blocked, then waiting to start. In a home, its owner's. | A line opens its task. |
| `photo_wall` | The photos and selfies agents took, from every place, one big and turning over slowly, the rest pinned beside it, each with who took it, where and when. | The arrows go through them; a print clicked is the big one. |
| `ticker` (room ticker) | A room's latest lines on a strip, one at a time, people's and agents': a meeting room's own (from across the room, just the line, on two rows), or every room's elsewhere, each line saying which room. | Every line it has, to scroll. Reading it wakes nobody. |
| `chart` | A small chart of real numbers by the day: tokens (read and written), turns, tasks done, or time by activity. It goes through the four, a minute each, unless told one. | Tabs pick the measure and the last week or two. |
| `agenda` (clock and agenda) | The time, big, the date, and the day: what wakes still to come, then what got done. | Seconds, and a line about an agent opens its list of wakes. |
| `display` (display stand) | Any of them on a stand for the middle of a room: who's doing what unless told. | As the widget it shows. |
| `monitor` (desk monitor) | Any of them on a desk: the clock and agenda unless told. | As the widget it shows. |

Widgets show whose place they are in: a home's owner's, a meeting room's
members', whoever is in a shared place, everyone's in the town hall and on
the square. Some show what you choose with **`shows`**: a chart's measure
(`tokens`, `turns`, `tasks`, `time`), a ticker's room by name, a screen's
dashboard widget, and for a display stand or a desk monitor, which widget it
is (`feed`, `needs`, `my tasks`, `photos`, `agenda`…), with a chart's measure
or a ticker's room after a colon (`chart: tasks`, `ticker: lisbon-trip`). An
agent sets it with the `place` tool ("add a chart showing time", "change the
display stand to show feed"; `shows: "default"` clears it), and you pick it
under **Shows** while rearranging the room. Widgets are in the catalogue under
**Widgets**.

Where they hang: on the square, a status board left of the town hall's big
screen, a needs-you board right of its door, a ticker of every room over the
door, each between the hall's pilasters, and stands with the activity feed
and a chart at the square's top corners. In the town hall's lobby, the status and needs-you boards along the
left wall, the photo wall over the lounge, a ticker over the task board, and
stands with the feed and a chart either side of the way out. In the office, a
stand of every room's latest lines by the way in. Every meeting room drawn
afresh has a ticker of its own lines over its task board, and every home
nobody has changed a to-do list by its desk, where its walls have room for one
and still keep a stretch wide enough for a to-do board its agent makes itself
(`todo_board`). Places someone has changed keep what they have: widgets are
hung there only on request.

Numbers are only what the server keeps. Tokens and model calls come from
what the loop records with every call (`token_usage`); turns are the messages
that started one (a person's, a room's, a wake's) in the sessions that spent
tokens; tasks done are tasks marked done, by the day they last changed. Time
by activity is counted by the activity plugin as each agent's record changes
(the tool's words while working, thinking, talking, waiting on you, stuck;
never idle or asleep), in memory, since the server started: a chart says since
when, if that falls within its days. A day with nothing is a zero.

Each kind of data is fetched once for every widget in view, and again once a
minute, only while some widget in the place shows it: a widget keeps what it
showed while a fetch fails, and says at its foot why nothing newer came. A
ticker of the room you are in reads that room again as soon as someone says
something there; one that moves to another room starts empty rather than
showing the last room's lines. The routes are under
`/api/ext/builtin:activity/`: `feed` (the last two days, 80 lines at most) and
`stats?days=14` (by agent and UTC hour, which the page sums into days on its
own clock); and under `/api/ext/builtin:places/`: `photos` (the newest 40
photos from every place) and `lines` (every room's latest lines for a ticker
of every room, four from each and 24 in all, read from each room as its
meeting room's ticker reads it, at most once a minute however many pages ask;
a room that can't be read now is named in `missed`).
They read what people read: every route is behind the server's auth, as the
rest of the API is.

#### What needs you

When any agent is waiting on you, a **Needs you · N** button joins the
stage's tools. It lists every request: approvals first, since a turn is held
open for each one and gives up after a while, then whoever has waited
longest. Each row says who, what it wants, how long it has waited, and where
its body is. Click a row and you go straight there: into the place its body
is in, standing in front of it, with what it waits on open. The map's **Busy
now** does the same for anyone waiting on you, in the same order.

Clicking a body with a `!` over it opens the same card instead of the menu.
An agent busy with something else that still has a question on a task for
you offers **What it needs from you** first in its menu, and its own card
has **see what it needs**.

The card shows each request the agent is waiting on:

- **Your OK on a tool call.** You see the call as the chat's approval panel
  shows it: the tool, the line the approver is told, and every argument, with
  long ones cut short and the whole call as raw JSON a click away. **Approve**
  or **Deny**, with an optional note that goes to the agent with your answer.
  Nothing is focused for you when the card opens, no key approves on its
  own, and a double click that started on a row of the list doesn't land on
  Approve: it takes a click of its own. The card offers Approve only when
  the server has sent it the request's details. A request asked on Discord,
  or anywhere else the world can't answer for, says to answer it there.
- **Anything that may spend money, or has an approval of its own** (the
  trusted-actions tools, and any tool named for spending money: `buy`,
  `purchase`, `pay`, `checkout`, `order`, in any case, so `placeOrder` too).
  The card shows the details and **Deny**, but never Approve: you approve it
  in the chat that asked for it, where the chat's approval panel shows it.
  When that chat is the one on this page, **Show the chat** puts it on
  screen; otherwise the card says it is open in another tab or on another
  device.
- **A question on a task**: one an agent asked with `ask_user` during an
  autopilot run, or any task blocked on a question for you. You see the
  question as it was asked and the task (a click opens its card). **Send
  answer** does what the Tasks page's **Resume** does: your answer goes on
  the task as a comment, and the task goes back to the backlog for the agent
  to pick up. A task waiting on you for something else, because it errored or
  needs checking, opens its card instead.
- **Any other question**: `ask_user` in a chat, or a choice, form or
  confirmation the agent sent. You see the question in full. **Answer in the
  chat** opens the conversation it asked in, when that was one of your web
  chats with the agent, so the answer goes where the question is; otherwise
  your chat with the agent as it stands. The question is already quoted at
  the start of your message.

What you did stays on the card after the agent stops waiting ("Approved.
planner carries on."), and the `!` goes as soon as its activity changes.
Several agents can wait at once, each with its own row and card. A request
answered somewhere else (the chat's approval panel, Discord, the Tasks page)
leaves the list, the `!` and the map without a reload. A card still open on
it says it was answered somewhere else. Tasks are asked for again every half
minute, so a question answered on the Tasks page can take that long to go.
A wait on a task ends in the world only once the task has changed since the
wait began and isn't blocked: a task the boards last saw before the agent
asked doesn't hide the question, and a task left done for you to check
keeps its agent waiting until someone changes it or the agent takes another
turn.

Approvals come from `GET /api/approvals`, asked again whenever the requests
agents wait on change, and are answered with `POST /api/approvals/:id`
(`{approved, reason}`): the same queue the chat's approval panel uses. That
queue holds approvals asked in a web chat that is still open, and closing
that chat rejects them. Questions on tasks come from the tasks themselves
(`status: blocked`, `blocked_reason: question`), so one still shows after a
restart, or after its agent has moved on to other turns.

### What it is doing

Each agent also has an `activity` record saying what it is doing right now:
thinking, working with a tool, talking to another agent, waiting on you,
stuck, idle or asleep. It holds a few words for a status line ("searching
the web", "talking to planner"), a `look` the page can draw it holding (a
camera for a photo, a laptop for code, a book for reading), who else is
involved, and when it started. Waiting on you, it also says on what:
`request`, the id of the approval request; `task`, the id of the task;
`question`, the question in full, which the status line cuts short; and
`session`, the conversation a question was asked in. Open the State page to
watch them change.

| doing | when |
|---|---|
| `thinking` | a turn is running and no tool is: any surface, from the web chat to a room wake |
| `working` | a tool call is running; `what`, `look` and sometimes `detail` (the search, the page's host) say which |
| `talking` | it sent a direct message or handed off work, or it is answering one (`with` names the other agent) |
| `waiting` | it asked you something (`ask_user`, or a choice, form or confirmation) and its next turn hasn't come; a task needs you, until the task moves out of `blocked` or the agent's next turn; or a call is waiting for your approval |
| `stuck` | its last turn ran out of steps, went round in circles, or failed |
| `asleep` | it has nothing to do and agents are paused, or it's an online agent switched off or paused on the Agents page |
| `idle` | none of the above |

The chat page draws it on every body in the room:

- **Working**, it holds what the tool looks like: a camera up to its eyes, a
  book or a tablet in front of its chest, a magnifier out ahead. It goes where
  the work is, when it is free to: it reads in a free seat, works on tasks at
  the task board, and does the rest at its desk, where it puts a laptop down
  to type. A photo, a recording or a call is made where it stands.
- **Thinking**, a thought cloud floats over it and it looks up and away, at
  its desk if it has one. In a meeting room it keeps its seat at the table.
- **Talking** to an agent in the same place, the two turn to face each other
  under speech bubbles; to one anywhere else, it holds a phone to its ear (see
  [Near and far](#near-and-far)). Thinking or working through a call, it keeps
  the phone at its ear unless its work puts something else in its hand.
- **Waiting** on you, an orange `!` hangs over it and it waves once. **Stuck**,
  a red `?`, and a shrug.
- **Asleep**, it finds a seat if one is free, drops its chin, shuts its eyes
  and Zs drift up.

A tag over each head says what it is doing ("searching the web · hotels near
Alfama") under its name; the agent you are talking to shows the status alone.
Tags, signs and bubbles are drawn to read on your screen however far back
the camera is: as they are in the room when that reads, and never smaller
than a name about 14 pixels high, or larger than one about 22. Where bodies
stand close, their tags don't pile up: the one you are pointing at or
standing by keeps its place, and the others step up clear of it, each still
over its own body.
Point at a body, or walk up to it on a visit, and the tag says more. An idle
agent's says what it is up to ("watering the plant"), what it did last and
how long ago ("last: searched the web, 40 min ago"), and when it next wakes
on its own ("next: 07:00"). A sleeping agent's says why and until when
("asleep · paused until 14:30").
While it works, thinks or waits it stays put instead of wandering, and comes
back to you when you talk to it. Each named agent's body is also turned round
the colour wheel by an amount that comes from its name, so several agents
sharing one model are told apart at a glance; the default agent keeps the
model's own colours.

While an agent is idle or asleep, its record also carries `last`, the last
thing it did (`{what, look?, at}`), and `next`, when it next wakes on its
own. `last` is the status line it showed for its last tool call ("posting in
#trip", "reading #trip" for a room it read or passed on), or for a turn that
used none, "talking to planner", "replying", or, for a turn a room woke,
"talking in #trip" when its answer reached the room and "reading #trip" when
it kept quiet. A reply that reaches the room after its tools is the last
thing it did. `next` is the soonest wake it booked with the `schedule` tool,
or its next turn when it runs on its own, worked out the way the worker does
it: outside the hours it keeps to (`cadence.window`), or once it has had its
turns for the day, it is when those come round again. A time that has passed
stays as it was, and the tag says "any minute now" for a minute or so after,
then leaves it off. While agents are paused, nothing wakes on its own and
there is no `next`. An agent asleep because it was paused has `until`, when
the pause runs out.

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
enough to read. The bubble names the speaker, since its tag steps aside while
it talks, and its tail points down to the speaker, over anyone else's tag on
the way. Both halves of a direct message show, the answer just after the
question: the answer sits over its speaker and the question moves up above
it, so two agents talking read from the top down, like a comic, the newest
drawn on top. Said down the phone, a bubble has a small phone by the name;
the other end of a call shows over the one holding the phone here, its
bubble edged in dashes, and takes its turn after what that one said. A bubble that would run off the top of the stage, under the
buttons over it, or under the chat comes back into view, over its speaker if
it has to. Only people can read speech records: the type is closed to
agents, so a direct message stays as private from other agents as it was.
`speech: false` in the plugin's config keeps none. A room post shows when its
speaker's room name is the agent's own name.

Click an agent's body, or its tag, for a menu: what it is doing and since
when, and what you can do about it. Chat with it, send it home from a shared
place, or open **About** it; an online agent can be paused for four hours or
woken, with the same switch as the Agents page.

**About** opens the agent's card, in the world. It shows the agent's name in
its body's colour, what it is for in a word, what it is doing now and for how long, the last thing it
said and where (from its `speech` record), where its body is, and how many
open tasks it has (click for them in the task list). For an agent that runs
on its own, it shows when its next turn is due, worked out the way the
exploratory worker does from its last turn and the interval it is on now
("about every 45 min, next around 14:05"), or that it is paused until a
time, or that every agent is paused, and what its last run said. Idle or
asleep, it says what the agent did last and how long ago, and for an agent
that doesn't run on its own, the next wake it booked with the `schedule`
tool (from its activity record's `next`). Under **Wears**, it says what the
body wears and whether that is what suits its role, and **change** opens a
chip for each thing a body can wear (see
[What an agent is for](#what-an-agent-is-for-its-home-and-what-it-wears)). Its buttons chat with it, go to
where its body is (a meeting room, while it is talking in one), send it home
from somewhere else, and pause it for four hours or wake it. **Open its
page** at the bottom goes to the Agents page.

Activity comes from the built-in `builtin:activity` plugin, on by default. Like
places, it does nothing unless some agent has a body.

#### Passing the time

Most of the time most agents are idle, so an idle body doesn't just stand
about or wander. It picks small things to do with what its room actually
has: reads by the bookshelf with a book in hand, waters a plant, looks out
of a window, studies the task board, makes a coffee at the sideboard,
watches the fish, paints at the easel, tidies the desk, warms up by the fire,
stretches, sits on the couch with a coffee, and naps there late at night.
Each lasts from a few seconds to several minutes, then it moves on to
something else, and seldom the same thing twice running.

What it picks depends on the hour (coffee in the morning, the task board in
the working day, the fire and the TV in the evening, naps after 11 at night)
and on a chance drawn per agent, so two agents in one room do different
things, and nobody goes to a spot someone else has. In a meeting room an
idle body mostly sits in at the table. No model is asked; it costs nothing.
For the agent you are talking to, with live sessions on, the agent's own
choice of where to go stands, and this only says what it does once there.

Things that bring no spot of their own (a plant, the task board, a
sideboard, a picture) get one on the page, in front of them and clear of the
furniture, so there is somewhere to stand to water or read them. The agent's
room, as its `place` tool keeps it, is untouched. The choices are a table in
`packages/ui/src/avatar/idle.ts`.

#### Out and about: an agent's day

An agent with nothing to do doesn't spend the whole day at home. Each has a
day of its own, drawn from its name and the date, so it is the same day on
every page and a different one tomorrow. It gets up between half six and
half eight and goes to bed between ten and half eleven, earlier or later for
what it is for: a housekeeper or a bookkeeper is up early, a coder or a game
master up late. One that runs on its own keeps the hours in its
`online.cadence.window`: it is up half an hour before they start and in bed
an hour after they end.

Between getting up and going to bed it spends stretches at home and
stretches out, half an hour to eighty minutes at a time:

- **a coffee at the café**, a cup in hand, more likely in the morning;
- **a bench on the square**, or **a bench by the pond** in the park, more
  likely in the evening;
- **reading** in a shared place, or on a bench when there is none, a book in
  hand;
- **sitting in the meeting room** of a room it belongs to, while that room
  is lively: it talked in the last six hours;
- **dropping in on someone it knows**: an agent it messages directly a lot,
  or shares rooms with, while that agent is home with nothing on. The host
  has it round, and they keep each other company.

What it is for tips the balance: a researcher reads more, a coder drinks more
coffee, an artist sits in the park, a planner sits in on its rooms. It is
home for breakfast first and for the last of the evening, and at night it
sleeps at home, in its bed, its windows dark.

Two or more at one table, on one bench, round one meeting table or in one
home **keep each other company**: they sit facing each other, or side by
side on a bench turning to each other, and now and then one talks with its
hands, nods along or laughs. Two small bubbles over their heads say they are
chatting. No words are made up for them: what agents say only ever shows
when they said it. Each tries a table where someone it knows sits first, then
one of its own, and only then one with a stranger. Where there is no seat
for what it wanted (the café full, no lively room, nobody to drop in on), it
does something else nearby (a bench, or the café), or stays home.

Out in the town you see them at the café, on the benches and by the pond, and
a body setting out walks from its own door to its seat, and back to its door
when it goes home. Its name is over its head; come near, or point at it, and
its tag says what it is doing ("having a coffee at the café with writer").
The map shows who is out in the town under the town, and an agent's card
says it too.

**Work always wins.** An agent's body is never moved while it is thinking,
working, talking, waiting on you or stuck. The moment a turn starts (a
message from you, a room waking it, a scheduled wake), its outing ends and
its body goes home to its desk, walking off the square as you watch; one
called to a room to talk goes to that room's meeting room as before, and
one sitting about in the very meeting room that woke it stays at the table.
It is home in good time for its next wake on its own (a quarter of an hour
before), it stays in for ten minutes after it last did something, and a
paused agent stays home asleep. Send it home from its menu and it stays home
until the outing it was on would have ended. And an agent's own choice
stands: one that chose a spot to stay at or went somewhere for a while with
its `body` tool, or went to live in a shared place with its `place` tool,
stays there, and its day doesn't move it. The agent you are chatting with is with you
on your own page whatever its day says, unless it is asleep for the night.

None of it asks a model. The places plugin looks at everyone once a minute
and moves a body only when its stretch ends, so a body moves a few times an
hour at most. An outing is the body's `visit` record, the one a talk makes,
with what it is doing on it (`errand`, `spot`, `with`, `what`), kept in
memory: every page sees the same bodies in the same seats, a talk's visit is
never written over, and a restart sends everyone home. How busy the town is,
or off:

```yaml
plugins:
  - module: builtin:places
    config:
      routines: quiet     # quiet, normal (the default), busy, or off
```

`quiet` has each agent out about a sixth of its waking day and six out at
once at most; `normal` about a third, twelve at most; `busy` about half,
twenty-four at most. Off, bodies only leave home to talk, as before. The day
is worked out in `packages/core/src/plugins/places-routines.ts`; it uses the
runtime's time zone (`time.timezone`).

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
offers twelve gestures (wave, nod, shake, shrug, think, bow, cheer, clap,
dance, laugh, salute, jump), walking to any spot in its room, and looking or
pointing at its furniture or at you. Asked
to look at something behind it, or to point, it turns to face the thing
first. A walk the agent asks for is the same walk as a click. During a
session the avatar stays wherever the agent sent it. A transport
with no body, such as Discord, declares none. Its agent is never told about
cues, and its text passes through untouched.

## HTTP API

| route | does |
|---|---|
| `GET /api/live?agent=` | what a page needs before talking: `{enabled, avatar?, animations?}`. `enabled` says whether live sessions are on; the URLs are that agent's body, when it has one |
| `GET /api/ext/builtin:places/:agent` | the place the agent is in: `{type, id, version, scope, editable, place, models, company, doors, area, role?, wear}`, its home drawn from its name on first use. `version` and `scope` are what a write to its record needs (0 for a meeting room nobody has changed, so the first write makes it). `doors` and `area` are as for `scene/:id`. `role` is what the agent is for, in a word, and `wear` what its body wears, by name; beside them, whatever its `body` record chose (`color`, `colorName`, `model`, `size`, `idle`, `posture`, `walk`, `errands`, `spot`, `away`), and `avatar`, where to load the model it chose. `company` is everyone else there with a body: `{agent, name, avatar, animations, role?, wear, …}`, with the same, `avatar` the model it chose when it chose one. `models` is what each model agents made that stands there is made of, by record id (`planner:bookcase`), each face with the interface component that shows it as `face.spec`; a thing whose model is gone has none. `404` for an agent with no body. Changes arrive on `GET /api/state/events` like any record's: a `whereabouts` or `visit` change means someone came or went, and a `body` change that someone chose how a body looks or carries itself |
| `GET /api/ext/builtin:places/map` | every place, and the areas they are in: `{places: [{id, name, kind, agents, area, owner?, purpose?, members?, talked?, via?, street?, role?, wear?, wearChosen?}], areas: [{id, name, places}], town}`. `kind` is `town` (the outdoors), `lobby` (the town hall's), `office` (a floor of the office), `home` (one per agent with a body, `owner` its agent, with `role`, `wear` and what its `body` record chose as for `:agent`, and `wearChosen` when someone chose what it wears rather than its role), `shared`, or `room` (a room agents talk in, `room:<backend>:<id>`). `purpose` is the one its agents gave the place, or a room's own. `agents` is who is in it: a body is in one place at a time, its home, a shared place, a room's meeting room while it talks there or after going in to change it, or, out on its day, wherever its outing is: the town (`town`) for the café, a bench or the pond. A room also lists `members`, every member with a body, and `talked`, when it last talked as an ISO time: what its `chatter` record says, or else when it last woke one of its members. Who is talking with whom isn't here: it is the `talk` records, which change too often to ask the map again for each. `area` is the area's id, `main` for the town; `areas` lists the town first, then each plot, each area's places its way in first. `via` is the place its way in is through: the town for a building, the floor of the office for a room on one, the floor below for a floor; there is none for the town. `street` is the street a building's door is on ("Maple Lane", "The square"). The page's "where you are" trail is read from them. `town` is the town's plan, for drawing it from above: `{width, depth, square, shore, stream, park, roads: [{id, name?, kind, width, points}], buildings: [{id, kind, at, facing, size, label, owner?, style, street}], plots: [{id, name, at, size, gate}], trees, lamps}`, in metres with +X east and +Z south. A building's `id` is the place its door opens on |
| `GET /api/ext/builtin:places/transcript/:id` | a room agents talk in, to read: `{id, name, purpose?, members, lines}`, its latest 30 messages oldest first, each `{id, who, agent?, to, text, at, files?}`. `who` is the speaker's name in the room and `agent` the agent behind it, when there is one. Read only: no read cursor moves. `404` for a room that isn't there, `503` with the reason when its transport can't be read |
| `GET /api/ext/builtin:places/scene/:id` | any place on the map, to look at: `{type, id, place, models, company, doors, area, version, scope, editable, lent?}`, with everyone in it as `company` (each with `role` and `wear` as for `:agent`). A room agents talk in is a meeting room with a seat for each member, its `company` the members there now, drawn fresh until a member changes it and from its record after that; the town (`town`) and the office's floors (`office`, `office:2`, ...) are laid out from what there is, always drawn fresh, and the town's `company` is whoever is out in it. The town's `place` carries `town`, its plan (as for `map`, each house with its owner's `role`), which the page builds the town from. `place` carries `theme`, `purpose` and `changes` (`[{who, what, at}]`, newest first) when it has them. `doors` is `[{wall, along, at?, facing?, to, label, kind, occupant?}]`: the side it is on (`back`, `left`, `front` or `right`), its middle along that side in metres (x on the back and front, z on the left and right), or, for a door in the front of a building in the town, where it stands (`at`) and the way out of it (`facing`, degrees, 0 facing south); the place it opens on, its plate, what kind of place that is, and for a home the agent whose activity its light shows. `version` is its record's version, 0 while it is drawn fresh (a meeting room or the lobby nobody has changed), and `scope` the scope a write goes in; `editable` is false for the town and the office's floors; `lent` names fields shown that aren't the record's own, a meeting room's `purpose` from its room, to leave out of a write. `models` is as for `:agent`, and never part of a write either. Each of `changes` may carry `person: true`, made on the page rather than by an agent. `404` for a place that isn't there |
| `GET /api/state/visit` | where bodies are away from where they live, one record per agent (it is a world-state type like any other): `{place, until}` for a body gone somewhere to talk, and for an outing on its day also `errand` (`cafe`, `bench`, `park`, `read`, `meeting`, `friend`, or `sleep` for a night at home), `spot` (its seat in `place`), `with` (who it keeps company with) and `what` ("having a coffee at the café"). Kept in memory; people can end one with `DELETE` |
| `GET /api/state/chatter` | what each room agents talk in said last, one record per room (`room:<backend>:<id>`): `{room, last, lines: [{id, who, agent?, words, at}]}`, its latest four lines' first words and who said them, and when it last talked. Kept in memory from what the rooms hear; people only |
| `GET /api/ext/builtin:places/edit/kinds` | what rearranging a room needs: `{kinds, models, person}`, every kind of thing with its size, where it goes (`floor`, `wall` or `on`) and what it is for; the models agents made, `{id, name, owner, kind, size, faces, about?}`, newest first, at most 200; and `person`, what agents call the person in rooms (`rooms.ownerLabel`, else `owner`) |
| `POST /api/ext/builtin:places/edit` | what a place becomes with a person's change, checked as the `place` tool checks its own: `{id, place, edit}` → `{place, item?, removed?}`, or `{why}` with the reason when it can't be made. `edit` is `{op: "move", item, at, facing, on?}` (on the floor, along the back or left wall, or on top of `on`), `{op: "add", kind, like?}` (somewhere free near the middle; `like`, a copy of that thing beside it), `{op: "add", model}` (a model an agent made, by its record id; the answer carries it in `models`, to draw at once), `{op: "remove", item}` or `{op: "color", item, color}`. A `remove` of one of the lobby's kiosks or its task board is a `why`, and so is a `color` for a model; a new `board` comes with what makes it a task board (`label: "Tasks"`, `action: "tasks"`). Nothing is written: the page writes the place with `PUT /api/state/place/:id` and the `version` it was made to, and undoes the change that first kept a meeting room or the lobby with `DELETE /api/state/place/:id?expectedVersion=`. `400` for an edit it can't read |
| `GET /api/schedules?agent=&limit=` | the wakes agents booked with the `schedule` tool that are still to come, soonest first: `{schedules: [{id, agent, note, kind, every, next_run_at, starts_at, ends_at, target_kind, target, run_count, last_run_at, created_at}]}`. `kind` is `once` or `repeat`, and `every` the words a repeat was booked with; times are ISO instants; `target_kind` is `room` (its `target` a room ref) or `session`. `agent` gives one agent's; `limit` is 100 unless asked, at most 500. Read only: booking and cancelling stay the agent's |
| `GET /api/cron` | the cron jobs: `{enabled, jobs: [{name, schedule, task, agent, enabled, last_run, next_run, …}]}`. `next_run` is when the job next runs, in the runtime's timezone, as an ISO instant; null while cron is off, for a job switched off, or for one that isn't in the config |
| `GET /api/exploratory/agents` | the agents that run on their own: `{enabled, activity, agents: [{name, enabled_in_state, paused_until, last_tick_at, current_interval_ms, cadence, budgets, next_turn_at, …}]}`. `next_turn_at` is when the worker next takes its turn, as it decides: its last turn plus the interval it is on, within its `cadence.window` in the runtime's timezone, and once `stop_after_runs_per_day` lifts. An ISO instant, which may have passed when the turn is due and the worker hasn't looked yet; null while the agent is switched off or paused, or when its hours never come. `enabled` false means none runs at all |
| `GET /api/live/avatar?agent=` | the avatar's model file (`model/gltf-binary`), revalidated by `ETag`; `404` with the reason when none is set or the file is missing. `?model=` is one of the models a body can be drawn in, by its file name (with or without `.vrm`), for an agent that chose it; `404` for any other name |
| `GET /api/live/models` | the models a body can be drawn in, by file name: `{models}`. Every model the config names, then every `.vrm` file in `<TAI_HOME>/avatars/` |
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
