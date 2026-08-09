#!/usr/bin/env node
/**
 * Fail the build when a tracked file references one machine instead of the
 * framework.
 *
 * This exists because the leak is not deliberate and never looks like a
 * mistake at the time. Writing a doc, a test fixture or an example, the nearest
 * concrete material to hand is whatever the author is running — so a home
 * directory, a checkout path or a personal repo name ends up in a public file,
 * and reads as if it were canonical. By the time anyone notices it has been
 * copied into three more places.
 *
 * Only *structural* markers are checked: absolute home paths, developer
 * checkout paths, and the names of one deployment's config repos. Those are
 * unambiguous — none of them can be correct in a repo other people install.
 *
 * The other half of the problem, an example cast borrowed from somebody's real
 * agent roster, is not mechanically detectable: `mail-sorter` and
 * `email-classifier` look identical to a regex. That half is a convention, in
 * CLAUDE.md under "Examples use a neutral cast".
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  {
    name: "absolute home directory",
    // Service and fixture accounts are the correct thing to write: a container
    // really does run as `executor`, and a test fixture needs *some* home. What
    // is never correct is a real person's account from the machine this was
    // authored on.
    pattern:
      /\/(?:home|Users)\/(?!<|\$|USER\b|you\b|user\b|executor\b|agent\b|test\b|node\b|app\b|ubuntu\b|runner\b|root\b)[a-z][\w.-]*\//i,
    why: "names one machine's user account. Use a service/fixture name, ~/, or <TAI_HOME>.",
  },
  {
    name: "developer checkout path",
    pattern: /~\/repos\/(?!my-app\b|my-project\b)[\w.-]+/,
    why: "names where one person keeps their code. Use a repo-relative path.",
  },
  {
    name: "a deployment's own config repo",
    pattern: /\btai-personal\b|\.tai-work\b|\.tai-personal\b/,
    why: "names one deployment's config repo or home. Say 'a deployment's config repo' or <TAI_HOME>.",
  },
];

/** Recorded benchmark runs are immutable records of what a model actually saw. */
const SKIP = [/^packages\/evals\/results\//, /^scripts\/guard-no-local-refs\.mjs$/, /^CHANGELOG\.md$/, /CHANGELOG\.md$/];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => !SKIP.some((re) => re.test(f)));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable — nothing to match
  }
  if (text.includes("\0")) continue;
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match) findings.push({ file, line: index + 1, rule, text: match[0] });
    }
  });
}

if (findings.length === 0) {
  console.log(`guard-no-local-refs: ${files.length} tracked files, no local references.`);
  process.exit(0);
}

console.error(`\nguard-no-local-refs: ${findings.length} local reference(s) in tracked files.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.rule.name}: "${f.text}" — ${f.rule.why}\n`);
}
console.error("A public repo should describe the framework, not the machine it was written on.");
console.error("See CLAUDE.md → Examples use a neutral cast.\n");
process.exit(1);
