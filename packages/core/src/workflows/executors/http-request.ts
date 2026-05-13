import { resolveString, resolveValue } from "../scope.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { HttpRequestStep, WorkflowStepDef } from "../types.js";

export interface HttpRequestExecutorOptions {
  /** Override fetch for testing. */
  fetcher?: typeof fetch;
  /** Default timeout when step.timeoutMs is unset. Default 30s. */
  defaultTimeoutMs?: number;
}

const RAW_BUFFER_PREVIEW = 64;

/**
 * Issues a generic HTTP request and returns `{ status, headers, body }`.
 * Non-success status raises so the engine can apply onError/retry policies.
 * See HttpRequestStep in types.ts for the configurable fields.
 */
export class HttpRequestExecutor implements StepExecutor {
  type = "http_request" as const;
  private fetcher: typeof fetch;
  private defaultTimeoutMs: number;

  constructor(opts: HttpRequestExecutorOptions = {}) {
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as HttpRequestStep;
    const url = String(resolveString(s.url, ctx.scope));
    if (!url) throw new Error("http_request: url is required");

    const method = (s.method ?? "GET").toUpperCase();

    // In dry-run mode, only allow GET/HEAD/OPTIONS to actually fire (those
    // are side-effect-free). Mutating methods are short-circuited so a
    // dry-run never POSTs/PUTs/DELETEs against a real endpoint.
    if (ctx.dryRun && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      console.log(`[dry-run] http_request ${method} ${url} skipped`);
      return {
        output: {
          status: 0,
          headers: {},
          body: { dryRun: true, method, url, note: "skipped in dry-run mode" },
        },
      };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers ?? {})) {
      headers[k] = String(resolveString(v, ctx.scope));
    }

    let body: BodyInit | undefined;
    if (s.body !== undefined && s.body !== null) {
      const resolved = resolveValue(s.body, ctx.scope);
      if (typeof resolved === "string") {
        body = resolved;
      } else {
        body = JSON.stringify(resolved);
        if (!headerSet(headers, "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const timeoutMs = s.timeoutMs ?? this.defaultTimeoutMs;
    const local = new AbortController();
    const onParentAbort = () => local.abort();
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => local.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetcher(url, { method, headers, body, signal: local.signal });
    } catch (err) {
      const msg = (err as Error).message;
      if (local.signal.aborted && !ctx.signal.aborted) {
        throw new Error(`http_request ${method} ${url} timed out after ${timeoutMs}ms`);
      }
      throw new Error(`http_request ${method} ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }

    const respHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    const parseAs = s.parseAs ?? inferParseAs(respHeaders["content-type"] ?? "");
    let parsedBody: unknown;
    if (parseAs === "raw") {
      const buf = await res.arrayBuffer();
      parsedBody = `[binary ${buf.byteLength} bytes, preview=${truncateBase64(buf)}]`;
    } else {
      const text = await res.text();
      if (parseAs === "json") {
        try {
          parsedBody = text.length === 0 ? null : JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      } else {
        parsedBody = text;
      }
    }

    const expected = s.expectStatus ?? null;
    const ok = expected ? expected.includes(res.status) : res.ok;
    if (!ok) {
      const preview = typeof parsedBody === "string"
        ? parsedBody.slice(0, 200)
        : JSON.stringify(parsedBody).slice(0, 200);
      throw new Error(
        `http_request ${method} ${url} returned ${res.status} ${res.statusText}: ${preview}`,
      );
    }

    return { output: { status: res.status, headers: respHeaders, body: parsedBody } };
  }
}

function headerSet(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

function inferParseAs(contentType: string): "json" | "text" | "raw" {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) return "json";
  if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("javascript")) return "text";
  if (!ct) return "text";
  return "raw";
}

function truncateBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf, 0, Math.min(RAW_BUFFER_PREVIEW, buf.byteLength));
  return Buffer.from(bytes).toString("base64");
}
