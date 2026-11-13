import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { EmbeddingMode } from "../config.ts";
import { chunkBody, outline, section, type OutlineEntry } from "./chunk.ts";
import { EmbedUnavailableError, cosine, type Embedder, type EmbedderStatus } from "./embed.ts";
import { initSchema, removeNote, rowToMeta, upsertNote, type NoteRow } from "./index-db.ts";
import { parseNote, serializeNote } from "./note-file.ts";
import { buildFtsQuery, fuseRanks, parseSince, queryTerms, snippet } from "./search.ts";
import { fromFloat32, openDb, toFloat32, type Db, type SqlValue } from "./sqlite.ts";
import {
  CONFIDENCE_LEVELS,
  DEFAULT_STALE_DAYS,
  ageDays,
  confidenceRank,
  isNoteId,
  isStale,
  newNoteId,
  type Confidence,
  type Note,
  type NoteKind,
  type NoteMeta,
  type NoteSource,
  type StaleWindows,
  type Volatility,
} from "./types.ts";
import {
  ValidationError,
  assertNoSecrets,
  cleanBody,
  cleanLinks,
  cleanRunId,
  cleanSources,
  cleanSummary,
  cleanTitle,
  cleanTopics,
  parseConfidence,
  parseKind,
  parseVolatility,
} from "./validate.ts";

export interface LibraryOptions {
  path: string;
  embedder?: Embedder;
  embeddingMode?: EmbeddingMode;
  staleDays?: StaleWindows;
  log?: (message: string) => void;
  now?: () => number;
}

export interface Card {
  id: string;
  title: string;
  kind: NoteKind;
  summary: string;
  topics: string[];
  confidence: Confidence;
  volatility: Volatility;
  runId?: string;
  updatedAt: string;
  ageDays: number;
  stale: boolean;
  superseded?: boolean;
  score?: number;
  snippet?: string;
}

export interface SearchInput {
  query?: string;
  topics?: string[];
  kinds?: NoteKind[];
  runId?: string;
  since?: string;
  minConfidence?: Confidence;
  includeStale?: boolean;
  includeSuperseded?: boolean;
  limit?: number;
  mode?: "hybrid" | "keyword" | "semantic";
}

export type SemanticState = "used" | "keyword-only" | "off" | "unavailable";

export interface SearchResult {
  cards: Card[];
  semantic: SemanticState;
  pendingEmbeddings: number;
}

export interface SaveInput {
  title: unknown;
  summary: unknown;
  body?: unknown;
  kind?: unknown;
  topics?: unknown;
  sources?: unknown;
  confidence?: unknown;
  volatility?: unknown;
  runId?: unknown;
  links?: unknown;
  supersedes?: unknown;
}

export interface UpdateInput {
  id: string;
  title?: unknown;
  summary?: unknown;
  body?: unknown;
  appendBody?: unknown;
  topics?: unknown;
  addTopics?: unknown;
  addSources?: unknown;
  addLinks?: unknown;
  confidence?: unknown;
  volatility?: unknown;
  kind?: unknown;
}

export interface SaveResult {
  id: string;
  path: string;
  embedded: boolean;
  possibleDuplicates: { id: string; title: string; reason: "same-title" | "similar" }[];
}

export interface ReindexResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  invalid: { file: string; reason: string }[];
  embedded: number;
  pendingEmbeddings: number;
}

