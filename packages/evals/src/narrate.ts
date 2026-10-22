/**
 * A commentator that can only watch.
 *
 * The idea is a narrator agent that observes a run and says what is happening.
 * "Observes" is the load-bearing word, and it is why this is a separate command
 * with its own process rather than a flag on `run`.
 *
 * A narrator is a model. A model that watches costs tokens, takes time, and —
 * if it were wired into the loop — would appear in the run's usage, its
 * latency, and potentially its transcript. Every number this package produces
 * is meant to be comparable with every other, so a run made while somebody was
 * watching has to be byte-identical to one made in private. The only way to
 * guarantee that is for the observer to live outside the run entirely:
 *
 *   - it reads the trace file, which is append-only and already being written
 *   - it writes `<trace>.narration.ndjson` beside it, which nothing reads back
 *   - it can be started, stopped or killed at any point with no effect at all
 *
 * If this process dies mid-run, the run does not notice. That is the whole
 * design.
 *
 * ## Why it is told so little
 *
 * The digest below is deliberately thin: what changed this round, who is hurt,
 * what is on the floor. It is not given the agents' reasoning, their tool
 * results, or the scenario's intent. A commentator who can see the players'
 * cards stops describing a game and starts explaining it, which is both less
 * watchable and — because it would be summarising the very reasoning the
 * benchmark is measuring — a way to smuggle an interpretation into what looks
 * like a neutral record.
 */

import { appendFileSync, existsSync, statSync } from "node:fs";
import { readTrace, type TraceEvent } from "./trace.js";

export interface NarrateOptions {
  tracePath: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  /** Stop after this many rounds. Unbounded by default. */
  maxRounds?: number;
  /** How often to look for new events. */
  pollMs?: number;
  /** Called with each line, for a console view. */
  onLine?: (line: string, round: number) => void;
  /**
   * Anything that went wrong loudly enough to explain a silent narrator.
   * A dropped line is not fatal here by design, which is exactly why the
   * reason for one has to reach somebody.
   */
  onNote?: (note: string) => void;
}

const SYSTEM =
  "You are the commentator on a live broadcast of five AI agents playing an endless dungeon crawl. " +
  "You are watching, not playing, and you cannot affect anything. " +
  "Given what just happened in a round, say one or two short sentences about it, in the present tense, " +
  "the way a sports commentator would. Be specific about names and numbers you were given. " +
  "Never invent anything you were not told. Never give the party advice — they cannot hear you. " +
  "Vary your openings; do not start consecutive lines the same way. " +
  // Added after a narrator reported that a character paid a toll "trusting the
  // rogue's scout report" on a round where the rogue had not scouted at all.
  // The events were real and the reason joining them was invented, which is the
  // failure the blanket "never invent" line did not prevent: a commentator
  // reaches for cause because that is what makes a sentence feel like
  // commentary.
  "Report what they did, never why they did it. You are told actions and numbers, never intentions — " +
  "if a reason is not in front of you, leave it out rather than supplying a plausible one. " +
  // Added after six consecutive rounds of a backtracking party were rendered as
  // six synonyms for "finds nothing new".
  "When a round is uneventful, say so briefly and move on; do not dress up an empty round as an event.";

/**
 * One round, reduced to what a commentator can see from the stands.
 *
 * Built from the `scene` on the newest `state` event plus the round's own
 * announcement, which already contains the combat log in readable prose. The
 * agents' posts are included because what the party says to each other is the
 * most watchable thing in the run — and it is public, in the sense that it is
 * what a spectator of the room would hear.
 */
