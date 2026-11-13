import {
  CONFIDENCE_LEVELS,
  MAX_SOURCES,
  NOTE_KINDS,
  VOLATILITY_LEVELS,
  isNoteId,
  type Confidence,
  type Note,
  type NoteKind,
  type NoteMeta,
  type NoteSource,
  type Volatility,
} from "./types.ts";

const FENCE = "---";

/** Notes are Markdown with a JSON front matter block (JSON is valid YAML, so other tools can read it too). */
export function serializeNote(note: Note, extra: Record<string, unknown> = {}): string {
  const { body, ...meta } = note;
  return `${FENCE}\n${JSON.stringify({ ...meta, ...extra }, null, 2)}\n${FENCE}\n\n${body.trim()}\n`;
}

export type ParseResult = { ok: true; note: Note } | { ok: false; reason: string };

export function parseNote(text: string): ParseResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) return { ok: false, reason: "missing front matter" };
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length + 1);
  const endAtEof = normalized.endsWith(`\n${FENCE}`) && end === -1;
  if (end === -1 && !endAtEof) return { ok: false, reason: "unterminated front matter" };
  const rawMeta = normalized.slice(FENCE.length + 1, end === -1 ? normalized.length - FENCE.length - 1 : end);
  const body = end === -1 ? "" : normalized.slice(end + FENCE.length + 2).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    return { ok: false, reason: "front matter is not valid JSON" };
  }
  const meta = normalizeMeta(parsed);
  if (!meta) return { ok: false, reason: "front matter is missing required fields" };
  return { ok: true, note: { ...meta, body } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

function normalizeSource(v: unknown): NoteSource | undefined {
  if (!isRecord(v)) return undefined;
  const url = asString(v.url);
  if (!url) return undefined;
  const source: NoteSource = { url };
  for (const key of ["title", "publishedAt", "accessedAt", "quote"] as const) {
    const value = asString(v[key]);
    if (value) source[key] = value;
  }
  return source;
}

export function normalizeMeta(v: unknown): NoteMeta | undefined {
  if (!isRecord(v)) return undefined;
  const id = v.id;
  const title = asString(v.title);
  const summary = asString(v.summary);
  const createdAt = asString(v.createdAt);
  if (!isNoteId(id) || !title || !summary || !createdAt) return undefined;
  const meta: NoteMeta = {
    id,
    title,
    kind: pick<NoteKind>(v.kind, NOTE_KINDS, "note"),
    summary,
    topics: Array.isArray(v.topics) ? v.topics.filter((t): t is string => typeof t === "string") : [],
    sources: (Array.isArray(v.sources) ? v.sources : [])
      .map(normalizeSource)
      .filter((s): s is NoteSource => s !== undefined)
      .slice(0, MAX_SOURCES),
    confidence: pick<Confidence>(v.confidence, CONFIDENCE_LEVELS, "unverified"),
    volatility: pick<Volatility>(v.volatility, VOLATILITY_LEVELS, "slow"),
    links: Array.isArray(v.links) ? v.links.filter(isNoteId) : [],
    createdAt,
    updatedAt: asString(v.updatedAt) ?? createdAt,
  };
  const runId = asString(v.runId);
  if (runId) meta.runId = runId;
  if (isNoteId(v.supersedes)) meta.supersedes = v.supersedes;
  if (isNoteId(v.supersededBy)) meta.supersededBy = v.supersededBy;
  return meta;
}
