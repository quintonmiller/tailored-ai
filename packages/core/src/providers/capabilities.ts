/**
 * What a model accepts, and what to do when a request exceeds it.
 *
 * See `docs/media-design.md`. Three shapes here are borrowed rather than
 * invented, each from a system that got it wrong first:
 *
 * - **A leaf is an object, never a bare boolean.** Anthropic's Models API
 *   returns `capabilities.image_input: { supported: true }`, so a leaf can grow
 *   `maxBytes` or `formats` later without breaking a reader.
 *
 * - **`"unknown"` is not `false`.** LiteLLM's `supports_vision()` and its
 *   sixteen siblings swallow the lookup failure and return `False` for a model
 *   they have never heard of, so "this model has no eyes" and "I have never
 *   heard of this model" are the same value. That is exactly wrong for TAI: a
 *   local gateway serves whatever was last loaded under a name core cannot
 *   introspect, so **undeclared is the normal case**, and treating it as `false`
 *   would refuse images to a vision model for lack of a config line.
 *
 * - **Bytes, URLs and tool-result media are three capabilities.** LangChain
 *   splits `image_inputs` / `image_url_inputs` / `image_tool_message`, which is
 *   the same distinction this design reached from vLLM rejecting an image on a
 *   `role: "tool"` message while accepting it on a user turn.
 *
 * And one shape deliberately not borrowed: LiteLLM's flat namespace of 34
 * `supports_*` booleans has visibly drifted — `supports_vision` set on 1007
 * entries, `supports_image_input` on 6, `supports_multimodal` on 6, all
 * nominally about the same thing. Modalities live in {@link
 * ModelCapabilities.input}; only genuinely distinct mechanisms get a leaf.
 */

import { type ContentPart, contentParts, type MessageContent, mediaPlaceholder } from "../content/types.js";
import type { Message } from "./interface.js";

/**
 * Three states, not two. `"unknown"` means nobody said — which is the common
 * case, and different from a declared no.
 */
export type SupportState = true | false | "unknown";

export interface Support {
  supported: SupportState;
  /** Largest single item this accepts, when the vendor documents one. */
  maxBytes?: number;
  /** Most items in one request, when the vendor documents one. */
  maxItems?: number;
  /** Exact media types, when narrower than {@link ModelCapabilities.input}. */
  formats?: string[];
}

/** How a model's API takes media returned by a tool. */
export interface ToolResultMediaSupport extends Support {
  /**
   * `inline` — media rides inside the tool result (Anthropic, Bedrock Converse,
   * OpenAI Responses). Preferred: the content stays quarantined as tool output.
   *
   * `follow-up` — the API takes a string there, so media must travel as a
   * separate user turn (OpenAI Chat Completions, vLLM, OpenRouter, DeepSeek).
   * Costs something real — see {@link adaptForCapabilities}.
   */
  mode?: "inline" | "follow-up";
}

export interface ModelCapabilities {
  /** Media types accepted as input. Globs allowed: `["text/*", "image/*"]`. */
  input: string[];
  /** Media types the model can produce. Almost always just text today. */
  output: string[];
  /** Accepts raw bytes (base64/binary) for an input part. */
  inputBytes: Support;
  /** Accepts a URL the provider fetches itself. */
  inputUrl: Support;
  /** Accepts media returned by a tool, and how. */
  toolResultMedia: ToolResultMediaSupport;
  /** Accepts tool/function definitions. Replaces the never-read `supportsTools`. */
  tools: Support;
}

/** Everything unknown. What a model nobody has described resolves to. */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  input: ["text/*"],
  output: ["text/*"],
  inputBytes: { supported: "unknown" },
  inputUrl: { supported: "unknown" },
  toolResultMedia: { supported: "unknown" },
  tools: { supported: "unknown" },
};

/** A declaration from config or a provider; every field optional. */
export type PartialCapabilities = Partial<ModelCapabilities>;