export function digest(events: TraceEvent[], round: number): string | null {
  const resolved = [...events]
    .reverse()
    .find(
      (e): e is Extract<TraceEvent, { kind: "state" }> =>
        e.kind === "state" && e.round === round && e.resolved === true,
    );
  const scene = (
    resolved ?? [...events].reverse().find((e): e is Extract<TraceEvent, { kind: "state" }> => e.kind === "state")
  )?.snapshot?.scene as Record<string, unknown> | undefined;

  const nextRoundEvent = [...events]
    .reverse()
    .find((e): e is Extract<TraceEvent, { kind: "round" }> => e.kind === "round" && e.round === round + 1);
  const currentRoundEvent = [...events]
    .reverse()
    .find((e): e is Extract<TraceEvent, { kind: "round" }> => e.kind === "round" && e.round === round);
  const turns = new Map(
    events.filter((e): e is Extract<TraceEvent, { kind: "turn" }> => e.kind === "turn").map((e) => [e.turn, e.round]),
  );

  const said = events
    .filter(
      (e): e is Extract<TraceEvent, { kind: "post" }> =>
        e.kind === "post" && (turns.size === 0 || turns.get(e.turn) === round),
    )
    .slice(-4)
    .map((e) => `${e.agent}: ${e.body.replace(/\s+/g, " ").slice(0, 220)}`);

  const announce = resolved?.announce ?? nextRoundEvent?.announce ?? currentRoundEvent?.announce;
  if (!scene && !announce) return null;

  const party = (scene?.party as Array<Record<string, unknown>> | undefined) ?? [];
  const enemies = (scene?.enemies as Array<Record<string, unknown>> | undefined) ?? [];

  const lines: string[] = [];
  lines.push(`Round ${round + 1}. Floor ${scene?.floor ?? "?"}, ${scene?.phase ?? "?"}.`);
  if (party.length) {
    const nameOf = (p: Record<string, unknown>) => {
      const identity = p.identity as Record<string, unknown> | undefined;
      const displayName = typeof identity?.displayName === "string" ? identity.displayName : String(p.id ?? "?");
      return `${displayName} (${p.id})`;
    };
    lines.push(
      `Party: ${party.map((p) => (p.dead ? `${nameOf(p)} DOWN` : `${nameOf(p)} ${p.hp}/${p.maxHp}`)).join(", ")}`,
    );
    if (round <= 1) {
      lines.push(
        `The cast: ${party
          .map((p) => {
            const identity = p.identity as Record<string, unknown> | undefined;
            return `${nameOf(p)}, ${String(identity?.archetype ?? "personality unrecorded")}; public aim: ${String(
              identity?.publicAspiration ?? "unknown",
            )}`;
          })
          .join(" | ")}`,
      );
    }
    const disclosed = party.flatMap((p) => {
      const identity = p.identity as Record<string, unknown> | undefined;
      const goal = identity?.secretGoal as Record<string, unknown> | undefined;
      return (goal?.revealed || goal?.completed) && goal?.title
        ? [`${nameOf(p)}'s ${goal.completed ? "completed" : "revealed"} motive: ${goal.title}`]
        : [];
    });
    if (disclosed.length) lines.push(`Known personal motives: ${disclosed.join("; ")}.`);
  }
  if (enemies.length) {
    lines.push(
      `Against them: ${enemies
        .map((e) => `${e.name} ${e.hp}/${e.maxHp}${e.telegraph ? ` (${e.telegraph})` : ""}`)
        .join(", ")}`,
    );
  }
  lines.push(...movedThisRound(events, round, enemies));
  if (announce) lines.push(`What happened:\n${announce}`);
  if (said.length) lines.push(`They are saying:\n${said.join("\n")}`);
  return lines.join("\n");
}

/** Counters worth a sentence when they move, and what to call them out loud. */
const NOTEWORTHY: Array<[key: string, singular: string, plural: string]> = [
  ["elitesDefeated", "an elite went down", "elites went down"],
  ["bossesDefeated", "a boss went down", "bosses went down"],
  ["secretRoutesFound", "a hidden way was found", "hidden ways were found"],
  ["tollsPaid", "a toll gate was paid open", "toll gates were paid open"],
  ["locksPicked", "a lock was picked", "locks were picked"],
  ["trapsDisarmed", "a trap was disarmed", "traps were disarmed"],
  ["trapsTriggered", "a trap went off", "traps went off"],
  ["goldTransfers", "gold changed hands", "gold changed hands"],
  ["pooledPurchases", "the party pooled up to buy something", "pooled purchases were made"],
  ["revives", "somebody was brought back up", "revivals happened"],
  ["retreats", "the party pulled out of a fight", "retreats were called"],
  ["floorsCleared", "a floor was finished", "floors were finished"],
];

