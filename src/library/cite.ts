import type { Library } from "./library.ts";
import { NOTE_ID_GLOBAL, ageDays, isStale, type NoteMeta, type NoteSource, type StaleWindows } from "./types.ts";

export interface CitationEntry {
  n: number;
  id: string;
  title: string;
  confidence: NoteMeta["confidence"];
  ageDays: number;
  stale: boolean;
  sources: Pick<NoteSource, "url" | "title" | "publishedAt" | "accessedAt">[];
}

export interface Bibliography {
  entries: CitationEntry[];
  missing: string[];
  text: string;
}

export function bibliography(library: Library, ids: readonly string[], windows: StaleWindows, now: number = Date.now()): Bibliography {
  const unique = [...new Set(ids)];
  const metas = library.metaFor(unique);
  const entries: CitationEntry[] = [];
  const missing: string[] = [];
  for (const id of unique) {
    const meta = metas.get(id);
    if (!meta) {
      missing.push(id);
      continue;
    }
    entries.push({
      n: entries.length + 1,
      id,
      title: meta.title,
      confidence: meta.confidence,
      ageDays: ageDays(meta.updatedAt, now),
      stale: isStale(meta, windows, now),
      sources: meta.sources.map(({ url, title, publishedAt, accessedAt }) => ({ url, title, publishedAt, accessedAt })),
    });
  }
  const lines = entries.map((e) => {
    const sources = e.sources.length
      ? e.sources.map((s) => `${s.title ? `${s.title}: ` : ""}${s.url}${s.accessedAt ? ` (accessed ${s.accessedAt.slice(0, 10)})` : ""}`).join("; ")
      : "no external source recorded";
    return `[${e.n}] ${e.title}. ${sources}`;
  });
  return { entries, missing, text: lines.join("\n") };
}

export interface AuditFinding {
  id: string;
  problem: "unresolved" | "superseded" | "disputed" | "unverified" | "stale" | "no-source";
  detail: string;
}

export interface AuditResult {
  citations: number;
  findings: AuditFinding[];
  uncitedParagraphs: string[];
  numberedText: string;
  bibliography: string;
  entries: CitationEntry[];
}

const FACTUAL_HINT = /\d|%|\b(?:according to|reported|found|showed|study|survey|percent|million|billion)\b/i;

/**
 * Check a draft report that cites notes as `[rn_xxxxxxxxxxxx]`: resolve every id, flag weak evidence, find
 * paragraphs that make factual-looking claims without a citation, and emit a numbered version for the reader.
 */
export function auditReport(library: Library, text: string, windows: StaleWindows, now: number = Date.now()): AuditResult {
  const ids = [...text.matchAll(NOTE_ID_GLOBAL)].map((m) => m[1] ?? "");
  const unique = [...new Set(ids)];
  const metas = library.metaFor(unique);
  const numbering = new Map<string, number>();
  for (const id of unique) if (metas.has(id)) numbering.set(id, numbering.size + 1);

  const findings: AuditFinding[] = [];
  for (const id of unique) {
    const meta = metas.get(id);
    if (!meta) {
      findings.push({ id, problem: "unresolved", detail: "No such note in the library. Fix the id or remove the claim." });
      continue;
    }
    if (meta.supersededBy) findings.push({ id, problem: "superseded", detail: `Replaced by ${meta.supersededBy}; cite the newer note.` });
    if (meta.confidence === "disputed") findings.push({ id, problem: "disputed", detail: "Marked disputed; present it as contested or drop it." });
    if (meta.confidence === "unverified") findings.push({ id, problem: "unverified", detail: "Not independently checked; verify it or label it unverified in the report." });
    if (isStale(meta, windows, now)) findings.push({ id, problem: "stale", detail: `Last updated ${ageDays(meta.updatedAt, now)} days ago (${meta.volatility}); refresh if it drives a conclusion.` });
    if (meta.sources.length === 0 && meta.kind !== "report" && meta.kind !== "plan") {
      findings.push({ id, problem: "no-source", detail: "Note has no recorded source URL." });
    }
  }

  const uncitedParagraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 80 && !p.startsWith("#") && !/\[rn_[0-9a-z]{12}\]/.test(p) && FACTUAL_HINT.test(p))
    .slice(0, 10)
    .map((p) => (p.length > 160 ? `${p.slice(0, 157)}…` : p));

  const numberedText = text.replace(NOTE_ID_GLOBAL, (whole, id: string) => {
    const n = numbering.get(id);
    return n === undefined ? whole : `[${n}]`;
  });
  const bib = bibliography(library, [...numbering.keys()], windows, now);
  return { citations: unique.length, findings, uncitedParagraphs, numberedText, bibliography: bib.text, entries: bib.entries };
}
