# Evaluating a research run

Judge the observable result: notes, citations, and report against the sources. A
confident answer is not evidence. Score each dimension 1 (poor) to 5 (strong), and
record what you inspected.

## Rubric

| Dimension | 1 | 3 | 5 |
| --- | --- | --- | --- |
| Factual accuracy | Material errors | Minor slips | Claims match sources |
| Citation accuracy | Broken or invented ids | Mostly resolve, some overreach | Every citation entails its claim |
| Completeness | Misses core question | Covers main parts | Covers question and material counterevidence |
| Source quality | SEO farms, aggregators | Mixed | Primary sources and original data |
| Tool efficiency | Loops, repeats queries | Some waste | Short path, parallel reads, stops early |
| Library reuse | Ignores notes, duplicates | Some reuse | Reuses fresh notes, saves atomic findings |
| Note quality | Vague summaries, mixed claims | Usable | Atomic, self-contained, sourced, correctly typed |

Also record: tier chosen, researchers launched, budget used, follow-up rounds,
verification coverage, and whether the plan and report notes exist.

## Smoke tests

Run a small sample; do not treat it as a benchmark. One prompt at a time, inspect the
notes and sources, not just the prose.

Breadth-first:

1. Compare the free-tier limits of Cloudflare R2, Backblaze B2, and Amazon S3.
2. Compare the range, charging time, and battery chemistry of the Tesla Model 3,
   Hyundai Ioniq 6, and BYD Seal.
3. Compare the governance, license, and release cadence of PostgreSQL, MySQL, and
   SQLite.

Depth-first:

4. What explains conflicting estimates of the U.S. personal saving rate?
5. Which is better for a latency-sensitive trading system, Rust or C++, and why?
6. What are the strongest arguments for and against the EU carbon border adjustment
   mechanism?

Straightforward:

7. What is the current status of the ITER fusion project?
8. What does RFC 9110 specify about idempotent methods?
9. What is the latest monthly U.S. CPI inflation reading, and for which month?
10. Who is the current Secretary-General of the United Nations, and since when?

For each, accept a quick path when the request is narrow. Reject invented citations,
snippet-only support, a swarm for a one-line fact, and a report that hides a conflict.

## Failure modes

- Too many researchers for a simple question; duplication and coordination cost.
- Endless searching for a source that does not exist; no stop condition.
- Workers researching the same sub-question from the same angle.
- Accepting SEO farms, aggregators, or marketing pages as primary evidence.
- Vague briefs that produce overlapping or off-scope findings.
- Snippet or search-summary citations presented as read evidence.
- A verifier that approves a summary without reopening the source.
- Confidence inflation: `verified` set from agreement rather than a source.
- Reports that list sources but never map them to claims.
- Saving a plan and report but no atomic findings, so nothing is reusable.

## What good looks like

A good run answers the question at the requested depth, shows its evidence, explains
disagreement, states limits, and leaves a library that makes the next run cheaper.
A partial run that says what is missing is better than a polished unsupported one.
