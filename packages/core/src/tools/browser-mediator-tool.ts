import { dispatchToMediator, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from "@tailored-ai/browser-mediator";
import type Database from "better-sqlite3";
import { BrowserMediator, type BrowserMediatorOptions } from "../browser/mediator.js";
import { mediaPart, textPart } from "../content/types.js";
import type { MediaStore } from "../media/interface.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * TAI Tool adapter around the framework-agnostic
 * `@tailored-ai/browser-mediator` package. The Tool boilerplate
 * (name/description/parameters) comes straight from the upstream
 * shared dispatcher so TAI and any other adapter stay in lock-step.
 */
export interface BrowserMediatorToolConfig {
  enabled?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  egressAllowList?: string[];
  alwaysHitlConfig?: BrowserMediatorOptions["alwaysHitlConfig"];
  /** When set, type_text values run through vault $ns.key expansion. */
  db?: Database.Database;
  vaultKey?: Buffer;
  /**
   * Where screenshots go. Without one the tool still works and still reports
   * the capture — it just cannot hand the image to the model.
   */
  mediaStore?: MediaStore;
}

export class BrowserMediatorTool implements Tool {
  name = TOOL_NAME;
  description = TOOL_DESCRIPTION;
  parameters = TOOL_PARAMETERS as unknown as Record<string, unknown>;

  private mediator: BrowserMediator;
  private mediaStore?: MediaStore;

  constructor(config: BrowserMediatorToolConfig) {
    this.mediator = new BrowserMediator({
      headless: config.headless ?? true,
      timeoutMs: config.timeoutMs,
      egressAllowList: config.egressAllowList,
      alwaysHitlConfig: config.alwaysHitlConfig,
      db: config.db,
      vaultKey: config.vaultKey,
    });
    this.mediaStore = config.mediaStore;
  }

  /** Test/seam: swap the mediator for a fake. */
  setMediator(m: BrowserMediator): void {
    this.mediator = m;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const r = await dispatchToMediator(this.mediator, args);
    // The constructor store is a test seam. In production nothing passes one —
    // the factory builds this tool from config, and the store only exists once
    // the runtime does — so the live store arrives per call on the context.
    // Reading only the constructor field is how this path stayed dead.
    const store = this.mediaStore ?? context.mediaStore;
    if (!r.ok || !r.media || !store) {
      return { success: r.ok, output: r.output, error: r.error };
    }
    try {
      const ref = await store.put(r.media.bytes, {
        mimeType: r.media.mimeType,
        name: "screenshot.png",
        sessionId: context.sessionId,
      });
      return { success: true, output: { parts: [textPart(r.output), mediaPart(ref)] } };
    } catch (err) {
      // A screenshot we could not store still happened. Say so and carry on
      // rather than failing the call over the storage layer.
      return { success: true, output: `${r.output} (image not stored: ${(err as Error).message})` };
    }
  }
}