/**
 * Merge a provider's answer with a deployment's override.
 *
 * Config wins, and has to: a local gateway serves whatever model was last
 * loaded under a name core cannot introspect, so the operator is often the only
 * one who knows. A field nobody declares stays `"unknown"` rather than
 * collapsing to a conservative `false`.
 */
export function resolveCapabilities(
  fromConfig?: PartialCapabilities,
  fromProvider?: PartialCapabilities,
): ModelCapabilities {
  return {
    input: fromConfig?.input ?? fromProvider?.input ?? UNKNOWN_CAPABILITIES.input,
    output: fromConfig?.output ?? fromProvider?.output ?? UNKNOWN_CAPABILITIES.output,
    inputBytes: fromConfig?.inputBytes ?? fromProvider?.inputBytes ?? UNKNOWN_CAPABILITIES.inputBytes,
    inputUrl: fromConfig?.inputUrl ?? fromProvider?.inputUrl ?? UNKNOWN_CAPABILITIES.inputUrl,
    toolResultMedia:
      fromConfig?.toolResultMedia ?? fromProvider?.toolResultMedia ?? UNKNOWN_CAPABILITIES.toolResultMedia,
    tools: fromConfig?.tools ?? fromProvider?.tools ?? UNKNOWN_CAPABILITIES.tools,
  };
}

/** Does `mimeType` match any entry of `patterns` (`image/*` style globs)? */
export function mimeMatches(mimeType: string, patterns: readonly string[]): boolean {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase().trim();
    if (p === "*" || p === "*/*") return true;
    if (p.endsWith("/*")) return type.startsWith(p.slice(0, -1));
    return p === type;
  });
}

/**
 * What to do when a request carries something the model has not agreed to take.
 */
