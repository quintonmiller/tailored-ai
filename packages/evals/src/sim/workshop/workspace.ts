/**
 * A real directory on disk, and the rules that keep five agents from ruining it.
 *
 * Every other simulation in this package invents its world. This one does not:
 * the files are real files, they survive the run, and the whole point of the
 * scenario is that somebody opens them afterwards. That single difference is
 * where all the risk lives, so the constraints are here rather than spread
 * through the tool handlers.
 *
 * ## Why not `TAI_HOME`
 *
 * `runOnce` builds the agent's home with `mkdtempSync` and deletes it in a
 * `finally`. An artifact written there ceases to exist at the exact moment
 * somebody wants to look at it. So the workspace lives beside the traces, under
 * `results/`, which is gitignored except for the published cohort — a run
 * cannot accidentally commit what it built.
 *
 * ## Why the caps are low
 *
 * Not for disk. A 900-line file read back into a prompt is ~9,000 tokens, and a
 * descent run died at round 13 on 2026-08-17 for reaching 44,913 tokens against
 * a 32,768-token server. The file caps here are a context budget wearing a
 * different hat, and `patch`/`outline`/ranged `read` exist so a growing file
 * never has to enter a prompt whole.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** What a file may be called, and what may be in it. */
export const ALLOWED_EXTENSIONS = [".html", ".css", ".js", ".json", ".md", ".txt", ".svg", ".csv"] as const;

export const LIMITS = {
  /** Roughly 1,200 lines of code. Past this a file cannot be reasoned about in a prompt anyway. */
  fileBytes: 48_000,
  totalBytes: 400_000,
  files: 32,
  /** `a/b/c.js` is deep enough for anything this scenario can produce. */
  depth: 3,
  /** Lines one `read_file` may return without a range. */
  readLines: 120,
  /** Lines one `read_file` may return with one. */
  readLinesMax: 240,
} as const;

export interface FileInfo {
  path: string;
  bytes: number;
  lines: number;
  /** The role that last wrote it. Absent on a file the brief declared but nobody has created. */
  lastWriter?: string;
  /** The round it was last written on. */
  lastRound?: number;
  /** Declared by the brief and not yet created. */
  planned?: boolean;
  /** Which role is allowed to write it, when the brief says. */
  owner?: string;
}

export interface WorkspaceEdit {
  path: string;
  by: string;
  round: number;
  kind: "create" | "write" | "patch" | "delete";
  linesBefore: number;
  linesAfter: number;
  /** The exact text was not there; it matched ignoring indentation. See `patch`. */
  loosened?: boolean;
}

/**
 * Why a write was refused.
 *
 * A refusal is information, not a crash — the same rule the shared `tool()`
 * helper follows. Every message here has to be actionable by a model that
 * cannot see this file: say what the rule is and what to do instead, never just
 * "invalid".
 */
export class WorkspaceRefusal extends Error {}

function refuse(message: string): never {
  throw new WorkspaceRefusal(message);
}

/**
 * A path a model proposed, turned into one this workspace will accept — or a
 * refusal saying why not.
 *
 * Deliberately strict and deliberately not clever. `../` handling by
 * normalisation is how sandbox escapes happen; the rule here is that a segment
 * is a plain name, full stop, and anything else is refused by shape before any
 * filesystem call is made.
 */
