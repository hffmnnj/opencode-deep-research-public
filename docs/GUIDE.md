# Usage guide

`hffmnnj.deep-research` gives your OpenCode agents a research workflow and a library that remembers. You do not run commands. You install it, ask real questions, and the agents decide when a question deserves a full investigation.

## 1. Install

Add the package to your `opencode.json` (global: `~/.config/opencode/opencode.json`, or per project):

```jsonc
{
  "plugins": ["hffmnnj.deep-research"]
}
```

OpenCode installs it on the next config load. Check it worked by asking your agent: "Show me the research library stats." It should call `tools.research.stats()` and report an empty library.

Works on Linux, macOS and Windows.

## 2. Use it

Just ask. Examples that trigger a full run:

- "Compare Postgres logical replication tools and tell me which to adopt for a 2 TB database."
- "What is the current evidence on GLP-1 drugs and cognitive decline? Where do studies disagree?"
- "Is library X still maintained, and what are the realistic alternatives?"

What happens, with no prompts to you:

1. The agent searches the library. If it already holds fresh, verified notes, it reuses them.
2. It decides how much effort the question deserves (Quick, Standard, Deep or Rigorous) and tells you in one line.
3. It saves a plan note, then launches parallel `deep-research/researcher` workers with bounded briefs. Each saves findings and sources to the library and returns only note ids.
4. A `deep-research/verifier` reopens the key sources when the tier calls for it.
5. The agent writes the report itself, cites notes as `[rn_...]`, runs an audit (unresolved, stale, unverified or disputed citations), fixes problems, and saves the final report.

Quick lookups stay quick: a repo question or a simple fact is answered with a library search and one read, without workers. Ask for a depth directly ("do a rigorous pass", "quick answer only") and that wins.

Runs never stop to ask you clarifying questions or approval. Assumptions are written into the plan note.

## 3. Use the library

The library is searchable by any agent through Code Mode:

```js
search({ namespace: "research" })                       // discover the tools
await tools.research.search({ query: "http3 adoption", since: "1y" })
await tools.research.read({ id: "rn_...", view: "outline" })
```

Useful things to ask your agent directly:

- "What do we already know about X?" (library search, no web)
- "Which research notes are stale? Refresh the ones that matter." (it can launch the `librarian`)
- "Merge duplicate notes about Y."
- "Forget the note about Z." (moves it to `.trash`; recoverable)

Notes are Markdown files in the library folder (see below). You can read, edit, sync or version them yourself; run `tools.research.reindex()` after manual edits.

## 4. Configure

All options are optional. Put them in the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "hffmnnj.deep-research",
      "options": {
        "libraryPath": "~/research-library",
        "models": { "researcher": "anthropic/claude-sonnet-5-5#high" },
        "embedding": { "mode": "auto" }
      }
    }
  ]
}
```

| Option | What it does |
| --- | --- |
| `libraryPath` | Where notes and the index live. Default `~/.local/share/opencode-deep-research/library` (macOS, Linux) or `%LOCALAPPDATA%\opencode-deep-research\library` (Windows). |
| `models.researcher` / `verifier` / `librarian` | Pin a model per worker as `provider/model#variant`. Unset workers inherit the session model. |
| `hint` | `true` (default). The short system hint that makes agents search the library first and start research on their own. Setting `false` makes the workflow opt-in. |
| `staleDays` | Freshness windows in days for `slow`, `fast`, `live` notes. |
| `embedding` | Semantic search backend, below. |

### Semantic search

| Mode | Use when |
| --- | --- |
| `auto` (default) | Uses your server if `embedding.server.url` is set, otherwise the built-in local model. |
| `local` | You want zero setup. EmbeddingGemma runs in-process on first use (a one-time model download). |
| `server` | You already run an OpenAI-compatible `/embeddings` endpoint (OpenAI, Ollama, LM Studio, vLLM, TEI). |
| `off` | Keyword search only. |

Server example (Ollama):

```jsonc
"embedding": {
  "mode": "server",
  "server": { "url": "http://127.0.0.1:11434", "model": "nomic-embed-text", "apiKey": "env://EMBED_API_KEY" }
}
```

`apiKey` accepts a literal, `env://NAME`, or `file://path`. Changing models is safe: old vectors are ignored until `tools.research.reindex()` re-embeds them. If the embedder is unreachable, search falls back to keywords and saves still succeed.

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Agents never mention the library | Check `hint` is not `false`, and that `search({ namespace: "research" })` lists 12 tools. |
| `semantic: "unavailable"` in search results | Embedder is down or still downloading. Run `tools.research.stats()` for the status and last error. Keyword search keeps working. |
| Local model fails to load | `@huggingface/transformers` is an optional dependency; install it in the plugin folder, or use `mode: "server"` or `"off"`. |
| Stale or missing results after editing note files | Run `tools.research.reindex()`. |
| Notes you want gone | Ask the agent to `forget` them (recoverable in `.trash`), or delete the file and reindex. |

The library refuses to store credentials, so an agent cannot save an API key into a note by accident.

## 6. Update and uninstall

Update: bump or remove a pinned version in `opencode.json` (for example `hffmnnj.deep-research@latest`) and reload. Your library is untouched by updates.

Uninstall: remove the entry from `plugins`. The library folder stays until you delete it.
