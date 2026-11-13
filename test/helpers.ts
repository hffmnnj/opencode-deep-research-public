import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { EmbedUnavailableError, normalize, type Embedder, type EmbedderStatus } from "../src/library/embed.ts";
import { Library, type LibraryOptions } from "../src/library/library.ts";

const SCRATCH = process.env.DEEP_RESEARCH_TEST_TMP ?? join("/var/tmp/example/opencode", "dr-tests");

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, "lib-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Words in the same group land on the same dimension, so "car" and "automobile" are semantically identical. */
const CONCEPTS = [
  ["car", "automobile", "vehicle"],
  ["bank", "lender", "finance"],
  ["cat", "feline", "kitten"],
  ["quantum", "qubit"],
];

export class FakeEmbedder implements Embedder {
  readonly fingerprint: string;
  readonly source = "server" as const;
  down = false;
  calls = 0;

  constructor(version = "v1") {
    this.fingerprint = `fake:${version}`;
  }

  status(): EmbedderStatus {
    return { source: "server", fingerprint: this.fingerprint, state: this.down ? "unavailable" : "ready" };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.down) throw new EmbedUnavailableError("fake embedder is down");
    return texts.map((text) => {
      const vec = new Float32Array(CONCEPTS.length + 1);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        const i = CONCEPTS.findIndex((group) => group.includes(word));
        if (i >= 0) vec[i] = (vec[i] ?? 0) + 1;
      }
      if (vec.every((v) => v === 0)) vec[CONCEPTS.length] = 1;
      return normalize(vec);
    });
  }
}

export async function openLibrary(dir: string, overrides: Partial<LibraryOptions> = {}): Promise<Library> {
  return Library.open({ path: join(dir, "library"), ...overrides });
}
