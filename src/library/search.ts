const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of", "on", "or",
  "the", "to", "was", "what", "when", "where", "which", "who", "why", "with",
]);

export function queryTerms(query: string): string[] {
  const all = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.+-]*/gu) ?? [];
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return [...new Set(meaningful.length > 0 ? meaningful : all)].slice(0, 16);
}

/** FTS5 expression: every term quoted (so operators in user text are inert), OR-joined, last term as a prefix. */
export function buildFtsQuery(query: string): string | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  return terms
    .map((term, i) => {
      const quoted = `"${term.replace(/"/g, '""')}"`;
      return i === terms.length - 1 && term.length >= 3 ? `${quoted}*` : quoted;
    })
    .join(" OR ");
}

/** Reciprocal rank fusion over ordered id lists; ids appearing in several lists accumulate score. */
export function fuseRanks(lists: readonly (readonly string[])[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

export function snippet(text: string, terms: readonly string[], max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (hit === -1 || at < hit)) hit = at;
  }
  const start = hit === -1 ? 0 : Math.max(0, hit - Math.floor(max / 4));
  const slice = flat.slice(start, start + max).trim();
  return `${start > 0 ? "…" : ""}${slice}${start + max < flat.length ? "…" : ""}`;
}

const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000, y: 31_536_000_000 };

/** Accepts an ISO date or a relative window such as `12h`, `30d`, `2w`, `6m`, `1y`. Returns an ISO timestamp. */
export function parseSince(value: string, now: number = Date.now()): string | undefined {
  const relative = /^(\d+)\s*([hdwmy])$/i.exec(value.trim());
  if (relative) return new Date(now - Number(relative[1]) * (UNITS[(relative[2] ?? "d").toLowerCase()] ?? 0)).toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);
