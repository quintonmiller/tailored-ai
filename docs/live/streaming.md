# Getting a slow show onto Twitch

Prices and platform limits checked 2026-08-13 and cited inline.

## The pacing problem, stated honestly

A run is ~200 agent turns in 27–38 minutes: **one action every 8–11 seconds**,
each a paragraph of text and a few numbers moving. Run 3 was measured at 19 of
24 rounds in combat — the party descended one floor and fought two encounters.
The pacing defect behind that has since been fixed (`rule-based` now clears ~5
floors instead of 1), but the underlying tempo does not change: this is a chess
stream, an aquarium cam, a departures board. Not a game stream.

Design for that. Every decision below follows from it, and two of them —
bitrate and encoder class — get *cheaper* because of it.

## The pipeline

```
runner box ──trace──► S3 ──► /broadcast page
                                   │
   encoder box:  Xvfb :99  ──►  headless Chrome ──► x11grab
                                                        │
                              ffmpeg  x264 + AAC ───────┴──► RTMP ──► Twitch
                                        │
                              60–90s delay buffer
```

**Chosen stack: Xvfb + headless Chrome + ffmpeg `x11grab`.** Not OBS.

| option | verdict |
|---|---|
| **Xvfb + Chrome + ffmpeg** | **Chosen.** No GUI, no scene graph, no config database, entirely reproducible from a Dockerfile, and the thing being captured is already a web page. Restart is one process. |
| OBS headless in a container | More moving parts to reproduce a browser source we already have natively. Its value is scenes and transitions, which a web page can do in CSS. |
| Browser-capture SaaS | Removes control of the delay buffer and adds a vendor to a 24/7 dependency chain. |
| Server-side frame rendering, no browser | Would mean reimplementing the canvas renderer twice. The build-step decision in [broadcast-viewer.md](../broadcast-viewer.md) already rejected maintaining two renderers. |

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &

google-chrome --headless=new --disable-gpu --no-sandbox \
  --window-size=1920,1080 --window-position=0,0 --kiosk \
  --autoplay-policy=no-user-gesture-required \
  "https://<site>/broadcast?mode=stream" &

ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :99.0 \
       -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
       -c:v libx264 -preset medium -tune stillimage \
       -b:v 3500k -maxrate 3500k -bufsize 7000k \
       -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p \
       -c:a aac -b:a 160k -ar 44100 \
       -filter_complex "[0:v]tpad=start_duration=75[v]" -map "[v]" -map 1:a \
       -f flv "rtmp://<region>.contribute.live-video.net/app/$STREAM_KEY"
