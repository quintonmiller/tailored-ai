import {
  type Message as BedrockMessage,
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type SystemContentBlock,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { DocumentType } from "@smithy/types";
import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ThinkingLevel,
  ToolCall,
  ToolSchema,
} from "@tailored-ai/core";
import { messageText } from "@tailored-ai/core";

// --- Conversion helpers (exported for testing) ---

/**
 * Bedrock extended-thinking budget (#254), in tokens — same policy as native
 * Anthropic. `off` omits reasoning; `auto`/`medium` use a moderate budget;
 * effort levels scale. Returns null to leave reasoning off.
 */
function bedrockThinkingBudget(level: ThinkingLevel | undefined): number | null {
  switch (level) {
    case "low":
      return 1024;
    case "auto":
    case "medium":
      return 4096;
    case "high":
      return 16000;
    default:
      return null; // undefined | "off"
  }
}

/**
 * Only Anthropic-family models on Bedrock accept `reasoning_config`; Nova,
 * Llama, Mistral, etc. reject it, so the mapper must no-op for them.
 */
export function isAnthropicBedrockModel(modelId: string): boolean {
  return /anthropic\.|claude/i.test(modelId);
}

/**
 * Convert internal messages to the Converse API format.
 * Returns { system, messages } since Converse takes system as a top-level param.
 */
export function toConverseMessages(messages: Message[]): {
  system: SystemContentBlock[];
  messages: BedrockMessage[];
} {
  // Extract leading system messages into the top-level system param
  const system: SystemContentBlock[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    if (messages[i].content) system.push({ text: messages[i].content as string });
    i++;
  }

  const result: BedrockMessage[] = [];

  for (; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      // Tool results become user messages with toolResult content blocks
      result.push({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: msg.toolCallId ?? "",
              content: [{ text: messageText(msg.content) }],
            },
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: ContentBlock[] = [];
      if (msg.content) {
        blocks.push({ text: messageText(msg.content) });
      }
      for (const tc of msg.toolCalls) {
        blocks.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: tc.arguments as DocumentType,
          },
        });
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      // Plain user/assistant text; mid-conversation system messages become
      // user messages. Converse rejects empty text blocks, so skip messages
      // with no content — merging below keeps the turn order valid.
      if (!msg.content) continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      result.push({ role, content: [{ text: messageText(msg.content) }] });
    }
  }

  // Merge adjacent same-role messages (Converse requires alternating turns)
  const merged: BedrockMessage[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...(prev.content ?? []), ...(msg.content ?? [])];
    } else {
      merged.push(msg);
    }
  }

  return { system, messages: merged };
}

export function toConverseTools(tools: ToolSchema[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.function.name,
      description: t.function.description,
      // The SDK types JSON schemas as a Smithy document; a JSON-schema
      // object is one, the compiler just can't see it through `unknown`.
      inputSchema: { json: t.function.parameters as DocumentType },
    },
  }));
}

export function mapStopReason(reason: string | undefined): "stop" | "tool_calls" | "length" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export function parseConverseResponse(data: ConverseCommandOutput): ChatResponse {
  let textContent = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  for (const block of data.output?.message?.content ?? []) {
    if (block.text) {
      textContent += block.text;
    } else if (block.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId ?? "",
        name: block.toolUse.name ?? "",
        arguments: (block.toolUse.input ?? {}) as Record<string, unknown>,
      });
    } else {
      // reasoningContent blocks (#254) — typed loosely so we compile against
      // SDK versions that predate the ReasoningContentBlock union.
      const text = (block as { reasoningContent?: { reasoningText?: { text?: string } } }).reasoningContent
        ?.reasoningText?.text;
      if (text) reasoning += text;
    }
  }

  return {
    content: textContent || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoning: reasoning || undefined,
    usage: {
      input: data.usage?.inputTokens ?? 0,
      output: data.usage?.outputTokens ?? 0,
    },
    finishReason: mapStopReason(data.stopReason),
  };
}

// --- Provider class ---

export interface BedrockProviderOptions {
  /** AWS region (e.g. "us-west-2"). Falls back to the SDK's resolution (AWS_REGION, profile config). */
  region?: string;
  /** Named profile from ~/.aws/{config,credentials}. Falls back to the default credential chain. */
  profile?: string;
  /** Injected client for tests. When set, region/profile are ignored. */
  client?: Pick<BedrockRuntimeClient, "send">;
  /** Default reasoning effort (#254) for Anthropic-family models. Per-call `ChatParams.thinking` overrides it. */
  defaultThinking?: ThinkingLevel;
}

/**
 * AWS Bedrock provider speaking the Converse API, which normalizes message,
 * tool, and stop-reason shapes across Bedrock-hosted model families
 * (Anthropic, Amazon Nova, Meta, Mistral, …).
 *
 * Auth and region come from the standard AWS credential chain
 * (environment, ~/.aws profiles, SSO, IMDS); `region` / `profile`
 * narrow it without replacing it.
 */
