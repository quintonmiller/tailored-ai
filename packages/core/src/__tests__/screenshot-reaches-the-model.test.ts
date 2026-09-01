/**
 * A screenshot is a picture, and the model should get to see it.
 *
 * Both browser tools could already produce media and neither one did in
 * production, for the same reason: the store they reached for was a
 * constructor field nothing outside a test ever set. The live store arrives
 * per call, on the ToolContext, because it does not exist until the runtime
 * does — which is later than the moment a tool factory runs.
 *
 * These tests build the tools the way production builds them (through the
 * factory, or with the config the factory passes) rather than handing them a
 * store directly, because handing them a store is precisely what nobody does.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolOutputText } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import { DiskMediaStore } from "../media/disk.js";
import { BrowserTool } from "../tools/browser.js";
import { BrowserMediatorTool } from "../tools/browser-mediator-tool.js";
import type { ToolContext } from "../tools/interface.js";

// A 1x1 PNG. Real bytes, so the store's magic-byte sniffing agrees with us.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b7d4990000000049454e44ae426082",
  "hex",
);

function mediaPartsOf(output: unknown): Array<{ type: string }> {
  if (typeof output === "string" || output == null) return [];
  const parts = (output as { parts?: Array<{ type: string }> }).parts ?? [];
  return parts.filter((p) => p.type === "media");
}

describe("screenshots reach the model", () => {
  let dir: string;
  let db: Database.Database;
  let store: DiskMediaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-shot-"));
    db = initDatabase(":memory:");
    store = new DiskMediaStore({ db, dir: join(dir, "media") });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = (withStore: boolean): ToolContext =>
    ({
      sessionId: "s1",
      workingDirectory: dir,
      env: {},
      ...(withStore ? { mediaStore: store } : {}),
    }) as unknown as ToolContext;

  describe("browser_mediator", () => {
    /** Build the tool exactly as tools/builtin-optional.ts does: no mediaStore. */
    const asFactoryBuildsIt = () => new BrowserMediatorTool({ enabled: true, headless: true });

    function withFakeMediator(tool: BrowserMediatorTool) {
      // Same shape the mediator package's own dispatch tests use: capture the
      // bytes, describe them in text. No browser involved.
      tool.setMediator({
        screenshot: async () => ({ bytes: PNG, mimeType: "image/png" }),
        screenshotMeta: async () => `Captured ${PNG.length} bytes.`,
      } as never);
      return tool;
    }

    it("attaches the picture using the store on the context", async () => {
      const tool = withFakeMediator(asFactoryBuildsIt());
      const r = await tool.execute({ action: "screenshot" }, ctx(true));
      expect(r.success).toBe(true);
      expect(mediaPartsOf(r.output)).toHaveLength(1);
    });

    it("still answers in text when the deployment has no media store", async () => {
      const tool = withFakeMediator(asFactoryBuildsIt());
      const r = await tool.execute({ action: "screenshot" }, ctx(false));
      expect(r.success).toBe(true);
      expect(mediaPartsOf(r.output)).toHaveLength(0);
      expect(toolOutputText(r.output)).toMatch(/screenshot/i);
    });
  });

  describe("browser", () => {
    /** Stand in for ensureBrowser(): a page whose screenshot writes the file. */
    function fakePage() {
      return {
        screenshot: async ({ path }: { path: string }) => writeFileSync(path, PNG),
        $: async () => ({ screenshot: async ({ path }: { path: string }) => writeFileSync(path, PNG) }),
      };
    }

    const tool = () => {
      const t = new BrowserTool({ enabled: true, screenshotDir: join(dir, "shots") });
      (t as unknown as { ensureBrowser: () => Promise<unknown> }).ensureBrowser = async () => fakePage();
      return t;
    };

    it("attaches the picture and keeps the path", async () => {
      const r = await tool().execute({ action: "screenshot" }, ctx(true));
      expect(r.success).toBe(true);
      expect(mediaPartsOf(r.output)).toHaveLength(1);
      // The path is still in the text: an agent whose next move is a shell
      // command has not lost anything.
      expect(toolOutputText(r.output)).toContain("Screenshot saved:");
    });

    it("stores the same bytes that landed on disk", async () => {
      const r = await tool().execute({ action: "screenshot" }, ctx(true));
      const path = /Screenshot saved: (\S+)/.exec(toolOutputText(r.output))?.[1] as string;
      const media = (r.output as { parts: Array<{ type: string; media?: { id: string } }> }).parts.find(
        (p) => p.type === "media",
      )?.media as { id: string };
      const stored = await store.get(media.id);
      expect(stored).not.toBeUndefined();
      expect(readFileSync(path).equals(PNG)).toBe(true);
    });

    it("falls back to the path when there is no store, as it always did", async () => {
      const r = await tool().execute({ action: "screenshot" }, ctx(false));
      expect(r.success).toBe(true);
      expect(typeof r.output).toBe("string");
      expect(r.output as string).toMatch(/^Screenshot saved: /);
    });
  });
});
