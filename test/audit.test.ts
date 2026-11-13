import { afterEach, beforeEach, expect, test } from "bun:test";
import { auditReport } from "../src/library/cite.ts";
import type { Library } from "../src/library/library.ts";
import { DEFAULT_STALE_DAYS } from "../src/library/types.ts";
import { openLibrary, tempDir } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let lib: Library;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  lib = await openLibrary(dir);
  await lib.ready();
});
afterEach(async () => {
  lib.close();
  await cleanup();
});

const source = [{ url: "https://example.com/p", title: "Paper", accessedAt: "2026-11-02T00:00:00Z" }];

test("audit_numbersCitationsInOrderOfFirstUseAndBuildsBibliography", async () => {
  const a = await lib.save({ title: "Alpha", summary: "Alpha claim.", sources: source, confidence: "verified" });
  const b = await lib.save({ title: "Beta", summary: "Beta claim.", sources: [{ url: "https://example.org/q" }], confidence: "verified" });
  const text = `Beta first [${b.id}], then alpha [${a.id}], beta again [${b.id}].`;
  const result = auditReport(lib, text, DEFAULT_STALE_DAYS);
  expect(result.numberedText).toBe("Beta first [1], then alpha [2], beta again [1].");
  expect(result.bibliography.split("\n")).toEqual([
    "[1] Beta. https://example.org/q",
    "[2] Alpha. Paper: https://example.com/p (accessed 2026-11-02)",
  ]);
  expect(result.findings).toEqual([]);
});

test("audit_flagsUnresolvedUnverifiedDisputedAndSupersededCitations", async () => {
  const unverified = await lib.save({ title: "Unchecked", summary: "Unchecked claim.", sources: source });
  const disputed = await lib.save({ title: "Contested", summary: "Contested claim.", sources: source, confidence: "disputed" });
  const old = await lib.save({ title: "Old", summary: "Old claim.", sources: source, confidence: "verified" });
  const next = await lib.save({ title: "New", summary: "New claim.", sources: source, confidence: "verified", supersedes: old.id });
  const ghost = "rn_000000000000";
  const text = [unverified.id, disputed.id, old.id, next.id, ghost].map((id) => `Claim [${id}].`).join(" ");
  const result = auditReport(lib, text, DEFAULT_STALE_DAYS);
  const problems = Object.fromEntries(result.findings.map((f) => [f.id, f.problem]));
  expect(problems).toEqual({
    [unverified.id]: "unverified",
    [disputed.id]: "disputed",
    [old.id]: "superseded",
    [ghost]: "unresolved",
  });
  expect(result.numberedText).toContain(`[${ghost}]`); // unresolved ids stay visible instead of becoming a fake number
});

test("audit_listsFactualParagraphsWithoutCitations", async () => {
  const a = await lib.save({ title: "Alpha", summary: "Alpha claim.", sources: source, confidence: "verified" });
  const text = [
    "# Report",
    `Revenue grew 40% in 2025 according to the filing, a figure the draft states plainly [${a.id}].`,
    "Adoption reached 12 million users across the three largest markets by the end of the same year, per analysts.",
  ].join("\n\n");
  const result = auditReport(lib, text, DEFAULT_STALE_DAYS);
  expect(result.uncitedParagraphs).toHaveLength(1);
  expect(result.uncitedParagraphs[0]).toContain("12 million users");
});
