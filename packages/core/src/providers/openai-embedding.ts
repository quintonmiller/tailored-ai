import { isTransientError, withRetry } from "../tools/retry.js";
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
  /**
   * Soft cap on the characters of each input string. Inputs longer than this
   * are truncated before the request so an oversized query/chunk does not
   * exceed the embedding model's context window (which returns a non-retryable
   * 400 and silently drops semantic recall to keyword-only). Default 8000
   * (~2k tokens). On an overflow 400 the request is retried with the cap
   * halved, so recall self-heals regardless of the model's actual window.
   */
  maxInputChars?: number;
}

interface EmbeddingsResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * True when an embeddings error looks like a context-length overflow (the
 * input was too long for the model). Matches the common wordings across
 * vLLM / Ollama / OpenAI, and treats a bare 400 as an overflow candidate
 * since embeddings endpoints 400 almost exclusively on input size.
 */
function isContextOverflow(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: number }).status;
  const message = (err as { message?: string }).message ?? "";
  if (/input.*length|context length|maximum context|too long|exceeds|max.*tokens/i.test(message)) {
    return true;
  }
  return status === 400;
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
  private maxInputChars: number;

  constructor(opts: OpenAICompatibleEmbeddingOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.defaultModel = opts.defaultModel;
    this.defaultDim = opts.dim ?? 1536;
    this.name = opts.name ?? "OpenAI-compatible embeddings";
    this.id = opts.id ?? "openai_compatible_embedding";
    this.maxInputChars = opts.maxInputChars && opts.maxInputChars > 0 ? opts.maxInputChars : 8000;
  }

  async embed(inputs: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    if (inputs.length === 0) {
      return { vectors: [], model: opts.model ?? this.defaultModel, dim: this.defaultDim };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const model = opts.model ?? this.defaultModel;

    const post = async (clamp: number): Promise<EmbeddingsResponse> => {
      const clamped = inputs.map((s) => (s.length > clamp ? s.slice(0, clamp) : s));
      const body = JSON.stringify({ model, input: clamped });
      return withRetry<EmbeddingsResponse>(async () => {
        const resp = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers,
          body,
          signal: opts.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          const err = new Error(`embeddings request failed: ${resp.status} ${text.slice(0, 200)}`);
          // Surface the status so withRetry's isTransientError() can decide,
          // and so the overflow check below can react to a 400.
          (err as Error & { status?: number }).status = resp.status;
          throw err;
        }
        return (await resp.json()) as EmbeddingsResponse;
      }, { shouldRetry: isTransientError });
    };

    // Clamp oversized inputs up front, then retry with a smaller clamp if the
    // server still reports a context-length overflow — so recall self-heals
    // for any model window instead of failing the whole semantic search (#254
    // follow-up: 539 "input length exceeds the context length" 400s in the
    // wild went unrecovered because a 400 is not transient).
    const MIN_CLAMP = 512;
    let clamp = this.maxInputChars;
    let json: EmbeddingsResponse;
    for (;;) {
      try {
        json = await post(clamp);
        break;
      } catch (err) {
        if (isContextOverflow(err) && clamp > MIN_CLAMP) {
          clamp = Math.max(MIN_CLAMP, Math.floor(clamp / 2));
          continue;
        }
        throw err;
      }
    }

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