export class BedrockProvider implements AIProvider {
  id = "bedrock";
  name = "AWS Bedrock";
  supportsTools = true;

  private client: Pick<BedrockRuntimeClient, "send">;
  private defaultThinking?: ThinkingLevel;

  constructor(opts: BedrockProviderOptions = {}) {
    this.client =
      opts.client ??
      new BedrockRuntimeClient({
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.profile ? { credentials: fromNodeProviderChain({ profile: opts.profile }) } : {}),
      });
    this.defaultThinking = opts.defaultThinking;
  }

  private buildInput(params: ChatParams): ConverseCommandInput {
    const { system, messages } = toConverseMessages(params.messages);

    const baseMax = params.maxTokens ?? 4096;
    const inferenceConfig: ConverseCommandInput["inferenceConfig"] = {
      maxTokens: baseMax,
      temperature: params.temperature ?? 0.3,
    };

    // Reasoning control (#254): only Anthropic-family models accept
    // reasoning_config. Thinking tokens count against maxTokens, so bump it and
    // drop temperature (Anthropic rejects temperature != 1 with reasoning on).
    const budget = bedrockThinkingBudget(params.thinking ?? this.defaultThinking);
    const reasoningOn = budget !== null && isAnthropicBedrockModel(params.model);
    if (reasoningOn) {
      inferenceConfig.maxTokens = budget + Math.max(baseMax, 4096);
      inferenceConfig.temperature = undefined;
    }

    const input: ConverseCommandInput = { modelId: params.model, messages, inferenceConfig };

    if (system.length > 0) {
      input.system = system;
    }

    if (params.tools?.length) {
      input.toolConfig = { tools: toConverseTools(params.tools) };
    }

    // Merge (don't assign) so the reasoning_config fragment and a caller's
    // extra coexist; a per-call extra wins.
    const extraFields: Record<string, unknown> = {
      ...(reasoningOn ? { reasoning_config: { type: "enabled", budget_tokens: budget } } : {}),
      ...((params.extra as Record<string, unknown> | undefined) ?? {}),
    };
    if (Object.keys(extraFields).length > 0) {
      input.additionalModelRequestFields = extraFields as ConverseCommandInput["additionalModelRequestFields"];
    }

    return input;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    let data: ConverseCommandOutput;
    try {
      data = await this.client.send(new ConverseCommand(this.buildInput(params)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Bedrock Converse error for model ${params.model}: ${msg}`, { cause: err });
    }

    return parseConverseResponse(data);
  }

  /**
   * Streaming variant via ConverseStream. Text arrives as `delta` events;
   * toolUse input fragments accumulate per contentBlockIndex and surface
   * complete on `done`. Usage comes from the trailing `metadata` event.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    let stream: AsyncIterable<ConverseStreamOutput>;
    try {
      const data = await this.client.send(new ConverseStreamCommand(this.buildInput(params)));
      if (!data.stream) {
        throw new Error("response contained no stream");
      }
      stream = data.stream;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Bedrock ConverseStream error for model ${params.model}: ${msg}`, { cause: err });
    }

    let content = "";
    let reasoning = "";
    let stopReason: string | undefined;
    const usage = { input: 0, output: 0 };
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      const toolStart = event.contentBlockStart?.start?.toolUse;
      if (toolStart) {
        toolBlocks.set(event.contentBlockStart?.contentBlockIndex ?? 0, {
          id: toolStart.toolUseId ?? "",
          name: toolStart.name ?? "",
          json: "",
        });
      } else if (event.contentBlockDelta?.delta) {
        const delta = event.contentBlockDelta.delta;
        const reasoningText = (delta as { reasoningContent?: { text?: string } }).reasoningContent?.text;
        if (delta.text) {
          content += delta.text;
          yield { type: "delta", content: delta.text };
        } else if (reasoningText) {
          reasoning += reasoningText;
          yield { type: "reasoning", content: reasoningText };
        } else if (delta.toolUse?.input) {
          const block = toolBlocks.get(event.contentBlockDelta.contentBlockIndex ?? 0);
          if (block) block.json += delta.toolUse.input;
        }
      } else if (event.messageStop) {
        stopReason = event.messageStop.stopReason;
      } else if (event.metadata?.usage) {
        usage.input = event.metadata.usage.inputTokens ?? 0;
        usage.output = event.metadata.usage.outputTokens ?? 0;
      } else {
        // Mid-stream service errors arrive as exception members.
        const ex =
          event.internalServerException ??
          event.modelStreamErrorException ??
          event.validationException ??
          event.throttlingException ??
          event.serviceUnavailableException;
        if (ex) {
          throw new Error(`Bedrock ConverseStream error for model ${params.model}: ${ex.message}`, { cause: ex });
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.parse(block.json || "{}") as Record<string, unknown>,
      }));

    yield {
      type: "done",
      response: {
        content: content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoning || undefined,
        usage,
        finishReason: mapStopReason(stopReason),
      },
    };
  }
}
