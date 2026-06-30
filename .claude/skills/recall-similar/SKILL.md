---
name: recall-similar
description: "This skill should be used when the user or another agent asks to find similar reusable units in the project's catalog, search the catalog, recall existing entries, look up entries by topic, or check whether an entry already exists before creating a new one. Covers the hybrid BM25 + dense-embedding index over the project's catalog of reusable units, the recall-similar.mjs CLI, query patterns, fallback behavior, and integration as the duplicate-check Phase 0 of any create-new-unit workflow. Invoke whenever 'find me something that...' or 'is there an entry like X?' or 'similar to Y?' or 'does this already exist?' appears."
metadata:
  priority: 70
  pathPatterns:
    - '**/.agents/vector-index/**'
  promptSignals:
    minScore: 6
    phrases:
      - 'recall similar'
      - 'does this already exist'
      - 'find similar entry'
      - 'similar entry'
      - 'duplicate check'
      - 'before building a new one'
      - 'is there an entry like'
      - 'search the catalog'
---

# Recall Similar — Catalog Vector Search

A mature project accumulates a catalog of reusable units — components, modules, templates, dataset entries, knowledge records, or any other indexable artifact the project tracks. Once the catalog grows past a few hundred entries it is too large for a human or an agent to hold in memory, and too large for a substring search to discover by intent. This skill exposes a hybrid BM25 + dense-embedding index over the catalog's structured-text surface (display name, category, labels, option labels, and any cached description text) so that a natural-language query returns the top entries that already cover that conceptual space. Invoke whenever a user or sibling skill needs to locate an entry by intent, or whenever a create-new-unit workflow must verify the proposed thing is not already shipping — duplicate entries dilute the catalog and create maintenance drift.

> **Generalization note.** This skill is the generic *semantic-recall-over-a-catalog* capability. "Catalog" / "entry" / "unit" below stand for whatever indexable corpus the host project maintains (its memory/knowledge records, its component library, its dataset registry, etc.). Bind those terms to the project's actual artifact when you wire the index; the retrieval mechanism, fallback ladder, and recall-before-create discipline are project-agnostic.

## Project state

These paths are project-relative to the repo root. Adjust the catalog source to whatever generated registry the host project maintains.

- Index location: `.agents/vector-index/index.jsonl` (one line per catalog record)
- Metadata sidecar: `.agents/vector-index/corpus.json` (build manifest, schema version, embedding model, dimension, entry count, generation timestamp)
- Catalog source: the project's generated registry/manifest of active entries (the build script reads this registry to know what to index). Retired/archived entries are excluded from the index.
- Build script: `.claude/scripts/build-index.mjs`
- Query script: `.claude/scripts/recall-similar.mjs`
- Calibration script: `.claude/scripts/calibrate-recall-similar.mjs`
- Gold-query test set: `.claude/scripts/recall-similar-test-cases.json`
- Foundation docs (read these for the full reasoning, do not duplicate here) — write them under `.agents/vector-index/` when you stand the index up:
  - a **catalog-audit** doc — what fields exist on each catalog record, how to construct embedding text, near-duplicate clusters, retired-entry exclusion
  - a **use-cases** doc — picker/UI integration, agent-recall use cases, query patterns to support, API shape, re-build triggers

## When to invoke

Trigger phrases — invoke whenever any of these appear in a user or agent prompt:

- "find me something that..."
- "is there an entry like X?"
- "what's similar to Y?"
- "search the catalog for..."
- "recall existing entries for..."
- "look up entries by topic"
- "before I build a new one, what already exists in this space?"
- "any entry that does Z?"
- "show me everything in the [category] cluster"
- **As Phase 0 (mandatory duplicate check) of any create-new-unit workflow** — every new-unit design should start with catalog recall. Skipping it is the duplicate-entry failure class this index exists to prevent.

The skill does NOT auto-fire on every mention of a catalog entry. It fires when the intent is **search** or **recall**, not when the intent is **edit** or **explain a known entry**.

## What the index covers

Per the catalog audit, each entry's record carries:

- **Embedded text** — a composite of `name`, `category`, dedup'd section/grouping labels, field labels (filtered to non-empty), the option/enum labels that carry the vocabulary users actually search by, any class/type names extracted from the entry, and (where coverage exists) a leading description comment.
- **Description sentence** — an optional one-sentence human-facing description per entry, generated at build time and cached in `corpus.json`. Coverage is typically partial (some entries have a curated description; the remainder fall back to the composite text alone).
- **Filterable metadata** — `id`, `name`, `category`, plus whatever exact-match facets the project filters by (cost tier, capability flags, "is new", etc.). Used as exact-match facets at query time, not folded into the embedding text.
- **Aliases** — any alias registry that maps legacy ids to current ids routes both the legacy id and the current id to the current entry's record so saved/old references still resolve.

