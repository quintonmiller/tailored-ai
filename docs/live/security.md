# What can actually go wrong

Written against the code, with citations, because the intuitive threat model for
"AI agents running unattended in public" is wrong here in a way that matters:
the thing everyone worries about is the smallest risk on the list, and the
things that will actually cost money or reputation are further down.

## The trust boundary, established

**The agents cannot escape the simulation, because there is nothing to escape
into.** Three pieces of evidence:

**1. Simulation tools are pure functions over in-memory state.** Every tool a
descent agent holds is built by one factory, and its `execute` is a synchronous
`(args) => string` (`packages/evals/src/sim/tool.ts:17-41`). There is no
filesystem handle, no child process, no network client in the closure. A thrown
error is caught and returned to the model as `Refused: <message>` rather than
propagating — deliberate, and documented in that file as "a refusal is
information, not a crash."

**2. The tool set is an allowlist, and it contains only simulation tools plus
the party channel.** The harness composes each agent's tools as the declared
allowlist, the simulation's granted tools for that role, and `room`
(`packages/evals/src/harness.ts:668`). The scenario
(`packages/evals/scenarios/23-the-endless-descent.ts`) declares five agents with
class prompts and no core tool names at all — no exec, no file read or write, no
HTTP, no memory, no delegation. The party's only channel to anything outside the
dungeon is talking to each other.

**3. The viewer is a read-only loopback server.** `eval watch` binds explicitly
to `127.0.0.1` (`packages/evals/src/watch.ts:183`) and serves four read paths —
`/events`, `/history`, `/narration`, and static files under `/broadcast`. There
is no POST handler and no write path.

So "agent escapes the simulation" is not the risk. **The risk is that the
simulation's output is untrusted text, and this plan takes that text and puts it
on the public internet and on television.** That reframing drives everything
below.

One consequence worth stating plainly for the launch material, because it is a
genuine and unusual property: *the agents in this show have no tools that touch
the world. They can move, fight, talk to each other, and nothing else.* That is
worth saying out loud, and it is true.

## Risks, ranked by expected loss

### 1. Model output reaching a live broadcast

**Likelihood: certain, eventually. Impact: high, and not technical.**

Five models talk to each other for 200 turns per run, 40 runs a day, forever.
Some of that will be strange; some fraction of the strange will be something you
would not want a clip of. There is no technical fix, only a delay and a policy.

The exposure paths are all of them: the trace, the narrator's prompt (which is
fed model output and generates more), the site's DOM, the video, and — if Twitch
chat is ingested — an inbound path from the public into the same panel.

Mitigations, in order:

| control | cost | catches |
|---|---|---|
| **Broadcast delay of 60–90 seconds** | one config line in the encoder; the run is not live-interactive so a delay costs nothing | Everything, if somebody is looking |
| Automated first pass over `post` events before they render | small; a wordlist plus a length/repetition check | The obvious cases, not the subtle ones |
| Kill switch reachable from a phone | see below | The case where somebody is looking |
| Render model text as **text, never as markup** | should already hold — verify every path in `viewer/broadcast/src/` uses `textContent`, not `innerHTML` | The injection path from model output into the page |
| Chat ingest is display-only, delayed, and separately moderated | see [streaming.md](./streaming.md) | An audience member using the stream as a billboard |

The honest limit: **an unattended channel cannot promise real-time moderation**,
and the plan should not claim to. A 60-second delay plus a documented takedown
path plus a kill switch is what a one-person operation can actually offer, and
saying so is better than implying a moderator is awake.

**The kill switch.** One command that stops the encoder and puts up the holding
card, reachable via SSM Session Manager or a tiny authenticated endpoint, usable
from a phone in under 30 seconds, logging who pulled it and when. Test it before
launch, not after.

### 2. Runaway spend

**Likelihood: moderate. Impact: high and immediate.**

The failure is a loop that keeps calling models — a supervisor bug, a run that
never terminates, a retry storm against a throttling endpoint. At the shortlist's
prices this is hundreds of dollars a night, not thousands, which is exactly the
range that goes unnoticed for a week.

