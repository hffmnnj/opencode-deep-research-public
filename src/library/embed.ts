import type { EmbeddingConfig, LocalEmbeddingConfig, ServerEmbeddingConfig } from "../config.ts";

export type EmbedKind = "document" | "query";

export class EmbedUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbedUnavailableError";
  }
}

export interface Embedder {
  /** Identifies the vector space. Vectors with a different fingerprint are never compared. */
  readonly fingerprint: string;
  /** Where vectors come from, for status output. */
  readonly source: "server" | "local";
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
  status(): EmbedderStatus;
}

export interface EmbedderStatus {
  source: "server" | "local";
  fingerprint: string;
  state: "ready" | "cooldown" | "unavailable" | "untested";
  lastError?: string;
  retryInMs?: number;
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i] ?? 0;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

export function embeddingsUrl(base: string): string {
  const url = base.replace(/\/+$/, "");
  if (url.endsWith("/embeddings")) return url;
  if (/\/v\d+$/.test(url)) return `${url}/embeddings`;
  return `${url}/v1/embeddings`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class ServerEmbedder implements Embedder {
  readonly source = "server" as const;
  readonly fingerprint: string;
  private readonly url: string;

  constructor(private readonly cfg: ServerEmbeddingConfig) {
    this.url = embeddingsUrl(cfg.url);
    this.fingerprint = `server:${cfg.model}${cfg.dimensions ? `:${cfg.dimensions}` : ""}`;
  }

  status(): EmbedderStatus {
    return { source: this.source, fingerprint: this.fingerprint, state: "untested" };
  }

  async embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.cfg.batchSize) {
      out.push(...(await this.batch(texts.slice(i, i + this.cfg.batchSize), signal)));
    }
    return out;
  }

  private async batch(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.cfg.headers };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      input,
      encoding_format: "float",
      ...(this.cfg.dimensions ? { dimensions: this.cfg.dimensions } : {}),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(400 * attempt);
      const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers,
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`embedding server answered HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) {
          throw new EmbedUnavailableError(`embedding server rejected the request (HTTP ${response.status})`);
        }
        const json = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
        const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== input.length || rows.some((r) => !Array.isArray(r.embedding))) {
          throw new EmbedUnavailableError("embedding server returned an unexpected response shape");
        }
        return rows.map((r) => normalize(r.embedding ?? []));
      } catch (error) {
        if (error instanceof EmbedUnavailableError) throw error;
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw new EmbedUnavailableError(`embedding server unreachable at ${this.url}`, { cause: lastError });
  }
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{ tolist(): number[][] }>;
}

class LocalEmbedder implements Embedder {
  readonly source = "local" as const;
  readonly fingerprint: string;
  private extractor?: Promise<FeatureExtractor>;

  constructor(private readonly cfg: LocalEmbeddingConfig) {
    this.fingerprint = `local:${cfg.model}${cfg.dtype ? `:${cfg.dtype}` : ""}`;
  }

  status(): EmbedderStatus {
    return { source: this.source, fingerprint: this.fingerprint, state: this.extractor ? "ready" : "untested" };
  }

  private load(): Promise<FeatureExtractor> {
    this.extractor ??= (async () => {
      let transformers: typeof import("@huggingface/transformers");
      try {
        transformers = await import("@huggingface/transformers");
      } catch (error) {
        throw new EmbedUnavailableError(
          "local embeddings need the optional dependency @huggingface/transformers (run `bun add @huggingface/transformers` in the plugin directory)",
          { cause: error },
        );
      }
      transformers.env.cacheDir = this.cfg.cacheDir;
      transformers.env.allowRemoteModels = this.cfg.allowDownload;
      const pipe = await transformers.pipeline("feature-extraction", this.cfg.model, this.cfg.dtype ? ({ dtype: this.cfg.dtype } as never) : {});
      return pipe as unknown as FeatureExtractor;
    })().catch((error: unknown) => {
      this.extractor = undefined;
      throw error instanceof EmbedUnavailableError
        ? error
        : new EmbedUnavailableError(`could not load local model ${this.cfg.model}`, { cause: error });
    });
    return this.extractor;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    const extractor = await this.load();
    const prefix = kind === "query" ? this.cfg.queryPrefix : this.cfg.documentPrefix;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => prefix + t);
      const tensor = await extractor(batch, { pooling: "mean", normalize: true });
      out.push(...tensor.tolist().map((row) => normalize(row)));
    }
    return out;
  }
}

/** Wraps an embedder with a failure cooldown so an unreachable server costs one timeout, not one per call. */
class GuardedEmbedder implements Embedder {
  private failedAt = 0;
  private lastError?: string;
  private everWorked = false;

  constructor(
    private readonly inner: Embedder,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get fingerprint(): string {
    return this.inner.fingerprint;
  }
  get source(): "server" | "local" {
    return this.inner.source;
  }

  status(): EmbedderStatus {
    const base = this.inner.status();
    const retryInMs = this.failedAt ? Math.max(0, this.failedAt + this.cooldownMs - this.now()) : 0;
    if (this.lastError && retryInMs > 0) return { ...base, state: "cooldown", lastError: this.lastError, retryInMs };
    if (this.lastError) return { ...base, state: "unavailable", lastError: this.lastError };
    return { ...base, state: this.everWorked ? "ready" : base.state };
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (this.failedAt && this.now() - this.failedAt < this.cooldownMs) {
      throw new EmbedUnavailableError(this.lastError ?? "embedder in cooldown");
    }
    try {
      const vectors = await this.inner.embed(texts, kind, signal);
      this.failedAt = 0;
      this.lastError = undefined;
      this.everWorked = true;
      return vectors;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.failedAt = this.now();
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error instanceof EmbedUnavailableError ? error : new EmbedUnavailableError(this.lastError, { cause: error });
    }
  }
}

/**
 * `server`: use the configured OpenAI-compatible endpoint. `local`: run a model in-process.
 * `auto`: the server when one is configured, otherwise the local model. `off`: keyword search only.
 */
export function createEmbedder(config: EmbeddingConfig, cooldownMs = 30_000): Embedder | undefined {
  switch (config.mode) {
    case "off":
      return undefined;
    case "server":
      return config.server ? new GuardedEmbedder(new ServerEmbedder(config.server), cooldownMs) : undefined;
    case "local":
      return new GuardedEmbedder(new LocalEmbedder(config.local), cooldownMs);
    case "auto":
      return config.server
        ? new GuardedEmbedder(new ServerEmbedder(config.server), cooldownMs)
        : new GuardedEmbedder(new LocalEmbedder(config.local), cooldownMs);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
