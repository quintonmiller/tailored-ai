import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { withRetry, isTransientError } from "./retry.js";

const MAX_BODY_LENGTH = 8000;

function stripHtmlToText(html: string): string {
  return (
    html
      // Remove script/style blocks
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // Convert common block elements to newlines
      .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Remove remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export class WebFetchTool implements Tool {
  name = "web_fetch";
  description = "Fetch a URL and return its content as text.";
  parameters = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch.",
      },
    },
    required: ["url"],
  };

  private timeoutMs: number;

  constructor(timeoutMs: number = 15_000) {
    this.timeoutMs = timeoutMs;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const url = args.url as string;
    if (!url) {
      return { success: false, output: "", error: "No URL provided." };
    }

    try {
      new URL(url);
    } catch {
      return { success: false, output: "", error: `Invalid URL: ${url}` };
    }

    try {
      const resp = await withRetry(
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const r = await fetch(url, {
              headers: {
                "User-Agent": "autonomous-agent/0.1 (bot)",
                Accept: "text/html, application/json, text/plain, */*",
              },
              redirect: "follow",
              signal: controller.signal,
            });
            clearTimeout(timeout);
            // Retry on server errors
            if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
            return r;
          } catch (err) {
            clearTimeout(timeout);
            throw err;
          }
        },
        { retries: 2, shouldRetry: isTransientError },
      );

      if (!resp.ok) {
        return {
          success: false,
          output: "",
          error: `HTTP ${resp.status} ${resp.statusText}`,
        };
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const raw = await resp.text();

      let body: string;
      if (contentType.includes("application/json")) {
        // Pretty-print JSON for readability
        try {
          body = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          body = raw;
        }
      } else if (contentType.includes("text/html")) {
        body = stripHtmlToText(raw);
      } else {
        body = raw;
      }

      if (body.length > MAX_BODY_LENGTH) {
        body = `${body.slice(0, MAX_BODY_LENGTH)}\n\n[Truncated: ${raw.length} bytes total]`;
      }

      return { success: true, output: body };
    } catch (err) {
      const message =
        (err as Error).name === "AbortError" ? `Request timed out after ${this.timeoutMs}ms` : (err as Error).message;
      return { success: false, output: "", error: message };
    }
  }
}
