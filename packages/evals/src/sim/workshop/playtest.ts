/**
 * Actually run the thing, and describe what appeared on screen.
 *
 * `check_syntax` answers "does it parse", which is a real question and a small
 * one: a syntactically perfect page that throws on load, or draws nothing at
 * all, passes it completely. The first two live runs both ended with a tester
 * writing a section headed "Not verifiable this run" — honest, and a ceiling on
 * how good the artifact could get, because nobody could tell a working game
 * from a black rectangle.
 *
 * ## Why this describes a screenshot instead of sending one
 *
 * **Not because the model cannot see.** That was the original justification
 * here and it was wrong, corrected on 2026-08-20 by checking rather than
 * assuming: the artifact being served is `image-text-to-text`, its card lists
 * registered Vision allocations alongside the Text and MTP ones, and NInfer
 * serves media behind a `--vision` flag that simply is not on — a request with
 * an `image_url` part comes back `vision_disabled`, which is a server setting,
 * not a missing capability.
 *
 * The real blocker is one tier down. TAI cannot carry an image at all:
 * `ToolResult.output` is a `string`, and `ChatMessage.content` is
 * `string | null` with no content-parts array. There is nowhere to put a PNG
 * between a tool and a model, so a tool that returned one would have to
 * stringify it and hope.
 *
 * So the canvas is read back through `getImageData` *inside the page* — no
 * image decoding needed — and reduced to things a sentence can carry: how much
 * of the frame is not background, which colours dominate and in what
 * proportion, and a coarse luminance grid giving the shape of what is drawn.
 * That is worth keeping even after TAI grows an image path: it is small, it
 * diffs cleanly between frames, and "6.6% of the frame is not background"
 * survives a history trim in a way an image would not.
 *
 * The real screenshots are written to disk beside the artifact for the human
 * who reviews it. Both audiences get the form they can actually use.
 *
 * ## What it does to be safe
 *
 * This is the one place in the package that executes model-written code, so:
 * DNS is mapped to nothing, every non-`file:` request is aborted, Chrome's own
 * sandbox is left on, the profile is a temp directory, and everything races a
 * hard timeout. `file:` pages get an opaque origin in Chrome and
 * `--allow-file-access-from-files` is deliberately *not* set, so the page
 * cannot read the rest of the disk.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** A frame, as a text model can read it. */
export interface Frame {
  label: string;
  /** Fraction of pixels that differ from the most common colour. */
  coverage: number;
  /** Most common colours and their share, brightest-first after the background. */
  palette: Array<{ colour: string; share: number }>;
  /** Coarse luminance map — the shape of what is on screen. */
  grid: string[];
}

export interface PlaytestReport {
  ok: boolean;
  /** Why it could not run at all, when it could not. */
  unavailable?: string;
  errors: string[];
  warnings: string[];
  logs: string[];
  canvas?: { w: number; h: number };
  frames: Frame[];
  /** Did anything change between two samples with no input? */
  animates: boolean;
  /** Did the screen change after keys were pressed? */
  respondsToInput: boolean;
  /** Where the PNGs went, for the human. */
  screenshots: string[];
  /** When there is no canvas at all — a DOM artifact rather than a game. */
  dom?: { title: string; text: string; elements: number };
}

const RAMP = " .:-=+*#%@";

