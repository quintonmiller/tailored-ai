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
}

const SYSTEM =
  "You are the commentator on a live broadcast of five AI agents playing an endless dungeon crawl. " +
  "You are watching, not playing, and you cannot affect anything. " +
  "Given what just happened in a round, say one or two short sentences about it, in the present tense, " +
  "the way a sports commentator would. Be specific about names and numbers you were given. " +
  "Never invent anything you were not told. Never give the party advice — they cannot hear you. " +
  "Vary your openings; do not start consecutive lines the same way.";

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
  if (announce) lines.push(`What happened:\n${announce}`);
  if (said.length) lines.push(`They are saying:\n${said.join("\n")}`);
  return lines.join("\n");
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
}

async function say(options: NarrateOptions, prompt: string, recent: string[]): Promise<string | null> {
  const res = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      temperature: options.temperature ?? 0.8,
      // Two hundred, not the sixty a sentence needs. A reasoning model spends
      // this budget on its own thinking *first* and only then writes the reply,
      // so a tight cap does not produce a short line — it produces `content:
      // null` and `finish_reason: "length"`, which is silence. Measured on
      // qwen3.6: the whole of a 120-token budget went to the reasoning trace.
      max_tokens: 200,
      // And ask it not to think at all where the server understands the request.
      // vLLM's Qwen template takes this; anything that does not understand it
      // ignores an unknown key, so it is safe to send unconditionally.
      chat_template_kwargs: { enable_thinking: false },
      messages: [
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
      ],
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as ChatResponse;
  const choice = body.choices?.[0]?.message;
  // Fall back to the reasoning channel when a server insists on thinking and
  // leaves `content` empty. A commentator's aside is better than silence, and
  // the alternative is a blank panel whenever the configured model happens to
  // be a reasoning one.
  const text = (choice?.content ?? choice?.reasoning ?? "").trim();
  return text ? text.replace(/\s+/g, " ").slice(0, 400) : null;
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
        line = await say(options, prompt, recent);
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