Retired/archived entries are NOT indexed — they cannot be used, so surfacing them would mislead the agent into proposing duplicates of unusable entries.

## Query types and quality

| Query type | Example | Mode that wins | Notes |
|---|---|---|---|
| Exact-name | `Checkout` | BM25, sub-millisecond | Literal substring boost — exact name always ranks above semantic neighbors |
| Camel-case id | `userProfileCard` | BM25 | Engineering-shorthand queries route through the `id` field |
| Category match | `form components` | BM25 + category facet | Pre-filter on `category` then rank within |
| Field/label match | `date range` | BM25 over field labels | Hits entries whose labels contain the literal phrase |
| Concept / synonym | `login` | Dense embedding | BM25 fails on synonyms — the dense vector bridges `sign-in`, `auth`, `credentials` |
| Description-phrase | `the onboarding flow` | Dense embedding | Users describe context, not the internal name — the description sentence carries that vocabulary |
| Cross-vocabulary | `lightweight notice` | Dense embedding | The literal word never appears in any label; embedding bridges to toast / banner / alert entries |
| Combinatorial | `paginated filterable table` | Hybrid (BM25 + dense, fused with RRF) | Exact-feature vocabulary plus semantic neighborhood |

The hybrid ranker (Reciprocal Rank Fusion) merges BM25 and dense rankings. Below a configurable cosine floor (default 0.35), dense matches are dropped — a low-confidence semantic match shown without context erodes trust.

## Invocation

Two paths. Both produce the same JSON contract.

### 1. CLI directly (for agents and humans)

```
node .claude/scripts/recall-similar.mjs --query "<text>" [--k 5] [--category <facet>] [--exclude-retired] [--json]
```

Default `k=10`. Default `--exclude-retired=true`. Add `--json` for machine-readable output. Omit `--json` for the human-readable table. The `--category` (and any other facet flags) match whatever exact-match facets the project's records expose.

### 2. As a skill in a Claude session

The agent invokes `/recall-similar` (or the skill auto-fires on a trigger phrase). The skill:

1. Confirms the index file exists (`.agents/vector-index/index.jsonl`). If missing, halts with a clear "rebuild the index first" message.
2. Parses the query, optional category filter, and optional `k` from the user's prompt or the calling skill's argument.
3. Calls the CLI script under the hood with `--json`.
4. Returns the parsed result inline to the calling agent or summarizes the top-k for the human.

Typical agent call from inside a create-new-unit workflow's Phase 0:

```
node .claude/scripts/recall-similar.mjs --query "paginated filterable data table with sticky header" --k 10 --json
```

## Output shape

### Human-readable (default)

```
Query: "paginated filterable data table"
k=5  mode=hybrid

  score  id              displayName              category    tier
  -----  --              -----------              --------    ----
  0.781  dataTable       Data Table               component   medium
  0.713  gridView        Grid View                component   medium
  0.624  listView        List View                component   low
  0.512  paginator       Paginator                component   low
  0.487  filterBar       Filter Bar               component   low
```

### JSON (`--json`)

```json
{
  "query": "paginated filterable data table",
  "k": 5,
  "mode": "hybrid",
  "results": [
    {
      "id": "dataTable",
      "score": 0.781,
      "displayName": "Data Table",
      "category": "component",
      "tier": "medium",
      "snippet": "a sortable, paginated table that renders rows from a query with sticky header...",
      "matchedTerms": ["table", "paginated", "filterable"]
    }
  ]
}
```

`snippet` is the cached description sentence when present, or a 120-char truncation of the embedded composite text when not. `matchedTerms` lists the BM25 hits used in the rank — useful for UI dim-highlight. The exact metadata fields returned mirror whatever facets the project's records carry.

## Fallback behavior

The build script writes BM25 posting lists unconditionally. Dense embeddings require an embedding-provider key in env (`OPENAI_API_KEY` or `VOYAGE_API_KEY`); the build script reads the env at build time and writes vectors only when the key is present.

**Query-time fallback:**