/** Only what this file touches. See the note in `playtest` on why it is not the real type. */
interface PageLike {
  on(event: string, handler: (arg: never) => void): void;
  setViewport(v: { width: number; height: number }): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/**
 * Everything that happens in the browser, in one expression, so it can be one
 * `evaluate`.
 *
 * An immediately-invoked function, and the parentheses are the whole point:
 * `page.evaluate` given a *string* evaluates it as an expression, so a bare
 * `() => {...}` evaluates to a function object that is never called. The first
 * live probe reported "no console errors" and zero frames, which reads exactly
 * like a page that draws nothing.
 */
const SAMPLE = `(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    return { kind: 'dom',
      title: document.title || '',
      text: (document.body ? document.body.innerText : '').slice(0, 600),
      elements: document.getElementsByTagName('*').length };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return { kind: 'nocontext' };
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  // Colour histogram, quantised so anti-aliasing does not shatter it.
  const counts = new Map();
  const q = (v) => (v >> 4) << 4;
  for (let i = 0; i < data.length; i += 4) {
    const key = (q(data[i]) << 16) | (q(data[i + 1]) << 8) | q(data[i + 2]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = w * h;
  const hex = (k) => '#' + [(k >> 16) & 255, (k >> 8) & 255, k & 255]
    .map((n) => n.toString(16).padStart(2, '0')).join('');
  const background = sorted.length ? sorted[0][0] : 0;
  const coverage = sorted.length ? 1 - sorted[0][1] / total : 0;
  const palette = sorted.slice(0, 6).map(([k, n]) => ({ colour: hex(k), share: n / total }));

  // Coarse luminance grid: the shape of what is drawn, 32 x 16.
  const COLS = 32, ROWS = 16;
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
      let sum = 0, n = 0;
      const x0 = Math.floor((c * w) / COLS), x1 = Math.floor(((c + 1) * w) / COLS);
      const y0 = Math.floor((r * h) / ROWS), y1 = Math.floor(((r + 1) * h) / ROWS);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          n++;
        }
      }
      line += String(n ? sum / n : 0);
      line += ',';
    }
    grid.push(line);
  }
  return { kind: 'canvas', w, h, coverage, palette, grid, background: hex(background) };
})()`;

/** Luminance rows from the page turned into characters, scaled to what is actually there. */
function toAscii(rows: string[]): string[] {
  const values = rows.map((row) =>
    row
      .split(",")
      .filter((v) => v.length > 0)
      .map((v) => Number(v)),
  );
  const flat = values.flat();
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  const span = hi - lo || 1;
  return values.map((row) =>
    row
      .map((v) => {
        const t = (v - lo) / span;
        return RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(t * (RAMP.length - 1))))];
      })
      .join(""),
  );
}

function differs(a: Frame | undefined, b: Frame | undefined): boolean {
  if (!a || !b) return false;
  if (a.grid.length !== b.grid.length) return true;
  let changed = 0;
  let cells = 0;
  for (let r = 0; r < a.grid.length; r++) {
    for (let c = 0; c < a.grid[r].length; c++) {
      cells++;
      if (a.grid[r][c] !== b.grid[r][c]) changed++;
    }
  }
  // A couple of cells is anti-aliasing noise; a real frame change moves more.
  return cells > 0 && changed / cells > 0.01;
}

export interface PlaytestOptions {
  /** The page to open. */
  entry: string;
  /** The directory holding it. */
  workspace: string;
  /** Where PNGs go. */
  shotDir: string;
  /** Overall ceiling. A game with a runaway loop must not hold the run open. */
  timeoutMs?: number;
}

/**
 * Open the artifact, poke it, and report what happened.
 *
 * Never throws: every failure is a report the agent can read and act on, which
 * is the same rule the tools follow. A crash here would take down a run whose
 * model time has already been spent.
 */
