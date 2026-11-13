import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_STALE_DAYS, type StaleWindows } from "./library/types.ts";

export type EmbeddingMode = "auto" | "server" | "local" | "off";

export interface ServerEmbeddingConfig {
  /** OpenAI-compatible base URL (`http://host:port`, `.../v1`) or a full `.../embeddings` URL. */
  url: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
  batchSize: number;
  timeoutMs: number;
  headers: Record<string, string>;
}

export interface LocalEmbeddingConfig {
  /** Hugging Face model id run in-process through `@huggingface/transformers`. */
  model: string;
  cacheDir: string;
  dtype?: string;
  allowDownload: boolean;
  queryPrefix: string;
  documentPrefix: string;
}

export interface EmbeddingConfig {
  mode: EmbeddingMode;
  server?: ServerEmbeddingConfig;
  local: LocalEmbeddingConfig;
}

export interface AgentModels {
  researcher?: string;
  verifier?: string;
  librarian?: string;
}

export interface PluginConfig {
  libraryPath: string;
  hint: boolean;
  models: AgentModels;
  staleDays: StaleWindows;
  embedding: EmbeddingConfig;
}

type Raw = Record<string, unknown>;
export const DEFAULT_LOCAL_MODEL = "onnx-community/embeddinggemma-2-ONNX";

/** EmbeddingGemma is trained with task prompts; retrieval quality drops without them. */
const GEMMA_QUERY_PREFIX = "task: search result | query: ";
const GEMMA_DOCUMENT_PREFIX = "title: none | text: ";

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-deep-research");
}

/** Resolve a secret given as a literal, `env://NAME`, or `file://path` so keys never need to live in opencode.json. */
export function resolveSecret(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env://")) return str(env[value.slice(6)]);
  if (value.startsWith("file://")) {
    try {
      return str(readFileSync(resolve(expandHome(value.slice(7))), "utf8"));
    } catch {
      return undefined;
    }
  }
  return value;
}

export function parseConfig(options: unknown, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const o: Raw = isRecord(options) ? options : {};
  const dataDir = defaultDataDir(env);
  const libraryPath = resolve(expandHome(str(o.libraryPath) ?? join(dataDir, "library")));

  const models = isRecord(o.models) ? o.models : {};
  const stale = isRecord(o.staleDays) ? o.staleDays : {};
  const emb = isRecord(o.embedding) ? o.embedding : {};
  const server = isRecord(emb.server) ? emb.server : {};
  const local = isRecord(emb.local) ? emb.local : {};

  const localModel = str(local.model) ?? DEFAULT_LOCAL_MODEL;
  const isGemma = /embeddinggemma/i.test(localModel);
  const serverUrl = str(server.url) ?? str(env.DEEP_RESEARCH_EMBED_URL);
  const mode = ((): EmbeddingMode => {
    const m = str(emb.mode);
    return m === "server" || m === "local" || m === "off" || m === "auto" ? m : "auto";
  })();

  const serverConfig: ServerEmbeddingConfig | undefined = serverUrl
    ? {
        url: serverUrl,
        model: str(server.model) ?? str(env.DEEP_RESEARCH_EMBED_MODEL) ?? "text-embedding-3-small",
        apiKey: resolveSecret(str(server.apiKey) ?? str(env.DEEP_RESEARCH_EMBED_KEY), env),
        dimensions: num(server.dimensions),
        batchSize: Math.min(256, Math.floor(num(server.batchSize) ?? 32)),
        timeoutMs: Math.floor(num(server.timeoutMs) ?? 15_000),
        headers: isRecord(server.headers)
          ? Object.fromEntries(Object.entries(server.headers).filter((e): e is [string, string] => typeof e[1] === "string"))
          : {},
      }
    : undefined;

  return {
    libraryPath,
    hint: o.hint !== false,
    models: { researcher: str(models.researcher), verifier: str(models.verifier), librarian: str(models.librarian) },
    staleDays: {
      slow: num(stale.slow) ?? DEFAULT_STALE_DAYS.slow,
      fast: num(stale.fast) ?? DEFAULT_STALE_DAYS.fast,
      live: num(stale.live) ?? DEFAULT_STALE_DAYS.live,
    },
    embedding: {
      mode,
      server: serverConfig,
      local: {
        model: localModel,
        cacheDir: resolve(expandHome(str(local.cacheDir) ?? join(dataDir, "models"))),
        dtype: str(local.dtype) ?? (isGemma ? "q8" : undefined),
        allowDownload: local.allowDownload !== false,
        queryPrefix: typeof local.queryPrefix === "string" ? local.queryPrefix : isGemma ? GEMMA_QUERY_PREFIX : "",
        documentPrefix: typeof local.documentPrefix === "string" ? local.documentPrefix : isGemma ? GEMMA_DOCUMENT_PREFIX : "",
      },
    },
  };
}
