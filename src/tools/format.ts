import type { Card } from "../library/library.ts";
import { approxTokens } from "../library/search.ts";

/**
 * Structured tool output must be a plain JSON value: OpenCode rejects the whole result if any field is undefined
 * (optional note fields such as runId) or a non-finite number. A JSON round-trip drops undefined keys and turns
 * undefined array items and NaN/Infinity into null, matching what callers would see over the wire.
 */
export function toJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function formatCard(card: Card): string {
  const flags = [card.stale ? "STALE" : "", card.confidence === "disputed" ? "DISPUTED" : "", card.superseded ? "SUPERSEDED" : ""].filter(Boolean);
  const head = `${card.id} ${card.kind}/${card.confidence} ${card.ageDays}d${flags.length ? ` [${flags.join(",")}]` : ""}  ${card.title}`;
  const lines = [head];
  if (card.topics.length) lines.push(`  topics: ${card.topics.join(", ")}`);
  lines.push(`  ${card.summary}`);
  if (card.snippet) lines.push(`  ↳ ${card.snippet}`);
  return lines.join("\n");
}

/** Fit cards into a rough token budget; returns the cards kept and the text. Always keeps at least one card. */
export function fitCards(cards: Card[], maxTokens: number): { kept: Card[]; text: string; omitted: number } {
  const kept: Card[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const card of cards) {
    const text = formatCard(card);
    const cost = approxTokens(text) + 1;
    if (kept.length > 0 && used + cost > maxTokens) break;
    kept.push(card);
    parts.push(text);
    used += cost;
  }
  return { kept, text: parts.join("\n"), omitted: cards.length - kept.length };
}

export function wrapUntrusted(attrs: Record<string, string | number>, text: string): string {
  const attributes = Object.entries(attrs)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`)
    .join(" ");
  return `<note ${attributes} untrusted="true">\n${text.replace(/<\/note/gi, "<\\/note")}\n</note>`;
}