export interface LibraryStats {
  path: string;
  notes: number;
  superseded: number;
  chunks: number;
  byKind: Record<string, number>;
  byConfidence: Record<string, number>;
  stale: number;
  pendingEmbeddings: number;
  embedding: { mode: EmbeddingMode | "off"; configured: boolean; status?: EmbedderStatus };
  invalidFiles: number;
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No note with id ${id}`);
    this.name = "NotFoundError";
  }
}

interface CachedVector {
  noteId: string;
  idx: number;
  vec: Float32Array;
}

const NOTE_FILE = /^(rn_[0-9a-z]{12})\.md$/;
const EMBED_ON_SAVE_MS = 5_000;
const SEMANTIC_MIN_SCORE = 0.2;
const DUPLICATE_SIMILARITY = 0.92;
const CONFIDENCE_WEIGHT: Record<Confidence, number> = { disputed: 0.85, unverified: 1, checked: 1.05, verified: 1.15 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export class Library {
  readonly root: string;
  private readonly notesDir: string;
  private readonly trashDir: string;
  private readonly stale: StaleWindows;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly embedder?: Embedder;
  private readonly embeddingMode: EmbeddingMode | "off";

  private lock: Promise<unknown> = Promise.resolve();
  private synced?: Promise<void>;
  private backfilling?: Promise<void>;
  private invalidFiles: { file: string; reason: string }[] = [];

  private vectors = new Map<number, CachedVector>();
  private vectorsByNote = new Map<string, number[]>();
  private vectorFp?: string;
  private vectorDataVersion?: number;

  private constructor(private readonly db: Db, opts: LibraryOptions) {
    this.root = opts.path;
    this.notesDir = join(opts.path, "notes");
    this.trashDir = join(opts.path, ".trash");
    this.stale = opts.staleDays ?? DEFAULT_STALE_DAYS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.embedder = opts.embedder;
    this.embeddingMode = opts.embedder ? (opts.embeddingMode ?? "auto") : "off";
  }

  static async open(opts: LibraryOptions): Promise<Library> {
    await mkdir(join(opts.path, "notes"), { recursive: true });
    const db = await openDb(join(opts.path, "index.db"));
    initSchema(db);
    return new Library(db, opts);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- plumbing

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Index is derived from the note files; reconcile it once before the first operation. */
  ready(): Promise<void> {
    this.synced ??= this.withLock(() => this.syncFiles()).then(() => undefined);
    return this.synced;
  }

  private notePath(id: string, createdAt: string): string {
    const month = /^\d{4}-\d{2}/.test(createdAt) ? createdAt.slice(0, 7) : "unsorted";
    return join("notes", month, `${id}.md`);
  }

  private async writeFileAtomic(absolute: string, content: string): Promise<void> {
    await mkdir(dirname(absolute), { recursive: true });
    const tmp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${this.now().toString(36)}.tmp`);
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absolute);
  }

  private row(id: string): NoteRow | undefined {
    return this.db.get<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
  }

  private toCard(meta: NoteMeta, extra: Partial<Card> = {}): Card {
    const now = this.now();
    const card: Card = {
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      summary: meta.summary,
      topics: meta.topics,
      confidence: meta.confidence,
      volatility: meta.volatility,
      updatedAt: meta.updatedAt,
      ageDays: ageDays(meta.updatedAt, now),
      stale: isStale(meta, this.stale, now),
      ...extra,
    };
    if (meta.runId) card.runId = meta.runId;
    if (meta.supersededBy) card.superseded = true;
    return card;
  }

  // ------------------------------------------------------------ file <-> index

  /** Index one parsed note whose file is already on disk. Returns its chunk ids. */
  private async indexNote(note: Note, relativePath: string): Promise<number[]> {
    const info = await stat(join(this.root, relativePath));
    const { body, ...meta } = note;
    this.dropCachedNote(note.id);
    return upsertNote(this.db, meta, chunkBody(body), body.length, { path: relativePath, mtimeMs: info.mtimeMs, size: info.size });
  }

  private async syncFiles(): Promise<ReindexResult> {
    const known = new Map(this.db.all<Pick<NoteRow, "id" | "path" | "mtime_ms" | "size">>("SELECT id, path, mtime_ms, size FROM notes").map((r) => [r.id, r]));
    const result: ReindexResult = { scanned: 0, added: 0, updated: 0, removed: 0, invalid: [], embedded: 0, pendingEmbeddings: 0 };
    const seen = new Set<string>();
    let entries: string[] = [];
    try {
      entries = await readdir(this.notesDir, { recursive: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const match = NOTE_FILE.exec(basename(entry));
      if (!match) continue;
      const id = match[1] ?? "";
      if (seen.has(id)) continue;
      seen.add(id);
      result.scanned++;
      const relative = join("notes", entry);
      let info;
      try {
        info = await stat(join(this.root, relative));
      } catch {
        continue;
      }
      const existing = known.get(id);
      if (existing && existing.path === relative && existing.mtime_ms === info.mtimeMs && existing.size === info.size) continue;
      const parsed = parseNote(await readFile(join(this.root, relative), "utf8"));
      if (!parsed.ok || parsed.note.id !== id) {
        result.invalid.push({ file: relative, reason: parsed.ok ? "id does not match file name" : parsed.reason });
        continue;
      }
      await this.indexNote(parsed.note, relative);
      if (existing) result.updated++;
      else result.added++;
    }
    for (const id of known.keys()) {
      if (!seen.has(id)) {
        this.dropCachedNote(id);
        removeNote(this.db, id);
        result.removed++;
      }
    }
    this.invalidFiles = result.invalid;
    return result;
  }

  async reindex(options: { embed?: boolean } = {}): Promise<ReindexResult> {
    const result = await this.withLock(() => this.syncFiles());
    this.synced = Promise.resolve();
    if (options.embed !== false && this.embedder) result.embedded = await this.backfillNow(this.now() + 60_000);
    result.pendingEmbeddings = this.pendingCount();
    return result;
  }

  async getNote(id: string): Promise<Note> {
    await this.ready();
    if (!isNoteId(id)) throw new ValidationError(`'${id}' is not a note id (expected rn_ followed by 12 characters)`);
    const row = this.row(id);
    if (!row) throw new NotFoundError(id);
    let text: string;
    try {
      text = await readFile(join(this.root, row.path), "utf8");
    } catch {
      this.dropCachedNote(id);
      removeNote(this.db, id);
      throw new NotFoundError(id);
    }
    const parsed = parseNote(text);
    if (!parsed.ok) throw new ValidationError(`note ${id} is unreadable: ${parsed.reason}`);
    return parsed.note;
  }

  // ----------------------------------------------------------------- writing

  async save(input: SaveInput): Promise<SaveResult> {
    await this.ready();
    const title = cleanTitle(input.title);
    const summary = cleanSummary(input.summary);
    const body = cleanBody(input.body);
    const sources = cleanSources(input.sources);
    assertNoSecrets(title, summary, body, ...sources.map((s) => s.quote));
    const replaced = input.supersedes === undefined ? [] : Array.isArray(input.supersedes) ? input.supersedes : [input.supersedes];
    if (replaced.length > 10 || !replaced.every(isNoteId)) throw new ValidationError("supersedes must be a note id or an array of up to 10 note ids");
    const supersedes = replaced[0] as string | undefined;

    const iso = new Date(this.now()).toISOString();
    const note: Note = {
      id: newNoteId(this.now()),
      title,
      kind: parseKind(input.kind) ?? "note",
      summary,
      topics: cleanTopics(input.topics),
      sources,
      confidence: parseConfidence(input.confidence) ?? "unverified",
      volatility: parseVolatility(input.volatility) ?? "slow",
      links: cleanLinks(input.links),
      createdAt: iso,
      updatedAt: iso,
      body,
    };
    const runId = cleanRunId(input.runId);
    if (runId) note.runId = runId;
    if (supersedes) note.supersedes = supersedes;

    const sameTitle = this.db.all<{ id: string; title: string }>(
      "SELECT id, title FROM notes WHERE lower(title) = lower(?) AND superseded_by IS NULL LIMIT 3", title,
    );

    const { relative, chunkIds } = await this.withLock(async () => {
      const relativePath = this.notePath(note.id, iso);
      await this.writeFileAtomic(join(this.root, relativePath), serializeNote(note));
      const ids = await this.indexNote(note, relativePath);
      for (const oldId of new Set(replaced as string[])) await this.markSuperseded(oldId, note.id);
      return { relative: relativePath, chunkIds: ids };
    });

    const embedded = await this.embedWithin(chunkIds, EMBED_ON_SAVE_MS);
    const possibleDuplicates: SaveResult["possibleDuplicates"] = sameTitle
      .filter((d) => !replaced.includes(d.id))
      .map((d) => ({ id: d.id, title: d.title, reason: "same-title" as const }));
    if (embedded) {
      for (const similar of this.similarCards(note.id, 3)) {
        if (similar.score >= DUPLICATE_SIMILARITY && !possibleDuplicates.some((d) => d.id === similar.id) && !replaced.includes(similar.id)) {
          possibleDuplicates.push({ id: similar.id, title: similar.title, reason: "similar" });
        }
      }
    }
    if (!embedded) this.backfillSoon();
    return { id: note.id, path: join(this.root, relative), embedded, possibleDuplicates };
  }

  private async markSuperseded(oldId: string, newId: string): Promise<void> {
    const row = this.row(oldId);
    if (!row) throw new ValidationError(`supersedes: note ${oldId} does not exist`);
    const old = await this.readFromRow(row);
    old.supersededBy = newId;
    old.updatedAt = new Date(this.now()).toISOString();
    await this.writeFileAtomic(join(this.root, row.path), serializeNote(old));
    await this.indexNote(old, row.path);
  }

  private async readFromRow(row: NoteRow): Promise<Note> {
    const parsed = parseNote(await readFile(join(this.root, row.path), "utf8"));
    if (!parsed.ok) throw new ValidationError(`note ${row.id} is unreadable: ${parsed.reason}`);
    return parsed.note;
  }

  async update(input: UpdateInput): Promise<{ id: string; embedded: boolean }> {
    await this.ready();
    if (!isNoteId(input.id)) throw new ValidationError("id must be a note id");
    const chunkIds = await this.withLock(async () => {
      const row = this.row(input.id);
      if (!row) throw new NotFoundError(input.id);
      const note = await this.readFromRow(row);
      if (input.title !== undefined) note.title = cleanTitle(input.title);
      if (input.summary !== undefined) note.summary = cleanSummary(input.summary);
      if (input.body !== undefined) note.body = cleanBody(input.body);
      if (input.appendBody !== undefined) note.body = cleanBody(`${note.body}\n\n${cleanBody(input.appendBody)}`);
      if (input.topics !== undefined) note.topics = cleanTopics(input.topics);
      if (input.addTopics !== undefined) note.topics = cleanTopics([...note.topics, ...cleanTopics(input.addTopics)]);
      if (input.addSources !== undefined) note.sources = mergeSources(note.sources, cleanSources(input.addSources));
      if (input.addLinks !== undefined) note.links = [...new Set([...note.links, ...cleanLinks(input.addLinks)])].filter((l) => l !== note.id);
      note.confidence = parseConfidence(input.confidence) ?? note.confidence;
      note.volatility = parseVolatility(input.volatility) ?? note.volatility;
      note.kind = parseKind(input.kind) ?? note.kind;
      assertNoSecrets(note.title, note.summary, note.body, ...note.sources.map((s) => s.quote));
      note.updatedAt = new Date(this.now()).toISOString();
      await this.writeFileAtomic(join(this.root, row.path), serializeNote(note));
      return this.indexNote(note, row.path);
    });
    const embedded = await this.embedWithin(chunkIds, EMBED_ON_SAVE_MS);
    if (!embedded) this.backfillSoon();
    return { id: input.id, embedded };
  }

  /** Move a note out of the library into `.trash` (recoverable) and drop it from the index. */
  async forget(id: string, reason?: string): Promise<{ id: string; trashedTo: string }> {
    await this.ready();
    if (!isNoteId(id)) throw new ValidationError("id must be a note id");
    return this.withLock(async () => {
      const row = this.row(id);
      if (!row) throw new NotFoundError(id);
      const note = await this.readFromRow(row);
      const target = join(this.trashDir, `${id}.md`);
      await this.writeFileAtomic(target, serializeNote(note, { forgotten: { at: new Date(this.now()).toISOString(), reason: reason ?? "" } }));
      const { unlink } = await import("node:fs/promises");
      await unlink(join(this.root, row.path));
      this.dropCachedNote(id);
      removeNote(this.db, id);
      return { id, trashedTo: target };
    });
  }

  // ----------------------------------------------------------------- reading

  async outlineOf(id: string): Promise<{ note: Note; outline: OutlineEntry[] }> {
    const note = await this.getNote(id);
    return { note, outline: outline(note.body) };
  }

  sectionOf(note: Note, name: string): string | undefined {
    return section(note.body, name);
  }

  cardFor(id: string): Card | undefined {
    const row = this.row(id);
    return row ? this.toCard(rowToMeta(row)) : undefined;
  }

  metaFor(ids: readonly string[]): Map<string, NoteMeta> {
    const out = new Map<string, NoteMeta>();
    const unique = [...new Set(ids)].filter(isNoteId);
    for (let i = 0; i < unique.length; i += 200) {
      const slice = unique.slice(i, i + 200);
      for (const row of this.db.all<NoteRow>(`SELECT * FROM notes WHERE id IN (${placeholders(slice.length)})`, ...slice)) {
        out.set(row.id, rowToMeta(row));
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ search

  private filterSql(input: SearchInput): { where: string; params: SqlValue[] } {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (!input.includeSuperseded) clauses.push("n.superseded_by IS NULL");
    if (input.kinds?.length) {
      clauses.push(`n.kind IN (${placeholders(input.kinds.length)})`);
      params.push(...input.kinds);
    }
    if (input.runId) {
      clauses.push("n.run_id = ?");
      params.push(input.runId);
    }
    if (input.since) {
      const iso = parseSince(input.since, this.now());
      if (!iso) throw new ValidationError("since must be an ISO date or a window like 30d, 12h, 2w, 6m, 1y");
      clauses.push("n.updated_at >= ?");
      params.push(iso);
    }
    if (input.minConfidence) {
      const allowed = CONFIDENCE_LEVELS.filter((c) => confidenceRank(c) >= confidenceRank(input.minConfidence as Confidence));
      clauses.push(`n.confidence IN (${placeholders(allowed.length)})`);
      params.push(...allowed);
    }
    if (input.topics?.length) {
      const topics = cleanTopics(input.topics);
      const parts = topics.map(() => "EXISTS (SELECT 1 FROM note_topics t WHERE t.note_id = n.id AND (t.topic = ? OR t.topic LIKE ? ESCAPE '\\'))");
      clauses.push(`(${parts.join(" OR ")})`);
      for (const topic of topics) params.push(topic, `${escapeLike(topic)}/%`);
    }
    return { where: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
  }

  async search(input: SearchInput = {}): Promise<SearchResult> {
    await this.ready();
    const limit = clamp(Math.floor(input.limit ?? 8), 1, 25);
    const { where, params } = this.filterSql(input);
    const query = (input.query ?? "").trim();
    const mode = input.mode ?? "hybrid";
    const pending = this.pendingCount();

    if (!query) {
      const rows = this.db.all<NoteRow>(`SELECT n.* FROM notes n WHERE ${where} ORDER BY n.updated_at DESC LIMIT ?`, ...params, limit * 3);
      const cards = rows.map((r) => this.toCard(rowToMeta(r))).filter((c) => input.includeStale !== false || !c.stale);
      return { cards: cards.slice(0, limit), semantic: "off", pendingEmbeddings: pending };
    }

    const terms = queryTerms(query);
    const snippets = new Map<string, { text: string; idx: number }>();
    const lists: string[][] = [];
    let semantic: SemanticState = this.embedder ? "keyword-only" : "off";

    if (mode !== "semantic") {
      const keywordOrder = this.keywordSearch(query, where, params, snippets);
      if (keywordOrder.length) lists.push(keywordOrder);
    }
    if (mode !== "keyword" && this.embedder) {
      const outcome = await this.semanticSearch(query, where, params, snippets);
      if (outcome.state === "unavailable") semantic = "unavailable";
      else {
        semantic = "used";
        if (outcome.order.length) lists.push(outcome.order);
      }
    }
    if (mode === "semantic" && semantic !== "used" && lists.length === 0) {
      const fallback = this.keywordSearch(query, where, params, snippets);
      if (fallback.length) lists.push(fallback);
    }

    const fused = fuseRanks(lists);
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const metas = this.metaFor(ranked);
    const cards: Card[] = [];
    for (const id of ranked) {
      const meta = metas.get(id);
      if (!meta) continue;
      const hit = snippets.get(id);
      const score = (fused.get(id) ?? 0) * CONFIDENCE_WEIGHT[meta.confidence];
      const card = this.toCard(meta, { score: Math.round(score * 10_000) / 10_000 });
      if (hit && hit.idx > 0) card.snippet = snippet(hit.text, terms);
      cards.push(card);
    }
    cards.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const visible = cards.filter((c) => input.includeStale !== false || !c.stale).slice(0, limit);
    if (semantic === "used" || semantic === "keyword-only") this.backfillSoon();
    return { cards: visible, semantic, pendingEmbeddings: pending };
  }

  private keywordSearch(query: string, where: string, params: SqlValue[], snippets: Map<string, { text: string; idx: number }>): string[] {
    const match = buildFtsQuery(query);
    if (!match) return [];
    let rows: { chunk_id: number; note_id: string }[];
    try {
      rows = this.db.all(
        `SELECT fts.rowid AS chunk_id, fts.note_id AS note_id, bm25(fts, 0.0, 6.0, 3.0, 3.0, 1.5, 1.0) AS score
         FROM fts JOIN notes n ON n.id = fts.note_id
         WHERE fts MATCH ? AND ${where} ORDER BY score LIMIT 120`,
        match, ...params,
      );
    } catch (error) {
      this.log(`keyword search failed for ${JSON.stringify(match)}: ${String(error)}`);
      return [];
    }
    const order: string[] = [];
    const bestChunk = new Map<string, number>();
    for (const row of rows) {
      if (bestChunk.has(row.note_id)) continue;
      bestChunk.set(row.note_id, row.chunk_id);
      order.push(row.note_id);
    }
    const chunkIds = [...bestChunk.values()];
    if (chunkIds.length) {
      const byId = new Map(
        this.db
          .all<{ id: number; note_id: string; idx: number; text: string }>(
            `SELECT id, note_id, idx, text FROM chunks WHERE id IN (${placeholders(chunkIds.length)})`, ...chunkIds,
          )
          .map((c) => [c.id, c]),
      );
      for (const [noteId, chunkId] of bestChunk) {
        const chunk = byId.get(chunkId);
        if (chunk) snippets.set(noteId, { text: chunk.text, idx: chunk.idx });
      }
    }
    return order;
  }

  private async semanticSearch(
    query: string,
    where: string,
    params: SqlValue[],
    snippets: Map<string, { text: string; idx: number }>,
  ): Promise<{ state: "ok" | "unavailable"; order: string[] }> {
    const embedder = this.embedder;
    if (!embedder) return { state: "unavailable", order: [] };
    let queryVector: Float32Array | undefined;
    try {
      queryVector = (await embedder.embed([query], "query"))[0];
    } catch (error) {
      if (error instanceof EmbedUnavailableError) return { state: "unavailable", order: [] };
      throw error;
    }
    if (!queryVector) return { state: "unavailable", order: [] };
    this.ensureVectors();
    const allowed = new Set(this.db.all<{ id: string }>(`SELECT n.id AS id FROM notes n WHERE ${where}`, ...params).map((r) => r.id));
    const best = new Map<string, { score: number; chunkId: number }>();
    for (const [chunkId, cached] of this.vectors) {
      if (!allowed.has(cached.noteId)) continue;
      const score = cosine(queryVector, cached.vec);
      if (score < SEMANTIC_MIN_SCORE) continue;
      const current = best.get(cached.noteId);
      if (!current || score > current.score) best.set(cached.noteId, { score, chunkId });
    }
    const ordered = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 120);
    const missing = ordered.map(([, v]) => v.chunkId).filter((id) => true && id > 0);
    if (missing.length) {
      const rows = new Map(
        this.db
          .all<{ id: number; idx: number; text: string }>(`SELECT id, idx, text FROM chunks WHERE id IN (${placeholders(missing.length)})`, ...missing)
          .map((c) => [c.id, c]),
      );
      for (const [noteId, v] of ordered) {
        const chunk = rows.get(v.chunkId);
        if (chunk && !snippets.has(noteId)) snippets.set(noteId, { text: chunk.text, idx: chunk.idx });
      }
    }
    return { state: "ok", order: ordered.map(([id]) => id) };
  }

  async related(id: string, limit = 6): Promise<Card[]> {
    const note = await this.getNote(id);
    const linked = this.metaFor(note.links);
    const cards = [...linked.values()].map((m) => this.toCard(m));
    const found = await this.search({ query: `${note.title} ${note.summary}`, limit: limit + 1, includeStale: true });
    for (const card of found.cards) if (card.id !== id && !cards.some((c) => c.id === card.id)) cards.push(card);
    return cards.slice(0, limit);
  }

  private similarCards(id: string, limit: number): { id: string; title: string; score: number }[] {
    const ids = this.vectorsByNote.get(id);
    const first = ids?.map((cid) => this.vectors.get(cid)).find((v) => v?.idx === 0);
    if (!first) return [];
    const scored = new Map<string, number>();
    for (const cached of this.vectors.values()) {
      if (cached.noteId === id || cached.idx !== 0) continue;
      scored.set(cached.noteId, cosine(first.vec, cached.vec));
    }
    const top = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const metas = this.metaFor(top.map(([nid]) => nid));
    return top.flatMap(([nid, score]) => {
      const meta = metas.get(nid);
      return meta && !meta.supersededBy ? [{ id: nid, title: meta.title, score }] : [];
    });
  }

  // --------------------------------------------------------- topics and stale

  topics(prefix?: string, depth = 2): { topic: string; notes: number }[] {
    const base = prefix ? cleanTopics([prefix])[0] ?? "" : "";
    const baseDepth = base ? base.split("/").length : 0;
    const counts = new Map<string, Set<string>>();
    const rows = this.db.all<{ topic: string; note_id: string }>(
      "SELECT t.topic, t.note_id FROM note_topics t JOIN notes n ON n.id = t.note_id WHERE n.superseded_by IS NULL",
    );
    for (const { topic, note_id } of rows) {
      const parts = topic.split("/");
      for (let level = Math.max(1, baseDepth + 1); level <= Math.min(parts.length, baseDepth + depth); level++) {
        const ancestor = parts.slice(0, level).join("/");
        if (base && ancestor !== base && !ancestor.startsWith(`${base}/`)) continue;
        if (!counts.has(ancestor)) counts.set(ancestor, new Set());
        counts.get(ancestor)?.add(note_id);
      }
    }
    return [...counts.entries()].map(([topic, ids]) => ({ topic, notes: ids.size })).sort((a, b) => b.notes - a.notes || a.topic.localeCompare(b.topic));
  }

  staleNotes(options: { limit?: number; topics?: string[] } = {}): Card[] {
    const { where, params } = this.filterSql({ topics: options.topics });
    const rows = this.db.all<NoteRow>(`SELECT n.* FROM notes n WHERE ${where} AND n.volatility != 'stable'`, ...params);
    const now = this.now();
    return rows
      .map(rowToMeta)
      .filter((m) => isStale(m, this.stale, now))
      .map((m) => ({ card: this.toCard(m), over: ageDays(m.updatedAt, now) - this.stale[m.volatility as keyof StaleWindows] }))
      .sort((a, b) => b.over - a.over)
      .slice(0, clamp(options.limit ?? 20, 1, 100))
      .map((x) => x.card);
  }

  // -------------------------------------------------------------- embeddings

  pendingCount(): number {
    if (!this.embedder) return 0;
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL OR embed_fp IS NOT ?", this.embedder.fingerprint)?.n ?? 0;
  }

  private dropCachedNote(noteId: string): void {
    for (const cid of this.vectorsByNote.get(noteId) ?? []) this.vectors.delete(cid);
    this.vectorsByNote.delete(noteId);
  }

  private ensureVectors(): void {
    const embedder = this.embedder;
    if (!embedder) return;
    const version = this.db.get<{ data_version: number }>("PRAGMA data_version")?.data_version;
    if (this.vectorFp === embedder.fingerprint && this.vectorDataVersion === version) return;
    this.vectors.clear();
    this.vectorsByNote.clear();
    const rows = this.db.all<{ id: number; note_id: string; idx: number; embedding: Uint8Array }>(
      "SELECT id, note_id, idx, embedding FROM chunks WHERE embed_fp = ? AND embedding IS NOT NULL", embedder.fingerprint,
    );
    for (const row of rows) this.cacheVector(row.id, row.note_id, row.idx, toFloat32(row.embedding));
    this.vectorFp = embedder.fingerprint;
    this.vectorDataVersion = version;
  }

  private cacheVector(chunkId: number, noteId: string, idx: number, vec: Float32Array): void {
    this.vectors.set(chunkId, { noteId, idx, vec });
    const list = this.vectorsByNote.get(noteId);
    if (list) list.push(chunkId);
    else this.vectorsByNote.set(noteId, [chunkId]);
  }

  private embeddingText(row: { idx: number; heading: string; text: string; title: string }): string {
    const head = row.idx === 0 ? row.title : `${row.title}${row.heading ? ` — ${row.heading}` : ""}`;
    return `${head}\n${row.text}`.slice(0, 2000);
  }

  /** Embed the given chunk ids (or all pending ones when omitted). Returns how many were stored. */
  private async embedChunks(ids?: number[], limit = 64): Promise<number> {
    const embedder = this.embedder;
    if (!embedder) return 0;
    const base = `SELECT c.id, c.idx, c.heading, c.text, n.title FROM chunks c JOIN notes n ON n.id = c.note_id`;
    const rows = ids
      ? this.db.all<{ id: number; idx: number; heading: string; text: string; title: string }>(`${base} WHERE c.id IN (${placeholders(ids.length)})`, ...ids)
      : this.db.all<{ id: number; idx: number; heading: string; text: string; title: string }>(
          `${base} WHERE c.embedding IS NULL OR c.embed_fp IS NOT ? LIMIT ?`, embedder.fingerprint, limit,
        );
    if (rows.length === 0) return 0;
    const vectors = await embedder.embed(rows.map((r) => this.embeddingText(r)), "document");
    let stored = 0;
    this.ensureVectors();
    this.db.transaction(() => {
      rows.forEach((row, i) => {
        const vec = vectors[i];
        if (!vec) return;
        const changed = this.db.run("UPDATE chunks SET embedding = ?, embed_fp = ? WHERE id = ?", fromFloat32(vec), embedder.fingerprint, row.id);
        if (changed > 0) {
          const owner = this.db.get<{ note_id: string }>("SELECT note_id FROM chunks WHERE id = ?", row.id);
          if (owner) this.cacheVector(row.id, owner.note_id, row.idx, vec);
          stored++;
        }
      });
    });
    return stored;
  }

  private async embedWithin(ids: number[], ms: number): Promise<boolean> {
    if (!this.embedder || ids.length === 0) return !this.embedder;
    try {
      const done = await Promise.race([
        this.embedChunks(ids),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);
      return done !== null && done >= ids.length;
    } catch (error) {
      if (!(error instanceof EmbedUnavailableError)) this.log(`embedding failed: ${String(error)}`);
      return false;
    }
  }

  private async backfillNow(deadline: number): Promise<number> {
    let total = 0;
    try {
      while (this.now() < deadline) {
        const n = await this.embedChunks();
        if (n === 0) break;
        total += n;
      }
    } catch (error) {
      if (!(error instanceof EmbedUnavailableError)) this.log(`embedding backfill failed: ${String(error)}`);
    }
    return total;
  }

  /** Fire-and-forget: embed chunks that are still missing vectors, at most one run at a time. */
  private backfillSoon(): void {
    if (!this.embedder || this.backfilling || this.pendingCount() === 0) return;
    if (this.embedder.status().state === "cooldown") return;
    this.backfilling = this.backfillNow(this.now() + 20_000)
      .then(() => undefined)
      .finally(() => {
        this.backfilling = undefined;
      });
  }

  // -------------------------------------------------------------------- stats

  async stats(): Promise<LibraryStats> {
    await this.ready();
    const count = (sql: string) => this.db.get<{ n: number }>(sql)?.n ?? 0;
    const group = (column: string) =>
      Object.fromEntries(this.db.all<{ k: string; n: number }>(`SELECT ${column} AS k, COUNT(*) AS n FROM notes WHERE superseded_by IS NULL GROUP BY ${column}`).map((r) => [r.k, r.n]));
    return {
      path: this.root,
      notes: count("SELECT COUNT(*) AS n FROM notes WHERE superseded_by IS NULL"),
      superseded: count("SELECT COUNT(*) AS n FROM notes WHERE superseded_by IS NOT NULL"),
      chunks: count("SELECT COUNT(*) AS n FROM chunks"),
      byKind: group("kind"),
      byConfidence: group("confidence"),
      stale: this.staleNotes({ limit: 100 }).length,
      pendingEmbeddings: this.pendingCount(),
      embedding: { mode: this.embeddingMode, configured: this.embedder !== undefined, status: this.embedder?.status() },
      invalidFiles: this.invalidFiles.length,
    };
  }
}

export function mergeSources(existing: NoteSource[], added: NoteSource[]): NoteSource[] {
  const byUrl = new Map(existing.map((s) => [s.url, s]));
  for (const source of added) byUrl.set(source.url, { ...byUrl.get(source.url), ...source });
  return [...byUrl.values()];
}
