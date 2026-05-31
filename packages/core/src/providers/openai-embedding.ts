import { withRetry } from "../tools/retry.js";
import type { EmbeddingProvider, EmbedOptions, EmbedResult } from "./embedding.js";

export interface OpenAICompatibleEmbeddingOptions {
  /** Endpoint base URL — must include /v1. */
  baseUrl: string;
  /** Default model id. */
  defaultModel: string;
  /** Optional auth header. When omitted no Authorization is sent (vLLM/local). */
  apiKey?: string;
  /** Output dimension hint (used by callers; not enforced on response). */
  dim?: number;
  /** Display name in logs / UI. */
  name?: string;
  /** Stable id reported by `.id`; default is "openai_compatible_embedding". */
  id?: string;
}

interface EmbeddingsResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Generic embeddings client for any OpenAI-compatible server (vLLM, Ollama
 * `/v1`, LM Studio, hosted OpenAI). Mirrors the wire format of POST
 * /v1/embeddings.
 *
 * Output dimension is read from the response's first vector; callers can
 * pre-declare it via `dim` (used for sanity checks elsewhere). No client-
 * side enforcement so a model upgrade with a different dim still works.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  id: string;
  name: string;
  defaultModel: string;
  defaultDim: number;

  private baseUrl: string;
  private apiKey: string;

  constructor(opts: OpenAICompatibleEmbeddingOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.defaultModel = opts.defaultModel;
    this.defaultDim = opts.dim ?? 1536;
    this.name = opts.name ?? "OpenAI-compatible embeddings";
    this.id = opts.id ?? "openai_compatible_embedding";
  }

  async embed(inputs: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    if (inputs.length === 0) {
      return { vectors: [], model: opts.model ?? this.defaultModel, dim: this.defaultDim };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: opts.model ?? this.defaultModel,
      input: inputs,
    });

    const json = await withRetry<EmbeddingsResponse>(async () => {
      const resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body,
        signal: opts.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const err = new Error(`embeddings request failed: ${resp.status} ${text.slice(0, 200)}`);
        // Surface the status so withRetry's isTransientError() can decide.
        (err as Error & { status?: number }).status = resp.status;
        throw err;
      }
      return (await resp.json()) as EmbeddingsResponse;
    });

    // Preserve input order — OpenAI promises it but we sort on `index` to be safe.
    const slots: number[][] = new Array(inputs.length);
    for (const entry of json.data) {
      slots[entry.index] = entry.embedding;
    }
    const vectors = slots.map((arr) => Float32Array.from(arr ?? []));
    const dim = vectors[0]?.length ?? this.defaultDim;
    return {
      vectors,
      model: json.model,
      dim,
      usage: json.usage
        ? {
            prompt: json.usage.prompt_tokens ?? 0,
            total: json.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}
