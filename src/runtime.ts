import type { PluginConfig } from "./config.ts";
import { createEmbedder } from "./library/embed.ts";
import { Library } from "./library/library.ts";

interface Entry {
  library: Promise<Library>;
  refs: number;
}

const shared = new Map<string, Entry>();

export interface LibraryHandle {
  get(): Promise<Library>;
  release(): void;
}

/**
 * One Library per library path per process. A plugin instance is created per location, but they all
 * share the same notes, index and embedder.
 */
export function acquireLibrary(config: PluginConfig, log: (message: string) => void): LibraryHandle {
  let entry = shared.get(config.libraryPath);
  if (!entry) {
    entry = {
      library: Library.open({
        path: config.libraryPath,
        embedder: createEmbedder(config.embedding),
        embeddingMode: config.embedding.mode,
        staleDays: config.staleDays,
        log,
      }),
      refs: 0,
    };
    shared.set(config.libraryPath, entry);
  }
  entry.refs++;
  const held = entry;
  let released = false;
  return {
    get: () => held.library,
    release() {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs <= 0) {
        shared.delete(config.libraryPath);
        void held.library.then((lib) => lib.close()).catch(() => undefined);
      }
    },
  };
}
