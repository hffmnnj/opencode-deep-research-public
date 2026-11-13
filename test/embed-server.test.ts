import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig, resolveSecret } from "../src/config.ts";
import { EmbedUnavailableError, createEmbedder, embeddingsUrl } from "../src/library/embed.ts";

// A local OpenAI-compatible stub: it checks our request shape, not any real provider's behavior.
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request, body: Record<string, unknown>) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      return handler(req, (await req.json().catch(() => ({}))) as Record<string, unknown>);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const config = (url: string, extra: Record<string, unknown> = {}) =>
  parseConfig({ embedding: { mode: "server", server: { url, model: "m", apiKey: "k", batchSize: 2, timeoutMs: 2000, ...extra } } }).embedding;

describe("server embedder", () => {
  test("embedsInBatchesWithBearerKeyAndRestoresIndexOrder", async () => {
    const seen: { auth: string | null; path: string; size: number }[] = [];
    const base = serve((req, body) => {
      const input = body.input as string[];
      seen.push({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname, size: input.length });
      // answer out of order to prove we sort by index
      const data = input.map((text, index) => ({ index, embedding: [text.length, 1, 0] })).reverse();
      return Response.json({ data });
    });
    const embedder = createEmbedder(config(base));
    const vectors = await embedder!.embed(["a", "bbb", "cc"], "document");
    expect(seen).toEqual([
      { auth: "Bearer k", path: "/v1/embeddings", size: 2 },
      { auth: "Bearer k", path: "/v1/embeddings", size: 1 },
    ]);
    // inputs "a", "bbb", "cc" have lengths 1, 3, 2; the first component grows with length, so it proves index order
    expect(vectors).toHaveLength(3);
    const first = vectors.map((v) => v[0] ?? 0);
    expect(first[1]!).toBeGreaterThan(first[2]!);
    expect(first[2]!).toBeGreaterThan(first[0]!);
    for (const v of vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  test("unreachableServer_throwsUnavailableThenCoolsDownWithoutRetryingNetwork", async () => {
    let hits = 0;
    const base = serve(() => {
      hits++;
      return new Response("boom", { status: 503 });
    });
    const embedder = createEmbedder(config(base), 60_000)!;
    await expect(embedder.embed(["x"], "query")).rejects.toBeInstanceOf(EmbedUnavailableError);
    const afterFirst = hits;
    expect(afterFirst).toBe(3); // one try plus two retries
    await expect(embedder.embed(["x"], "query")).rejects.toBeInstanceOf(EmbedUnavailableError);
    expect(hits).toBe(afterFirst);
    expect(embedder.status().state).toBe("cooldown");
  });

  test("clientError_failsFastWithoutRetries", async () => {
    let hits = 0;
    const base = serve(() => {
      hits++;
      return new Response("bad key", { status: 401 });
    });
    await expect(createEmbedder(config(base))!.embed(["x"], "query")).rejects.toThrow(/HTTP 401/);
    expect(hits).toBe(1);
  });
});

describe("configuration", () => {
  test("embeddingsUrl_acceptsBaseVersionedAndFullUrls", () => {
    expect(embeddingsUrl("http://h:1")).toBe("http://h:1/v1/embeddings");
    expect(embeddingsUrl("http://h:1/v1/")).toBe("http://h:1/v1/embeddings");
    expect(embeddingsUrl("https://h/api/embeddings")).toBe("https://h/api/embeddings");
  });

  test("resolveSecret_readsEnvAndFileReferencesButNotMissingOnes", async () => {
    expect(resolveSecret("literal")).toBe("literal");
    expect(resolveSecret("env://DR_KEY", { DR_KEY: " from-env " })).toBe("from-env");
    expect(resolveSecret("env://NOPE", {})).toBeUndefined();
    expect(resolveSecret("file:///definitely/not/here")).toBeUndefined();
  });

  test("modeOff_createsNoEmbedderAndAutoPrefersConfiguredServer", () => {
    expect(createEmbedder(parseConfig({ embedding: { mode: "off", server: { url: "http://x" } } }).embedding)).toBeUndefined();
    const auto = createEmbedder(parseConfig({ embedding: { server: { url: "http://x", model: "srv" } } }).embedding);
    expect(auto?.source).toBe("server");
    expect(auto?.fingerprint).toBe("server:srv");
    const local = createEmbedder(parseConfig({}).embedding);
    expect(local?.source).toBe("local");
  });

  test("localDefault_isEmbeddingGemmaQuantizedWithTaskPromptsAndOverridable", () => {
    const def = parseConfig({}).embedding.local;
    expect(def.model).toBe("onnx-community/embeddinggemma-2-ONNX");
    expect(def.dtype).toBe("q8");
    expect(def.queryPrefix).toBe("task: search result | query: ");
    expect(def.documentPrefix).toBe("title: none | text: ");
    const other = parseConfig({ embedding: { local: { model: "Xenova/all-MiniLM-L6-v2" } } }).embedding.local;
    expect([other.dtype, other.queryPrefix, other.documentPrefix]).toEqual([undefined, "", ""]);
    const custom = parseConfig({ embedding: { local: { dtype: "fp32", queryPrefix: "" } } }).embedding.local;
    expect([custom.dtype, custom.queryPrefix, custom.documentPrefix]).toEqual(["fp32", "", "title: none | text: "]);
  });

  test("serverModeWithoutUrl_createsNoEmbedder", () => {
    expect(createEmbedder(parseConfig({ embedding: { mode: "server" } }, {}).embedding)).toBeUndefined();
  });
});
