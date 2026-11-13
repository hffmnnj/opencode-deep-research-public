/** Minimal synchronous SQLite surface shared by `bun:sqlite` (OpenCode's runtime) and `node:sqlite` (tests, tooling). */
export interface Db {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined;
  /** Returns the number of rows changed. */
  run(sql: string, ...params: SqlValue[]): number;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type SqlValue = string | number | bigint | null | Uint8Array;

interface Statement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): unknown;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function wrap(raw: RawDb): Db {
  let depth = 0;
  return {
    exec: (sql) => raw.exec(sql),
    all: <T>(sql: string, ...params: SqlValue[]) => raw.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: SqlValue[]) => (raw.prepare(sql).get(...params) ?? undefined) as T | undefined,
    run: (sql, ...params) => Number((raw.prepare(sql).run(...params) as { changes?: number | bigint } | undefined)?.changes ?? 0),
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

export async function openDb(path: string): Promise<Db> {
  let raw: RawDb;
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    raw = new Database(path, { create: true }) as unknown as RawDb;
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    raw = new DatabaseSync(path) as unknown as RawDb;
  }
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA synchronous = NORMAL");
  return wrap(raw);
}

export function toFloat32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export function fromFloat32(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
