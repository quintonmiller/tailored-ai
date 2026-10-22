/**
 * Whether the party can actually hear each other.
 *
 * `execute_actions` accepts a `message` described to the model as "the whole
 * party reads this at the top of the next round". Until 2026-08-16 it did not:
 * the message was pushed onto `lastLog`, and `advance()` reassigns `lastLog` in
 * every branch of its phase switch, so every word spoken during a round was
 * destroyed before the round after it was announced. The tool still answered
 * `Said: …` and reported success, so no test, no metric and no agent could tell.
 * Measured on the live run of that morning: 23 of 28 batch calls carried a
 * message and not one of them reached another character.
 *
 * The tests that matter here all straddle an `advance()`. A test that calls
 * `announce()` without one passes against the broken code — which is exactly
 * what the old assertion in `descent-batch.test.ts` did.
 */

import { describe, expect, it } from "vitest";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

interface Speaks {
  execute(
    args: Record<string, unknown>,
    context?: { agentName?: string },
  ): Promise<{ success: boolean; output?: string }>;
}

type Sim = ReturnType<typeof createSimulation> & { announce(): string; describeFor(who: string): string };

function sim(seed = 1000, rounds = 0): Sim {
  const s = createSimulation("descent", { seed, days: 40, ...simulationDefaults("descent") });
  if (rounds > 0) {
    const pol = simulationPolicies("descent")["rule-based"]?.();
    for (let i = 0; i < rounds && !s.done && pol; i++) {
      pol.act(s);
      s.advance();
    }
  }
  return s as Sim;
}

function say(s: Sim, who: string, text: string): Promise<unknown> {
  const tool = s.sharedTools().find((t) => t.name === "execute_actions");
  if (!tool) throw new Error("execute_actions is not in sharedTools()");
  return (tool as unknown as Speaks).execute({ message: text, actions: [] }, { agentName: who });
}

/** Play forward until the party is in a fight, which is where `lastLog` is rewritten hardest. */
function inCombat(seed: number): Sim {
  const s = sim(seed);
  const pol = simulationPolicies("descent")["rule-based"]?.();
  if (!pol) throw new Error("no rule-based baseline");
  for (let i = 0; i < 40 && !s.done; i++) {
    if ((s as unknown as { view(): { phase: string } }).view().phase === "combat") return s;
    pol.act(s);
    s.advance();
  }
  throw new Error(`seed ${seed} never reached combat`);
}

