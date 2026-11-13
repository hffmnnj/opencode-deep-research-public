import type { Chunk } from "./chunk.ts";
import type { Db } from "./sqlite.ts";
import type { NoteMeta } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface NoteRow {
  id: string;
  path: string;
  title: string;
  kind: string;
  summary: string;
  topics: string;
  confidence: string;
  volatility: string;
  run_id: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  mtime_ms: number;
  size: number;
  body_chars: number;
  links: string;
  sources: string;
}

export function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      topics TEXT NOT NULL,
      confidence TEXT NOT NULL,
      volatility TEXT NOT NULL,
      run_id TEXT,
      supersedes TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      body_chars INTEGER NOT NULL,
      links TEXT NOT NULL,
      sources TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_run ON notes(run_id);
    CREATE INDEX IF NOT EXISTS notes_kind ON notes(kind);
    CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated_at);
    CREATE TABLE IF NOT EXISTS note_topics (
      note_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      PRIMARY KEY (note_id, topic)
    );
    CREATE INDEX IF NOT EXISTS note_topics_topic ON note_topics(topic);
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      heading TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      embed_fp TEXT
    );
    CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      note_id UNINDEXED, title, topics, summary, heading, text,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
  `);
  const existing = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (!existing) db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
}

export interface FileInfo {
  path: string;
  mtimeMs: number;
  size: number;
}

export function removeNote(db: Db, id: string): void {
  db.run("DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)", id);
  db.run("DELETE FROM chunks WHERE note_id = ?", id);
  db.run("DELETE FROM note_topics WHERE note_id = ?", id);
  db.run("DELETE FROM notes WHERE id = ?", id);
}

/** Replace a note's row, topics, chunks and FTS rows. Chunk 0 is the "card" (summary); body chunks follow. */
export function upsertNote(db: Db, meta: NoteMeta, bodyChunks: Chunk[], bodyChars: number, file: FileInfo): number[] {
  return db.transaction(() => {
    removeNote(db, meta.id);
    db.run(
      `INSERT INTO notes (id, path, title, kind, summary, topics, confidence, volatility, run_id, supersedes, superseded_by,
         created_at, updated_at, mtime_ms, size, body_chars, links, sources)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.id, file.path, meta.title, meta.kind, meta.summary, JSON.stringify(meta.topics), meta.confidence, meta.volatility,
      meta.runId ?? null, meta.supersedes ?? null, meta.supersededBy ?? null, meta.createdAt, meta.updatedAt,
      file.mtimeMs, file.size, bodyChars, JSON.stringify(meta.links), JSON.stringify(meta.sources),
    );
    for (const topic of meta.topics) db.run("INSERT OR IGNORE INTO note_topics (note_id, topic) VALUES (?, ?)", meta.id, topic);

    const topics = meta.topics.join(" ");
    const all: Chunk[] = [{ idx: 0, heading: "", text: meta.summary }, ...bodyChunks.map((c) => ({ ...c, idx: c.idx + 1 }))];
    const ids: number[] = [];
    for (const chunk of all) {
      db.run("INSERT INTO chunks (note_id, idx, heading, text) VALUES (?, ?, ?, ?)", meta.id, chunk.idx, chunk.heading, chunk.text);
      const row = db.get<{ id: number }>("SELECT last_insert_rowid() AS id");
      const chunkId = row?.id ?? 0;
      ids.push(chunkId);
      db.run(
        "INSERT INTO fts (rowid, note_id, title, topics, summary, heading, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        chunkId, meta.id, meta.title, topics, chunk.idx === 0 ? meta.summary : "", chunk.heading, chunk.idx === 0 ? "" : chunk.text,
      );
    }
    return ids;
  });
}

export function rowToMeta(row: NoteRow): NoteMeta {
  const meta: NoteMeta = {
    id: row.id,
    title: row.title,
    kind: row.kind as NoteMeta["kind"],
    summary: row.summary,
    topics: JSON.parse(row.topics) as string[],
    sources: JSON.parse(row.sources) as NoteMeta["sources"],
    confidence: row.confidence as NoteMeta["confidence"],
    volatility: row.volatility as NoteMeta["volatility"],
    links: JSON.parse(row.links) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.run_id) meta.runId = row.run_id;
  if (row.supersedes) meta.supersedes = row.supersedes;
  if (row.superseded_by) meta.supersededBy = row.superseded_by;
  return meta;
}