export async function playtest(options: PlaytestOptions): Promise<PlaytestReport> {
  const report: PlaytestReport = {
    ok: false,
    errors: [],
    warnings: [],
    logs: [],
    frames: [],
    animates: false,
    respondsToInput: false,
    screenshots: [],
  };

  // Typed loosely on purpose. `puppeteer` is a transitive dependency here (it
  // arrives via `md-to-pdf`), so the module resolved at runtime need not be the
  // one the compiler found, and pinning the type couples this file to a version
  // nothing declares. Only four calls are used and each is guarded.
  type Launcher = { launch: (opts: Record<string, unknown>) => Promise<BrowserLike> };
  let puppeteer: Launcher;
  try {
    puppeteer = (await import("puppeteer")).default as unknown as Launcher;
  } catch (err) {
    report.unavailable = `a headless browser is not available in this checkout (${(err as Error).message}). check_syntax still works.`;
    return report;
  }

  const timeout = options.timeoutMs ?? 25_000;
  let browser: BrowserLike | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-first-run",
        // No DNS, for a page that is not allowed to reach the network anyway.
        // The brief says self-contained; this is what makes it true rather than
        // asked for.
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--mute-audio",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 720 });

    page.on("console", (message: { text(): string; type(): string }) => {
      const text = `${message.text()}`.slice(0, 300);
      const kind = String(message.type());
      // Warnings this harness caused itself must never reach the agent. The
      // canvas readback below triggers Chrome's `willReadFrequently` advice,
      // which is about *our* getImageData and not about anything the team
      // wrote — reporting it would send somebody to fix a problem they do not
      // have.
      if (/willReadFrequently|getImageData are faster/i.test(text)) return;
      if (kind === "error") report.errors.push(text);
      else if (kind === "warn" || kind === "warning") report.warnings.push(text);
      else if (report.logs.length < 12) report.logs.push(text);
    });
    page.on("pageerror", (err: unknown) =>
      report.errors.push(`uncaught: ${(err as Error)?.message ?? String(err)}`.slice(0, 300)),
    );
    page.on("requestfailed", (request: { url(): string }) => {
      const url = request.url();
      if (!url.startsWith("file:")) report.warnings.push(`blocked network request to ${url.slice(0, 120)}`);
    });

    await page.setRequestInterception(true);
    page.on("request", (request: { url(): string; continue(): unknown; abort(): unknown }) => {
      // `file:` only. Anything else is a brief violation and is refused rather
      // than merely reported, so a run cannot depend on the network by accident.
      if (request.url().startsWith("file:")) void request.continue();
      else void request.abort();
    });

    mkdirSync(options.shotDir, { recursive: true });

    const shoot = async (label: string): Promise<void> => {
      const path = join(options.shotDir, `${label}.png`);
      try {
        await page.screenshot({ path });
        report.screenshots.push(path);
      } catch {
        // A screenshot is for the human; losing one must not fail the playtest.
      }
    };

    const sample = async (label: string): Promise<Frame | undefined> => {
      const raw = (await page.evaluate(SAMPLE)) as Record<string, unknown>;
      if (raw?.kind === "dom") {
        report.dom = {
          title: String(raw.title ?? ""),
          text: String(raw.text ?? ""),
          elements: Number(raw.elements ?? 0),
        };
        return undefined;
      }
      if (raw?.kind !== "canvas") return undefined;
      report.canvas = { w: Number(raw.w), h: Number(raw.h) };
      const frame: Frame = {
        label,
        coverage: Number(raw.coverage ?? 0),
        palette: (raw.palette as Frame["palette"]) ?? [],
        grid: toAscii((raw.grid as string[]) ?? []),
      };
      report.frames.push(frame);
      return frame;
    };

    const url = `file://${join(options.workspace, options.entry)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    // Let a boot sequence and one animation frame happen.
    await new Promise((r) => setTimeout(r, 700));

    const first = await sample("01-opened");
    await shoot("01-opened");

    // Two samples with no input at all: does it animate on its own?
    await new Promise((r) => setTimeout(r, 500));
    const idle = await sample("02-idle");
    report.animates = differs(first, idle);

    // Start it. Most title screens take one of these.
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 500));
    const started = await sample("03-after-start");
    await shoot("03-after-start");

    /*
     * Hold one direction, and sample *during* play.
     *
     * The first version mashed every direction in sequence, which in a game
     * where your own trail is solid is a request to die immediately: the
     * only frame it ever captured was a game-over screen reading SCORE 0.
     * That is a true description of what the robot did and a useless one for
     * anybody trying to see whether the game works.
     *
     * One direction, held, is what a player does first.
     */
    await page.keyboard.down("ArrowRight").catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
    const playing = await sample("04-playing");
    await shoot("04-playing");
    await page.keyboard.up("ArrowRight").catch(() => {});

    // Then a gentle turn, and the action key, to see whether anything answers.
    for (const key of ["ArrowUp", "KeyW", "Space"]) {
      await page.keyboard.down(key).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.up(key).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
    const played = await sample("05-after-input");
    await shoot("05-after-input");
    report.respondsToInput = differs(started, playing) || differs(started, played) || differs(first, played);

    // A game that is still moving while nobody is pressing anything is the
    // strongest evidence available here that a loop is actually running.
    if (!report.animates) report.animates = differs(playing, played);

    report.ok = true;
    return report;
  } catch (err) {
    report.errors.push(`playtest could not complete: ${(err as Error).message}`.slice(0, 300));
    return report;
  } finally {
    // `close` can hang on a page with a runaway loop; the run must not.
    await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, timeout))]).catch(() => {});
  }
}

/** The report, as the agent reads it. Numbers and shapes, never a verdict on quality. */
export function formatPlaytest(report: PlaytestReport, entry: string): string {
  if (report.unavailable) return `Could not run it: ${report.unavailable}`;

  const lines: string[] = [];
  lines.push(
    report.ok ? `Opened ${entry} in a real browser and drove it.` : `Tried to open ${entry} and could not finish.`,
  );

  if (report.errors.length) {
    lines.push(`${report.errors.length} error${report.errors.length === 1 ? "" : "s"} on the console:`);
    for (const e of report.errors.slice(0, 8)) lines.push(`  ! ${e}`);
  } else if (report.ok) {
    lines.push("No console errors and nothing thrown.");
  }
  for (const w of report.warnings.slice(0, 4)) lines.push(`  warning: ${w}`);

  if (report.dom && !report.canvas) {
    lines.push(`No <canvas> on the page. ${report.dom.elements} elements, title "${report.dom.title}".`);
    if (report.dom.text.trim()) lines.push(`Visible text begins: ${report.dom.text.trim().slice(0, 200)}`);
  }

  if (report.canvas) {
    lines.push(`Canvas ${report.canvas.w}x${report.canvas.h}.`);
    lines.push(
      report.animates
        ? "It animates on its own with no input."
        : "Nothing moved between two samples taken half a second apart with no input.",
    );
    lines.push(
      report.respondsToInput
        ? "The screen changed after keys were pressed."
        : "The screen did NOT change after Enter, Space, the arrows and WASD were pressed.",
    );
  }

  // The first and last frames only. Every frame would be four screens of text
  // for a marginal gain, and these two are the ones that answer "does anything
  // appear" and "did playing it change what is there".
  const show = [report.frames[0], report.frames[report.frames.length - 1]].filter(
    (f, i, a): f is Frame => !!f && (i === 0 || f !== a[0]),
  );
  for (const frame of show) {
    lines.push("");
    lines.push(`--- ${frame.label} --- ${(frame.coverage * 100).toFixed(1)}% of the frame is not background`);
    lines.push(`colours: ${frame.palette.map((p) => `${p.colour} ${(p.share * 100).toFixed(0)}%`).join("  ")}`);
    for (const row of frame.grid) lines.push(`|${row}|`);
  }

  if (report.frames.length && report.frames.every((f) => f.coverage < 0.001)) {
    lines.push("");
    lines.push("Every frame was a flat single colour. Nothing is being drawn.");
  }

  if (report.screenshots.length) {
    lines.push("");
    lines.push(`${report.screenshots.length} screenshots saved for the human reviewer.`);
  }
  lines.push("");
  lines.push(
    "The grid is a coarse luminance map, darkest to lightest as ` .:-=+*#%@`. It is a description of " +
      "the screen, not the screen — read it for shape and change, not detail.",
  );
  return lines.join("\n");
}
