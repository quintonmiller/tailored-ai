# The site

The stream is the ambient feed. The site is where the numbers are, and it is the
half that survives the stream being offline.

AWS prices checked 2026-08-13, cited inline.

## What the site is for

The stream answers *what is happening*. The site has to answer four questions the
stream cannot, and each one earns a page.

| page | the question | why it earns its place |
|---|---|---|
| **Live** | what is happening right now | The landing page during a run. Same renderer as the broadcast, plus the things a video frame can't give you: selectable text, links, a scrollback |
| **The ladder** | is this score good? | **The most important page on the site.** Six scripted parties spanning 37×, and where the models land among them. Without it a score is a number; with it, it is a verdict |
| **Run archive + replay** | what happened in run 412? | The trace is a complete recording. Replay is nearly free and it is the strongest feature here — see below |
| **Records** | what is the best anyone has done? | The reason to come back. Best ever, this season, today, by model |
| **What is this** | I came from Twitch, what am I looking at? | Two minutes of reading for someone with zero context. Without it, the traffic the stream sends here bounces |

Two more that earn their place as the project accumulates data:

- **Per-run diagnostics** — "never visited a merchant", "attacked into an
  immunity 30 times", "ten deaths, zero revives, soul stone in the pack the whole
  time". These are the funniest and most legible artefacts the benchmark
  produces, and they are already computed. They should be first-class, not
  buried in a JSON blob.
- **Model comparison** — the leaderboard across models, with the qualifying runs
  and the tool-correctness numbers. This is what an ML reader arrives for, and it
  becomes the reason the project gets cited rather than just watched.

### Replay deserves the argument

A trace is an ordered, complete, deterministic record of a run, and the broadcast
page is already a pure function of that record. Replay is therefore *the same
renderer with a different data source and a scrubber* — no new rendering code, no
new data model, no simulation re-run.

That buys a great deal:

- Every run becomes a permanent, linkable artefact. "Run 412, round 31" is a URL.
- Clips for social become a matter of pointing at a timestamp rather than editing
  video.
- The archive is what makes the project useful to someone who was asleep, which
  is most people most of the time.
- It is the verification surface: publish the seed and the trace, and a stranger
  can check that the record book is telling the truth.

The one thing it needs that does not exist: an index. A directory of 1.2 MB
NDJSON files is not browsable. A small per-run JSON summary — model, seed, score,
survivors, floors, the three most interesting diagnostics — written alongside
each trace, and a season index that lists them.

```
┌─────────────────────────────────────────────────────────────┐
│  ▣ LIVE   floor 34 · round 28/40 · 3 standing               │
│                                          record 29,007 (bot)│
├──────────────┬────────────────────────────┬─────────────────┤
│   MAP        │        STAGE               │   PARTY TALK    │
│              │                            │  (permanent)    │
│              │   ┌──────────────────────┐ │                 │
│  RECORDS     │   │  readied ribbon      │ │─────────────────│
│              │   └──────────────────────┘ │   NARRATOR      │
├──────────────┴────────────────────────────┴─────────────────┤
│  THE LADDER    greedy 1,220 │ random 2,198 │ basic 3,754    │
│  ▲ this run 6,550           │ tactics 12,350 │ rule 29,007  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  RUN 412 · qwen3-32b · seed 1104 · 2026-09-02        REPLAY │
│  ├──────────────●────────────────────────────────────────┤  │
│  round 31/40                                    ▶ 1× 2× 8×  │
├─────────────────────────────────────────────────────────────┤
│  score 6,550   floors 5   survivors 0   tool calls 91%      │
│  vs basic-tactics 3,754  ✔      vs rule-based 29,007  ✘     │
├─────────────────────────────────────────────────────────────┤
│  DIAGNOSTICS                                                │
│  ✘ never visited a merchant, finished holding 17,180 gold   │
│  ✘ 10 deaths, 0 revives — soul stone in ranger's pack       │
│  ✘ attacked into a known immunity 30 times                  │
│  ✔ never fell for the same hidden mechanic twice            │
└─────────────────────────────────────────────────────────────┘
```

## Architecture

The existing reader was written for one developer on localhost: `eval watch`
binds `127.0.0.1` and re-reads files per request
(`packages/evals/src/watch.ts:183`). None of that survives contact with an
audience, and none of it should — **the runner must never serve a viewer
request**, because the box running the benchmark cannot be allowed to fall over
because the show got popular.

**Chosen: the runner publishes to S3; CloudFront serves everything; the page
polls a snapshot.**

```
runner ──put──► S3  live/scene.json      (overwritten every ~3s, TTL 5s)
                    live/events-<n>.json (append-only chunks, TTL 1y)
                    traces/<run>.ndjson  (immutable, TTL 1y)
                    records/book.json    (TTL 60s)
                    site/*               (immutable, hashed filenames)
                         │
                    CloudFront (OAC) ──► viewers
```

Weighed against the alternatives:

| option | why not |
|---|---|
| Page polls the runner directly | Puts viewer load on the benchmark box. Disqualifying. |
| Small origin server + SSE/WebSocket | Genuinely lower per-viewer cost at scale, and it reintroduces an always-on stateful box, connection management, and a component that can wedge. Revisit only if the request-cost table below actually bites. |
| CloudFront cached against a live origin | Same box problem, one layer removed. |
| **S3 snapshot + CDN + polling** | **Chosen.** No origin to knock over, no connection state, and the delay it introduces is a *feature* — see below. |

### The delay is the moderation buffer

Publishing on a 60–90 second delay and caching the snapshot for 5 seconds means
the CDN *is* the broadcast delay ([security.md](./security.md)), and the site and
the stream agree with each other because both sit behind the same buffer. A
design that fought for sub-second liveness would have to build a separate
moderation delay anyway. Two requirements, one mechanism.