describe("what the party says out loud", () => {
  it("reaches the others on the round after it is said", async () => {
    const s = sim(1000, 6);
    await say(s, "guardian", "regrouping at the stairs");
    s.advance();
    expect(s.announce()).toContain("regrouping at the stairs");
  });

  it("survives a combat round, where the log is rewritten wholesale", async () => {
    // The branch that broke it. `advance()` assigns `lastLog = result.lines`
    // during a fight, so a message merged into the log was guaranteed to die
    // exactly when the party most needed to coordinate.
    const s = inCombat(1000);
    await say(s, "mage", "hold the fireball, rogue is putting them down");
    s.advance();
    expect(s.announce()).toContain("hold the fireball");
  });

  it("says who said it, by display name and by the id tools take", async () => {
    const s = sim(1000, 6);
    await say(s, "cleric", "I am nearly out of mana");
    s.advance();
    const said = s.announce();
    expect(said).toContain("(cleric)");
    expect(said).toContain("I am nearly out of mana");
  });

  it("carries every speaker in a round, not just the last", async () => {
    const s = sim(1000, 6);
    await say(s, "guardian", "alpha-one");
    await say(s, "rogue", "bravo-two");
    await say(s, "ranger", "charlie-three");
    s.advance();
    const said = s.announce();
    for (const word of ["alpha-one", "bravo-two", "charlie-three"]) expect(said).toContain(word);
  });

  it("does not outlive the round that reads it", async () => {
    // A line has the same lifetime as the round log. Without this the
    // announcement grows without bound and the party re-reads week-old
    // conversation as though it were current.
    const s = sim(1000, 6);
    await say(s, "guardian", "regrouping at the stairs");
    s.advance();
    expect(s.announce()).toContain("regrouping at the stairs");
    s.advance();
    expect(s.announce()).not.toContain("regrouping at the stairs");
  });

  it("is audible to whoever has not acted yet, in the round it is spoken", async () => {
    // Changed 2026-08-17. This asserted the opposite, on the grounds that
    // immediate speech would let the party "coordinate by taking turns, which
    // is the exact free lunch queued intents exist to deny". The premise was
    // already false: `describe()` prints "Readied this round:" listing every
    // actor's intent, so a character deciding fifth could always see what the
    // four before it had *done*. Delaying only the words meant the explanation
    // arrived a round after the action it explained — the party coordinated by
    // watching rather than by talking, in a scenario whose subject is
    // organisation. Public is now public on the same terms as a readied intent.
    const s = sim(1000, 6);
    await say(s, "guardian", "regrouping at the stairs");
    expect(s.describeFor("cleric")).toContain("regrouping at the stairs");
    expect(s.announce()).toContain("regrouping at the stairs");
  });

  it("still survives the round boundary, which is the bug this file exists for", async () => {
    // The original defect was total loss: `advance()` reassigns `lastLog` in
    // every branch, so a message pushed there died before anyone read it. That
    // must stay fixed regardless of when speech becomes audible, so this
    // straddles `advance()` on purpose.
    const s = sim(1000, 6);
    await say(s, "guardian", "regrouping at the stairs");
    s.advance();
    expect(s.announce()).toContain("regrouping at the stairs");
  });

  it("reaches the private view while it is still this round, and stops repeating after", async () => {
    /*
     * Changed 2026-08-18, and the change is a deletion.
     *
     * This asserted that speech from *last* round was still in the private
     * view, which it was — and so was the whole round's combat log, and so was
     * every line of it in `announce()`, which the harness posts into the room
     * as a message at the top of every round. A character that then called
     * `look` read all of it a second time inside one turn. Measured on the run
     * of that morning: 32 `look` calls, every one carrying a verbatim repeat of
     * a block already sitting in the history above it.
     *
     * What must survive is the property the file exists for — that speech
     * reaches other people and survives the round boundary — and it does, in
     * the room. What must also survive is same-round audibility, which the
     * round-opening post *cannot* carry because it is written before anybody
     * has spoken. So the private view keeps this round's speech and drops last
     * round's, and both halves are asserted here.
     */
    const s = sim(1000, 6);
    await say(s, "rogue", "there is a trap on the left way");
    // Before the round turns over: audible privately, to somebody yet to act.
    expect(s.describeFor("cleric")).toContain("there is a trap on the left way");
    s.advance();
    // After: carried by the announcement the whole party reads, and not
    // repeated into every tool result on top of it.
    expect(s.announce()).toContain("there is a trap on the left way");
    expect(s.describeFor("cleric")).not.toContain("there is a trap on the left way");
  });

  it("is not crowded out by a long round log", async () => {
    // `announce()` truncates the log to fourteen lines. Speech merged into that
    // list would be dropped by a busy fight — silently, and precisely when the
    // party had most to talk about. It is rendered as its own section instead.
    const s = inCombat(1000);
    for (let i = 0; i < 30; i++) {
      (s as unknown as { lastLog: string[] }).lastLog.push(`filler line ${i}`);
    }
    await say(s, "ranger", "zulu-marker");
    s.advance();
    expect(s.announce()).toContain("zulu-marker");
  });

  it("reaches the broadcast as speech, not as dungeon narration", async () => {
    const s = sim(1000, 6);
    await say(s, "guardian", "regrouping at the stairs");
    const scene = (s.snapshot() as { scene: { said?: Array<{ who: string; text: string }>; log?: string[] } }).scene;
    expect(scene.said).toEqual([{ who: "guardian", text: "regrouping at the stairs" }]);
    expect(scene.log?.join("\n") ?? "").not.toContain("regrouping at the stairs");
  });
});
