/**
 * A scenario with machinery in it.
 *
 * Every stub before this was a pure function of the call — the same arguments
 * returned the same string forever. That is fine for asking "did you pick the
 * right tool" and useless for asking "did you work out what the right calls
 * *were*", because nothing could be locked, so nothing had to be unlocked
 * first. Order of operations, which is most of what coordinating anything
 * consists of, was not expressible at all.
 *
 * A world is a small state machine the agent's tool calls drive. The scenario
 * states a goal and withholds the procedure; the dependencies are discoverable
 * only from what the tools say when they refuse. That is the shape of every
 * system worth automating, and — not incidentally — the shape of a good puzzle:
 * you learn the machine by operating it badly first.
 *
 * ## Why the win condition is the state and not the transcript
 *
 * `goal` is a claim about the world, never about which calls were made. A
 * puzzle with two solutions passes on either. An agent that finds a route the
 * author did not think of still passes, which it should. And an agent that
 * narrates a flawless account of having done the work reaches no state at all,
 * so it fails — the witness idea, applied to actions instead of facts.
 */

import type { WorldEvent, WorldRule, WorldSpec } from "./types.js";

/** Same matching `toolResults` uses, so a rule and a check agree on "matches". */
function matchesArg(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === "string" && expected.startsWith("/") && expected.lastIndexOf("/") > 0) {
    const end = expected.lastIndexOf("/");
    return new RegExp(expected.slice(1, end), expected.slice(end + 1) || "i").test(String(actual ?? ""));
  }
  if (typeof actual === "string" && typeof expected === "string")
    return actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

/** `set-cap 40` — enough of a call to recognise in a trace, never the whole payload. */
function describeCall(tool: string, args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
  const shown = typeof first === "string" ? first : JSON.stringify(args);
  return `${tool}(${shown.length > 60 ? `${shown.slice(0, 57)}…` : shown})`;
}

export class World {
  private readonly state: Record<string, string>;
  private readonly rules: WorldRule[];
  private readonly goalState?: Record<string, string>;
  readonly log: WorldEvent[] = [];

  constructor(spec: WorldSpec) {
    this.state = { ...spec.state };
    this.rules = spec.rules;
    this.goalState = spec.goal;
  }

  /**
   * Answer a call, and move the world if it lands.
   *
   * Returns `null` when no rule claims the call, so the caller can fall through
   * to `toolResults` and then to the default stub. The two compose deliberately:
   * a scenario usually has a handful of calls that move the machinery and a
   * larger number that just report things.
   */
  resolve(tool: string, args: Record<string, unknown>, agent?: string): string | null {
    for (const rule of this.rules) {
      if (rule.tool !== tool) continue;
      if (rule.when && !Object.entries(rule.when).every(([key, want]) => matchesArg(args[key], want))) continue;

      if (rule.by) {
        const allowed = Array.isArray(rule.by) ? rule.by : [rule.by];
        if (!agent || !allowed.includes(agent)) {
          this.log.push({
            agent,
            tool,
            call: describeCall(tool, args),
            effect: `refused: only ${allowed.join(" or ")} can do this`,
            applied: false,
          });
          return `you are not authorised for that. ${allowed.join(" or ")} has to run it.`;
        }
      }

      const unmet = Object.entries(rule.requires ?? {}).filter(([key, want]) => this.state[key] !== want);
      if (unmet.length > 0) {
        // Refused, and the refusal is the scenario's only way of teaching. A
        // world whose locked doors say nothing is not a puzzle, it is a maze:
        // the agent can only find the order by trying every permutation, which
        // measures patience rather than understanding.
        this.log.push({
          agent,
          tool,
          call: describeCall(tool, args),
          effect: `blocked: needs ${unmet.map(([k, v]) => `${k}=${v}`).join(", ")} (is ${unmet
            .map(([k]) => `${k}=${this.state[k]}`)
            .join(", ")})`,
          applied: false,
        });
        return rule.else ?? `refused: preconditions not met (${unmet.map(([k, v]) => `${k} must be ${v}`).join("; ")})`;
      }

      const changes = Object.entries(rule.sets ?? {}).filter(([key, value]) => this.state[key] !== value);
      for (const [key, value] of changes) this.state[key] = value;
      this.log.push({
        agent,
        tool,
        call: describeCall(tool, args),
        // A call that lands and changes nothing is worth seeing as itself: it is
        // usually an agent repeating work somebody else already did.
        effect: changes.length ? changes.map(([k, v]) => `${k}→${v}`).join(", ") : "no change",
        applied: true,
      });
      return rule.then;
    }
    return null;
  }

  snapshot(): Record<string, string> {
    return { ...this.state };
  }

  goal(): Record<string, string> | undefined {
    return this.goalState;
  }
}

/**
 * Did the world end where it had to?
 *
 * Split out from the grader so `regrade` scores a stored run the same way a
 * live one is scored, off the recorded final state rather than off a `World`
 * that no longer exists.
 */
export function unmetGoal(
  final: Record<string, string> | undefined,
  wanted: Record<string, string>,
): Array<{ key: string; want: string; got: string }> {
  if (!final) return [];
  return Object.entries(wanted)
    .filter(([key, want]) => final[key] !== want)
    .map(([key, want]) => ({ key, want, got: final[key] ?? "(unset)" }));
}

/** `nova  exec(breaker on)  power→on` — one line per transition, for reading a solution back. */
export function formatWorldLog(log: WorldEvent[]): string[] {
  return log.map((e) => `${e.applied ? " " : "×"} ${e.agent ? `${e.agent} ` : ""}${e.call}  ${e.effect}`);
}
