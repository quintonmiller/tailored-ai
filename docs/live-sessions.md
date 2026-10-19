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
| `room` | the room's `width` (up to 16 m), `depth` (up to 12 m) and `height` (up to 4 m), `walls` colour, `floor` (wood, carpet, tile, concrete, or a colour), `name`, `theme` and `purpose` (see [A theme and a purpose](#a-theme-and-a-purpose)), and `area` (see [Areas, halls and doors](#areas-halls-and-doors)) |
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
new goes there or hangs over it. `look` says where the door is, or, for a place
alone in an area of its own, that it has no door yet. "Near the door" puts
something beside it, back to its wall where there's room, never in the way in.

What can be added: seats (couch, armchair, beanbag, bed, chair, stool),
tables (desk, table, round table, coffee table, side table, sideboard), a
bookshelf, TV, fireplace, easel, rugs (square or round), lamps, plants (a
plant, a tall plant, a cactus, a palm), things for the walls (window,
picture, painting, poster, clock, shelf, pegboard, task board, and a sign
that shows its name), a bench, small things for a surface (laptop, books,
vase of flowers, small plant, mug, candle, table lamp, aquarium), and blocks,
balls and cylinders of any size and colour.
Seats, desks, the bookshelf, the TV, the fireplace, the easel and windows each
bring a spot: add an armchair, and the agent can sit in it, and so can a
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
talk in, the shared places, each agent's home, and the halls between them,
with who is in each and a mark for anyone waiting on you (`!`), stuck (`?`) or
asleep (`z`). Type to find a place or an agent. Click one to go there. Within
a building, you can also walk from place to place through doors (see [Areas,
halls and doors](#areas-halls-and-doors)).

**Busy now**, at the top, lists every agent that is doing something, most
pressing first: waiting on you, then stuck, then talking, working and
thinking. Each line says what it is doing and where its body is ("writing
code · in the commons", "has a question for you · in #trip"); click it to go
straight there. When nobody is busy it says so, which tells you a quiet world
is idle rather than broken. In each group, places where something is
happening come first, with a coloured edge and a word for the most pressing
thing there and how many are doing it, then how many others are busy
("waiting on you · 2 more busy", "2 working").

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

#### Areas, halls and doors

The places are joined up. Most of them are in **the main building**, where
the lobby is the hub and three wings lead off it, each through a door of its
own: the **residences**, with a door for every agent's home; the **meeting
rooms**, with a door for every room agents talk in; and the **shared
places**. A wing with one place opens straight off the lobby. More, and they
are behind a hall: a long room with doors down both sides, benches and plants
down the middle, lamps for the evening, and a sign with its name by the
entrance. A hall holds up to 14 doors, read left to right, at the back and
then facing them at the front. A wing with more than that has several halls,
each covering a run of the alphabet ("Residences A–F", "Residences G–M"), and
the lobby's door leads to a foyer with a door to each of them. So any home is
three doors from the lobby at most: into the foyer, into its hall, into the
home. Halls are cut where the first letter changes, so a new agent only
changes the hall its name falls in, unless that hall was full.

A door on the back or left wall is a door in the wall, with a name plate over
it: the agent's name, the room's `#name`, or where a hall leads. On the open
front and right sides, where the wall is cut away so the camera can see in,
the door is cut away too: a low gate with the plate across it, readable from
either side, that never stands between you and the room. A door to a home has
a light by its dark plate, and a lit strip along it, that says what that agent
is doing, from its `activity` record: green working, blue thinking or talking,
amber waiting on you, red stuck, white idle, and dim violet asleep. You can see
who needs you from the hall, before you knock.

**Walk into a door**, or click it, to go through. Up against the wall in
front of a door, keep pressing toward it. The picture fades, the place behind
it loads, and you're standing just inside the matching door, facing into the
room: a little further in through a gate, so its plate doesn't hide you, and
past anything that stands just inside. Your body, and walking or flying, carry
on as they were. A click goes to whatever is nearest under the pointer, so a
chair in front of a door is still a chair. You
stop on the threshold: a key you held through the door waits until you let it
go, since the view faces the same way on the other side and holding `W` would
otherwise walk you straight back out. Everyone stays in their own place: you
only see the bodies in the room you're in. Going into an
agent's home through its door switches the chat to that agent, the same as
going there on the map. From an agent's own view, clicking a door starts a
visit: you come out of that door on the other side, in your own body.

**Areas.** A home or a shared place can be somewhere else: the `place` tool's
`room` action takes `area` ("the summer house"), and so does `new`. Places in
the same area are joined to each other and not to the main building: two by a
door from one straight into the other, three or more round a hall of their own
("Summer house hall"). A place alone in its area has no door at all, and the
map says so. Between areas, you use the map, which still goes anywhere. An agent can build itself a
summer house with two rooms this way, or move its home out to a cabin with
the places it made there. `area` "main" puts a place back in the main
building.

Rooms agents talk in always stay in the main building, on the meeting rooms'
hall, whatever they are dressed as. A trip room is a beach to look at, but it
is a room of conversation that several agents share, not anyone's own place to
move, and it has no record of its own to say where it is. Splitting them out by
theme would leave a string of one-room areas reached only by the map, which is
what the building is for avoiding.

**The map** groups places by area when there is more than one, the area you're
in first, and says which one you're in. Halls are listed too, so you can jump
straight to one.

How it works: the building is worked out on every read from the places there
are, by `places-world.ts` in the places plugin. Nothing about it is stored, so
an agent's own changes to its room stay its own, and a home nobody has changed
is still redrawn as rooms improve. A place's door goes wherever its room keeps
a clear stretch of the back or left wall, at the end nearest the open side,
which is where the rooms the world starts with keep their doorway. A room
whose walls an agent has filled gets its door as a gate at the open front or
right instead. Since the door depends on what is in the room, the page asks
for it again after each change, and moves it if it moved. Halls are
`hall:<area>:<wing>-<n>` in the main building (`hall:main:homes-1`) and
`hall:<area>:<n>` elsewhere; a wing's foyer is `hall:main:<wing>-foyer`, and
an area's own `hall:<area>:foyer`.

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
quiet room shows its member count on the map ("quiet · 3 members").

The agent you are chatting with is the exception on your own page: it stays
in its own room with you while you talk, even while its body is at a
meeting. The map, **Busy now** and anyone visiting see it at the table, and
if you go to that meeting room you'll find it there too.

A visit is a `visit` record, one per agent, naming the room's place and an
`until`. It lives in the built-in `memory` state provider, apart from the
`whereabouts` record that says where the agent lives, so a visit never
changes where it lives, leaves no history behind, and ends on restart. The
plugin clears visits that have run out every 20 seconds, so a page watching
sees the body go. The `place` tool still works on the place the agent lives
in (its home, a shared place, or a meeting room it went into) while its
body is at a meeting, and moving
with the `place` tool ends the visit. Sending it home from the menu ends the
visit early too; its next message brings it back. Change the quiet spell, or
turn this off with `0`:

```yaml
plugins:
  - module: builtin:places
    config:
      quietMinutes: 5        # 0: bodies stay put while their agents talk
```

A body that turns up while you are there walks in through the room's door
and on to a free seat; one that goes walks out through it. Whoever is
already there when you arrive is simply about. The same goes for anyone
coming or going anywhere else: a visitor to a home comes in at its door.

A meeting room is dressed for what the room is for, read from its name and
purpose: a trip or a vacation gets a beach (sand floor, sky-blue walls, palms
and an umbrella), a campaign a tavern (dark wood, a hearth, barrels, candles
on the table), a podcast a studio (an easel and posters), code a workshop (a
workbench under a pegboard, crates), research a library (shelves of books and
a reading chair). A room whose words match none is plain. Each comes in a
few colourings and wall arrangements, and the room's name picks one, so two
rooms of the same kind still look different. A theme a member chooses beats
the guess.

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
drawn from its name again. A meeting room keeps its door and stays in the
meeting rooms' wing of the main building, so `area` is refused there.

Only members go in. Anyone else is told whose room it is and who can change
it: "#trip's meeting room is for the members of #trip: guest and host can go
in and change it." An agent that leaves the room is home again.

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

The **Room** button, beside **Map** and **Tasks** in a home, a shared place
or a meeting room, opens the place's card: what it is for, its theme, who can
change it, and its recent changes, newest first, each with who made it and
when. A place keeps its last 8 changes made with the `place` tool, in its
record's `changes`, each cut short past 160 characters; the **State** page
has the full history, including
changes made there. In a home whose owner has the `place` tool, the card has
**Ask planner to make it fit its work**, which opens a chat with the agent
with "Have a look at your room and make it reflect what you've been working
on." written for you to send. **Redo its room** on the agent's own card does
the same. In a meeting room, it takes you out of reading the room's own
conversation and into a chat with that agent. An agent whose `tools:` list
leaves out `place` can't change a room, and the card says so instead of
offering, with a link to the agent's page, where you can add the tool.

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
  book or a tablet in front of its chest, a magnifier out ahead. It goes where
  the work is, when it is free to: it reads in a free seat, works on tasks at
  the task board, and does the rest at its desk, where it puts a laptop down
  to type. A photo, a recording or a call is made where it stands.
- **Thinking**, a thought cloud floats over it and it looks up and away, at
  its desk if it has one. In a meeting room it keeps its seat at the table.
- **Talking** to an agent in the same room, the two turn to face each other
  under speech bubbles; to one who isn't there, it's on the phone.
- **Waiting** on you, an amber `!` hangs over it and it waves once. **Stuck**,
  an orange `?`, and a shrug.
- **Asleep**, it finds a seat if one is free, drops its chin, shuts its eyes
  and Zs drift up.

A tag over each head says what it is doing ("searching the web · hotels near
Alfama") under its name; the agent you are talking to shows the status alone.
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
time, or that every agent is paused, and what its last run said. Idle or
asleep, it says what the agent did last and how long ago, and for an agent
that doesn't run on its own, the next wake it booked with the `schedule`
tool (from its activity record's `next`). Its buttons chat with it, go to
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
| `GET /api/ext/builtin:places/:agent` | the place the agent is in: `{type, id, version, place, company, doors, area}`, its home drawn from its name on first use. `doors` and `area` are as for `scene/:id`. `company` is everyone else there with a body: `{agent, name, avatar, animations}`. `404` for an agent with no body. Changes arrive on `GET /api/state/events` like any record's, and a `whereabouts` or `visit` change means someone came or went |
| `GET /api/ext/builtin:places/map` | every place, and the areas they are in: `{places: [{id, name, kind, agents, area, owner?, purpose?, members?}], areas: [{id, name, places}]}`. `kind` is `lobby`, `hall`, `home` (one per agent with a body, `owner` its agent), `shared`, or `room` (a room agents talk in, `room:<backend>:<id>`). `purpose` is the one its agents gave the place, or a room's own. `agents` is who is in it: a body is in one place at a time, its home, a shared place, or a room's meeting room while it talks there or after going in to change it. A room also lists `members`, every member with a body. `area` is the area's id, `main` for the main building; `areas` lists the main building first, each area's places its way in first |
| `GET /api/ext/builtin:places/transcript/:id` | a room agents talk in, to read: `{id, name, purpose?, members, lines}`, its latest 30 messages oldest first, each `{id, who, agent?, to, text, at, files?}`. `who` is the speaker's name in the room and `agent` the agent behind it, when there is one. Read only: no read cursor moves. `404` for a room that isn't there, `503` with the reason when its transport can't be read |
| `GET /api/ext/builtin:places/scene/:id` | any place on the map, to look at: `{type, id, place, company, doors, area}`, with everyone in it as `company`. A room agents talk in is a meeting room with a seat for each member, its `company` the members there now, drawn fresh until a member changes it and from its record after that; a hall is a corridor with a door for each place off it, always drawn fresh. `place` carries `theme`, `purpose` and `changes` (`[{who, what, at}]`, newest first) when it has them. `doors` is `[{wall, along, to, label, kind, occupant?}]`: the side it is on (`back`, `left`, `front` or `right`), its middle along that side in metres (x on the back and front, z on the left and right), the place it opens on, its plate, what kind of place that is, and for a home the agent whose activity its light shows. `404` for a place that isn't there |
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
