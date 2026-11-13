import {
  CONFIDENCE_LEVELS,
  MAX_BODY_CHARS,
  MAX_SOURCES,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  MAX_TOPICS,
  NOTE_KINDS,
  VOLATILITY_LEVELS,
  isNoteId,
  type Confidence,
  type NoteKind,
  type NoteSource,
  type Volatility,
} from "./types.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["API key (sk-…)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer credential", /authorization:\s*bearer\s+[A-Za-z0-9._~+/-]{20,}/i],
];

export function findSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function assertNoSecrets(...texts: (string | undefined)[]): void {
  for (const text of texts) {
    const hit = text ? findSecret(text) : undefined;
    if (hit) throw new ValidationError(`Refusing to store this: it looks like a credential (${hit}). Remove it and retry.`);
  }
}

export function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title) throw new ValidationError("title is required");
  if (title.length > MAX_TITLE_CHARS) throw new ValidationError(`title must be at most ${MAX_TITLE_CHARS} characters`);
  return title;
}

export function cleanSummary(value: unknown): string {
  const summary = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!summary) throw new ValidationError("summary is required: one or two self-contained sentences");
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new ValidationError(`summary must be at most ${MAX_SUMMARY_CHARS} characters; put detail in body`);
  }
  return summary;
}

export function cleanBody(value: unknown): string {
  const body = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (body.length > MAX_BODY_CHARS) {
    throw new ValidationError(`body must be at most ${MAX_BODY_CHARS} characters; split it into linked notes`);
  }
  return body;
}

/** Topics are lowercase `a/b/c` slugs. */
export function cleanTopics(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("topics must be an array of strings");
  const topics = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new ValidationError("topics must be an array of strings");
    const topic = raw
      .toLowerCase()
      .split("/")
      .map((part) => part.trim().replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean)
      .join("/");
    if (topic) topics.add(topic);
  }
  if (topics.size > MAX_TOPICS) throw new ValidationError(`at most ${MAX_TOPICS} topics per note`);
  return [...topics];
}

export function cleanSources(value: unknown): NoteSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("sources must be an array");
  if (value.length > MAX_SOURCES) throw new ValidationError(`at most ${MAX_SOURCES} sources per note`);
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new ValidationError(`sources[${i}] must be an object`);
    const record = entry as Record<string, unknown>;
    const rawUrl = typeof record.url === "string" ? record.url.trim() : "";
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ValidationError(`sources[${i}].url must be an absolute http(s) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError(`sources[${i}].url must be http(s)`);
    if (url.username || url.password) throw new ValidationError(`sources[${i}].url must not embed credentials`);
    const source: NoteSource = { url: url.toString() };
    for (const key of ["title", "publishedAt", "accessedAt", "quote"] as const) {
      const v = record[key];
      if (typeof v === "string" && v.trim()) source[key] = v.trim().slice(0, key === "quote" ? 600 : 300);
    }
    return source;
  });
}

export function cleanLinks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isNoteId)) throw new ValidationError("links must be an array of note ids (rn_…)");
  return [...new Set(value)];
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${label} must be one of: ${allowed.join(", ")}`);
}

export const parseKind = (v: unknown): NoteKind | undefined => oneOf(v, NOTE_KINDS, "kind");
export const parseConfidence = (v: unknown): Confidence | undefined => oneOf(v, CONFIDENCE_LEVELS, "confidence");
export const parseVolatility = (v: unknown): Volatility | undefined => oneOf(v, VOLATILITY_LEVELS, "volatility");

export function cleanRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{3,64}$/.test(value)) {
    throw new ValidationError("runId must be 3-64 characters of letters, digits, '_', '.', '-'");
  }
  return value;
}
