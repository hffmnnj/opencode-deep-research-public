import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import plugin from "../src/index.ts";
import { tempDir } from "./helpers.ts";

type Added = { name: string; options?: { namespace?: string; codemode?: boolean }; execute: (input: unknown) => Promise<{ content?: string; output?: Record<string, unknown> }> };

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(() => cleanup());

function fakeContext(options: Record<string, unknown>) {
  const tools: Added[] = [];
  const namespaces: { name: string }[] = [];
  const skills: { id: string; path: string; content: string }[] = [];
  const agents = new Map<string, Record<string, unknown>>();
  const hooks: string[] = [];
  const systemParts: { type: string; text: string }[] = [];
  const ctx = {
    options,
    tool: { transform: async (cb: (e: unknown) => void) => cb({ namespace: (n: { name: string }) => namespaces.push(n), add: (t: Added) => tools.push(t) }) },
    skill: { transform: async (cb: (e: unknown) => void) => cb({ add: (s: (typeof skills)[number]) => skills.push(s) }) },
    agent: {
      transform: async (cb: (e: unknown) => void) =>
        cb({
          get: (id: string) => agents.get(id),
          update: (id: string, fn: (a: Record<string, unknown>) => void) => {
            const agent = agents.get(id) ?? {};
            fn(agent);
            agents.set(id, agent);
          },
        }),
    },
    session: {
      hook: async (name: string, cb: (event: { system: typeof systemParts }) => void) => {
        hooks.push(name);
        cb({ system: systemParts });
      },
    },
  };
  return { ctx, tools, namespaces, skills, agents, hooks, systemParts };
}

const setup = (ctx: unknown) => (plugin as unknown as { setup: (c: unknown) => Promise<(() => void) | void> }).setup(ctx);

test("setup_registersEveryLibraryToolInCodeModeOnlyUnderResearchNamespace", async () => {
  const f = fakeContext({ libraryPath: join(dir, "lib"), embedding: { mode: "off" } });
  const cleanupPlugin = await setup(f.ctx);
  expect(f.namespaces.map((n) => n.name)).toEqual(["research"]);
  expect(f.tools.map((t) => t.name).sort()).toEqual(
    ["audit", "cite", "forget", "read", "reindex", "related", "save", "search", "stale", "stats", "topics", "update"].sort(),
  );
  for (const tool of f.tools) expect(tool.options).toEqual({ namespace: "research", codemode: true });
  if (cleanupPlugin) cleanupPlugin();
});

test("setup_bundlesSkillAgentsCommandsAndStaticHint", async () => {
  const f = fakeContext({ libraryPath: join(dir, "lib"), embedding: { mode: "off" }, models: { researcher: "muse/model-x#high" } });
  const cleanupPlugin = await setup(f.ctx);
  expect(f.skills.map((s) => s.id)).toEqual(["deep-research"]);
  expect(f.skills[0]?.path.replaceAll("\\", "/")).toEndWith("content/skills/deep-research/SKILL.md");
  expect(f.skills[0]?.content).not.toStartWith("---");
  expect([...f.agents.keys()].sort()).toEqual(["deep-research/librarian", "deep-research/researcher", "deep-research/verifier"]);
  const researcher = f.agents.get("deep-research/researcher");
  expect(researcher?.model).toEqual({ providerID: "muse", id: "model-x", variant: "high" });
  expect(f.agents.get("deep-research/verifier")?.model).toBeUndefined();
  expect(researcher?.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  // Agent-first: the fake context has no `command` domain, so setup would throw if it registered slash commands.
  expect(researcher?.steps).toBeUndefined(); // Rigorous research is uncapped
  expect(f.agents.get("deep-research/verifier")?.steps).toBeGreaterThanOrEqual(100);
  expect(f.hooks).toEqual(["context"]);
  expect(f.systemParts[0]?.text).toContain("tools.research");
  expect(f.systemParts[0]?.text).toContain("without waiting to be asked");
  if (cleanupPlugin) cleanupPlugin();
});

test("hintOption_false_registersNoContextHook", async () => {
  const f = fakeContext({ libraryPath: join(dir, "lib"), embedding: { mode: "off" }, hint: false });
  const cleanupPlugin = await setup(f.ctx);
  expect(f.hooks).toEqual([]);
  if (cleanupPlugin) cleanupPlugin();
});

test("registeredTools_saveThenSearchThenAuditEndToEnd", async () => {
  const f = fakeContext({ libraryPath: join(dir, "lib"), embedding: { mode: "off" } });
  const cleanupPlugin = await setup(f.ctx);
  const call = (name: string, input: unknown) => f.tools.find((t) => t.name === name)!.execute(input);
  const saved = await call("save", {
    title: "Hybrid retrieval beats keyword-only",
    summary: "Fusing BM25 with embeddings improves recall on paraphrased queries.",
    body: "## Evidence\n\nReciprocal rank fusion is a simple, robust combiner.",
    kind: "finding",
    topics: ["ai/retrieval"],
    sources: [{ url: "https://example.com/rrf" }],
  });
  const id = saved.output?.id as string;
  expect(id).toMatch(/^rn_[0-9a-z]{12}$/);
  const found = await call("search", { query: "reciprocal rank fusion" });
  expect(found.content).toContain(id);
  expect(found.content).toContain("Fusing BM25");
  const read = await call("read", { id, view: "outline" });
  expect(read.content).toContain("Evidence");
  expect(read.content).toContain('untrusted="true"');
  const audit = await call("audit", { text: `Fusion helps recall [${id}].` });
  expect(audit.output?.numberedText).toBe("Fusion helps recall [1].");
  await expect(call("save", { title: "x", summary: "bad id link", links: ["nope"] })).rejects.toThrow(/note ids/);
  if (cleanupPlugin) cleanupPlugin();
});