Three layers, because any one of them can be the one that fails:

1. **Per-run token ceiling** in the harness — a run that exceeds it is killed and
   marked, not retried.
2. **Per-day ceiling** in the supervisor, checked between runs and enforced
   mid-run. This is the only control that acts with nobody awake.
3. **An AWS Budget action at the hard monthly ceiling that detaches the runner's
   Bedrock permission.** Blunt, and correct: a dead show is recoverable, a
   surprise invoice is less so.

Plus a budget *alert* at 50/80/100%, which is free.

### 3. Credentials on a box whose output is on television

**Likelihood: low. Impact: severe.**

- **No static AWS keys anywhere.** The runner uses an **EC2 instance role**
  scoped to `bedrock:InvokeModel` on the specific model IDs of the current
  season, plus write to exactly one S3 prefix. The encoder gets an instance role
  with **no Bedrock and no S3 write at all** — it only reads a page and pushes
  RTMP.
- **The Twitch stream key is the one true secret on the encoder.** In Secrets
  Manager, fetched at process start, never written to a log, never an
  environment variable visible in a process listing that a screenshot could
  catch.
- **Nothing secret may enter a trace.** The trace is published verbatim. The
  harness records model, base URL, provider and usage in run metadata; confirm
  before publishing that no key, endpoint credential, or account identifier is
  in there.
- **Scan what gets published, not just what gets committed.** The realistic leak
  vector for a project like this is never `config.yaml` — it is a trace, a doc
  example, a changeset, or a screenshot in a launch post. Automated secret
  scanning is tuned for the first and routinely misses the rest, so the
  pre-publish review has to be a deliberate step rather than a trusted default.

### 4. The public HTTP surface

**Likelihood: moderate. Impact: moderate.**

Today's origin is a loopback server that re-reads files per request. Exposed
directly it would fall over under a front-page spike, and it is on the same box
as the simulation.

The structural fix is that **the origin is S3, not the runner** — CloudFront in
front of a private bucket with Origin Access Control, and the runner never serves
a viewer request. See [website.md](./website.md). That removes the class of
attack rather than mitigating it: there is no path from a viewer to the box that
runs the benchmark.

Keep `eval watch` bound to `127.0.0.1` and reachable only over an SSH tunnel. It
is the developer viewer; it should never be the public one.

### 5. Supply chain and the deploy path

**Likelihood: low. Impact: high.**

A one-person project with a GitHub Actions deploy has exactly one interesting
credential: whatever lets CI push to ECR and touch the account. Use OIDC
federation with a role scoped to that, not a long-lived access key. Pin the base
image by digest. Keep the last five images so a rollback does not need a rebuild.

### 6. Platform account takeover

**Likelihood: low. Impact: high, and unrecoverable in the way that matters.**

The channel, the domain and the social handles are the brand. Hardware MFA on
all of them, recovery codes stored offline, and a separate email address for
platform accounts that is not the one used for everything else. This costs an
afternoon and prevents the failure that cannot be undone by redeploying.

## "Writable only from the instance"

The requirement, made structural.

**The runner is the sole writer. Everything public is a read replica.**

- One S3 bucket, **block all public access on**, split by prefix:
  `traces/`, `records/`, `live/`, `site/`.
- The **runner's instance role** may `PutObject` under those prefixes and
  nothing else. It has no `DeleteObject` on `traces/` or `records/` — a
  compromised or buggy runner should not be able to erase the archive.
- **CloudFront reads via Origin Access Control**; the bucket policy allows
  `s3:GetObject` only to that distribution. No principal on the internet reads
  the bucket directly.
- **Versioning on**, with a lifecycle rule keeping non-current versions for 90
  days. Restores an overwritten record book without a backup restore.
- **The record book additionally gets Object Lock in governance mode**, or a
  nightly copy to a prefix the runner cannot write. It is the one artefact that
  cannot be regenerated.

