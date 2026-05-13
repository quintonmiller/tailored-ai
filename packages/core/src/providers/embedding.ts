/**
 * Pluggable embedding backend. Mirrors the AIProvider interface but produces
 * dense float vectors. See docs/memory-tiers.md (M5).
 *
 * Implementations live in packages/core/src/providers/openai-embedding.ts
 * (default, hits /v1/embeddings) and optionally a local impl in a future slice.
 */
export interface EmbeddingProvider {
  id: string;
  name: string;
  /** Embedding model identifier (e.g. "text-embedding-3-small"). */
  defaultModel: string;
  /** Expected output dimension. */
  defaultDim: number;
  /** Compute embeddings for one or more inputs. Order is preserved. */
  embed(inputs: string[], opts?: EmbedOptions): Promise<EmbedResult>;
}

export interface EmbedOptions {
  model?: string;
  /** Optional abort signal threaded through to fetch(). */
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** One vector per input, in input order. Length matches `dim`. */
  vectors: Float32Array[];
  /** Echoed model id (provider may upgrade/downgrade the requested model). */
  model: string;
  dim: number;
  /** Token usage when reported by the provider. */
  usage?: { prompt: number; total: number };
}

/** Pack a Float32Array as a Buffer for SQLite BLOB storage. */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Decode a Buffer (read from SQLite) back into a Float32Array. */
export function blobToVector(buf: Buffer): Float32Array {
  // Float32 = 4 bytes; the buffer might be a slice of a shared ArrayBuffer.
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
