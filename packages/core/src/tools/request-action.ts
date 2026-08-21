import { toolOutputText } from "../content/types.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface TrustedActionsClientOptions {
  /** Base URL of the trusted-actions executor, e.g. http://localhost:3100 */
  url: string;
  /** Shared secret for TAI → executor auth. */
  sharedSecret: string;
  /**
   * Optional URL the executor calls back to when an action finishes.
   * If set, the executor POSTs a terminal-status notification here so
   * TAI can inject a system message into the originating chat session.
   */
  callbackUrl?: string;
  /** Override the global fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Generic tool: enqueue an approval-gated action against the trusted-actions
 * executor. The agent calls this for ANY action type the executor supports.
 * Returns immediately with an `action_id` — does NOT block on approval.
 *
 * The executor handles the approval (push to phone → user taps),
 * audit, spending caps, and execution. TAI never sees credentials or the
 * approval token.
 */
export class RequestActionTool implements Tool {
  name = "request_action";
  description =
    "Enqueue a trusted action (e.g. an Amazon purchase) for human approval. Returns an action_id; the action runs only after the user approves via push notification. Use check_action_status to poll for the outcome.";
  parameters = {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Action type id (e.g. 'purchase.amazon').",
      },
      input: {
        type: "object",
        description: "Type-specific input. For purchase.amazon: { url|query, max_price, qty?, why? }.",
      },
      why: {
        type: "string",
        description: "One-line justification shown to the user during approval.",
      },
    },
    required: ["type", "input"],
  };

  constructor(private readonly opts: TrustedActionsClientOptions) {}

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const type = typeof args.type === "string" ? args.type : "";
    const input = typeof args.input === "object" && args.input ? (args.input as Record<string, unknown>) : null;
    const why = typeof args.why === "string" ? args.why : undefined;
    if (!type) return { success: false, output: "", error: "`type` is required" };
    if (!input) return { success: false, output: "", error: "`input` must be an object" };

    const body: Record<string, unknown> = {
      type,
      input: why ? { ...input, why } : input,
      requested_by: _ctx.sessionId || "tai-agent",
    };
    if (this.opts.callbackUrl) body.callback_url = this.opts.callbackUrl;

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(`${this.opts.url}/internal/enqueue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.sharedSecret}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Executor unreachable at ${this.opts.url}: ${(err as Error).message}. Is the trusted-actions service running?`,
      };
    }

    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* leave empty */
    }

    if (!resp.ok) {
      return {
        success: false,
        output: text,
        error: (parsed.error as string) || `Executor returned ${resp.status}`,
      };
    }

    return {
      success: true,
      output: JSON.stringify(parsed, null, 2),
    };
  }
}

/**
 * Convenience tool: shorthand for request_action(type=purchase.amazon, ...).
 * Pre-validates inputs so the agent can't easily forget required fields.
 */
export class PurchaseItemTool implements Tool {
  name = "purchase_item";
  description =
    "Propose an Amazon purchase for approval. Always returns an action_id; the action runs only after the user approves via push. The agent NEVER sees the credit card or login. By default, returns immediately (async) and the agent learns the outcome via a system-message callback. Pass wait=true to block until the action reaches a terminal state (use sparingly — can wait minutes).";
  parameters = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Direct Amazon product URL. Either url OR query is required.",
      },
      query: {
        type: "string",
        description: "Search query for Amazon (e.g. 'reusable coffee filter'). Use when url is unknown.",
      },
      max_price: {
        type: "number",
        description: "Cap on what you'd pay, in USD. Required.",
      },
      why: {
        type: "string",
        description: "One-line reason — shown to the user when they approve.",
      },
      qty: {
        type: "integer",
        description: "Quantity. Defaults to 1.",
      },
      wait: {
        type: "boolean",
        description:
          "If true, block until the action finishes (completed/failed/rejected/expired). Default false — returns immediately with action_id.",
      },
      wait_timeout_ms: {
        type: "integer",
        description:
          "When wait=true, max ms to wait before giving up and returning the latest known status. Default 600000 (10 min).",
      },
    },
    required: ["max_price", "why"],
  };

  private readonly inner: RequestActionTool;
  private readonly status: CheckActionStatusTool;

  constructor(readonly opts: TrustedActionsClientOptions) {
    this.inner = new RequestActionTool(opts);
    this.status = new CheckActionStatusTool(opts);
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const max_price = typeof args.max_price === "number" ? args.max_price : NaN;
    const why = typeof args.why === "string" ? args.why : "";
    const qty = typeof args.qty === "number" ? args.qty : 1;
    const wait = args.wait === true;
    const waitTimeoutMs =
      typeof args.wait_timeout_ms === "number" && args.wait_timeout_ms > 0 ? args.wait_timeout_ms : 600_000;

    if (!url && !query) {
      return { success: false, output: "", error: "Either `url` or `query` is required" };
    }
    if (!Number.isFinite(max_price) || max_price <= 0) {
      return { success: false, output: "", error: "`max_price` must be a positive number" };
    }
    if (!why || why.length < 5) {
      return { success: false, output: "", error: "`why` is required (one-line reason)" };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      return { success: false, output: "", error: "`qty` must be 1-10" };
    }

    const input: Record<string, unknown> = { max_price, qty, why };
    if (url) input.url = url;
    if (query) input.query = query;

    const enqueueResult = await this.inner.execute({ type: "purchase.amazon", input, why }, ctx);
    if (!enqueueResult.success || !wait) return enqueueResult;

    // Parse the action_id out so we can poll for completion.
    let actionId: string | null = null;
    try {
      const parsed = JSON.parse(toolOutputText(enqueueResult.output)) as { action_id?: string };
      actionId = parsed.action_id ?? null;
    } catch {
      /* leave null */
    }
    if (!actionId) return enqueueResult;

    // Poll until terminal or timeout.
    const TERMINAL = new Set(["completed", "failed", "rejected", "expired"]);
    const start = Date.now();
    const pollMs = 5_000;
    let lastStatusOutput = enqueueResult.output;
    while (Date.now() - start < waitTimeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const s = await this.status.execute({ action_id: actionId }, ctx);
      if (s.success) {
        lastStatusOutput = s.output;
        try {
          const parsed = JSON.parse(toolOutputText(s.output)) as { status?: string };
          if (parsed.status && TERMINAL.has(parsed.status)) {
            return { success: true, output: s.output };
          }
        } catch {
          /* keep polling */
        }
      }
    }
    return {
      success: true,
      output:
        lastStatusOutput +
        `\n\n[wait timed out after ${Math.round(waitTimeoutMs / 1000)}s — action still in flight; use check_action_status to follow up]`,
    };
  }
}