- **Index file missing** → script exits with code 1 and prints: "Index not found at `.agents/vector-index/index.jsonl`. Run `node .claude/scripts/build-index.mjs build` to generate it." The skill surfaces this directly to the agent or human.
- **Index file present, dense vectors missing** (no API key was set at build time) → script logs a single-line warning to stderr (`recall-similar: dense vectors absent, BM25-only mode — synonym queries will be degraded`) and falls through to BM25-only retrieval. Exact-name and label queries still work perfectly. Concept queries return weaker results.
- **Query embedding fails at runtime** (API key valid at build, transient network failure at query) → log warning, fall back to BM25, return results with `mode=bm25-fallback` in the JSON output so callers can detect it.
- **All filters return empty** (e.g. a facet filter plus a query that nothing matches above the score floor) → return `{"results": []}` honestly. Never fabricate a match below the floor.

The fallback ladder is deterministic: dense-hybrid → BM25-only → empty. The skill never silently degrades quality — every fallback path emits a stderr warning so the agent or human knows what mode produced the result.

## Integration as Phase 0 (catalog recall before creating a new unit)

Any create-new-unit pipeline (Research → Design → Build → Review → Verify, or whatever the project's workflow is) should be preceded by a mandatory **Phase 0: Catalog Recall**. Skipping Phase 0 reintroduces the duplicate-entry failure class.

**Phase 0 protocol — mandatory before any research/build begins:**

1. Compose a one-line spec of the proposed unit (the same sentence that will become its description target).
2. Run:
   ```
   node .claude/scripts/recall-similar.mjs --query "<one-line spec>" --k 10 --json
   ```
3. Surface the top-10 to the design document under "Current state analysis":
   - For each result with score ≥ 0.5: note the overlapping axes (what does the existing entry already cover?) and the non-overlapping axes (where is the proposed unit's wedge?).
   - For each result with score ≥ 0.7: STOP. This is a duplicate-detection signal. Either the proposed unit is a V2 rewrite of the matched entry (an upgrade path) or the proposed unit is redundant. Confirm with the operator before proceeding.
4. **Decision gate:** if 2+ existing entries cover the proposed conceptual space at score ≥ 0.6, document in the design doc why the new unit is still warranted. Acceptable wedges (adapt to the project's own facets):
   - Different combinatorial axes (existing covers A × B, new covers A × B × C)
   - Different capability/requirement profile (existing single-pass, proposed multi-pass)
   - Different interaction strategy (existing static, proposed interactive)
   - Different `category` semantically
   - Different cost/performance profile that genuinely opens a new budget tier
5. If no compelling wedge surfaces, abort the new-unit track and recommend extending the matched existing entry instead.

**Sample Phase 0 dialogue:**

> Agent task: "I want to build a sortable, paginated data table with column filters."
>
> Phase 0 → `recall-similar --query "sortable paginated data table column filters"` returns `[dataTable (0.78), gridView (0.71), listView (0.62), paginator (0.51), filterBar (0.49)]`.
>
> Agent reports to the operator: "dataTable at 0.78 cosine — pagination and sorting are already covered. gridView at 0.71 — also covers tabular rendering. Recommend either (a) a V2 of dataTable that adds the column-filter axis, or (b) abort the new unit and ship column-filters as a dataTable upgrade. Which direction?"

This single addition prevents the duplicate-entry class from re-occurring across the agent-recall path. The project's design-doc template should be amended to include the Phase 0 output as a required section.

## Re-build trigger

The index is a generated artifact and must rebuild whenever the source it embeds changes. The triggers:

- **A new entry is added** to the catalog source — same trigger that regenerates the project's registry/manifest.
- **An existing entry's `name`, `category`, or label / option labels change** — the embedded composite text changes, so that entry's record (and its embedding) must regenerate.
- **An entry moves between active and retired/archived** — record must be removed (retirement) or added (un-retirement).
- **The catalog registry/manifest is regenerated** — the index rebuild runs as a downstream output of the same pipeline. One catalog regenerate command, the index rebuild in lockstep.
- **Schema bump** (`schemaVersion` in `corpus.json` changes) — full rebuild forced; cached embeddings are invalidated.
- **Embedding model swap** — full rebuild forced.

**How to rebuild:**

```
node .claude/scripts/build-index.mjs build
```

The build script reads the catalog registry, composes embedding text per entry per the audit's recipe, computes BM25 posting lists, and — if an embedding-provider env key is set — fetches dense vectors via the configured provider. Output: `index.jsonl` (one record per line) + `corpus.json` (manifest).

The output files are committed to git as generated artifacts alongside the catalog registry. The build is deterministic given the same source and the same embedding model.

**Hash-based skip:** the build script tracks a per-entry content hash of the composite text. On rebuild, only entries whose hash changed re-embed. A typo fix to one definition does not re-embed the whole catalog — only the touched record.

## Example queries (worked)

Adapt these to the host project's catalog. The "wins" column names which retrieval mode produces the right top-k.

| # | Query | Wins | Notes |
|---|---|---|---|
| 1 | `login` | dense | BM25 fails — entries named `sign-in` / `auth` don't contain "login" as a substring |
| 2 | `table` | hybrid | BM25 finds entries with "table" in name; dense bridges grid/list neighbors |
| 3 | `notification` | dense | The literal word rarely appears; concept routes through embedding to toast/banner/alert |
| 4 | `the onboarding flow` | dense | Description-style intent query; the cluster sits in one embedding neighborhood |
| 5 | `the homepage hero` | dense | Pure description-phrase test — human mental model, not the internal name |
| 6 | `paginated filterable table` | hybrid | Agent-recall use case — exact feature name plus neighborhood |
| 7 | `modal dialog` | hybrid | Taxonomy query for Phase 0 duplicate detection |
| 8 | `date picker` | hybrid | Taxonomy query |
| 9 | `inline edit` | dense | Description-phrase test |
| 10 | `empty state` | dense | Description-phrase test |
| 11 | `simple low-cost --category component` | BM25 + facet | Combined facet + free-text |

The "strict" rows (1, 4, 5, 6, 7, 9, 10) are the ones the calibration suite gates on. The "loose" rows (2, 3, 8, 11) are graceful — top-K with cosine context is acceptable even if exact ordering varies.

## Quality threshold

The calibration script at `.claude/scripts/calibrate-recall-similar.mjs` runs the gold-query set at `.claude/scripts/recall-similar-test-cases.json` (a set of queries with curated expected top-k). Passing thresholds:

- **Recall@5 ≥ 0.80** — at least 4 of every 5 expected results appear in the top-5 across the gold set.
- **MRR ≥ 0.70** — mean reciprocal rank of the first relevant result.

Below threshold → retrieval is degraded. Investigate in this order:

1. Embedding-provider key absent at build time (the most common cause — drops the suite to BM25-only).
2. Composite-text recipe regressed (a recent build-script change dropped one of the source fields).
3. Catalog drift (an entry renamed without a rebuild — gold set still references the old name).
4. Embedding-model change without `schemaVersion` bump.

Re-run after each fix. The calibration result is logged to `.agents/vector-index/calibration-<ISO-timestamp>.md` and surfaced to the human.

## What this skill does NOT do

Out of scope. These are different problems with different solutions; conflating them bloats the index and degrades quality.

- **Full-text search inside source files** — that is a code-search problem (Grep / ripgrep / a code-aware LSP index). The vector index is metadata-only.
- **Code-structure semantic search** ("find all functions that use X pattern") — requires parsing source and embedding by code structure; different model, different pipeline. If needed in the future, build a separate code-structure index.
- **Image / preview retrieval** ("find an entry that looks like this screenshot") — requires CLIP-style image embeddings + a per-entry thumbnail pipeline. Separate workstream.
- **Live editor / UI integration** — any picker UI consumes `recall-similar.mjs` separately via the same JSON API. The skill is for AGENTS; the UI consumer is a separate work item.
- **Real-time index updates** — rebuild is build-time only. The index is a generated artifact, not a live service.
- **Schema changes to the catalog record type** — the index reads what's there. It does not propose adding a `description`, `tags`, or `keywords` field to the type. The build-time description-sentence pass is cached in `corpus.json`, NOT folded back into the source schema.
- **Modification of `.claude/rules/`** — the rule corpus is the canonical source of truth, not the index target.
- **Replacing the existing substring search in any picker** — the index AUGMENTS, it does not REPLACE. Substring is fast, deterministic, and infallible for exact-name queries. A picker UX should run substring first, then merge in semantic results below the substring matches with visual differentiation.

## References

- audit doc: `.agents/vector-index/catalog-audit.md` (write when standing up the index)
- use-cases doc: `.agents/vector-index/use-cases.md` (write when standing up the index)
- build script: `.claude/scripts/build-index.mjs`
- query script: `.claude/scripts/recall-similar.mjs`
- calibration script: `.claude/scripts/calibrate-recall-similar.mjs`
- gold queries: `.claude/scripts/recall-similar-test-cases.json`
- index data: `.agents/vector-index/index.jsonl`
- metadata sidecar: `.agents/vector-index/corpus.json`
- canonical rules: `.claude/rules/README.md` (the project's recall-before-create and file-maintenance rules are load-bearing for this skill)
- catalog source of truth: the project's generated registry/manifest of active entries
