# The box, the loop, and everything that has to survive 3am

AWS prices verified 2026-08-13 and cited inline. Model token cost is
[models.md](./models.md) and is excluded from every table here.

## Topology

Two small instances, not one medium one, and not a cluster.

```
                    ┌──────────────────────────────────────┐
                    │  RUNNER      c7g.large               │
   Bedrock ◄────────┤  supervisor loop                     │
   (models)         │  eval run  (one at a time)           │
                    │  eval narrate (sidecar process)      │
                    │  publisher → S3                      │
                    └───────────┬──────────────────────────┘
                                │ trace + scene snapshots
                                ▼
                        ┌───────────────┐        ┌──────────────┐
                        │  S3 (private) │◄───────┤  CloudFront  │──► viewers
                        │  origin       │  OAC   │              │
                        └───────┬───────┘        └──────────────┘
                                │ read-only
                    ┌───────────▼──────────────────────────┐
                    │  ENCODER     c7g.xlarge              │
                    │  Xvfb + headless Chrome → /broadcast │
                    │  ffmpeg → RTMP                       │──► Twitch
                    └──────────────────────────────────────┘
```

**Why split.** The encoder pegs its CPU continuously; the runner must not miss a
Bedrock response because a video frame was late. More importantly the encoder is
the component that gets restarted most often — a dropped stream, a browser leak,
a codec change — and restarting it must never touch a run in progress. Two
processes with entirely different failure rates and restart cadences do not
belong under one supervisor.

