/**
 * Does this artifact parse? Nothing here runs a line of it.
 *
 * The distinction is the whole design. Running agent-written code needs a
 * sandbox, a timeout, a network policy and a headless browser, which is a week
 * of work and a much larger attack surface; parsing needs none of that and
 * catches the failure that actually dominates a first build — a stray brace, an
 * unclosed tag, a script tag pointing at a file nobody created.
 *
 * `node:vm` compiles without executing, which is exactly the primitive wanted
 * and is in the standard library. Deliberately not esbuild: it is a
 * devDependency of this package, and reaching for a build-time dependency at
 * run time is how a private package acquires a runtime it did not declare.
 *
 * ## What this cannot tell you
 *
 * Whether it works. A syntactically perfect page that throws on load, or draws
 * nothing, passes every check here. `playtest.ts` is the instrument for that
 * question and this one says so in its own output — a team told "checks passed"
 * that reads it as "it works" has been misled by the tool, not by the model.
 *
 * Keeping the two separate is deliberate. Parsing is instant, needs no browser
 * and can run every round; running the artifact costs a browser launch and a
 * few seconds. A team should be able to ask the cheap question often and the
 * expensive one when it matters.
 */

import { Script } from "node:vm";
import type { Workspace } from "./workspace.js";

export interface CheckProblem {
  path: string;
  line?: number;
  message: string;
}

export interface CheckReport {
  filesChecked: number;
  problems: CheckProblem[];
}

/**
 * A syntax error from V8, reduced to a line number and a sentence.
 *
 * V8 reports the position in a stack frame rather than on the error, so the
 * line has to be dug out of the formatted output. When it cannot be, the
 * message alone is still useful and a missing line number is better than a
 * wrong one.
 */
function describeSyntaxError(err: unknown, offset: number): { line?: number; message: string } {
  const error = err as Error & { stack?: string };
  const message = (error?.message ?? String(err)).trim();
  const frame = error?.stack?.split("\n").find((l) => /:\d+$/.test(l.trim()) || /:\d+:\d+/.test(l));
  const match = frame?.match(/:(\d+)(?::\d+)?/);
  const line = match ? Number(match[1]) + offset : undefined;
  return { ...(line && Number.isFinite(line) ? { line } : {}), message };
}

/** Compile as a classic script. Never runs: `new Script` stops at compilation. */
function checkJs(path: string, source: string, offset = 0): CheckProblem[] {
  try {
    new Script(source, { filename: path });
    return [];
  } catch (err) {
    const { line, message } = describeSyntaxError(err, offset);
    return [{ path, ...(line ? { line } : {}), message }];
  }
}

/** Tags that close themselves and must not be looked for on the stack. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "!doctype",
]);

/**
 * Tag balance, script extraction, and dangling references.
 *
 * Not an HTML parser and not trying to be — HTML's real parser recovers from
 * almost everything, so "does it parse" is nearly always yes and nearly always
 * useless. What breaks a page in practice is a `<div>` that never closed and a
 * `<script src="ui.js">` where nobody wrote `ui.js`, and those are both cheap
 * to see.
 */