/**
 * What changed this round that the prose does not reliably say.
 *
 * The commentator only knows what it is handed, and it was handed a scene and a
 * combat log. Everything else the run counts — kills, secret ways, tolls, gold
 * moved — sat one field away on the same snapshot and never reached it. The
 * visible cost: an elite died in round 16 of one run and the narration for
 * rounds 16 and 17 never mentioned it, because a defeated enemy simply stops
 * being in `enemies` and nothing says it used to be there. Three secret routes
 * were found in that run and none was ever remarked on.
 *
 * Party deaths were always narrated well, and they are the one thing already
 * computed into an explicit line. That is the whole lesson.
 */
function movedThisRound(events: TraceEvent[], round: number, enemies: Array<Record<string, unknown>>): string[] {
  const snapshotsFor = (target: number): Record<string, unknown> | undefined =>
    [...events]
      .reverse()
      .find(
        (e): e is Extract<TraceEvent, { kind: "state" }> =>
          e.kind === "state" && e.round === target && e.resolved === true,
      )?.snapshot ?? undefined;

  const now = snapshotsFor(round);
  const before = snapshotsFor(round - 1);
  if (!now) return [];

  const out: string[] = [];

  // An enemy that was standing last round and is not on any list now is dead.
  // Naming it is the difference between "the wisp takes 72" and "the wisp dies".
  const previousEnemies =
    ((before?.scene as Record<string, unknown> | undefined)?.enemies as Array<Record<string, unknown>> | undefined) ??
    [];
  const standing = new Set(enemies.map((e) => String(e.ref ?? e.name)));
  const gone = previousEnemies
    .filter((e) => !e.dead && !standing.has(String(e.ref ?? e.name)))
    .map((e) => String(e.name ?? e.ref));
  if (gone.length) out.push(`Killed this round: ${gone.join(", ")}.`);

  if (before) {
    const moved = NOTEWORTHY.flatMap(([key, singular, plural]) => {
      const delta = Number(now[key] ?? 0) - Number(before[key] ?? 0);
      if (delta <= 0) return [];
      return [delta === 1 ? singular : `${delta} ${plural}`];
    });
    if (moved.length) out.push(`Also this round: ${moved.join("; ")}.`);
  }
  return out;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      /** OpenAI's name for the thinking channel. */
      reasoning?: string | null;
      /** vLLM's and NInfer's name for the same thing. */
      reasoning_content?: string | null;
    };
  }>;
}

/**
 * Whether this server refuses to have its thinking switched off, learned from
 * its own 400 rather than assumed.
 *
 * `chat_template_kwargs` used to be sent unconditionally, on the reasoning that
 * "anything that does not understand it ignores an unknown key". NInfer
 * falsifies that: it answers `400 chat_template_option_not_supported` and
 * refuses the whole request. Because a dropped line is deliberately not fatal
 * here, the visible result was a narrator that connected, announced the file it
 * was writing, and then said nothing for a whole run — re-sending the same
 * rejected body every two seconds. Ask once, believe the answer, stop asking.
 *
 * Per-call rather than module-level: two narrators in one process may be
 * pointed at two different servers, and one of them learning this about its own
 * would otherwise silently change how the other asks.
 */
/**
 * @property dialect Which way of asking for less thinking this server accepts.
 *   Three rungs, tried in order, because two are not enough. `template` is
 *   vLLM's `chat_template_kwargs`; `effort` is the top-level `reasoning_effort`
 *   that NInfer takes and vLLM does not; `none` is neither, and pays for it
 *   with a budget large enough to think *and* answer.
 *
 *   The middle rung is the one this file was missing. NInfer rejects
 *   `chat_template_kwargs` outright, so the probe concluded "unsuppressible"
 *   and fell straight to the large budget — and then **13 of 30 rounds of a
 *   live run still came back `finish_reason: "length"`**, because a model given
 *   2,000 tokens and no instruction to be brief spends them all wondering what
 *   the question is. The server was never unable to stop thinking; it was only
 *   unable to be asked in vLLM's words.
 */
