/**
 * The scenario-set digest identifies *what was measured*, and `compare` reads
 * it to decide whether two runs' scenarios were defined the same way.
 *
 * It used to be a digest of the file bytes, which got that wrong in both
 * directions: adding a one-line `knownGap` annotation — a field no model and no
 * grader ever sees — invalidated every run that came before it, while a
 * reflowed comment did the same. The two published baselines were declared
 * incomparable on exactly that basis, over two annotation lines.
 *
 * Each case here asserts both directions, because a digest that never moves is
 * as useless as one that always does.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../schema.js";

/** Write a one-file scenario dir and return its digest. */
async function hashOf(yaml: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-hash-"));
  try {
    writeFileSync(join(dir, "01-cases.yaml"), yaml);
    return (await loadScenarios(dir)).hash;
  } finally {
    // Removed, because it was not: every run of this file left a directory in
    // /tmp and the box had accumulated 368 of them. Harmless individually, and
    // the reason a `ls /tmp` is useless for finding a real leak.
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = `
- id: answers-a-question
  category: chat
  difficulty: 1
  intent: A plain question gets a plain answer.
  message: what is the capital of France?
  expect:
    - replies: true
    - reply_matches: "Paris"
`;

describe("scenario set digest", () => {
  it("ignores an annotation, because no model or grader reads one", async () => {
    const annotated = BASE.replace(
      "  message: what",
      '  knownGap: "#443 — asserts the behaviour we want, not the one we have."\n  message: what',
    );
    expect(annotated).not.toEqual(BASE); // the fixture really did change
    expect(await hashOf(annotated)).toEqual(await hashOf(BASE));
  });

  it("ignores `intent`, which is prose for a reader", async () => {
    const reworded = BASE.replace("A plain question gets a plain answer.", "Completely different words here.");
    expect(reworded).not.toEqual(BASE);
    expect(await hashOf(reworded)).toEqual(await hashOf(BASE));
  });

  it("ignores a re-grade, so revising the scale costs nothing", async () => {
    // The scale was applied to a set that already existed and the grades are a
    // judgement that will be revised. If a re-grade invalidated every published
    // run, the predictable outcome is that nobody ever re-grades anything and
    // the levels drift away from what the scenarios actually demand.
    const regraded = BASE.replace("difficulty: 1", "difficulty: 5");
    expect(regraded).not.toEqual(BASE);
    expect(await hashOf(regraded)).toEqual(await hashOf(BASE));
  });

  it("ignores comments and blank lines", async () => {
    const commented = BASE.replace("- id: answers", "# a note for whoever reads this next\n\n- id: answers");
    expect(await hashOf(commented)).toEqual(await hashOf(BASE));
  });

  it("moves when an assertion changes", async () => {
    const changed = BASE.replace('reply_matches: "Paris"', 'reply_matches: "Lyon"');
    expect(await hashOf(changed)).not.toEqual(await hashOf(BASE));
  });

  it("moves when the message the model is sent changes", async () => {
    const changed = BASE.replace("what is the capital of France?", "what is the capital of Spain?");
    expect(await hashOf(changed)).not.toEqual(await hashOf(BASE));
  });

  it("moves when a scenario is added", async () => {
    const extra = `${BASE}
- id: declines-to-guess
  category: chat
  difficulty: 2
  intent: Nothing in the conversation supports an answer.
  message: what did I say yesterday?
  expect:
    - replies: true
`;
    expect(await hashOf(extra)).not.toEqual(await hashOf(BASE));
  });

  it("moves when a category is renamed, since the rollup is scored by it", async () => {
    const changed = BASE.replace("category: chat", "category: restraint");
    expect(await hashOf(changed)).not.toEqual(await hashOf(BASE));
  });
});
