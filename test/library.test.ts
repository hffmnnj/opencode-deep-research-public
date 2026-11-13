import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "../src/library/library.ts";
import { parseNote, serializeNote } from "../src/library/note-file.ts";
import { FakeEmbedder, openLibrary, tempDir } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let lib: Library | undefined;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  lib?.close();
  lib = undefined;
  await cleanup();
});

const finding = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  summary: `Summary of ${title}.`,
  body: `## Evidence\n\nDetails about ${title} with a distinctive marker zebrafish-${title.length}.`,
  kind: "finding",
  topics: ["ai/agents"],
  sources: [{ url: "https://example.com/a", title: "Example", accessedAt: "2026-11-01T00:00:00Z" }],
  ...extra,
});

describe("keyword search", () => {
  test("save_thenSearchByBodyTerm_returnsCardWithSnippet", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Subagent budgets"));
    const result = await lib.search({ query: "zebrafish-16" });
    expect(result.cards.map((c) => c.id)).toEqual([saved.id]);
    expect(result.cards[0]?.snippet).toContain("zebrafish-16");
    expect(result.semantic).toBe("off");
  });

  test("emptyQuery_listsMostRecentFirst", async () => {
    let clock = Date.parse("2026-11-01T00:00:00Z");
    lib = await openLibrary(dir, { now: () => (clock += 60_000) });
    const first = await lib.save(finding("First"));
    const second = await lib.save(finding("Second"));
    const result = await lib.search({});
    expect(result.cards.map((c) => c.id)).toEqual([second.id, first.id]);
  });

  test("topicFilter_matchesPrefixButNotSiblingWithSameStart", async () => {
    lib = await openLibrary(dir);
    const inside = await lib.save(finding("Inside", { topics: ["ai/agents/research"] }));
    await lib.save(finding("Sibling", { topics: ["ai/agentsmith"] }));
    const result = await lib.search({ query: "zebrafish", topics: ["ai/agents"] });
    expect(result.cards.map((c) => c.id)).toEqual([inside.id]);
  });

  test("queryWithFtsOperators_isTreatedAsPlainText", async () => {
    lib = await openLibrary(dir);
    await lib.save(finding("Operators"));
    await expect(lib.search({ query: 'NEAR( " OR AND * ) -zebrafish' })).resolves.toBeDefined();
  });
});

describe("files are authoritative", () => {
  test("deletedIndex_isRebuiltFromNoteFilesOnReopen", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Durable note"));
    lib.close();
    await rm(join(dir, "library", "index.db"), { force: true });
    await rm(join(dir, "library", "index.db-wal"), { force: true });
    await rm(join(dir, "library", "index.db-shm"), { force: true });
    lib = await openLibrary(dir);
    const result = await lib.search({ query: "durable" });
    expect(result.cards.map((c) => c.id)).toEqual([saved.id]);
  });

  test("manualEditToNoteFile_isPickedUpByReindex", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Editable"));
    const file = saved.path;
    const parsed = parseNote(await readFile(file, "utf8"));
    if (!parsed.ok) throw new Error(parsed.reason);
    await writeFile(file, serializeNote({ ...parsed.note, body: "Now mentions the narwhal migration." }), "utf8");
    const report = await lib.reindex({ embed: false });
    expect(report.updated).toBe(1);
    expect((await lib.search({ query: "narwhal" })).cards.map((c) => c.id)).toEqual([saved.id]);
    expect((await lib.search({ query: "zebrafish" })).cards).toEqual([]);
  });

  test("bodyContainingFrontMatterFence_roundTripsIntact", async () => {
    lib = await openLibrary(dir);
    const body = "Intro\n\n---\n\nSecond block\n---\nstill body";
    const saved = await lib.save(finding("Fenced", { body }));
    expect((await lib.getNote(saved.id)).body).toBe(body);
  });

  test("unreadableNoteFile_isReportedNotIndexed", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Healthy"));
    const monthDir = saved.path.slice(0, saved.path.lastIndexOf("/"));
    await writeFile(join(monthDir, "rn_zzzzzzzzzzzz.md"), "no front matter here", "utf8");
    const report = await lib.reindex({ embed: false });
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]?.file).toContain("rn_zzzzzzzzzzzz.md");
    expect((await lib.stats()).notes).toBe(1);
  });
});

describe("write safeguards", () => {
  test("noteContainingApiKey_isRejectedAndNothingIsWritten", async () => {
    lib = await openLibrary(dir);
    const key = `sk-${"a1B2c3D4e5".repeat(3)}`;
    await expect(lib.save(finding("Leaky", { body: `token: ${key}` }))).rejects.toThrow(/credential/);
    expect((await lib.stats()).notes).toBe(0);
    expect(await readdir(join(dir, "library", "notes"), { recursive: true })).toEqual([]);
  });

  test("sourceUrlWithEmbeddedCredentials_isRejected", async () => {
    lib = await openLibrary(dir);
    await expect(lib.save(finding("Cred url", { sources: [{ url: "https://user:pw@example.com/x" }] }))).rejects.toThrow(/credentials/);
  });

  test("updateIntroducingSecret_isRejectedAndNoteUnchanged", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Clean"));
    await expect(lib.update({ id: saved.id, appendBody: "AKIAABCDEFGHIJKLMNOP" })).rejects.toThrow(/credential/);
    expect((await lib.getNote(saved.id)).body).not.toContain("AKIA");
  });

  test("sameTitleSavedTwice_flagsPossibleDuplicate", async () => {
    lib = await openLibrary(dir);
    const first = await lib.save(finding("Repeated title"));
    const second = await lib.save(finding("repeated TITLE"));
    expect(second.possibleDuplicates.map((d) => d.id)).toEqual([first.id]);
  });
});