interface Server {
  dialect: "unknown" | "template" | "effort" | "none";
}

async function post(options: NarrateOptions, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function say(options: NarrateOptions, server: Server, prompt: string, recent: string[]): Promise<string | null> {
  const messages = [
    { role: "system", content: SYSTEM },
    ...(recent.length
      ? [
          {
            role: "system" as const,
            content: `You have just said:\n${recent.slice(-3).join("\n")}\nDo not repeat yourself.`,
          },
        ]
      : []),
    { role: "user", content: prompt },
  ];

  // The budget is a function of whether thinking could be turned off, because a
  // reasoning model spends it on its own trace *first* and only then writes the
  // reply. Two hundred is ample for a sentence and nowhere near enough to think
  // first: measured on this box, a 200-token call to a thinking server returns
  // `finish_reason: "length"`, 882 characters of reasoning and an empty
  // `content` — which reaches the page as silence. The same call at 1200
  // finishes and answers in twelve words. Neither number is a preference; the
  // small one is simply wrong for a server that will not stop thinking. Two
  // thousand rather than the twelve hundred that first worked, because the
  // length of the trace swings widely round to round on the same prompt — 600
  // to 3100 characters was the observed spread — and a budget set at the
  // median silently drops the rounds that thought hardest.
  const build = (dialect: "template" | "effort" | "none"): Record<string, unknown> => ({
    model: options.model,
    temperature: options.temperature ?? 0.8,
    max_tokens: dialect === "none" ? 2000 : 200,
    messages,
    ...(dialect === "template" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(dialect === "effort" ? { reasoning_effort: "none" } : {}),
  });

  /** A 400 that names the field we just sent, rather than any 400 at all. */
  const rejectedTheKnob = async (res: Response, ...needles: string[]): Promise<boolean> => {
    if (res.ok || res.status !== 400) return false;
    const detail = await res.text().catch(() => "");
    return needles.some((n) => detail.includes(n));
  };

  // Walk the ladder once, remember the rung, and stop asking. Reading the
  // reason rather than inferring it from the status matters: a 400 has other
  // causes, and a narrator that abandoned the cheap request on every one of
  // them would spend ten times the budget for no reason.
  let res: Response;
  if (server.dialect === "unknown") {
    res = await post(options, build("template"));
    if (await rejectedTheKnob(res, "chat_template_kwargs", "chat_template_option")) {
      res = await post(options, build("effort"));
      if (await rejectedTheKnob(res, "reasoning_effort")) {
        server.dialect = "none";
        options.onNote?.("this server will not turn thinking down; narrating at a larger budget instead");
        res = await post(options, build("none"));
      } else if (res.ok) {
        server.dialect = "effort";
      }
    } else if (res.ok) {
      server.dialect = "template";
    }
  } else {
    res = await post(options, build(server.dialect));
  }
  if (!res.ok) {
    options.onNote?.(`commentary call failed: HTTP ${res.status}`);
    return null;
  }

  const payload = (await res.json()) as ChatResponse;
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const said = (message?.content ?? "").trim();
  if (said) return said.replace(/\s+/g, " ").slice(0, 400);

  // Nothing in `content`. Two very different situations share that symptom, and
  // reading the thinking channel is right for exactly one of them.
  //
  // `stop` — the model finished, and put its whole answer in the wrong channel.
  // Take it; a commentator's aside beats a blank panel. Both spellings, because
  // the field has two: OpenAI says `reasoning`, vLLM and NInfer say
  // `reasoning_content`, and reading only the first is why this fallback had
  // never once fired against a local server. (Nor could it have: it was written
  // as `content ?? reasoning`, and a server that returns `""` rather than
  // `null` — which is what both of them do — is not nullish, so the fallback
  // was unreachable on two counts.)
  //
  // `length` — the budget ran out mid-thought. What is in there is not an
  // answer, it is the model wondering what the question is: "We need answer
  // user's prompt? They provided game state and said?" — measured, not
  // imagined. Printing that on the broadcast is worse than skipping the round,
  // because a viewer cannot tell commentary from a leaked scratchpad.
  if (choice?.finish_reason === "length") {
    options.onNote?.("a round went unnarrated: the model spent its whole budget thinking");
    return null;
  }
  const aside = (message?.reasoning || message?.reasoning_content || "").trim();
  return aside ? aside.replace(/\s+/g, " ").slice(0, 400) : null;
}

/**
 * Follow a trace and comment on it until it ends.
 *
 * Polls rather than watches the filesystem: a run writes at human speed and an
 * `fs.watch` on a file being appended to is one of the least portable things in
 * Node. Resumes cleanly — it only ever narrates rounds it has not seen, so
 * restarting mid-run picks up where it left off rather than re-commentating.
 */
export async function narrate(options: NarrateOptions): Promise<number> {
  const sidecar = options.tracePath.replace(/\.ndjson$/, ".narration.ndjson");
  const pollMs = options.pollMs ?? 2_000;

  // Anything already narrated stays narrated, so a restart is not a rerun.
  const done = new Set<number>();
  const recent: string[] = [];
  if (existsSync(sidecar)) {
    for (const event of readTrace(sidecar)) {
      const round = (event as unknown as { round?: number }).round;
      if (typeof round === "number") done.add(round);
      const text = (event as unknown as { text?: string }).text;
      if (text) recent.push(text);
    }
  }

  const server: Server = { dialect: "unknown" };
  let idleSince = Date.now();
  let spoken = 0;

  for (;;) {
    const events = readTrace(options.tracePath);
    const resolvedRounds = events
      .filter((e): e is Extract<TraceEvent, { kind: "state" }> => e.kind === "state" && e.resolved === true)
      .map((e) => e.round);
    const legacyRounds = events
      .filter((e): e is Extract<TraceEvent, { kind: "round" }> => e.kind === "round")
      .map((e) => e.round);
    const ended = events.some((e) => e.kind === "end");

    // New traces mark resolved states directly. Older traces use the following
    // round boundary as the only available completion signal.
    const ready =
      resolvedRounds.length > 0
        ? [...new Set(resolvedRounds)]
        : legacyRounds.slice(0, Math.max(0, legacyRounds.length - (ended ? 0 : 1)));

    for (const round of ready) {
      if (done.has(round)) continue;
      const resolvedAt = events.findIndex((e) => e.kind === "state" && e.round === round && e.resolved === true);
      const nextBoundary = events.findIndex((e) => e.kind === "round" && (e as { round: number }).round === round + 1);
      const boundary = resolvedAt >= 0 ? resolvedAt : nextBoundary;
      const upTo = boundary >= 0 ? events.slice(0, boundary + 1) : events;
      const prompt = digest(upTo, round);
      if (!prompt) continue;

      let line: string | null = null;
      try {
        line = await say(options, server, prompt, recent);
      } catch {
        // A commentator who loses their line does not stop the match.
      }
      if (!line) continue;

      done.add(round);
      recent.push(line);
      spoken += 1;
      idleSince = Date.now();
      appendFileSync(sidecar, `${JSON.stringify({ kind: "narration", at: Date.now(), round, text: line })}\n`);
      options.onLine?.(line, round);
      if (options.maxRounds && spoken >= options.maxRounds) return spoken;
    }

    if (ended) return spoken;

    // A trace nobody has appended to for a while is a run that died without
    // writing its ending. Stop rather than poll a dead file forever.
    let quiet = false;
    try {
      quiet = Date.now() - statSync(options.tracePath).mtimeMs > 5 * 60_000;
    } catch {
      quiet = true;
    }
    if (quiet && Date.now() - idleSince > 5 * 60_000) return spoken;

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
