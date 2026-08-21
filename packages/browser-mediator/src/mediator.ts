import { randomBytes } from "node:crypto";

import { type ActionClass, type AlwaysHitlConfig, classifyButtonText, isAlwaysHitl } from "./always-hitl.js";
import { registerMediatorSession, unregisterMediatorSession } from "./egress-policy.js";
import { DEFAULT_SANITIZER_PATTERNS, type SanitizerPattern, sanitizeOutput } from "./output-sanitizer.js";

type PlaywrightBrowser = import("playwright").Browser;
type PlaywrightContext = import("playwright").BrowserContext;
type PlaywrightPage = import("playwright").Page;

const REF_PATTERN = /\$([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/g;

export interface BrowserMediatorOptions {
  headless?: boolean;
  timeoutMs?: number;
  /**
   * Hostnames the session may reach. Subdomains of an entry are also
   * allowed. Empty list = deny-all (the session can't navigate anywhere).
   */
  egressAllowList?: string[];
  /**
   * Vault lookup hook. When set, `$ns.key` substrings in `type_text`
   * values are expanded server-side before reaching Playwright. The
   * raw value never returns to the caller; audit entries show
   * `<masked:$ns.key>` instead. Return `null` to leave the ref alone.
   */
  resolveSecret?: (ns: string, key: string) => Promise<string | null>;
  /** Per-domain always-HITL overrides. Defaults apply when absent. */
  alwaysHitlConfig?: Record<string, AlwaysHitlConfig>;
  /** Audit callback fired for every API call (post-result). */
  audit?: (entry: BrowserAuditEntry) => void;
  /** Override sanitiser patterns; defaults cover PAN/SSN/IBAN/phone/email/address. */
  sanitizerPatterns?: SanitizerPattern[];
}

export interface BrowserAuditEntry {
  sessionId: string;
  callId: number;
  timestamp: string;
  action: string;
  args: Record<string, unknown>;
  result: "ok" | "refused" | "error";
  detail?: string;
  durationMs: number;
}

export interface LinkRef {
  text: string;
  node_id: string;
}

export class EgressBlockedError extends Error {
  constructor(public host: string) {
    super(`Egress to ${host} is not in the allow-list`);
    this.name = "EgressBlockedError";
  }
}

export class AlwaysHitlRefusedError extends Error {
  constructor(
    public actionClass: ActionClass,
    public buttonText: string,
  ) {
    super(`Refusing to ${actionClass} — high-risk action requires operator approval.`);
    this.name = "AlwaysHitlRefusedError";
  }
}

/**
 * Bounded browser-control surface for LLM agents. The boundary against
 * prompt injection is the API shape — no JS eval, no cookie/storage
 * accessor, no raw HTTP. The mediator is framework-agnostic: it
 * exposes plain methods that any agent framework can wrap.
 *
 * See `adapters/` for ready-made wrappers (OpenAI, Anthropic, TAI).
 */
export class BrowserMediator {
  readonly sessionId: string;
  private opts: BrowserMediatorOptions;
  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightContext | null = null;
  private page: PlaywrightPage | null = null;
  private elementMap = new Map<string, string>();
  private elementCounter = 0;
  private callCounter = 0;
  private allowSet: Set<string>;
  private sanitizerPatterns: SanitizerPattern[];

  constructor(opts: BrowserMediatorOptions = {}) {
    this.opts = opts;
    this.sessionId = `bm-${randomBytes(6).toString("hex")}`;
    this.allowSet = new Set((opts.egressAllowList ?? []).map((h) => h.toLowerCase()));
    this.sanitizerPatterns = opts.sanitizerPatterns ?? DEFAULT_SANITIZER_PATTERNS;
  }

  /**
   * Launch Playwright and install the egress route filter. Registers
   * the session with the process-global crosstalk policy so sibling
   * outbound tools (HTTP fetch, etc.) can consult it.
   */
  async start(): Promise<void> {
    if (this.browser) return;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.route("**/*", async (route) => {
      const host = new URL(route.request().url()).hostname.toLowerCase();
      if (this.hostAllowed(host)) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    if (this.opts.timeoutMs) {
      this.page.setDefaultTimeout(this.opts.timeoutMs);
    }
    registerMediatorSession(this.sessionId, this.opts.egressAllowList ?? []);
  }

  async close(): Promise<void> {
    unregisterMediatorSession(this.sessionId);
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.elementMap.clear();
  }

  hostAllowed(host: string): boolean {
    if (this.allowSet.size === 0) return false;
    const lc = host.toLowerCase();
    if (this.allowSet.has(lc)) return true;
    for (const entry of this.allowSet) {
      if (lc.endsWith(`.${entry}`)) return true;
    }
    return false;
  }

  // ---------- Public surface ----------

  async navigate(url: string): Promise<string> {
    return this.call("navigate", { url }, async () => {
      const page = this.requirePage();
      const host = new URL(url).hostname;
      if (!this.hostAllowed(host)) throw new EgressBlockedError(host);
      this.elementMap.clear();
      this.elementCounter = 0;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      return `Navigated to ${page.url()}. Status: ${resp?.status() ?? "unknown"}. Title: ${await page.title()}.`;
    });
  }

  async url(): Promise<string> {
    return this.call("url", {}, async () => {
      const page = this.requirePage();
      return `${page.url()}\nTitle: ${await page.title()}`;
    });
  }

  async readText(maxChars = 4000): Promise<string> {
    return this.call("read_text", { maxChars }, async () => {
      const page = this.requirePage();
      const text =
        (await page
          .locator("body")
          .innerText({ timeout: 5000 })
          .catch(() => "")) || "";
      if (text.length > maxChars) {
        return `${text.slice(0, maxChars)}\n... (truncated, ${text.length} chars total)`;
      }
      return text;
    });
  }

  async readLinks(): Promise<LinkRef[]> {
    return this.callRaw("read_links", {}, async () => {
      const page = this.requirePage();
      const links = await page.$$eval("a[href]", (els) =>
        els.slice(0, 200).map((a, i) => ({
          idx: i,
          text: ((a as HTMLAnchorElement).innerText || "").trim().slice(0, 80),
          href: (a as HTMLAnchorElement).href,
        })),
      );
      const out: LinkRef[] = [];
      for (const link of links) {
        if (!link.text) continue;
        const id = this.mintId(`a[href="${cssEscape(link.href)}"]`);
        out.push({ text: link.text, node_id: id });
      }
      return out;
    });
  }

  /**
   * Click an opaque element id from a prior `read_links`, or a
   * `text=…` reference. Visible text matching an always-HITL class
   * (place-order, submit-payment, etc.) refuses to fire.
   */
  async click(nodeIdOrText: string): Promise<string> {
    return this.call("click", { nodeIdOrText }, async () => {
      const page = this.requirePage();
      const selector = this.resolveSelector(nodeIdOrText);
      const locator = page.locator(selector).first();
      const visible = (await locator.textContent({ timeout: 2000 }).catch(() => "")) || "";
      const cls = classifyButtonText(visible.trim());
      if (cls) {
        const host = new URL(page.url()).hostname;
        if (isAlwaysHitl(cls, host, this.opts.alwaysHitlConfig ?? {})) {
          throw new AlwaysHitlRefusedError(cls, visible.trim());
        }
      }
      await locator.click({ timeout: 5000 });
      return `Clicked "${visible.trim().slice(0, 80)}". Now at ${page.url()}.`;
    });
  }

  /**
   * Fill an input. Values containing `$ns.key` are expanded via the
   * `resolveSecret` hook before reaching the page; the raw secret
   * never crosses back to the caller, and audit entries store the
   * masked form.
   */
  async typeText(nodeIdOrText: string, value: string): Promise<string> {
    let expanded = value;
    let masked = value;
    if (this.opts.resolveSecret) {
      expanded = await expandRefs(value, this.opts.resolveSecret);
      masked = value.replace(REF_PATTERN, (m) => `<masked:${m}>`);
    }
    return this.call("type_text", { nodeIdOrText, value: masked }, async () => {
      const page = this.requirePage();
      const selector = this.resolveSelector(nodeIdOrText);
      await page.locator(selector).first().fill(expanded, { timeout: 5000 });
      return `Filled ${masked.length} chars into ${nodeIdOrText}.`;
    });
  }

  /**
   * Capture the viewport and return the image.
   *
   * This used to take the screenshot, report its size, and drop the buffer on
   * the floor — "Mediator-owned; caller gets metadata only". That made a
   * vision-capable browser agent unrepresentable rather than merely
   * unimplemented: there was no path by which pixels could reach a model.
   *
   * The bytes come back raw. Deciding where they live is the host's job, not
   * this package's — it stays free of any framework dependency, and the TAI
   * adapter is what puts them in a media store.
   */
  async screenshot(): Promise<{ bytes: Buffer; mimeType: string }> {
    // `callRaw`, not `call`: the audit entry is wanted, the text sanitizer is
    // not — it matches secrets in strings and has nothing to say about PNG
    // bytes.
    const bytes = await this.callRaw("screenshot", {}, async () => {
      const page = this.requirePage();
      return page.screenshot({ fullPage: false });
    });
    return { bytes, mimeType: "image/png" };
  }

  /** Size-only description, for callers that cannot carry an image. */
  async screenshotMeta(): Promise<string> {
    const { bytes } = await this.screenshot();
    return `Captured ${bytes.length} bytes.`;
  }

  async waitFor(opts: { text?: string; selector?: string; timeoutMs?: number }): Promise<string> {
    return this.call("wait_for", opts, async () => {
      const page = this.requirePage();
      const timeout = opts.timeoutMs ?? this.opts.timeoutMs ?? 30_000;
      if (opts.selector) {
        await page.locator(this.resolveSelector(opts.selector)).first().waitFor({ state: "visible", timeout });
      } else if (opts.text) {
        await page.getByText(opts.text).first().waitFor({ state: "visible", timeout });
      } else {
        throw new Error("wait_for needs `text` or `selector`");
      }
      return "visible";
    });
  }

  // ---------- Internals ----------

  private mintId(selector: string): string {
    const id = `el:${this.sessionId}:${++this.elementCounter}`;
    this.elementMap.set(id, selector);
    return id;
  }

  private resolveSelector(ref: string): string {
    if (ref.startsWith("el:")) {
      const sel = this.elementMap.get(ref);
      if (!sel) throw new Error(`unknown element id ${ref}`);
      return sel;
    }
    if (ref.startsWith("text=") || ref.startsWith("role=")) return ref;
    return `text=${ref}`;
  }

  private requirePage(): PlaywrightPage {
    if (!this.page) throw new Error("BrowserMediator not started; call start() first");
    return this.page;
  }

  private sanitize(s: string): string {
    return sanitizeOutput(s, this.sanitizerPatterns);
  }

  private async call(action: string, args: Record<string, unknown>, fn: () => Promise<string>): Promise<string> {
    const start = Date.now();
    const callId = ++this.callCounter;
    try {
      const sanitized = this.sanitize(await fn());
      this.emitAudit({ callId, action, args, result: "ok", durationMs: Date.now() - start });
      return sanitized;
    } catch (err) {
      const refused = err instanceof EgressBlockedError || err instanceof AlwaysHitlRefusedError;
      this.emitAudit({
        callId,
        action,
        args,
        result: refused ? "refused" : "error",
        detail: (err as Error).message,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  private async callRaw<T>(action: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const callId = ++this.callCounter;
    try {
      const r = await fn();
      this.emitAudit({ callId, action, args, result: "ok", durationMs: Date.now() - start });
      return r;
    } catch (err) {
      this.emitAudit({
        callId,
        action,
        args,
        result: "error",
        detail: (err as Error).message,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  private emitAudit(p: Omit<BrowserAuditEntry, "sessionId" | "timestamp">): void {
    if (!this.opts.audit) return;
    this.opts.audit({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...p,
    });
  }
}

async function expandRefs(
  input: string,
  resolve: (ns: string, key: string) => Promise<string | null>,
): Promise<string> {
  const matches = [...input.matchAll(REF_PATTERN)];
  if (matches.length === 0) return input;
  let result = "";
  let lastEnd = 0;
  for (const m of matches) {
    const value = await resolve(m[1], m[2]);
    result += input.slice(lastEnd, m.index);
    result += value ?? m[0];
    lastEnd = m.index + m[0].length;
  }
  result += input.slice(lastEnd);
  return result;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