function checkHtml(path: string, source: string, workspace: Workspace): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const lineAt = (index: number): number => source.slice(0, index).split("\n").length;

  // Scripts and styles first: their contents are not markup, and leaving them
  // in would have every `if (a < b)` read as an opening tag.
  const blocks: Array<{ tag: string; body: string; start: number; attrs: string }> = [];
  const blockPattern = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let found: RegExpExecArray | null = blockPattern.exec(source);
  while (found) {
    blocks.push({ tag: found[1].toLowerCase(), attrs: found[2], body: found[3], start: found.index });
    found = blockPattern.exec(source);
  }

  for (const block of blocks) {
    if (block.tag !== "script") continue;
    const type = block.attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    // A module has import/export semantics a classic `Script` rejects outright,
    // so checking one as a script would report a syntax error for correct code.
    // The brief asks for classic scripts; say so rather than lying about it.
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    if (!block.body.trim()) continue;
    problems.push(...checkJs(path, block.body, lineAt(block.start)));
  }

  // References that go nowhere. The single most common way a multi-file build
  // ends up as a blank page: the layout was agreed, the tag was written, and
  // the file was never created.
  const refPattern = /<(?:script|link|img)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let ref: RegExpExecArray | null = refPattern.exec(source);
  while (ref) {
    const target = ref[1].trim();
    const external = /^(https?:)?\/\//i.test(target) || target.startsWith("data:") || target.startsWith("#");
    if (!external && target) {
      const clean = target.split(/[?#]/)[0];
      let exists = false;
      try {
        exists = workspace.exists(clean);
      } catch {
        exists = false;
      }
      if (!exists) {
        problems.push({
          path,
          line: lineAt(ref.index),
          message: `references "${target}", which does not exist in the workspace`,
        });
      }
    } else if (/^(https?:)?\/\//i.test(target)) {
      problems.push({
        path,
        line: lineAt(ref.index),
        message: `references "${target}" over the network; the artifact must be self-contained and will be reviewed offline`,
      });
    }
    ref = refPattern.exec(source);
  }

  // Tag balance, with script/style bodies blanked out so their contents cannot
  // be mistaken for markup.
  let markup = source;
  for (const block of blocks) {
    markup = markup.replace(block.body, " ".repeat(block.body.length));
  }
  markup = markup.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));

  const stack: Array<{ tag: string; index: number }> = [];
  const tagPattern = /<(\/?)([A-Za-z!][A-Za-z0-9-]*)\b[^>]*?(\/?)>/g;
  let tag: RegExpExecArray | null = tagPattern.exec(markup);
  while (tag) {
    const closing = tag[1] === "/";
    const name = tag[2].toLowerCase();
    const selfClosing = tag[3] === "/";
    if (!VOID_TAGS.has(name) && !selfClosing) {
      if (closing) {
        const open = stack.pop();
        if (!open) {
          problems.push({ path, line: lineAt(tag.index), message: `</${name}> closes a tag that was never opened` });
        } else if (open.tag !== name) {
          problems.push({
            path,
            line: lineAt(tag.index),
            message: `</${name}> closes out of order — <${open.tag}> opened on line ${lineAt(open.index)} is still open`,
          });
        }
      } else {
        stack.push({ tag: name, index: tag.index });
      }
    }
    tag = tagPattern.exec(markup);
  }
  for (const open of stack) {
    problems.push({ path, line: lineAt(open.index), message: `<${open.tag}> is never closed` });
  }
  return problems;
}

/** Brace and paren balance. CSS has no parser worth writing here; imbalance is the failure. */
function checkCss(path: string, source: string): CheckProblem[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  let line = 1;
  for (const char of stripped) {
    if (char === "\n") line++;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth < 0) return [{ path, line, message: "a closing brace with no matching rule above it" }];
    }
  }
  if (depth > 0) return [{ path, message: `${depth} rule${depth === 1 ? "" : "s"} left unclosed — a missing "}"` }];
  return [];
}

function checkJson(path: string, source: string): CheckProblem[] {
  try {
    JSON.parse(source);
    return [];
  } catch (err) {
    return [{ path, message: (err as Error).message }];
  }
}

/**
 * Every checkable file in the workspace, in one pass.
 *
 * Whole-workspace rather than per-file on purpose: a dangling `<script src>` is
 * only visible if the checker can see both the reference and the absence, and a
 * team that could check one file at a time would check the one it just wrote.
 */
export function checkWorkspace(workspace: Workspace): CheckReport {
  const problems: CheckProblem[] = [];
  let filesChecked = 0;

  for (const file of workspace.list()) {
    if (file.planned) continue;
    const ext = file.path.slice(file.path.lastIndexOf(".")).toLowerCase();
    let source: string;
    try {
      source = workspace.read(file.path);
    } catch {
      continue;
    }
    if (ext === ".js") {
      filesChecked++;
      problems.push(...checkJs(file.path, source));
    } else if (ext === ".html") {
      filesChecked++;
      problems.push(...checkHtml(file.path, source, workspace));
    } else if (ext === ".css") {
      filesChecked++;
      problems.push(...checkCss(file.path, source));
    } else if (ext === ".json") {
      filesChecked++;
      problems.push(...checkJson(file.path, source));
    }
  }
  return { filesChecked, problems };
}

/** What the tester reads back. Numbers and locations, never a verdict on quality. */
export function formatCheck(report: CheckReport, entry: string, workspace: Workspace): string {
  const lines: string[] = [];
  const hasEntry = (() => {
    try {
      return workspace.exists(entry);
    } catch {
      return false;
    }
  })();
  lines.push(
    `Checked ${report.filesChecked} file${report.filesChecked === 1 ? "" : "s"}. ` +
      `${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}.`,
  );
  if (!hasEntry) lines.push(`The entry point "${entry}" does not exist yet, so there is nothing to open.`);
  for (const problem of report.problems.slice(0, 25)) {
    lines.push(`  ${problem.path}${problem.line ? `:${problem.line}` : ""}  ${problem.message}`);
  }
  if (report.problems.length > 25) lines.push(`  … and ${report.problems.length - 25} more.`);
  if (!report.problems.length && hasEntry) {
    // Said every time, because it is the sentence a team most needs and least
    // wants to hear. "Checks passed" reads as "it works" unless the tool says
    // otherwise in the same breath.
    lines.push(
      "Everything parses. That says nothing about whether it works: this tool never runs anything. " +
        "Use `playtest` to find out what actually happens on screen.",
    );
  }
  return lines.join("\n");
}