export function normalisePath(raw: unknown): string {
  const text = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (!text) refuse("no path given.");
  if (text.startsWith("/"))
    refuse(`"${text}" is an absolute path. Use a path relative to the workspace, like "index.html".`);
  const segments = text.split("/").filter((s) => s.length > 0);
  if (!segments.length) refuse(`"${text}" is not a file path.`);
  if (segments.length > LIMITS.depth) {
    refuse(`"${text}" is nested too deeply. At most ${LIMITS.depth} path segments, like "src/ui/panel.js".`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..")
      refuse(`"${text}" contains "${segment}". Paths must not navigate upwards.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
      refuse(`"${segment}" is not a usable name. Use letters, digits, dots, dashes and underscores.`);
    }
  }
  const path = segments.join("/");
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    refuse(`"${path}" has no usable extension. This workspace holds ${ALLOWED_EXTENSIONS.join(", ")}.`);
  }
  return path;
}

/**
 * Does `child` really live inside `parent`, symlinks and all?
 *
 * Re-implemented rather than imported. Core has this
 * (`packages/core/src/tools/path-containment.ts`) and does not export it, and
 * widening a core export to serve one private benchmark package is the wrong
 * direction — this is tier-2 work and belongs in tier 2. Twenty lines is a
 * cheaper price than a seam nobody else asked for.
 */
function containedIn(child: string, parent: string): boolean {
  const real = (p: string): string => {
    let at = resolve(p);
    // Walk up to the nearest existing ancestor: the target of a write does not
    // exist yet, and `realpathSync` on it would throw rather than answer.
    const missing: string[] = [];
    while (!existsSync(at)) {
      const up = dirname(at);
      if (up === at) return resolve(p);
      missing.unshift(at.slice(up.length + 1));
      at = up;
    }
    return join(realpathSync(at), ...missing);
  };
  const c = real(child);
  const b = real(parent);
  return c === b || c.startsWith(b + sep);
}

function countLines(text: string): number {
  if (!text.length) return 0;
  return text.split("\n").length;
}

export class Workspace {
  readonly root: string;
  /** `<root>/workspace` — what the team writes. `rounds/` and the brief sit beside it. */
  readonly filesRoot: string;
  private readonly meta = new Map<string, { lastWriter: string; lastRound: number }>();
  private readonly planned = new Map<string, { owner?: string; purpose: string }>();
  readonly edits: WorkspaceEdit[] = [];

  constructor(root: string) {
    this.root = resolve(root);
    this.filesRoot = join(this.root, "workspace");
    mkdirSync(this.filesRoot, { recursive: true });
  }

  /**
   * What the brief says should exist, before anybody has made it.
   *
   * Shown by `list_files` from round zero with `(not created yet)` beside it,
   * which is the cheapest orientation a team can be given: five agents who each
   * invent a filename in round one produce five files nobody agreed on, and the
   * artifact is then a directory of near-duplicates. The layout is the brief's
   * to decide, not the simulation's — see `briefs.ts`.
   */
  plan(path: string, spec: { owner?: string; purpose: string }): void {
    this.planned.set(normalisePath(path), spec);
  }

  /** Who may write here, if anybody in particular. */
  ownerOf(path: string): string | undefined {
    return this.planned.get(normalisePath(path))?.owner;
  }

  /**
   * Every path a caller supplies goes through here, and there is no other door.
   *
   * Both halves are load-bearing and they check different things. `normalisePath`
   * refuses by *shape* — no absolute paths, no `..`, no odd characters, no
   * extension this workspace does not hold — before any filesystem call is made.
   * `containedIn` then resolves symlinks and asks whether the result is really
   * inside the workspace, which is the check that catches what a shape rule
   * cannot: a directory somebody created that points somewhere else.
   *
   * Centralising it is the point. An earlier arrangement validated on the way
   * in to `plan()` and trusted the callers of `write`/`read`/`patch`, which
   * meant the extension rule was enforced against the brief's own layout and
   * against nothing a model ever typed.
   */
  private absolute(path: string): string {
    const target = join(this.filesRoot, normalisePath(path));
    if (!containedIn(target, this.filesRoot)) refuse(`"${path}" resolves outside the workspace.`);
    return target;
  }

  exists(path: string): boolean {
    return existsSync(this.absolute(path));
  }

  read(path: string): string {
    const target = this.absolute(path);
    if (!existsSync(target)) refuse(`there is no file "${path}". Use list_files to see what exists.`);
    return readFileSync(target, "utf8");
  }

  list(): FileInfo[] {
    const out: FileInfo[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
          continue;
        }
        const text = readFileSync(join(dir, entry.name), "utf8");
        const info = this.meta.get(rel);
        out.push({
          path: rel,
          bytes: Buffer.byteLength(text),
          lines: countLines(text),
          ...(info ? { lastWriter: info.lastWriter, lastRound: info.lastRound } : {}),
          ...(this.planned.get(rel)?.owner ? { owner: this.planned.get(rel)?.owner } : {}),
        });
      }
    };
    walk(this.filesRoot, "");

    // Planned-but-absent rows last, so the real contents are never buried under
    // a layout nobody has started on.
    const have = new Set(out.map((f) => f.path));
    for (const [path, spec] of this.planned) {
      if (have.has(path)) continue;
      out.push({ path, bytes: 0, lines: 0, planned: true, ...(spec.owner ? { owner: spec.owner } : {}) });
    }
    return out;
  }

  purposeOf(path: string): string | undefined {
    return this.planned.get(normalisePath(path))?.purpose;
  }

  private totalBytes(): number {
    return this.list()
      .filter((f) => !f.planned)
      .reduce((sum, f) => sum + f.bytes, 0);
  }

  private checkBudget(path: string, content: string): void {
    const bytes = Buffer.byteLength(content);
    if (bytes > LIMITS.fileBytes) {
      refuse(
        `that would make "${path}" ${bytes.toLocaleString("en-US")} bytes; the limit is ` +
          `${LIMITS.fileBytes.toLocaleString("en-US")}. Split it, or cut what is not pulling weight.`,
      );
    }
    const existing = this.exists(path) ? Buffer.byteLength(this.read(path)) : 0;
    const after = this.totalBytes() - existing + bytes;
    if (after > LIMITS.totalBytes) {
      refuse(
        `the workspace would reach ${after.toLocaleString("en-US")} bytes; the limit is ` +
          `${LIMITS.totalBytes.toLocaleString("en-US")}. Delete something that is not needed.`,
      );
    }
    if (!this.exists(path) && this.list().filter((f) => !f.planned).length >= LIMITS.files) {
      refuse(`the workspace already holds ${LIMITS.files} files, which is the limit. Work in the ones that exist.`);
    }
  }

  write(raw: string, content: string, by: string, round: number): WorkspaceEdit {
    // Canonical from the first line, so the metadata map, the budget check and
    // the file on disk are all keyed by the same string. They were not, and a
    // path that merely needed trimming recorded its author under a key
    // `list()` would never look up.
    const path = normalisePath(raw);
    this.checkBudget(path, content);
    const created = !this.exists(path);
    const before = created ? 0 : countLines(this.read(path));
    const target = this.absolute(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    this.meta.set(path, { lastWriter: by, lastRound: round });
    const edit: WorkspaceEdit = {
      path,
      by,
      round,
      kind: created ? "create" : "write",
      linesBefore: before,
      linesAfter: countLines(content),
    };
    this.edits.push(edit);
    return edit;
  }

  /**
   * One surgical replacement, refusing on zero matches and on more than one.
   *
   * The refusals are the feature. A `find` that matched nothing is the precise
   * moment an agent's model of a file stopped matching the file, and it is
   * worth counting — `patchesRefused` is the highest-signal number this
   * simulation produces. A `find` that matched twice is an edit that would have
   * silently changed the wrong one.
   *
   * Matches core's `edit` tool semantics deliberately, so the ergonomics under
   * test are the ergonomics a production agent gets rather than a benchmark's
   * own invention.
   */
  patch(raw: string, find: string, replace: string, by: string, round: number): WorkspaceEdit {
    const path = normalisePath(raw);
    if (!find) refuse("patch_file needs a `find` string. To create or replace a whole file, use write_file.");
    const current = this.read(path);
    if (find === replace) refuse("`find` and `replace` are identical, so that patch would change nothing.");

    let first = current.indexOf(find);
    let width = find.length;
    let loosened = false;

    /*
     * Fall back to matching without indentation, when that is unambiguous.
     *
     * Measured on the first jam run and it is a defect this file caused. Reads
     * come back *line-numbered* — `  12  const x = 1;` — so a model copying a
     * multi-line passage has to strip a prefix it never wrote and reproduce the
     * leading whitespace of every continuation line exactly. Single-line
     * patches worked; every multi-line one was refused. The author burned three
     * calls, then gave up and rewrote a 52-line file whole, which is precisely
     * the context cost `patch_file` exists to avoid.
     *
     * So: exact first, always. Only if that finds nothing, try again comparing
     * lines with their leading whitespace stripped — and only accept it if it
     * lands in exactly one place, because a fuzzy match with two candidates is
     * how a patch silently changes the wrong one. The result says it was
     * loosened, so nobody reads it as an exact hit.
     */
    if (first === -1) {
      const strip = (text: string) =>
        text
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n");
      const wantedLines = strip(find)
        .split("\n")
        .map((l) => l.trim());
      const haveLines = current.split("\n");
      const hits: Array<{ start: number; end: number }> = [];
      for (let i = 0; i + wantedLines.length <= haveLines.length; i++) {
        let all = true;
        for (let j = 0; j < wantedLines.length; j++) {
          if (haveLines[i + j].trim() !== wantedLines[j]) {
            all = false;
            break;
          }
        }
        if (all) {
          // Character offsets of the matched block, so the splice below is
          // identical to the exact path.
          const before = haveLines.slice(0, i).join("\n");
          const start = i === 0 ? 0 : before.length + 1;
          const block = haveLines.slice(i, i + wantedLines.length).join("\n");
          hits.push({ start, end: start + block.length });
          if (hits.length > 1) break;
        }
      }
      if (hits.length === 1) {
        first = hits[0].start;
        width = hits[0].end - hits[0].start;
        loosened = true;
      }
    }

    if (first === -1) {
      refuse(
        `that exact text is not in "${path}". ${this.nearestTo(path, find)} ` +
          "Line numbers in a `read_file` result are added by the tool — do not include them in `find`.",
      );
    }
    if (!loosened && current.indexOf(find, first + find.length) !== -1) {
      refuse(
        `that text appears more than once in "${path}", so replacing it would change the wrong one. ` +
          "Include a surrounding line or two to make it unique.",
      );
    }
    const next = current.slice(0, first) + replace + current.slice(first + width);
    this.checkBudget(path, next);
    writeFileSync(this.absolute(path), next);
    this.meta.set(path, { lastWriter: by, lastRound: round });
    const edit: WorkspaceEdit = {
      path,
      by,
      round,
      kind: "patch",
      linesBefore: countLines(current),
      linesAfter: countLines(next),
      ...(loosened ? { loosened: true } : {}),
    };
    this.edits.push(edit);
    return edit;
  }

  remove(raw: string, by: string, round: number): WorkspaceEdit {
    const path = normalisePath(raw);
    const before = countLines(this.read(path));
    rmSync(this.absolute(path));
    this.meta.delete(path);
    const edit: WorkspaceEdit = { path, by, round, kind: "delete", linesBefore: before, linesAfter: 0 };
    this.edits.push(edit);
    return edit;
  }

  /**
   * What is actually there, where the model thought its text was.
   *
   * A refusal that only says "not found" costs a whole round trip to recover
   * from, and the first jam run showed what that looks like: read, patch,
   * refused, read, patch, refused, give up, rewrite the file. Showing the
   * nearest region verbatim turns the refusal into a repair — the correct text
   * to copy is in the message that rejected the wrong one.
   */
  private nearestTo(path: string, find: string): string {
    const lines = this.read(path).split("\n");
    const needle = find.split("\n")[0].trim();
    if (!needle) return "";
    // The line sharing the longest prefix with what they were looking for.
    let best = -1;
    let bestScore = 0;
    for (const [index, line] of lines.entries()) {
      const have = line.trim();
      let n = 0;
      while (n < have.length && n < needle.length && have[n] === needle[n]) n++;
      if (n > bestScore) {
        bestScore = n;
        best = index;
      }
    }
    // Below a few characters it is matching whitespace and punctuation, and
    // pointing somewhere arbitrary is worse than saying nothing.
    if (best === -1 || bestScore < 6) return "Read it again and copy the text exactly.";
    const from = Math.max(0, best - 2);
    const to = Math.min(lines.length, best + 4);
    const excerpt = lines.slice(from, to).join("\n");
    return `The closest thing in the file, exactly as it is stored:\n${excerpt}\n`;
  }

  /**
   * A slice, numbered, and never the whole thing by accident.
   *
   * The default window is small and the maximum is not much bigger, because the
   * failure this guards against is not a model asking for too much — it is a
   * model asking for a file that has quietly grown past what its context can
   * hold, and getting it.
   */
  slice(raw: string, from?: number, to?: number): { text: string; from: number; to: number; total: number } {
    const path = normalisePath(raw);
    const lines = this.read(path).split("\n");
    const total = lines.length;
    const start = Math.max(1, Math.floor(from ?? 1));
    const requested = to === undefined ? start + LIMITS.readLines - 1 : Math.floor(to);
    const window = from === undefined && to === undefined ? LIMITS.readLines : LIMITS.readLinesMax;
    const end = Math.min(total, Math.max(start, Math.min(requested, start + window - 1)));
    const width = String(end).length;
    const text = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
      .join("\n");
    return { text, from: start, to: end, total };
  }

  /**
   * The shape of a file without its body.
   *
   * How a 900-line file stays navigable when nothing may read it whole. The
   * patterns are deliberately shallow — this is a table of contents, not a
   * parser, and a wrong guess costs a missing row rather than a wrong answer.
   */
  outline(raw: string): string {
    const path = normalisePath(raw);
    const lines = this.read(path).split("\n");
    const rows: string[] = [];
    const width = String(lines.length).length;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      let label: string | undefined;
      if (/^(#{1,6})\s+\S/.test(trimmed)) label = trimmed;
      else if (/^(export\s+)?(async\s+)?function\s+[A-Za-z_$]/.test(trimmed)) label = trimmed.replace(/\s*\{\s*$/, "");
      else if (/^(export\s+)?class\s+[A-Za-z_$]/.test(trimmed)) label = trimmed.replace(/\s*\{\s*$/, "");
      else if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?(\(|function)/.test(trimmed)) {
        label = trimmed.replace(/\s*\{\s*$/, "").slice(0, 90);
      } else if (/^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{$/.test(trimmed)) label = trimmed.replace(/\s*\{$/, "");
      else if (/^\/\/\s*[-=]{3,}/.test(trimmed) || /^\/\*\s*[-=]{3,}/.test(trimmed)) label = trimmed.slice(0, 90);
      else if (/^<(html|head|body|script|style|main|section|header|footer|nav|canvas)\b/i.test(trimmed)) {
        label = trimmed.slice(0, 90);
      } else if (/^[.#][A-Za-z][\w-]*[^;{]*\{$/.test(trimmed)) label = trimmed.replace(/\s*\{$/, "");
      if (label) rows.push(`${String(index + 1).padStart(width)}  ${label}`);
    }
    if (!rows.length) return `${path}: ${lines.length} lines, no headings or top-level definitions found.`;
    return `${path}, ${lines.length} lines:\n${rows.join("\n")}`;
  }

  /**
   * Freeze the workspace as it stands, so the run has a timeline rather than an
   * ending.
   *
   * Called at each round boundary. It is what lets a reviewer see the artifact
   * grow, what the broadcast's preview panel points at, and — most usefully —
   * what makes "round 14 is where it broke" a thing anybody can check.
   */
  snapshot(round: number): boolean {
    const files = this.list().filter((f) => !f.planned);
    // Skipped when nothing changed, which is not a disk optimisation so much as
    // an honesty one: the solo arm runs 220 rounds of one turn each, and a
    // directory per round would present 220 frames of which most are the
    // previous frame. `snapshots` in the manifest says which rounds exist, so a
    // reader never has to guess whether a gap means "unchanged" or "missing".
    const fingerprint = files.map((f) => `${f.path}:${f.bytes}:${f.lines}`).join("|");
    if (this.lastSnapshot === fingerprint) return false;
    this.lastSnapshot = fingerprint;
    const dir = join(this.root, "rounds", String(round).padStart(3, "0"));
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.read(file.path));
    }
    this.snapshots.push(round);
    return true;
  }

  /** Which rounds have a frozen copy on disk. See `snapshot`. */
  readonly snapshots: number[] = [];
  private lastSnapshot: string | undefined;

  /** Bytes on disk under the whole run directory, for a size sanity line. */
  bytesOnDisk(): number {
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else total += statSync(at).size;
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return total;
  }
}