**Why not one bigger box.** A `c7i.2xlarge` (8 vCPU, 16 GiB) at
[$0.357/hr](https://instances.vantage.sh/aws/ec2/c7i.2xlarge) is $261/month and
does both jobs badly-isolated. The two-box split is `c7g.large` + `c7g.xlarge`
at **$159/month on demand** — cheaper *and* better isolated. That is unusual and
worth taking.

**Why Graviton.** Everything here is Node and ffmpeg, both of which are entirely
happy on ARM, and `c7g` is roughly 20% cheaper than the equivalent `c7i`
([$0.145/hr](https://instances.vantage.sh/aws/ec2/c7g.xlarge) for 4 vCPU vs
$0.357 for 8). The one thing to check before committing is that
`better-sqlite3` builds on arm64 in the deployment image — it is a native
module, it does, but it is the sort of thing that turns a deploy into an
afternoon if discovered late.

**Why not Spot, for either.** A Spot interruption on the runner throws away a
half-finished run — 20 minutes of tokens and a hole in the broadcast. A Spot
interruption on the encoder drops the stream, and a channel that goes dark
unpredictably is worse than one that runs 16 hours a day predictably. Spot is
correct for the *held-out arena*, which nobody watches and which can restart
freely.

## The supervisor

This is the piece that does not exist. `eval run` executes a batch and exits;
everything about running forever is unwritten, and nothing else in this plan can
start until it does.

### What it has to do

```
loop:
  pick a configuration        (season's ranked config, or an exhibition slot)
  pick a seed                 (deterministic sequence, recorded, never repeated
                               within a season)
  start `eval run` as a child process
  start `eval narrate` against the trace it is writing
  while the run is alive:
      watch the trace for forward progress
      publish new trace lines and the current scene to S3
      if no new turn in N minutes  -> kill, mark wedged, back off
      if the token ceiling for today is hit -> stop, hold, alert
  on exit:
      publish the final trace, the result summary, the diagnostics
      update the record book
      if the run failed: increment the failure counter, back off
      if it succeeded: reset the failure counter
  sleep(inter-run gap)         (the "next expedition assembles" card)
```

### Specification

| decision | choice | why |
|---|---|---|
| process model | **systemd unit on the host**, `Restart=always`, `RestartSec=30` | The runner is one long-lived Node process supervising children. systemd already does crash-restart, log capture, and boot ordering; a container adds a layer without removing one. |
| run isolation | each `eval run` is a **child process**, killed by process group | A wedged run must die completely, including the narrator, without taking the supervisor with it |
| progress watchdog | no new `turn` event in **5 minutes** → kill the run | The distinctive failure here is not a crash, it's a stall — a model call that never returns, or a party that stops calling tools. A crash announces itself; a stall does not. |
| run timeout | hard ceiling at 2× the configuration's expected wall clock | Backstop for a watchdog that itself misjudges |
| back-off | 30s → 2min → 8min → 30min, capped; reset on a clean run | Absorbs a Bedrock throttle or a regional blip without hammering |
| after 5 consecutive failures | stop starting runs, alert, switch the broadcast to bot rehearsals | Failing loudly and cheaply beats burning tokens into a broken configuration overnight |
| seeds | a recorded sequence per season, never repeated within it | Repeats are what make a score mean something; accidental repeats are what make it a lie |
| stopping | `systemctl stop` **and** a sentinel file the loop checks each iteration | The sentinel lets a stop be requested from anywhere the box can be written to, including a phone via SSM |
| token ceiling | per-day input-token budget, checked between runs and enforced mid-run | The only control that acts without a human awake — see [models.md](./models.md) |

### New code, honestly sized

| piece | where | rough size |
|---|---|---|
| `eval serve` — the supervisor loop | `packages/evals/src/serve.ts` | 250–400 lines |
| trace tailer + S3 publisher | `packages/evals/src/publish.ts` | 150–250 lines |
| progress watchdog + child lifecycle | inside `serve.ts` | included above |
| Bedrock provider wiring for the eval harness | check `packages/provider-bedrock` reaches the harness config | unknown until tested — **verify first** |
| per-run cost accounting into the result JSON | `harness.ts`, populating the existing null `cost` field | 30 lines |

The supervisor is a **new command in `packages/evals`, not core platform work**.
It orchestrates the benchmark; it does not add a capability to the agent runtime.
Per the repo's tiering rule that puts it firmly in the package that owns it.

One design constraint worth stating up front: **the supervisor must never write
into a trace**. It reads, it publishes, it kills. The moment it can edit a run's
record, "the broadcast does not change what is measured" stops being structurally
true and becomes a promise.

## Deployment

Proportionate to a one-person operation:

- **Artefact**: a container image in ECR, built by GitHub Actions on push to
  `main`, tagged with the commit SHA. ECR storage is
  [$0.10/GB-month](https://aws.amazon.com/ecr/pricing/) and pulls to EC2 in the
  same region are free.
- **Rollout**: pull the new image, then wait for the current run to finish before
  restarting the runner. A deploy that interrupts a run costs tokens and puts a
  hole in the record book. The supervisor should expose "finish this run then
  exit" as its normal restart path, and `systemd` should not force it.
- **The encoder can restart immediately** — the worst case is a few seconds of
  stream gap, and the holding card covers it.
- **Rollback** is re-pinning the previous SHA. Keep the last five images.
- **The season's configuration is part of the artefact**, not a runtime flag.
  A ranked run's fingerprint has to be reproducible from a commit, and that
  breaks the moment a human can change the round count over SSH.

## State and storage

Measured: a descent trace is **~1.2 MB**, its narration sidecar ~12 KB. At 40
runs a day that is **48 MB/day, 1.4 GB/month, ~17 GB/year**.

Storage cost is therefore not a consideration — a year of every trace ever
written is well under a dollar a month on S3. Retention should be decided on
what makes the archive useful, not on cost. Keep everything.

| artefact | home | why |
|---|---|---|
| traces, narration sidecars | S3, one prefix per season | Immutable once the run ends; the site's replay reads them directly |
| the record book / scoreboard | S3 **with versioning on**, plus a nightly copy to a second prefix | The only irreplaceable artefact here. Traces regenerate; records do not. |
| result summary JSON per run | S3, alongside the trace | Carries the model, seed, git SHA and fingerprint — the reproducibility receipt |
| the live scene snapshot | S3, overwritten every few seconds, short cache TTL | See [website.md](./website.md) |
| everything on the instances | disposable | Both boxes should be rebuildable from the image and nothing else |

`results/` on the runner still needs a rotation job — the scoreboard scans that
directory and a year of runs in it is 17 GB of local disk and a directory scan
on every request. Publish, then prune to the last ~50 runs locally.

## Observability

Alarm on the things that make the show *wrong*, not on the things that make it
noisy.

| alarm | threshold | why it matters |
|---|---|---|
| No new turn published | 10 minutes | Covers wedged run, dead supervisor, dead box — one alarm for the whole class |
| Run failure streak | 3 consecutive | Something structural broke; tokens are being burned into nothing |
| Model error rate | >10% of calls in a run | Throttling, a bad model ID, a schema change |
| Stream offline | 60 seconds | See [streaming.md](./streaming.md) — this is the one with the shortest fuse |
| Day's token spend | 80% of ceiling | The runaway-cost early warning |
| Disk | 80% | Boring, and it will happen if rotation is forgotten |

Cost, with [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
checked 2026-08-13: the free tier covers 10 custom metrics, 10 alarms, 5 GB of
log ingest and 5 GB of storage per month. Six alarms and a handful of metrics
fit inside it. Log ingest is the variable — at $0.50/GB for the Standard class,
keep the runner's logs terse or use the Infrequent Access class at $0.25/GB.
**Budget $5–15/month** and be surprised if it is more.

For the 3am notification, the arithmetic is lopsided and worth knowing:

| channel | cost |
|---|---|
| Mobile push via SNS | $0.50 per **million**, first million free — effectively free |
| Email | first 1,000/month free, then $2.00 per 100,000 |
| SMS to a US number | ~$0.012 **per message part**, plus a ~$11/month floor for an origination identity (10DLC number $1 + campaign $10) |

Push, then. SMS costs a fixed $11/month before the first message and buys
nothing that a push notification does not.

AWS Budgets basic monitoring and notifications are
[free](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/); only
action-enabled budgets beyond the first two cost anything ($0.10/day). Set three
budget alerts at 50/80/100% and one budget *action* that revokes the runner's
Bedrock permission at the hard ceiling — that action is worth its $3/month.

## The monthly bill

Excluding model tokens. Prices as cited above, us-east-1, 2026-08-13.

| line | lean | comfortable |
|---|---|---|
| Runner `c7g.large` | $53 (on demand) | $35 (1-yr reserved) |
| Encoder `c7g.xlarge` | $106 | $70 (1-yr reserved) |
| EBS, 30 GB gp3 × 2 | $5 | $5 |
| Public IPv4 × 2 | $7 | $7 |
| S3 storage + requests | $1 | $3 |
| CloudFront | $0 (inside the 1 TB free tier) | $10 |
| Route 53 hosted zone + queries | $1 | $1 |
| CloudWatch | $5 | $15 |
| ECR | $1 | $2 |
| **Stream egress to Twitch** | **$76** (3 Mbps) | **$119** (4.5 Mbps) |
| **Total** | **~$255/month** | **~$267/month** |

Two things stand out. First, **the stream's outbound bandwidth is the second
largest line after compute** — a 24/7 upstream at 4.5 Mbps is ~1.4 TB/month, and
at $0.09/GB beyond the 100 GB free allowance that is $119. Dropping to 3 Mbps
saves $43/month and costs picture quality on a mostly-static page, which is a
better trade here than almost anywhere else. See [streaming.md](./streaming.md).

Second, **reserving the instances saves $54/month (34% of compute)** but locks in
a year of a project that might not find an audience. Run on demand for the first
90 days, then decide with the kill criterion in [README.md](./README.md) in hand.

## Failure modes

| what breaks | how you notice | what you do |
|---|---|---|
| Run wedges — model call never returns | No-new-turn alarm at 10 min | Watchdog kills at 5 min and starts the next run; no human needed |
| Model returns garbage forever — party stops calling tools | Tool-correctness collapses; run scores near zero | Not automatable. Weekly review catches it. A model that does this fails the qualifying gate in [models.md](./models.md) |
| Bedrock throttles | Model error rate alarm | Back-off handles it; sustained throttling switches the broadcast to bot rehearsals |
| Supervisor dies | systemd restarts in 30s; no-new-turn alarm if it can't | Restart is automatic; repeated restarts alert |
| Runner box dies | No-new-turn alarm | Rebuild from image. Traces already published; only the in-flight run is lost |
| Narrator dies | Narration stops appearing; nothing else changes | Deliberately: it is a sidecar and the run does not depend on it. Restart on the next run boundary |
| Encoder drops frames / stream stalls | Stream-offline alarm at 60s | Restart the encoder; holding card covers the gap |
| Trace grows unboundedly | Disk alarm | A run's trace is bounded by its round count; an *unbounded* one means the supervisor failed to kill a run — same watchdog |
| Disk fills with old runs | Disk alarm at 80% | Rotation job; prune to last 50 locally |
| Spend runs away | Budget alert at 80%, budget action at 100% | The action revokes Bedrock access. Deliberately blunt |

## Build order

| phase | done means |
|---|---|
| **0** Prove headless | One `eval run` completes on a `c7g.large` against Bedrock, nobody logged in, spend ceiling set, one alarm firing correctly. Confirms the provider wiring, which is the unknown. |
| **1** The loop | `eval serve` runs unattended for 72 hours: survives a kill -9, a simulated throttle, and a deploy, and the record book is intact afterwards |
| **2** Publish | Traces land in S3 within seconds of being written, and the site reads them ([website.md](./website.md)) |
| **3** Encode | The encoder box renders `/broadcast` and reaches Twitch ([streaming.md](./streaming.md)) |
| **4** Harden | Alarms proven by breaking things on purpose, budget action tested, rollback tested |

Phase 0 has one genuine unknown in it — whether the eval harness can target
Bedrock today or whether that wiring is missing — and it should be answered in
the first hour, because everything downstream is priced on the answer.
