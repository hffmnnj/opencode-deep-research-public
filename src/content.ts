import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

export const contentPath = (...parts: string[]): string => join(CONTENT_DIR, ...parts);

export const readContent = (...parts: string[]): string => readFileSync(contentPath(...parts), "utf8");

export interface FrontMatter {
  meta: Record<string, string>;
  body: string;
}

/** Flat `key: value` front matter only; that is all the bundled skill needs. */
export function splitFrontMatter(markdown: string): FrontMatter {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) meta[match[1] ?? ""] = (match[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(end + 5).trim() };
}