export interface MediaPolicy {
  /**
   * The model declared it cannot take this.
   *
   * `degrade` — replace the part with its text placeholder. Friendly, and hides
   * a misconfiguration. `skip-rung` — refuse this candidate and let the
   * fallback chain try the next, which is honest and can empty a chain of one.
   * `error` — fail the call.
   */
  onUnsupported: "degrade" | "skip-rung" | "error";
  /**
   * Nobody declared anything, which is the common case.
   *
   * `try` — send it and let the provider answer. The right default here: TAI
   * already carries `providers/quirks.ts`, whose whole job is memoizing a
   * model's constraints learned from its 400s, so a refusal is information
   * rather than a dead end. `degrade` — assume the worst.
   */
  onUnknown: "try" | "degrade";
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = { onUnsupported: "degrade", onUnknown: "try" };

export interface AdaptResult {
  messages: Message[];
  /**
   * What was changed, in words. Never empty when a part failed to reach the
   * model in its original form.
   *
   * The rule this exists to enforce: **a part that does not reach the model
   * must leave a warning or a placeholder — never nothing, and never itself.**
   * Read at source, the Vercel AI SDK's `openai-compatible` path silently
   * `JSON.stringify`s a tool result's media into the prompt and does not even
   * collect a warning; that is the failure this field is here to prevent, on
   * the provider TAI uses by default.
   */
  notes: string[];
  /** Set when this candidate should be skipped rather than sent a degraded request. */
  skip?: string;
}

/** Decide what a media part may do against one model's declared capabilities. */
function verdict(state: SupportState, policy: MediaPolicy): "send" | "degrade" | "skip" | "error" {
  if (state === true) return "send";
  if (state === "unknown") return policy.onUnknown === "try" ? "send" : "degrade";
  return policy.onUnsupported === "degrade" ? "degrade" : policy.onUnsupported === "skip-rung" ? "skip" : "error";
}

/**
 * Shape a request for one model, before it is sent.
 *
 * This runs at the wire boundary and its output is never persisted, which is
 * what makes the `follow-up` rewrite safe: history keeps one tool message, and
 * only the outgoing array gains an extra user turn. Trimming and
 * `stripOrphanedToolMessages` have already run against the real history, so
 * they never see the synthesized message and cannot split it from its pair.
 */
export function adaptForCapabilities(
  messages: readonly Message[],
  caps: ModelCapabilities,
  policy: MediaPolicy = DEFAULT_MEDIA_POLICY,
): AdaptResult {
  const notes: string[] = [];
  const out: Message[] = [];
  // Media lifted out of tool results, waiting for the tool block to close.
  let pendingFollowUps: Extract<ContentPart, { type: "media" }>[] = [];

  const flushFollowUps = () => {
    if (pendingFollowUps.length === 0) return;
    out.push({
      role: "user",
      content: {
        parts: [
          {
            type: "text",
            text: "[Attached below: media returned by the preceding tool call, not sent by the user.]",
          },
          ...pendingFollowUps,
        ],
      },
    });
    pendingFollowUps = [];
  };

  for (const msg of messages) {
    // A non-tool message closes the block, so anything held back goes first.
    if (msg.role !== "tool") flushFollowUps();

    const parts = contentParts(msg.content);
    const media = parts.filter((p) => p.type === "media");
    if (media.length === 0) {
      out.push(msg);
      continue;
    }

    // Can this model take these types at all?
    const unacceptable = media.filter((p) => p.type === "media" && !mimeMatches(p.media.mimeType, caps.input));
    const byteState = caps.inputBytes.supported;
    const typeVerdict =
      unacceptable.length > 0 && byteState !== "unknown" ? verdict(false, policy) : verdict(byteState, policy);

    if (typeVerdict === "skip") {
      return { messages: [...messages], notes, skip: "declares it cannot accept media in this request" };
    }
    if (typeVerdict === "error") {
      throw new Error(`Model cannot accept media (${media.length} item(s)) and media.onUnsupported is "error"`);
    }
    if (typeVerdict === "degrade") {
      out.push(flatten(msg));
      notes.push(`${media.length} media part(s) degraded to text for this model`);
      continue;
    }

    // Accepted — but a tool result is its own question.
    if (msg.role === "tool") {
      const toolVerdict = verdict(caps.toolResultMedia.supported, policy);
      if (toolVerdict === "skip") {
        return { messages: [...messages], notes, skip: "declares it cannot accept media inside a tool result" };
      }
      if (toolVerdict === "error") {
        throw new Error('Model cannot accept media in a tool result and media.onUnsupported is "error"');
      }
      if (toolVerdict === "degrade") {
        out.push(flatten(msg));
        notes.push("media in a tool result degraded to text for this model");
        continue;
      }
      if (caps.toolResultMedia.mode === "follow-up") {
        // The documented workaround for APIs that take only a string there.
        // It has a real cost: the media moves from the quarantined tool-output
        // position into a user turn, which is where Anthropic's guidance warns
        // untrusted content should NOT go. The marker is what keeps its origin
        // visible to the model rather than laundering it into something the
        // user appears to have said.
        //
        // Deferred rather than emitted here. An assistant turn may open several
        // tool calls, and every `tool` answering it has to follow it with
        // nothing in between: emitting the user turn straight after the first
        // media-bearing result splits the block and orphans the rest. Strict
        // providers reject the whole request for it — DeepSeek with
        // "insufficient tool messages following tool_calls message" — so a
        // single screenshot in a multi-call turn failed every rung of the
        // fallback chain and landed on the most expensive one.
        out.push(flatten(msg));
        pendingFollowUps.push(...media);
        notes.push("media moved out of the tool result into a following user turn (provider takes text there)");
        continue;
      }
    }

    out.push(msg);
  }

  flushFollowUps();
  return { messages: out, notes };
}

/** Replace every media part with its placeholder, leaving the message text-only. */
function flatten(msg: Message): Message {
  const parts = contentParts(msg.content).map((p) =>
    p.type === "media" ? { type: "text" as const, text: mediaPlaceholder(p.media, p.alt) } : p,
  );
  const content: MessageContent = { parts };
  return { ...msg, content };
}
