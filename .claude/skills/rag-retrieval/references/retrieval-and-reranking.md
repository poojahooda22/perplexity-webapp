# Retrieval & Reranking — getting the RIGHT chunks in front of the model

> The generic mechanics of turning a vector store into a retriever that returns *few, relevant,
> grounded* chunks: top-k, hybrid (vector + keyword/FTS), reranking (cross-encoder / LLM-judge),
> MMR diversity, distance thresholds, and how to MEASURE whether retrieval works (recall@k,
> groundedness). Reusable knowledge — Lumina's `index.ts` semantic cache is cited only where it
> already runs one of these moves. Read when designing/tuning a knowledge-RAG retriever or
> debugging "the model cited the wrong thing." Adjacent refs: `embeddings-fundamentals.md` (what a
> vector IS, model/dims), `pgvector-and-postgres.md` (the `<=>` operator, `$queryRaw`, index types),
> `chunking-and-ingestion.md` (what you're retrieving OVER), `semantic-cache-vs-knowledge-rag.md`
> (cache-an-answer vs retrieve-a-chunk — read first if unsure which you're building),
> `lumina-knowledge-rag-design.md` (the concrete Lumina retrieval TOOL).

The retrieval contract: **maximize recall of relevant chunks at small k while keeping the prompt
short and the model grounded.** Every knob below trades one of those against another.

---

## 1. The retrieval pipeline (where each technique sits)

```
query
  │  embed (text-embedding-3-small)        ── embeddings-fundamentals.md
  ▼
[1] CANDIDATE GENERATION  — cast a wide net, cheap & fast
  │   vector ANN  (top-k₁, e.g. 50)  ──┐
  │   keyword/FTS (top-k₁, e.g. 50)  ──┤  HYBRID  (§3)
  ▼                                    ┘  fuse → ~50–100 candidates
[2] RERANK  — expensive & accurate, re-score the small candidate set   (§4)
  │   cross-encoder OR LLM-as-judge → ordered by true relevance
  ▼
[3] SELECT  — what actually enters the prompt
  │   threshold (drop low scores, §5)  +  MMR (kill near-duplicates, §6)
  ▼
top-k₂ chunks (e.g. 5–8) → prompt with source metadata → generate + cite
```

Two-stage by design: **retrieve wide (recall), rerank narrow (precision).** A single vector query
at k=5 forces one model to do both jobs and does neither well. Skip stage [2] only for tiny
corpora where stage [1] is already precise (Lumina's answer-cache is exactly that case — see §8).

---

## 2. Top-k retrieval — the baseline, and why k matters twice

There are **two k's** and conflating them is the classic mistake:

| | Symbol | Typical | What it controls |
|---|--------|---------|------------------|
| Candidate k | k₁ | 30–100 | How wide stage [1] casts. Bigger = higher recall, more rerank cost. |
| Context k | k₂ | 3–8 | How many chunks reach the prompt. Bigger = more grounding, more tokens, more distraction. |

- **k₂ too small** → the relevant chunk was retrieved but cut off → model hallucinates or says "I
  don't know." Most "RAG didn't work" reports are k₂ (or threshold) too tight.
- **k₂ too large** → "lost in the middle": LLMs weight the start/end of long contexts; a fact
  buried at position 6 of 12 gets ignored. More context is NOT monotonically better.
- **Order the final k₂ by rerank score**, then put the strongest chunks at the **edges** of the
  context block if the prompt is long.

Decision: start k₁=50, k₂=6, reranked. Tune k₂ down if grounding is fine and latency/cost hurt; up
if recall@k₂ (§7) shows relevant chunks falling outside the window.

---

## 3. Hybrid retrieval — vector + keyword, because each fails differently

Vector (dense) and keyword (sparse/FTS) have **complementary blind spots**:

| | Dense (embedding `<=>`) | Sparse (Postgres FTS / BM25 / trigram) |
|---|---|---|
| Wins on | paraphrase, synonyms, concepts ("car" ↔ "automobile") | exact terms, IDs, codes, rare proper nouns, acronyms |
| Fails on | exact tokens it never saw, SKUs, error codes, names | synonyms, "samsng" typo, conceptual queries |
| Mechanism | cosine ANN over `vector(d)` | inverted index / `tsvector` / `pg_trgm` |

A query like **"error TS2307 ESM import"** is keyword-shaped (those tokens must match literally); a
query like **"why won't my modules resolve"** is vector-shaped. Real corpora get both. Hybrid runs
both and **fuses** the ranked lists.

**Reciprocal Rank Fusion (RRF)** — the default fusion; needs no score calibration (dense cosine and
BM25 scores aren't on the same scale, so you fuse by *rank*, not raw score):

```
score(doc) = Σ_over_lists  1 / (k_rrf + rank_in_list(doc))      // k_rrf ≈ 60
```

In Postgres you can do all of this in **one database** — no separate search engine at Tier 1/2:

```sql
-- Dense candidates (pgvector) UNION'd with sparse candidates (FTS), fused by RRF.
WITH dense AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rnk
  FROM chunk ORDER BY embedding <=> $1::vector LIMIT 50
),
sparse AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY ts_rank(tsv, plainto_tsquery('english', $2)) DESC) AS rnk
  FROM chunk WHERE tsv @@ plainto_tsquery('english', $2) LIMIT 50
)
SELECT COALESCE(d.id, s.id) AS id,
       (1.0/(60 + COALESCE(d.rnk, 1000))) + (1.0/(60 + COALESCE(s.rnk, 1000))) AS rrf
FROM dense d FULL OUTER JOIN sparse s USING (id)
ORDER BY rrf DESC LIMIT 50;
```

> Lumina's answer-cache runs the **dense half only** — `embedding <=> ${vec}::vector` in
> `findCachedAnswer` ([`backend/index.ts`](../../../../backend/index.ts), ~L457). That's correct for
> a cache (you want an exact paraphrase of a *whole question*, not term overlap), but a knowledge-RAG
> retriever over docs should add the sparse leg. FTS uses the **same Supabase Postgres** — no new
> infra. See `pgvector-and-postgres.md`.

When you DON'T need hybrid: a homogeneous corpus with no codes/IDs/rare tokens, or queries that are
always natural-language. Don't add the sparse leg speculatively — measure recall first (§7).

---

## 4. Reranking — the highest-leverage knob in RAG

Stage [1] retrieval optimizes a proxy (vector distance / BM25), not true relevance. A **reranker**
re-scores the small candidate set with a model that reads the query and the chunk *together*.

| Approach | How it scores | Latency / cost | Use when |
|----------|---------------|----------------|----------|
| **Bi-encoder** (the retriever itself) | query & doc embedded *separately*, cosine | ~0 (already done) | candidate generation only — too coarse to be final |
| **Cross-encoder** (e.g. a reranker model / Cohere Rerank class) | query+doc encoded *together*, one relevance score | tens of ms per pair, batched | the standard production reranker; reorder ~50 → take top 6 |
| **LLM-as-reranker (listwise)** | prompt the LLM: "rank these N chunks for this query, return ids" | one extra LLM call, slower/pricier | no reranker available; or you want reasoning/instruction-following in the ranking |
| **LLM pointwise (yes/no relevant + score)** | LLM scores each chunk 0–1 | N small calls (parallelize) | filtering more than ranking; pairs with thresholding |

**Why a cross-encoder beats the bi-encoder:** the bi-encoder must compress a whole chunk into ONE
vector with no knowledge of the query; the cross-encoder sees both texts and attends across them, so
it catches "this chunk *mentions* React but is actually about Vue." It can't scale to the whole
corpus (it must run per candidate) — which is exactly why it's stage [2] over ~50 items, not stage [1].

**LLM-as-reranker skeleton** (listwise — cheaper than N pointwise calls, and Lumina already has the
AI SDK + Gateway wired):

```ts
// Reorder candidate chunks by true relevance using the same Gateway models as the agent.
const { object } = await generateObject({
  model: "anthropic/claude-haiku-4.5",          // a cheap, fast model is plenty for ranking
  schema: z.object({ ranked: z.array(z.object({ id: z.string(), score: z.number().min(0).max(1) })) }),
  prompt: `Query: ${query}\n\nRank these passages by how directly they answer the query.\n` +
          candidates.map((c, i) => `[${c.id}] ${c.text}`).join("\n\n"),
});
const top = object.ranked.filter(r => r.score >= 0.5).slice(0, k2);   // threshold + cut (§5)
```

Rule of thumb: **add a reranker before you add more chunks.** Reranking 50→6 usually beats raising
k₂ to 12 — better grounding AND a shorter prompt.

---

## 5. Thresholds — never return junk just to fill k

Top-k always returns k rows even when nothing is relevant. A **distance/score floor** turns "the
closest k" into "the close-enough ones, possibly zero."

| Stage | Cutoff | Direction |
|-------|--------|-----------|
| Dense vector | cosine **distance** ≤ threshold (pgvector `<=>`: 0=identical, 2=opposite) | smaller is closer |
| Rerank | relevance **score** ≥ threshold (0–1) | larger is better |

- **Returning zero chunks is a valid, GOOD outcome** — the agent should then say "I don't have that
  in my knowledge base" instead of grounding on a 0.4-distance non-answer. Junk grounding is worse
  than no grounding.
- **Tune against real logs, never by guess.** Hold a near-miss pair you KNOW should miss and confirm
  it sits the right side of the line. Lumina's cache does exactly this:

> `DISTANCE_THRESHOLD = 0.15` with the documented near-miss — *"learn React" vs "learn React Native"
> sit ABOVE 0.15 and correctly MISS* — and the filter `hit.distance <= DISTANCE_THRESHOLD` in
> `findCachedAnswer` ([`backend/index.ts`](../../../../backend/index.ts), L395 / L464). A retriever
> over *chunks* will want a **looser** distance threshold than a *whole-answer* cache (chunks are
> shorter, more varied) — re-tune; don't copy 0.15 blindly.

- **Distance ≠ similarity.** `<=>` is cosine *distance*; filter `<= threshold`. Treating it as
  similarity and using `>=` is a silent, total inversion (see the anti-patterns table).
- Thresholds are corpus- and model-specific. Re-tune after re-chunking or changing the embedding
  model — the geometry moves.

---

## 6. MMR — diversity so k chunks aren't k copies

Plain top-k over a corpus with duplicated/boilerplate content returns the SAME fact k times (k near
copies of one paragraph), wasting the window and starving the model of complementary facts.
**Maximal Marginal Relevance** balances relevance to the query against novelty vs already-picked
chunks:

```
MMR = argmax_{dᵢ ∉ S} [ λ · sim(dᵢ, query) − (1−λ) · max_{dⱼ ∈ S} sim(dᵢ, dⱼ) ]
                          └ relevance ┘        └ redundancy penalty ┘
```

- `λ = 1` → pure relevance (no diversity); `λ = 0` → pure diversity (ignores the query). Start
  **λ ≈ 0.7**.
- Apply MMR **after** rerank, **during** stage [3] selection — over the reranked candidates, picking
  k₂.
- Cheap alternative when MMR is overkill: **dedupe by source doc** (cap N chunks per parent
  document) so one verbose page can't monopolize the k₂ slots.
- Symptom you need it: the model's answer repeats one point and misses others that ARE in the corpus.

---

## 7. Evaluation — you cannot tune what you don't measure

Retrieval has two halves and you measure each separately, then end-to-end:

### Retrieval quality (did we fetch the right chunks?)

| Metric | Question it answers | Formula / note |
|--------|--------------------|----------------|
| **Recall@k** | Did the relevant chunk(s) make it into the top-k? | `relevant retrieved in top-k / total relevant`. The metric for "is k big enough / is retrieval finding it at all." |
| **Precision@k** | How much of the top-k is actually relevant? | `relevant in top-k / k`. Low precision → reranker/threshold work. |
| **MRR** | How high did the FIRST relevant chunk rank? | `mean(1 / rank_of_first_relevant)`. Rewards good ordering. |
| **nDCG@k** | Graded relevance with position discount | best when relevance is graded (0–3), not binary. The standard ranking metric. |

**Recall@k is the one to watch first.** If recall@k is low, NOTHING downstream can fix it — the
reranker can't promote a chunk that retrieval never fetched. Fix recall (hybrid, bigger k₁, better
chunking) before touching rerank/threshold.

### Generation quality (did the answer USE the chunks, faithfully?)

| Metric | Question | How |
|--------|----------|-----|
| **Groundedness / faithfulness** | Is every claim supported by a retrieved chunk? | LLM-judge: "is this sentence entailed by the cited chunk? yes/no." Catches hallucination *despite* good retrieval. |
| **Answer relevance** | Does the answer address the query? | LLM-judge or embedding sim(answer, query). |
| **Citation accuracy** | Do the `[n]` markers point at chunks that actually support the claim? | check the cited chunk entails the sentence — reuse the `[n]`/`<SOURCES>` format from **research-agent**. |

**Building the eval set (do this from day one):** assemble 30–100 `(query, relevant_chunk_ids)`
pairs — hand-label, mine from real logs, or LLM-generate Q&A from your own chunks (ask a model "write
a question this passage answers", then the passage is the gold chunk). Run it on every chunking/k/
threshold/reranker change; track the metrics over time. Without it you are tuning by vibes — exactly
what the cache's threshold comment warns against.

---

## 8. Where Lumina sits today (and what each technique would add)

| Technique | In `index.ts` answer-cache today | For a knowledge-RAG retriever (see `lumina-knowledge-rag-design.md`) |
|-----------|----------------------------------|----------------------------------------------------------------------|
| Top-k | `LIMIT 1` (it wants the single nearest *whole question*) | k₁≈50 → rerank → k₂≈6 |
| Hybrid | dense only (`<=>`) — correct for a paraphrase cache | add Postgres FTS leg + RRF (same Supabase DB) |
| Rerank | none needed (LIMIT 1 over a precise key) | cross-encoder or Haiku listwise over the 50 |
| Threshold | `DISTANCE_THRESHOLD = 0.15`, tuned w/ a near-miss | re-tune looser for chunks; return 0 = "not in KB" |
| MMR | n/a (1 row) | λ≈0.7 or per-doc cap |
| Eval | the "learn React" near-miss is the manual test | a real recall@k + groundedness suite |

The cache is a **Tier-1-correct degenerate retriever** (k=1, dense-only, hard threshold) because its
job is "is this the *same question*," not "what chunks are relevant." A retriever over a document
corpus needs the full stage [1]→[2]→[3] pipeline.

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Single vector query at k=5 as the whole system. | Two-stage: retrieve wide (k₁≈50), rerank, select k₂. Recall then precision. |
| Treating cosine `<=>` distance as *similarity* (`>= threshold`). | It's distance: 0=identical. Filter `<= threshold`; smaller is closer. Wrong sign = total inversion. |
| Stuffing k₂=20 chunks "to be safe." | Lost-in-the-middle drops them. Rerank to 6 strong chunks; put best at the edges. |
| Returning top-k even when everything is far. | Apply a floor; **zero chunks → "not in my KB"** beats grounding on junk. |
| Dense-only retrieval over docs full of codes/IDs/acronyms. | Add the sparse/FTS leg and fuse with RRF — the same Postgres, no new engine. |
| Fusing dense + sparse by adding raw scores. | Scales differ; fuse by **rank** (RRF), not raw score. |
| Picking k / threshold by vibes and shipping. | Build a 30–100 pair eval set; tune on recall@k + groundedness; keep a confirmed near-miss. |
| Adding a reranker but feeding it 5 candidates. | A reranker needs a wide net to reorder — give it 50; pointless over 5. |
| Adding more chunks when grounding is weak. | First add a **reranker** (50→6) — better grounding AND shorter prompt. |
| k near-duplicates from one boilerplate page. | MMR (λ≈0.7) or cap chunks-per-document during selection. |
| Copying `DISTANCE_THRESHOLD=0.15` from the answer-cache to a chunk retriever. | Re-tune: chunks are shorter/varied → usually a looser cutoff. Geometry differs per corpus/model. |
| Blaming the LLM for hallucination without checking recall@k. | If retrieval never fetched the supporting chunk, no prompt fixes it. Measure recall FIRST. |
| Re-chunking or swapping embedding model, keeping old thresholds. | Re-tune all cutoffs — the vector geometry moved. |

---

## 10. Decision framework — what to reach for

```
Symptom                                   → Move
──────────────────────────────────────────────────────────────────
recall@k low (right chunk not fetched)    → bigger k₁ ; add hybrid/FTS ; re-chunk (chunking ref)
precision@k low (top-k full of noise)     → add/strengthen reranker ; tighten threshold
right chunks fetched, wrong order         → reranker (cross-encoder > LLM listwise > none)
answer repeats one fact, misses others    → MMR (λ≈0.7) or per-doc cap
exact codes/IDs/names not matching        → sparse/FTS leg + RRF fusion
answer hallucinates despite good chunks    → groundedness eval ; tighter prompt ; lower k₂
"I don't know" when the fact IS in corpus  → k₂ too small or threshold too tight ; loosen, re-test
latency/cost too high                      → smaller k₂ after reranking ; cheaper reranker model
```

Order of operations when building: **chunk well → measure recall@k → add hybrid if recall is the
gap → add reranking → tune threshold + MMR on the eval set → measure groundedness end-to-end.**
Never tune two knobs at once without the eval suite telling you which moved the number.
