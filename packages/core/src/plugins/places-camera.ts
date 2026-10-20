/**
 * The places camera: a photo of an agent's room, taken the one way the room
 * can be seen, by letting the bundled UI draw it. It opens the UI's bare
 * `#/snapshot` page in headless Chromium and screenshots the frame.
 *
 * It needs Playwright with Chromium, as the browser tool does (`npm install
 * playwright && npx playwright install chromium`), and a runtime behind the
 * TAI server, which says how to reach it (`runtime.getSelfAccess()`). The
 * server's read header goes to the server and nowhere else: any other request
 * the page makes is refused.
 */
import type { SelfAccess } from "../runtime.js";

type Browser = import("playwright").Browser;

export interface Shot {
  agent: string;
  /** The whole room, or a close-up of the agent. */
  view: "room" | "selfie";
  /** The spot the avatar is at; its starting spot when omitted. */
  spot?: string;
  /** A gesture it is making as the picture is taken. */
  gesture?: string;
}

/** Landscape for the room, portrait for a selfie, as a phone would take them. */
const SIZES = { room: { width: 1200, height: 800 }, selfie: { width: 800, height: 1000 } } as const;
/** Long enough for a cold model and its animations on a software renderer. */
const SHOT_TIMEOUT_MS = 45_000;
/** The browser stays up this long after a photo, for the next one, then goes. */
const KEEP_WARM_MS = 120_000;

/** Said when Playwright itself isn't there to start a browser with. */
const NO_PLAYWRIGHT =
  "No photo: this server can't take photos, as Playwright isn't installed. Someone running TAI can add it with `npm install playwright`, then `npx playwright install chromium`.";

/**
 * Why a photo couldn't be taken, in a sentence for the agent to pass on:
 * what is missing, and what a person can do about it. Playwright's own
 * errors are a banner in box drawing, a call log and the browser's path in
 * someone's home directory, which a model repeats word for word. Of anything
 * else, the first line is kept, without paths.
 */
export function photoProblem(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === NO_PLAYWRIGHT) return raw;
  if (/missing dependencies|install-deps/i.test(raw))
    return "No photo: the browser photos are taken with can't start here, as system libraries it needs are missing. Someone running TAI can add them with `npx playwright install-deps chromium`.";
  if (/Executable doesn't exist|playwright install|download new browsers/i.test(raw))
    return "No photo: the browser photos are taken with isn't installed on this server. Someone running TAI can install it with `npx playwright install chromium`.";
  if (/Timeout \d+ms exceeded/i.test(raw)) return "No photo: the room took too long to draw. Try again in a moment.";
  const first =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^[\u2500-\u257f]/.test(line)) ?? "";
  const plain = first.replace(/(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/'"`]+){2,}[\\/]?/g, "…").slice(0, 200);
  return plain || "No photo: something went wrong taking it.";
}

export class PlaceCamera {
  private browser: Promise<Browser> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly access: () => SelfAccess | undefined) {}

  /** A PNG of the shot. One at a time: a second waits for the first. Failing, it says why in plain words. */
  take(shot: Shot): Promise<Buffer> {
    const run = this.queue.then(
      () => this.shoot(shot),
      () => this.shoot(shot),
    );
    this.queue = run.catch(() => {});
    return run.catch((err) => {
      throw new Error(photoProblem(err));
    });
  }

  private async launch(): Promise<Browser> {
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      throw new Error(NO_PLAYWRIGHT);
    }
    // No GPU in a headless browser: WebGL runs on SwiftShader, Chromium's software renderer.
    return pw.chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
  }

  private async shoot(shot: Shot): Promise<Buffer> {
    const access = this.access();
    if (!access) throw new Error("Photos need the TAI server running: it is what draws the room.");
    if (this.idle) clearTimeout(this.idle);
    this.browser ??= this.launch();
    let browser: Browser;
    try {
      browser = await this.browser;
    } catch (err) {
      this.browser = undefined;
      throw err;
    }
    const context = await browser.newContext({ viewport: SIZES[shot.view], deviceScaleFactor: 1 });
    try {
      const origin = new URL(access.baseUrl).origin;
      await context.route("**/*", (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin) return route.abort();
        return route.continue({ headers: { ...request.headers(), ...access.headers } });
      });
      const page = await context.newPage();
      const query = new URLSearchParams({
        agent: shot.agent,
        view: shot.view,
        ...(shot.spot ? { spot: shot.spot } : {}),
        ...(shot.gesture ? { gesture: shot.gesture } : {}),
      });
      await page.goto(`${access.baseUrl}/#/snapshot?${query}`, { waitUntil: "domcontentloaded" });
      const frame = await page.waitForSelector("[data-snapshot='ready'], [data-snapshot='failed']", {
        timeout: SHOT_TIMEOUT_MS,
      });
      if ((await frame.getAttribute("data-snapshot")) === "failed") {
        const why = (await frame.textContent())?.trim();
        throw new Error(`The room couldn't be drawn: ${why || "no reason given"}`);
      }
      return await frame.screenshot({ type: "png" });
    } finally {
      await context.close().catch(() => {});
      this.idle = setTimeout(() => void this.close(), KEEP_WARM_MS);
      this.idle.unref?.();
    }
  }

  /** Let the browser go. The next photo starts another. */
  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const pending = this.browser;
    this.browser = undefined;
    const browser = await pending?.catch(() => undefined);
    await browser?.close().catch(() => {});
  }
}