Nobody watching an 8-second-per-turn show notices a 5-second cache TTL.

### The read-only contract, structurally

The founding rule — a run's numbers are identical whether or not anybody is
watching — is enforced by topology here, not by discipline:

1. The site's origin is an S3 bucket. There is **no code path from a viewer to
   the runner**, in either direction.
2. The bucket has exactly one writer, the runner's instance role, and CloudFront
   reads via OAC ([security.md](./security.md)).
3. The page has no POST, no form, no API. Adding interactivity would require
   building an entire component that does not exist, which is exactly the amount
   of friction that rule deserves.

## Scale, and where it breaks

Assume the live page polls a ~30 KB snapshot every 5 seconds.

| viewers | requests/month | bytes/month | CloudFront cost | what breaks |
|---|---|---|---|---|
| 10 | 5.2M | 155 GB | **$0** — inside the 1 TB + 10M request free tier | nothing |
| 500 | 259M | 7.8 TB | **~$860** ($259 requests + ~$600 transfer) | the bill |
| 20,000 | 10.4B | 312 TB | **~$34,000** | everything |

[CloudFront pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/):
1 TB and 10M requests free monthly, then $0.085/GB and $0.0100 per 10,000 HTTPS
requests in North America. Origin fetches from S3 are free.

**Requests dominate, not bytes**, and polling scales requests linearly with
viewers. Three responses, in order of how much they matter:

1. **Twitch is the CDN for the live view.** Above a threshold, the live page
   should embed the Twitch player rather than render locally — Twitch pays that
   bandwidth, they are extremely good at it, and it is free. The site's own
   renderer is for people who want the data view, which will always be a
   minority. This is not a fallback; it is the correct primary design, and it
   means a front-page spike costs almost nothing.
2. **Everything except the live view is static and cacheable for hours.** The
   archive, ladder, records and explainer survive 20,000 concurrent readers on
   the free tier, because they are files.
3. **Back off the poll under load.** 5 seconds at low viewer counts, 15 at high;
   the content changes every 8–11 seconds anyway, so a 15-second poll loses
   nothing. That alone cuts the 500-viewer request bill by two thirds.

With those, the realistic 500-viewer bill is **well under $100/month**, and the
spike case is a Twitch problem rather than an AWS one.

## Frontend work

The broadcast page is a fixed 16:9 built to be filmed. Making it a website is
real work, and here is the honest sizing.

| work | files | size |
|---|---|---|
| Read from published snapshots instead of `/events` polling | `viewer/broadcast/src/state.js` | **small** — it is already the single fetch boundary, by design |
| Replay: same renderer, trace as source, plus a scrubber | `state.js` + a new control | **small–medium** — the payoff-to-cost ratio here is the best on the list |
| Responsive / mobile | `style.css`, `director.js` | **large.** A 16:9 three-column dashboard does not reflow. Mobile needs its own layout: stage, party, chat, stacked — and it is where most Twitch-referred traffic will come from |
| The ladder page | new | **medium** — new page, but the data is already computed by `bench` |
| Archive index + per-run summary | new page + a small writer in the publisher | **medium** |
| "What is this" explainer | new, static | **small**, and the highest return per hour of anything here |
| Accessibility: a text path to canvas content | new | **medium**. See below |
| SEO + social preview cards | head tags + a card renderer | **small–medium**. A per-run card showing score against the ladder is what makes a shared link work |
| Theme | `style.css`, `stage.ts` | **decision first** — three directions are drawn in [endless-descent-improvements.md](../endless-descent-improvements.md) §2; [branding.md](./branding.md) picks one |

### Accessibility is cheap now and expensive later

The stage is a `<canvas>`, which is invisible to a screen reader. The fix is not
to annotate the canvas — it is to render the *log and scene as real DOM* in a
visually-hidden region, which the trace already provides verbatim. Designed in
now it is an afternoon; retrofitted after the renderer has grown it is a rewrite.

The same region doubles as the SEO surface and as the plain-text view for anyone
on a slow connection, which makes it three features for one.

## Domain and operations

- **Domain**: name chosen in [branding.md](./branding.md); register it and every
  matching handle before the name appears anywhere public.
- **TLS**: ACM certificate in `us-east-1` for CloudFront, free.
- **DNS**: Route 53, [$0.50/month per hosted
  zone](https://aws.amazon.com/route53/pricing/) plus $0.40 per million queries;
  alias records to AWS resources are free.
- **When the run is down** — and an endless show still has gaps — the site must
  not show a broken live view. It should show the record book, the last run's
  scorecard, and when the next expedition starts. The publisher writes a
  `status` field into the snapshot; the page reads it and switches. This is the
  same holding-card content as the stream, and it should be built once.
- **Analytics** without a cookie banner: server-side counts from CloudFront
  access logs, or a privacy-preserving hosted analytics product. Do not put a
  third-party script on a page whose entire premise is that it only reads.

## What the site must not publish

[security.md](./security.md) owns the full classification. The site's own
position, stated so the frontend does not have to re-derive it each time:

- **Publish**: everything the run produced — scene, beats, log, agent chat,
  reasoning, tool calls, diagnostics, score, model ID and version, seed, and the
  per-run cost. Reproducibility is the whole basis for believing a self-published
  leaderboard.
- **On the delay**: anything containing model-generated prose.
- **Never**: error and stack traces, and anything from the held-out arena beyond
  its score.

The seed question is the one that looks like a mistake and is not: publishing
seeds for the public arena is what lets a stranger verify a record, and the
held-out arena is what stops that verifiability from turning into a training set.