```

Three flags carry weight. `-g 60` at 30fps is the **2-second keyframe interval
Twitch requires** for transcoding and VOD to work. `-tune stillimage` is the
correct tuning for a page that barely moves. And the delay is applied here, in
the encoder, rather than anywhere a run could see it.

## Bitrate, and why this show gets it cheap

Twitch caps Affiliates and Partners at **6,000 kbps** video, and requires a
2-second keyframe interval
([Twitch settings guides](https://bitratecalculator.org/blog/twitch-bitrate-settings-2026),
checked 2026-08-13). A new non-partner channel usually gets **no transcodes** —
viewers receive the source quality or nothing, so a high bitrate actively
excludes people on poor connections.

Both facts point the same way, and so does the content: a mostly-static,
high-contrast page at 30fps is the easiest thing a video codec ever has to
compress.

| profile | egress/month | AWS cost/month¹ | verdict |
|---|---|---|---|
| 1080p60 @ 6,000 kbps | ~1,860 GB | **$158** | Wasteful. There is no 60fps content here. |
| 1080p30 @ 4,500 kbps | ~1,400 GB | **$117** | Fine, and still more than the picture needs |
| **1080p30 @ 3,500 kbps** | **~1,100 GB** | **$90** | **Chosen.** Text stays crisp with `-tune stillimage`; no-transcode viewers can actually watch it |
| 720p30 @ 2,500 kbps | ~800 GB | $63 | The fallback if text legibility survives it — test before choosing |

¹ Data transfer out to the internet, first 10 TB tier at
[$0.09/GB](https://aws.amazon.com/ec2/pricing/on-demand/) after the account-wide
100 GB monthly free allowance.

**Resolution matters more than bitrate here** because the payload is text. Stay
at 1080p and spend the savings on a slower x264 preset, which costs CPU (which
is cheap) rather than bandwidth (which is not).

## The encoder box

`c7g.xlarge`, 4 vCPU Graviton,
[$0.145/hr](https://instances.vantage.sh/aws/ec2/c7g.xlarge) = **$106/month**.

1080p30 with `-preset medium -tune stillimage` on near-static content is a
fraction of what 1080p60 gameplay needs. Test at `slow` first and fall back
through `medium` to `fast` if frames drop; the difference is visible on text.

**Hardware encoding is not worth it.** A `g4dn.xlarge` is roughly $0.53/hr —
about $384/month, or 3.6× the CPU box — to accelerate a workload that is already
comfortable in software at 30fps. NVENC earns its keep at 60fps and high motion;
this is neither.

**Audio is mandatory** — Twitch requires an audio stream, and a silent one is a
supported answer (`anullsrc` above). But see [the case for a
voice](#the-case-for-a-narrator-voice): silence is a wasted channel on a show
whose best content is written prose.

## Making 8-second turns watchable

This is the section that decides whether anyone stays. The page's own review
([endless-descent-improvements.md](../endless-descent-improvements.md)) already
identified most of it; what follows is what specifically serves a broadcast.

### 1. Show the commitment, not just the result

The readied ribbon — five slots filling as agents queue their intents blind to
each other, then resolving together — is already shipped, and for a stream it is
the single most important thing on screen. It converts the dead time between
actions into *suspense*, because the viewer can see four commitments on the table
and knows the fifth is coming. Everything else fills gaps; this one turns the gap
into the content.

### 2. Give a newcomer ten seconds to orient

Someone arriving from a raid or a browse has no context. A permanent instrument
strip — floor, round of horizon, dread, party standing, **and the record to
beat** — answers "what is this and who's winning" without a word of explanation.
The record-to-beat is the load-bearing one: it turns a number nobody understands
into a race.

Below it, permanently, one line: *five AI agents, no win condition, playing until
they die — a scripted bot scores 29,007*. That sentence is the whole pitch and it
should never leave the screen.

### 3. Let the agents talk, and never cut away from it

Sampled party negotiation is, per the page's own review, "the most compelling
content on the page by a wide margin":

> **guardian:** I'm attacking crystal-5 this round. Rogue is down — @cleric can
> you heal or revive them? @mage @ranger — focus the remaining enemies.

That is the show. Chat now has a permanent home rather than rotating; for the
stream, give it more space than the developer view does, and set the type large
enough to read at 3,500 kbps.

### 4. The case for a narrator voice

The narrator already writes one or two sentences per round boundary into a
sidecar. Speaking them turns a silent page into something that works in a
background tab, which is where ambient channels actually live.

Amazon Polly, [prices](https://aws.amazon.com/polly/pricing/) checked
2026-08-13:

| engine | $/M characters | narrator at ~7–14M chars/month |
|---|---|---|
| Standard | $4.00 (first 5M free) | **$9–38/month** |
| Neural | $16.00 | $115–230/month |
| Generative | $30.00 | $216–432/month |
| Long-form | $100.00 | not sensible here |

**Speak selectively, on Neural.** Narrating every round is both expensive and
monotonous; narrating deaths, boss appearances, floor descents, records and the
wipe is perhaps 30% of the volume — **$35–70/month for a voice that sounds
deliberate rather than constant.** Silence between events is correct for this
show, not a gap to fill.

### 5. Music is a trap

A DMCA strike lands on the channel that is the entire brand. Either no music, or
a licensed library, decided before launch and never improvised. Given the
narrator voice above, low ambient room tone — a dungeon's worth of drips and
distant noise, generated or licensed once — costs nothing recurring and is the
safer answer.

### 6. Mark the moments

A member going down, a boss arriving, a level, a wipe, a new record. A 1.5–2
second full-stage treatment, then back. The director already has claim/dwell
machinery for exactly this. Restraint is the whole trick: if everything is a
moment, the pacing problem gets worse rather than better.

### 7. Structure the run into chapters

A drop-in viewer needs to know where they are. Floors are the natural chapter
break — a title card on descent (*floor 34*), a boss card every fifth floor, and
a run card at the start. Three seconds each, and they give the stream a rhythm
that 200 undifferentiated turns do not have.

### 8. Fill the gap between runs deliberately

A wipe is the emotional peak of the format and it should not cut straight to a
loading state. Sequence: the wipe, then the run's final scorecard against the
ladder — *this party scored 6,550; a scripted bot scores 29,007* — held for 30–60
seconds, then the record book, then the next expedition assembling.

That gap is also the honest place to run **the scripted baselines live**. They
cost nothing, they play fast, and watching `rule-based` calmly do everything the
model party forgot is the funniest possible argument for the whole project.

### 9. Real chat, alongside the agents

The panel deliberately shows agent conversation rather than an invented audience.
Real Twitch chat should be **a second, visually distinct lane** — never merged
with agent speech, because a viewer must never be unsure whether a line came from
a model or a person. Ingest is a standard IRC-over-WebSocket connection to
`irc-ws.chat.twitch.tv` with an OAuth token, feeding the adapter seam the page
already documents. Display-only, delayed to match the video, and separately
moderated.

## YouTube

**Not at launch.** A second RTMP output from the same ffmpeg is technically
trivial (`tee` muxer, one extra flag), and it doubles the thing that costs
money — another ~1,100 GB/month, **+$90** — while doubling the moderation
surface and splitting a small audience across two chat rooms.

**Do this instead:** use YouTube for VOD and Shorts. That is where discovery
actually happens for this kind of content, the failure clips are the strongest
asset the project has, and uploading them costs bandwidth once rather than
continuously. Revisit simulcasting when concurrent viewers justify it — the
number to watch is whether Twitch's own discovery has plateaued, not whether the
feature is available.

## Reliability

A stream that dies at 3am and stays dead until morning kills a channel's
standing with the recommendation algorithm, which is worse than the dead air
itself.

| control | detail |
|---|---|
| Watchdog | Poll the Twitch Helix `streams` endpoint every 30s; **alarm at 60 seconds offline** |
| Auto-reconnect | ffmpeg exits on RTMP failure; systemd restarts it in 5s. Chrome and Xvfb stay up — restarting the browser is slower and rarely the problem |
| Browser drift | Restart Chrome on a schedule between runs, not mid-run. A page open for a week will leak |
| Holding card | A static page the encoder switches to: the record book, "the next expedition is assembling", and a countdown |
| The better gap-filler | A replay of the best run so far, or the baselines playing live — both are real content and neither costs model tokens |
| Health from the page itself | The broadcast page should render a visible heartbeat (round number, wall clock). If the encoder is capturing a frozen page, only the page can tell you |

That last row catches the nastiest failure in this pipeline: **ffmpeg happily
encoding a frozen browser**. The stream is up, the bitrate is nominal, Twitch is
receiving video, and it is a photograph. Nothing in the video path detects it —
only a moving element on the page does.

## Build order

| step | done means |
|---|---|
| 1 | ffmpeg pushes a colour-bar test pattern to Twitch and it appears |
| 2 | Xvfb + Chrome renders `/broadcast` against a **finished trace** and reaches Twitch |
| 3 | Same, against a live run, with the 75-second delay in place |
| 4 | Watchdog + auto-reconnect proven by killing ffmpeg on purpose |
| 5 | Holding card switching on run boundaries and on failure |
| 6 | Instrument strip, chapter cards, moment beats |
| 7 | Narrator voice on selected events |
| 8 | Real chat ingest in its own lane |

Steps 1–5 are the stream. Steps 6–8 are the show. Do not start 6 until 5 has
survived a week, because a channel that looks good and disappears overnight is
worth less than a plain one that never does.
