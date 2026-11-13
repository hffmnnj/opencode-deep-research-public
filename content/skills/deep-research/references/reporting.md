# Reporting

## Answer first

Open with the answer or decision and the one or two facts that carry it. State scope
and date limits that change the answer. Match length to the request: a quick question
gets a short answer, a broad investigation gets a structured report.

## Cite notes locally

Cite with the note id in square brackets, next to the claim: `[rn_xxxxxxxxxxxx]`.
Place citations at the end of the sentence or clause they support, not in a pile at
the end of the document. A comparison table needs a citation per row or cell when
sources differ. Never cite a note you did not read, and never invent an id. For a
quick answer with no saved note, cite the source URL directly and say it was not
saved.

The bibliography is generated, not hand-written. After drafting, call:

```js
const check = await tools.research.audit({ text: draft })
const refs = await tools.research.cite({ ids: ["rn_xxxxxxxxxxxx"] })
```

`audit` returns unresolved ids and flags unverified, disputed, or stale notes. Fix
the draft or the notes, then rerun. Do not ship a citation that `audit` cannot
resolve. If a note is stale but still the best evidence, say so in the text.

## Conflicts and limits

Explain disagreement instead of hiding it. Name the sources, the differing figures
or claims, and the likely cause: different dates, definitions, populations, methods,
or incentives. Separate supported fact, calculation, inference, and unresolved
question. Say what was inaccessible and what remains unknown.

## Format by tier

Quick: a direct answer, two or three supporting sentences, one or two citations, and
a caveat if needed. No headings unless the answer has parts.

Standard: a short answer, then findings organized by sub-question. Include a
limitations line and a bibliography. Usually one to three screens.

Deep or Rigorous: answer and executive summary, findings by question, analysis or
comparison, conflicts and limitations, method and verification coverage, then
sources. Use only sections that add value. Do not pad with process narration.

## Save the report

Save every non-quick report as a `report` note. Link the evidence notes, set topics
and the run id, and use a summary that stands alone.

```js
await tools.research.save({
  kind: "report",
  title: "Grid storage costs in 2026",
  summary: "Storage costs fell across most markets, but policy and interconnection delays still dominate deployment.",
  body: finalMarkdown,
  topics: ["energy/storage"],
  links: ["rn_xxxxxxxxxxxx", "rn_xxxxxxxxxxxx"],
  volatility: "fast",
  runId,
})
```

A report is only complete when the plan, findings, and report notes exist and the
audit is clean. In chat, give the answer, the report note id, the main uncertainty,
and the verification coverage.

## Report checklist

- Answer appears before background.
- Every substantive claim has a local note citation.
- Numbers keep units, dates, denominators, and versions.
- Conflicts and gaps are explicit.
- No invented citation, quote, or source.
- Bibliography comes from `research.cite`; audit is clean.
- Length matches the ask; no filler sections.