describe("lifecycle", () => {
  test("supersededNote_isHiddenByDefaultAndPointsToSuccessor", async () => {
    lib = await openLibrary(dir);
    const old = await lib.save(finding("Old claim"));
    const next = await lib.save(finding("New claim", { supersedes: old.id }));
    expect((await lib.search({ query: "claim" })).cards.map((c) => c.id)).toEqual([next.id]);
    const all = await lib.search({ query: "claim", includeSuperseded: true });
    expect(all.cards.map((c) => c.id).sort()).toEqual([old.id, next.id].sort());
    expect((await lib.getNote(old.id)).supersededBy).toBe(next.id);
  });

  test("mergedNoteSupersedingSeveralDuplicates_hidesAllOfThem", async () => {
    lib = await openLibrary(dir);
    const a = await lib.save(finding("Dup A"));
    const b = await lib.save(finding("Dup B"));
    const merged = await lib.save(finding("Merged", { supersedes: [a.id, b.id] }));
    expect((await lib.search({ query: "zebrafish" })).cards.map((c) => c.id)).toEqual([merged.id]);
    expect((await lib.getNote(a.id)).supersededBy).toBe(merged.id);
    expect((await lib.getNote(b.id)).supersededBy).toBe(merged.id);
  });

  test("forget_movesFileToTrashAndRemovesFromSearch", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("Bad note"));
    const result = await lib.forget(saved.id, "wrong");
    expect((await lib.search({ query: "zebrafish" })).cards).toEqual([]);
    const trashed = parseNote(await readFile(result.trashedTo, "utf8"));
    expect(trashed.ok && trashed.note.id).toBe(saved.id);
    await expect(lib.getNote(saved.id)).rejects.toThrow(/No note/);
  });

  test("update_appendsBodyAndSetsConfidenceAndMergesSourcesByUrl", async () => {
    lib = await openLibrary(dir);
    const saved = await lib.save(finding("To verify"));
    await lib.update({
      id: saved.id,
      confidence: "verified",
      appendBody: "Verified against the primary source.",
      addSources: [{ url: "https://example.com/a", quote: "exact words" }, { url: "https://example.org/b" }],
    });
    const note = await lib.getNote(saved.id);
    expect(note.confidence).toBe("verified");
    expect(note.body).toEndWith("Verified against the primary source.");
    expect(note.sources.map((s) => s.url).sort()).toEqual(["https://example.com/a", "https://example.org/b"]);
    expect(note.sources.find((s) => s.url === "https://example.com/a")?.quote).toBe("exact words");
  });

  test("fastVolatilityNoteOlderThanWindow_isStaleAndFilterable", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    lib = await openLibrary(dir, { now: () => clock });
    const fast = await lib.save(finding("Fast moving", { volatility: "fast" }));
    const stable = await lib.save(finding("Timeless", { volatility: "stable" }));
    clock += 31 * 86_400_000;
    const all = await lib.search({ query: "zebrafish" });
    expect(all.cards.find((c) => c.id === fast.id)?.stale).toBe(true);
    expect(all.cards.find((c) => c.id === stable.id)?.stale).toBe(false);
    const fresh = await lib.search({ query: "zebrafish", includeStale: false });
    expect(fresh.cards.map((c) => c.id)).toEqual([stable.id]);
    expect(lib.staleNotes().map((c) => c.id)).toEqual([fast.id]);
  });
});

describe("semantic search", () => {
  test("synonymQuery_findsNoteThatSharesNoKeywords", async () => {
    const embedder = new FakeEmbedder();
    lib = await openLibrary(dir, { embedder });
    const car = await lib.save({ title: "Engine maintenance", summary: "How to service a car engine.", body: "Change the oil in your car." });
    await lib.save({ title: "Pet care", summary: "Feeding a cat.", body: "Cats need protein." });
    const keywordOnly = await lib.search({ query: "automobile", mode: "keyword" });
    expect(keywordOnly.cards).toEqual([]);
    const hybrid = await lib.search({ query: "automobile" });
    expect(hybrid.semantic).toBe("used");
    expect(hybrid.cards[0]?.id).toBe(car.id);
  });

  test("embedderDown_saveSucceedsKeywordStillWorksAndReindexBackfills", async () => {
    const embedder = new FakeEmbedder();
    embedder.down = true;
    lib = await openLibrary(dir, { embedder });
    const saved = await lib.save({ title: "Offline save", summary: "Written while embeddings are down about a car.", body: "car details" });
    expect(saved.embedded).toBe(false);
    const during = await lib.search({ query: "offline" });
    expect(during.cards[0]?.id).toBe(saved.id);
    expect(during.semantic).toBe("unavailable");
    expect(during.pendingEmbeddings).toBeGreaterThan(0);

    embedder.down = false;
    const report = await lib.reindex();
    expect(report.pendingEmbeddings).toBe(0);
    const after = await lib.search({ query: "automobile" });
    expect(after.semantic).toBe("used");
    expect(after.cards[0]?.id).toBe(saved.id);
  });

  test("changedEmbeddingModel_ignoresOldVectorsUntilReembedded", async () => {
    const v1 = new FakeEmbedder("v1");
    lib = await openLibrary(dir, { embedder: v1 });
    const saved = await lib.save({ title: "Vehicle note", summary: "About a vehicle.", body: "vehicle" });
    lib.close();
    const v2 = new FakeEmbedder("v2");
    lib = await openLibrary(dir, { embedder: v2 });
    expect((await lib.stats()).pendingEmbeddings).toBeGreaterThan(0);
    const report = await lib.reindex();
    expect(report.pendingEmbeddings).toBe(0);
    expect((await lib.search({ query: "automobile" })).cards[0]?.id).toBe(saved.id);
  });
});
