/**
 * Reading a tool's own account of what a call does.
 *
 * The declaration lives on the tool (`Tool.effect`) so a deployment does not
 * have to know what every installed plugin does in order to be safe from it.
 * This module is the reader, plus the one classifier complex enough to be worth
 * testing on its own: shell commands.
 */

import type { Tool, ToolEffect } from "./interface.js";

/** What this specific call does. Undeclared is `read`, which gates nothing. */
export function effectOf(tool: Tool, args: Record<string, unknown>): ToolEffect {
  const declared = tool.effect;
  if (!declared) return "read";
  if (typeof declared === "function") {
    try {
      return declared(args);
    } catch {
      // A classifier that throws must not take the turn down, and must not
      // quietly downgrade to `read` either — a broken classifier on a
      // destructive tool is exactly when you want the careful path.
      return "irreversible";
    }
  }
  return declared;
}

/**
 * Commands whose effect cannot be undone by running something else.
 *
 * Deliberately a small list of the verbs, not an attempt at a shell parser.
 * Two reasons. A parser that is wrong in the permissive direction is worse than
 * no parser, because the green result is read as evidence; and the cost of a
 * false positive here is one extra provider call on a command that turns out to
 * be unambiguous, which is cheap. So this errs toward `irreversible` and the
 * derivability check absorbs the difference.
 *
 * `rm` without a path, `git push --force`, `DROP TABLE`, `aws s3 rb` — the
 * shapes that have no inverse. Reversible mutations (`git commit`, `mkdir`,
 * writing a file) are `write`: they change something, and something else can
 * change it back.
 */
const IRREVERSIBLE = [
  /\brm\b/,
  /\brmdir\b/,
  /\bshred\b/,
  /\bmkfs\b/,
  /\bdd\b\s+.*\bof=/,
  /\btruncate\b/,
  /\bdrop\s+(table|database|schema|index)\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bgit\s+reset\b.*--hard/,
  /\bgit\s+clean\b.*-[a-z]*f/,
  /\bgit\s+branch\b.*\s-D\b/,
  /\bs3\s+(rb|rm)\b/,
  // Cloud CLIs spell it out rather than abbreviating, and the first version of
  // this list only knew the abbreviations — so `aws s3api delete-bucket` sailed
  // past while `aws s3 rb` was caught, on the same scenario, in the same batch.
  /\bdelete-[a-z-]+\b/,
  /\b(gcloud|az|aws)\b[^|;]*\bdelete\b/,
  /\bkubectl\s+delete\b/,
  /\bdocker\s+(rm|rmi|volume\s+rm|system\s+prune)\b/,
  /\bterraform\s+destroy\b/,
  /\bnpm\s+unpublish\b/,
  /\b(destroy|purge|wipe)\b/i,
];

/** Verbs that change something recoverable. Everything else observes. */
const WRITES = [
  /\b(mv|cp|touch|mkdir|ln|chmod|chown|tee)\b/,
  /\bgit\s+(commit|add|checkout|merge|rebase|stash|tag|push)\b/,
  /\b(npm|pnpm|yarn)\s+(install|add|publish)\b/,
  /\b(apt|apt-get|brew|pip)\s+install\b/,
  /\binsert\s+into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
  />>?/,
];

/**
 * What a shell command does.
 *
 * Applied to the whole string rather than to a parsed first word, because the
 * dangerous part is rarely first: `cd /tmp && rm -rf build`, `find . -exec rm
 * {} \;`, and `ls | xargs rm` all hide it behind something harmless.
 */
export function classifyCommand(command: string): ToolEffect {
  if (IRREVERSIBLE.some((pattern) => pattern.test(command))) return "irreversible";
  if (WRITES.some((pattern) => pattern.test(command))) return "write";
  return "read";
}
