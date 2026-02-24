import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface BrowserToolConfig {
  enabled: boolean;
  headless?: boolean;
  screenshotDir?: string;
  timeoutMs?: number;
}

type PlaywrightBrowser = import("playwright").Browser;
type PlaywrightPage = import("playwright").Page;

export class BrowserTool implements Tool {
  name = "browser";
  description = "Control a browser. Actions: navigate, click, type, screenshot, get_text, wait, back, close.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "type", "screenshot", "get_text", "wait", "back", "close"],
        description: "The browser action to perform.",
      },
      url: { type: "string", description: "URL to navigate to (for navigate)." },
      selector: { type: "string", description: "CSS or text= selector (for click, type, screenshot, get_text, wait)." },
      text: { type: "string", description: "Text to type (for type)." },
      timeout_ms: { type: "number", description: "Wait timeout in ms (for wait)." },
    },
    required: ["action"],
  };

  private headless: boolean;
  private screenshotDir: string;
  private timeoutMs: number;
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;

  constructor(config: BrowserToolConfig) {
    this.headless = config.headless ?? true;
    this.screenshotDir = config.screenshotDir ?? "./data/screenshots";
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case "navigate":
          return await this.navigate(args.url as string);
        case "click":
          return await this.click(args.selector as string);
        case "type":
          return await this.typeText(args.selector as string, args.text as string);
        case "screenshot":
          return await this.screenshot(args.selector as string | undefined);
        case "get_text":
          return await this.getText(args.selector as string | undefined);
        case "wait":
          return await this.waitFor(args.selector as string | undefined, args.timeout_ms as number | undefined);
        case "back":
          return await this.goBack();
        case "close":
          return await this.closeBrowser();
        default:
          return { success: false, output: "", error: `Unknown action "${action}".` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async ensureBrowser(): Promise<PlaywrightPage> {
    if (this.page) return this.page;

    const pw = await import("playwright");
    this.browser = await pw.chromium.launch({ headless: this.headless });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);
    return this.page;
  }

  private async navigate(url: string): Promise<ToolResult> {
    if (!url) return { success: false, output: "", error: '"url" is required for navigate.' };

    const page = await this.ensureBrowser();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    const title = await page.title();
    return { success: true, output: `Status ${status} | Title: ${title}` };
  }

  private async click(selector: string): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: '"selector" is required for click.' };

    const page = await this.ensureBrowser();
    await page.click(selector);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const title = await page.title();
    return { success: true, output: `Clicked. URL: ${page.url()} | Title: ${title}` };
  }

  private async typeText(selector: string, text: string): Promise<ToolResult> {
    if (!selector) return { success: false, output: "", error: '"selector" is required for type.' };
    if (!text) return { success: false, output: "", error: '"text" is required for type.' };

    const page = await this.ensureBrowser();
    await page.fill(selector, text);
    return { success: true, output: `Typed "${text}" into ${selector}.` };
  }

  private async screenshot(selector?: string): Promise<ToolResult> {
    const page = await this.ensureBrowser();

    mkdirSync(resolve(this.screenshotDir), { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const filepath = resolve(this.screenshotDir, filename);

    if (selector) {
      const element = await page.$(selector);
      if (!element) return { success: false, output: "", error: `Element not found: ${selector}` };
      await element.screenshot({ path: filepath });
    } else {
      await page.screenshot({ path: filepath });
    }

    return { success: true, output: `Screenshot saved: ${filepath}` };
  }

  private async getText(selector?: string): Promise<ToolResult> {
    const page = await this.ensureBrowser();

    let text: string;
    if (selector) {
      const element = await page.$(selector);
      if (!element) return { success: false, output: "", error: `Element not found: ${selector}` };
      text = (await element.innerText()) ?? "";
    } else {
      text = await page.innerText("body");
    }

    const maxLen = 4000;
    if (text.length > maxLen) {
      text = `${text.slice(0, maxLen)}\n... (truncated, ${text.length} chars total)`;
    }

    return { success: true, output: text };
  }

  private async waitFor(selector?: string, timeoutMs?: number): Promise<ToolResult> {
    const page = await this.ensureBrowser();
    const timeout = timeoutMs ?? this.timeoutMs;

    if (selector) {
      await page.waitForSelector(selector, { timeout });
      return { success: true, output: `Element "${selector}" is visible.` };
    } else {
      await page.waitForLoadState("domcontentloaded", { timeout });
      return { success: true, output: "Page loaded." };
    }
  }

  private async goBack(): Promise<ToolResult> {
    const page = await this.ensureBrowser();
    await page.goBack({ waitUntil: "domcontentloaded" });
    const title = await page.title();
    return { success: true, output: `URL: ${page.url()} | Title: ${title}` };
  }

  private async closeBrowser(): Promise<ToolResult> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    return { success: true, output: "Browser closed." };
  }

  async destroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
  }
}