A policy sketch for the runner role — each statement guarding a specific thing:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "PublishOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": ["arn:aws:s3:::<bucket>/traces/*",
                   "arn:aws:s3:::<bucket>/records/*",
                   "arn:aws:s3:::<bucket>/live/*"] },

    { "Sid": "NoDeletingHistory",
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion",
                 "s3:PutBucketPolicy", "s3:PutBucketVersioning"],
      "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"] },

    { "Sid": "OnlyThisSeasonsModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": ["arn:aws:bedrock:*::foundation-model/<season-model-id>",
                   "arn:aws:bedrock:*:<account>:inference-profile/<profile-id>"] }
  ]
}
```

The third statement is doing quiet double duty: scoping Bedrock to the season's
model IDs is a *cost* control as much as a security one. A bug that switches
model mid-season fails closed rather than silently running Opus at eight times
the price.

**Detecting tampering**: S3 access logging plus a CloudTrail data event on the
bucket, and — cheaper and more useful — publish a hash of each finished trace
into the record book. A record whose trace no longer hashes to its recorded value
is a tampered record, and anyone can check it. That property is worth more for
credibility than for security: it is what lets a stranger verify the leaderboard
rather than trust it.

## What is public

The interesting version of this project publishes almost everything. The
question is what it costs, item by item.

| data | recommendation | why |
|---|---|---|
| Scene snapshots (party, enemies, floor, phase) | **publish** | It is the show |
| Beats (damage, heals, statuses, deaths) | **publish** | The animation data; harmless |
| Readable combat log | **publish** | The show |
| Agent-to-agent chat | **publish, on the broadcast delay** | The most compelling content on the page, and the highest-variance |
| Agent reasoning text | **publish, delayed** | Same trade; it is where the "recognisable failure" content comes from |
| Tool calls and arguments | **publish** | Shows the mechanism; makes the diagnostics legible |
| Milestones, diagnostics, score | **publish** | The result |
| Model ID and version | **publish** | Mandatory. A leaderboard that hides which model played is not a leaderboard |
| Per-turn token counts and per-run cost | **publish** | Unusual, and one of the most interesting numbers on the page. It is a signal about the project's costs, not about a business |
| Latency per call | **aggregate only** | Per-call latency is a fingerprint of provider capacity, not a result |
| Full run trace, raw | **publish for the public arena; never for the held-out arena** | See below |
| Seeds | **publish for the public arena; never for the held-out arena** | See below |
| System prompts and class prompts | **publish** | See below |
| Error and stack traces | **private** | Leaks paths, versions, and account structure for no viewer benefit |

### Three of those deserve the argument

**System prompts.** Publishing them is the right call and it is a real cost:
they are the most reusable artefact the project has, and someone will lift them.
But a benchmark whose prompts are secret cannot be reproduced, and an
unreproducible self-published leaderboard is a claim, not a measurement. Publish
them, and treat being copied as the price of being believed.

**Seeds, and the reason for the held-out arena.** A published seed lets anyone
re-run a record and verify it — which is exactly the credibility property just
argued for. It also lets someone pre-compute a favourable run, and it lets a
future model train on the exact worlds it will be tested in. Both problems are
solved by the split in [README.md](./README.md): the **public arena** publishes
seeds and traces in full, the **held-out arena** publishes only scores. Verify
against the public arena; rank on both; report the gap. If the gap ever opens,
that is contamination, measured.

**Per-run cost.** Slightly unusual to publish, and worth it. "This run cost
$0.42 and scored below a hundred lines of if-statements" is the single most
legible sentence this project can put in front of a stranger.

## Delay and moderation

| | |
|---|---|
| Delay | 60–90 seconds on the video path; the site's live view runs at the same delay so the two agree |
| Automated first pass | wordlist and repetition checks on `post` events, before render; flags rather than blocks, except for a small hard-block list |
| Kill switch | stops the encoder, shows the holding card, logs actor and timestamp |
| Who can pull it | the operator, plus at least one other trusted person — a single point of human failure is the same problem as a single point of technical failure |
| After a pull | the run continues; only the broadcast stops. This matters: stopping the show must not corrupt the measurement |

That last row is the load-bearing one. Because the broadcast is a pure reader,
killing it is free — no run is lost, no number changes. That property was
designed in for measurement reasons and turns out to be the thing that makes
moderation cheap.

## Legal and platform terms

Each of these needs confirming against current terms before launch — they are
flagged as work, not as settled answers.

- **AI-generated content labelling** on Twitch and YouTube. Both platforms have
  disclosure requirements for synthetic content; a channel whose entire output is
  model-generated should label it prominently and in the about panel regardless
  of the minimum requirement. **Verify current wording before launch.**
- **Unattended / 24-7 streaming rules.** Both platforms have had rules about
  unattended broadcasts and rebroadcast content. **Verify.**
- **Music.** The cheapest licensing mistake to make and the easiest to avoid:
  either no music, or a licensed library. Never anything that could produce a
  DMCA strike on a channel that is the whole brand.
- **Bedrock acceptable use** for publicly broadcasting model output, and any
  attribution requirement for the specific model families used.
- **Model vendor sensitivities.** A public leaderboard that says a named
  commercial model plays worse than a scripted bot is fair comment, and it is
  also the kind of claim that attracts correction. Publish the methodology, the
  seeds, and the qualifying runs alongside the ranking, and describe results as
  *"on this benchmark, at this configuration"* every single time.
- **Benchmark contamination is a terms-adjacent issue too**: publishing the
  arena degrades it. The held-out split is the mitigation and it should be
  described in public, not just implemented.

## Pre-launch checklist

- [ ] Instance roles in place; **zero static AWS keys** on either box
- [ ] Bedrock permission scoped to the season's model IDs only
- [ ] Bucket public access blocked; CloudFront OAC configured; versioning on
- [ ] Runner cannot delete from `traces/` or `records/`
- [ ] Record book has a second copy the runner cannot write
- [ ] Budget alerts at 50/80/100% + a budget action at the hard ceiling, tested
- [ ] Per-day token ceiling enforced in the supervisor, tested by lowering it
- [ ] Kill switch tested from a phone, by someone who is not the author
- [ ] Broadcast delay verified end to end
- [ ] Every render path for model text confirmed to use `textContent`
- [ ] A published trace reviewed by eye for anything credential-shaped
- [ ] Hardware MFA on AWS, GitHub, Twitch, the registrar and every social handle
- [ ] AI-content labelling present in the stream, the about panel and the site
- [ ] Music licensing settled, or no music

## Incident runbook

| incident | first move | then |
|---|---|---|
| Offensive output on stream | Kill switch. Holding card up. | Pull the VOD segment, note the trace and turn, decide whether the filter should have caught it, publish a note if it was visible |
| Credential exposed | Rotate at the source (Twitch key, AWS role, GitHub OIDC) before anything else | Then find how it got out; the trace and the docs are the likely paths |
| Runaway spend | Budget action should already have cut Bedrock. Confirm, then stop the supervisor. | Find the loop before restarting. Do not raise the ceiling to get the show back up |
| Site defaced or wrong content served | Invalidate CloudFront, restore the S3 version | Then work out how a write happened, because by design there is exactly one writer |
| A record looks wrong | Check the trace hash in the record book | If it fails, the record is void; say so publicly. Doing this once, visibly, is worth more than never having to |

## One repo-hygiene finding

The scenario's opening room message is attributed to a speaker named after a
real person (`packages/evals/scenarios/23-the-endless-descent.ts`, the `rooms[].incoming`
block). This repository is public and its own conventions require examples to use
role names rather than real identities, precisely because example text spreads by
copy-paste. With the scenario about to be broadcast and published, that line
should become a role — `quartermaster`, `the one who sent you`, or nothing at
all. It is a one-word change and it is easier now than after it is on television.
