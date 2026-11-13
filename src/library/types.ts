export const NOTE_KINDS = ["finding", "source", "report", "plan", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const CONFIDENCE_LEVELS = ["disputed", "unverified", "checked", "verified"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const VOLATILITY_LEVELS = ["stable", "slow", "fast", "live"] as const;
export type Volatility = (typeof VOLATILITY_LEVELS)[number];

export interface NoteSource {
  url: string;
  title?: string;
  publishedAt?: string;
  accessedAt?: string;
  quote?: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  kind: NoteKind;
  summary: string;
  topics: string[];
  sources: NoteSource[];
  confidence: Confidence;
  volatility: Volatility;
  runId?: string;
  links: string[];
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Note extends NoteMeta {
  body: string;
}

export interface StaleWindows {
  slow: number;
  fast: number;
  live: number;
}

export const DEFAULT_STALE_DAYS: StaleWindows = { slow: 180, fast: 30, live: 3 };

export const MAX_BODY_CHARS = 100_000;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_TITLE_CHARS = 200;
export const MAX_TOPICS = 12;
export const MAX_SOURCES = 50;

const NOTE_ID = /^rn_[0-9a-z]{12}$/;
export const NOTE_ID_GLOBAL = /\[(rn_[0-9a-z]{12})\]/g;

export const isNoteId = (value: unknown): value is string => typeof value === "string" && NOTE_ID.test(value);

export function newNoteId(now: number = Date.now(), random: () => number = Math.random): string {
  const time = now.toString(36).padStart(8, "0").slice(-8);
  let tail = "";
  while (tail.length < 4) tail += Math.floor(random() * 36).toString(36);
  return `rn_${time}${tail}`;
}

export function ageDays(updatedAt: string, now: number = Date.now()): number {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : 0;
}

export function isStale(meta: Pick<NoteMeta, "volatility" | "updatedAt">, windows: StaleWindows, now: number = Date.now()): boolean {
  if (meta.volatility === "stable") return false;
  return ageDays(meta.updatedAt, now) > windows[meta.volatility];
}

export const confidenceRank = (c: Confidence): number => CONFIDENCE_LEVELS.indexOf(c);
