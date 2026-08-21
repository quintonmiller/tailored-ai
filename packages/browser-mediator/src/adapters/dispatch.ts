import { AlwaysHitlRefusedError, type BrowserMediator, EgressBlockedError } from "../mediator.js";

/**
 * Shared dispatcher used by every framework adapter. The `action`
 * discriminator field names the operation; the rest of the args are
 * loose-typed because each framework hands them off as raw JSON.
 *
 * Returns `{ ok, output }` on success and `{ ok: false, error }` on
 * failure. Adapters translate this shape into their framework's
 * native result type.
 */
export interface DispatchResult {
  ok: boolean;
  output: string;
  error?: string;
  /**
   * Raw image bytes, when the action produced one.
   *
   * Deliberately not a path, a data URL or a store id: this package has no
   * framework dependency and no opinion about where a host keeps files. The
   * adapter that owns storage converts it. Adapters that cannot carry an image
   * ignore this field and still have `output` to show.
   */
  media?: { bytes: Buffer; mimeType: string };
}

export const TOOL_NAME = "browser_mediator";

export const TOOL_DESCRIPTION =
  "Sandboxed browser. Actions: navigate, url, read_text, read_links, click, type_text, screenshot, wait_for, close. " +
  "Click targets are opaque ids from read_links. type_text expands $ns.key vault refs at the boundary.";

export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["navigate", "url", "read_text", "read_links", "click", "type_text", "screenshot", "wait_for", "close"],
    },
    url: { type: "string" },
    node_id: { type: "string", description: "Opaque element id or text=… selector (click, type_text)." },
    value: { type: "string", description: "Text to type. Supports $ns.key vault refs (type_text)." },
    selector: { type: "string", description: "Element to wait for (wait_for)." },
    text: { type: "string", description: "Visible text to wait for (wait_for)." },
    max_chars: { type: "number" },
    timeout_ms: { type: "number" },
  },
  required: ["action"],
} as const;

export async function dispatchToMediator(
  mediator: BrowserMediator,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const action = String(args.action ?? "");
  try {
    switch (action) {
      case "navigate": {
        await mediator.start();
        return { ok: true, output: await mediator.navigate(String(args.url ?? "")) };
      }
      case "url":
        return { ok: true, output: await mediator.url() };
      case "read_text": {
        const max = typeof args.max_chars === "number" ? args.max_chars : 4000;
        return { ok: true, output: await mediator.readText(max) };
      }
      case "read_links": {
        const links = await mediator.readLinks();
        const lines = links.map((l) => `${l.node_id}\t${l.text}`);
        return { ok: true, output: lines.length ? lines.join("\n") : "(no links)" };
      }
      case "click":
        return { ok: true, output: await mediator.click(String(args.node_id ?? args.selector ?? "")) };
      case "type_text": {
        const target = String(args.node_id ?? args.selector ?? "");
        const value = String(args.value ?? args.text ?? "");
        return { ok: true, output: await mediator.typeText(target, value) };
      }
      case "screenshot": {
        const shot = await mediator.screenshot();
        // `output` still describes the capture, so an adapter that drops the
        // image says something true rather than nothing.
        return {
          ok: true,
          output: `Captured a ${shot.bytes.length.toLocaleString()}-byte ${shot.mimeType} screenshot.`,
          media: shot,
        };
      }
      case "wait_for":
        return {
          ok: true,
          output: await mediator.waitFor({
            text: args.text as string | undefined,
            selector: args.selector as string | undefined,
            timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          }),
        };
      case "close":
        await mediator.close();
        return { ok: true, output: "closed" };
      default:
        return { ok: false, output: "", error: `unknown action "${action}"` };
    }
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      return {
        ok: false,
        output: "",
        error: `${err.message}. Add the host to egressAllowList to permit it.`,
      };
    }
    if (err instanceof AlwaysHitlRefusedError) {
      return { ok: false, output: "", error: err.message };
    }
    return { ok: false, output: "", error: (err as Error).message };
  }
}
