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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../schema.js";

/** Write a one-file scenario dir and return its digest. */
function hashOf(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-hash-"));
  writeFileSync(join(dir, "01-cases.yaml"), yaml);
  return loadScenarios(dir).hash;
}

const BASE = `
- id: answers-a-question
  category: chat
  intent: A plain question gets a plain answer.
  message: what is the capital of France?
  expect:
    - replies: true
    - reply_matches: "Paris"
`;

describe("scenario set digest", () => {
  it("ignores an annotation, because no model or grader reads one", () => {
    const annotated = BASE.replace(
      "  message: what",
      '  knownGap: "#443 — asserts the behaviour we want, not the one we have."\n  message: what',
    );
    expect(annotated).not.toEqual(BASE); // the fixture really did change
    expect(hashOf(annotated)).toEqual(hashOf(BASE));
  });

  it("ignores `intent`, which is prose for a reader", () => {
    const reworded = BASE.replace("A plain question gets a plain answer.", "Completely different words here.");
    expect(reworded).not.toEqual(BASE);
    expect(hashOf(reworded)).toEqual(hashOf(BASE));
  });

  it("ignores comments and blank lines", () => {
    const commented = BASE.replace("- id: answers", "# a note for whoever reads this next\n\n- id: answers");
    expect(hashOf(commented)).toEqual(hashOf(BASE));
  });

  it("moves when an assertion changes", () => {
    const changed = BASE.replace('reply_matches: "Paris"', 'reply_matches: "Lyon"');
    expect(hashOf(changed)).not.toEqual(hashOf(BASE));
  });

  it("moves when the message the model is sent changes", () => {
    const changed = BASE.replace("what is the capital of France?", "what is the capital of Spain?");
    expect(hashOf(changed)).not.toEqual(hashOf(BASE));
  });

  it("moves when a scenario is added", () => {
    const extra = `${BASE}
- id: declines-to-guess
  category: chat
  intent: Nothing in the conversation supports an answer.
  message: what did I say yesterday?
  expect:
    - replies: true
`;
    expect(hashOf(extra)).not.toEqual(hashOf(BASE));
  });

  it("moves when a category is renamed, since the rollup is scored by it", () => {
    const changed = BASE.replace("category: chat", "category: restraint");
    expect(hashOf(changed)).not.toEqual(hashOf(BASE));
  });
});