/**
 * R3: Capability-narrowed read tool. Calls a schema-gated `amazon_read.*`
 * action on the executor and returns the typed result directly to the agent.
 *
 * Unlike RequestActionTool, this is auto-approved — the security gate is
 * the executor's static schema, not a per-call user approval. The agent
 * literally cannot request fields the schema does not model. Each read
 * is audited in the executor's chain.
 */
export class RequestReadTool implements Tool {
  name = "request_read";
  description =
    "Read information from the trusted-actions executor (e.g. amazon_read.product_summary, amazon_read.order_history, amazon_read.cart_state). Returns the typed schema result synchronously — no approval required. Use this to verify product details before calling purchase_item.";
  parameters = {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Read action type (e.g. 'amazon_read.product_summary').",
      },
      input: {
        type: "object",
        description: "Type-specific input. product_summary: { url|query }. order_history/cart_state: {}.",
      },
    },
    required: ["type", "input"],
  };

  constructor(private readonly opts: TrustedActionsClientOptions) {}

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const type = typeof args.type === "string" ? args.type : "";
    const input = typeof args.input === "object" && args.input ? (args.input as Record<string, unknown>) : {};
    if (!type) return { success: false, output: "", error: "`type` is required" };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(`${this.opts.url}/internal/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.sharedSecret}`,
        },
        body: JSON.stringify({
          type,
          input,
          requested_by: _ctx.sessionId || "tai-agent",
        }),
      });
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Executor unreachable at ${this.opts.url}: ${(err as Error).message}`,
      };
    }

    const text = await resp.text();
    if (!resp.ok) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        /* */
      }
      return { success: false, output: text, error: (parsed.error as string) || `Executor returned ${resp.status}` };
    }
    return { success: true, output: text };
  }
}

/**
 * Poll the status of a previously-enqueued action.
 */
export class CheckActionStatusTool implements Tool {
  name = "check_action_status";
  description =
    "Check the status of a previously-enqueued trusted action by its action_id. Returns status (pending_approval/approved/rejected/running/completed/failed) plus result or error.";
  parameters = {
    type: "object",
    properties: {
      action_id: { type: "string", description: "The id returned by request_action / purchase_item." },
    },
    required: ["action_id"],
  };

  constructor(private readonly opts: TrustedActionsClientOptions) {}

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const id = typeof args.action_id === "string" ? args.action_id.trim() : "";
    if (!id) return { success: false, output: "", error: "`action_id` is required" };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(`${this.opts.url}/internal/actions/${encodeURIComponent(id)}/status`, {
        headers: { Authorization: `Bearer ${this.opts.sharedSecret}` },
      });
    } catch (err) {
      return { success: false, output: "", error: `Executor unreachable: ${(err as Error).message}` };
    }
    if (resp.status === 404) {
      return { success: false, output: "", error: `Action ${id} not found` };
    }
    const text = await resp.text();
    if (!resp.ok) return { success: false, output: text, error: `Executor returned ${resp.status}` };
    return { success: true, output: text };
  }
}
