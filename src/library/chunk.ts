export interface Chunk {
  idx: number;
  heading: string;
  text: string;
}

const TARGET_CHARS = 900;
const MAX_CHARS = 1400;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export interface OutlineEntry {
  heading: string;
  level: number;
  start: number;
  chars: number;
}

/** Heading outline of a Markdown body, with character offsets so a section can be read on its own. */
export function outline(body: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) entries.push({ heading: match[2] ?? "", level: (match[1] ?? "#").length, start: offset, chars: 0 });
    offset += line.length + 1;
  }
  entries.forEach((entry, i) => {
    const next = entries[i + 1];
    entry.chars = (next ? next.start : body.length) - entry.start;
  });
  return entries;
}

/** Text of the first section whose heading contains `name` (case-insensitive), including its sub-sections. */
export function section(body: string, name: string): string | undefined {
  const entries = outline(body);
  const needle = name.trim().toLowerCase();
  const index = entries.findIndex((e) => e.heading.toLowerCase().includes(needle));
  const hit = entries[index];
  if (!hit) return undefined;
  let end = body.length;
  for (const next of entries.slice(index + 1)) {
    if (next.level <= hit.level) {
      end = next.start;
      break;
    }
  }
  return body.slice(hit.start, end).trim();
}

/** Split a body into retrieval chunks: heading-aware, paragraph-packed, never splitting inside a code fence. */
export function chunkBody(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headingStack: string[] = [];
  let heading = "";
  let buffer: string[] = [];
  let size = 0;
  let inFence = false;

  const flush = () => {
    const text = buffer.join("\n\n").trim();
    buffer = [];
    size = 0;
    if (text) chunks.push({ idx: chunks.length, heading, text });
  };

  for (const block of body.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const fenceCount = (trimmed.match(/^\s*```/gm) ?? []).length;
    const wasInFence = inFence;
    if (fenceCount % 2 === 1) inFence = !inFence;
    const match = wasInFence ? null : HEADING.exec(trimmed.split("\n")[0] ?? "");
    if (match) {
      flush();
      const level = (match[1] ?? "#").length;
      headingStack.length = level - 1;
      headingStack[level - 1] = match[2] ?? "";
      heading = headingStack.filter(Boolean).join(" > ");
    }
    if (size + trimmed.length > MAX_CHARS && size > 0) flush();
    if (trimmed.length > MAX_CHARS) {
      flush();
      for (const piece of splitLong(trimmed)) chunks.push({ idx: chunks.length, heading, text: piece });
      continue;
    }
    buffer.push(trimmed);
    size += trimmed.length;
    if (size >= TARGET_CHARS) flush();
  }
  flush();
  return chunks;
}

function splitLong(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(". ", MAX_CHARS);
    if (cut < TARGET_CHARS / 2) cut = rest.lastIndexOf(" ", MAX_CHARS);
    if (cut < TARGET_CHARS / 2) cut = MAX_CHARS;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
