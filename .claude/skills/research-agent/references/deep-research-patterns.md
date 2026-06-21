# Deep Research Patterns — fan-out, adversarial verification, cited synthesis

> The mechanics of turning ONE web search into a multi-source, fact-checked research run: when to
> escalate, how to fan out queries, how to verify a claim adversarially before you write it, and how
> to synthesize with citations that survive scrutiny. This is **generic** research-agent craft —
> reusable across any domain — illustrated with Lumina's single-shot `/perplexity_ask` pipeline in
> [`backend/index.ts`](../../../../backend/index.ts) as the *baseline you escalate FROM*.
>
> Read this when a query is too big, too contested, or too high-stakes for one Tavily search.
> Adjacent refs: the baseline single-shot wiring → `lumina-research-pipeline.md`; tuning a single
> Tavily call → `web-search-tavily.md`; the `[n]` grounding/citation contract → `source-grounding-and-citations.md`;
> the `<ANSWER>`/`<FOLLOW_UPS>` output protocol → `answer-protocol-and-followups.md`. Engine-level
> mechanics (`streamText`, `stopWhen`, `generateObject`, compaction) → **ai-sdk-agent**.

---

## 1. The baseline vs. the escalation

Lumina's default Discover turn is a **single-shot** pipeline: one `webSearch(query)` (Tavily
`basic`, `maxResults:10`) → `formatSearchContext` → one `streamText` pass → `<ANSWER>` + sources tail
(`webSearch`, `formatSearchContext`, the MISS path in `/perplexity_ask` in
[`backend/index.ts`](../../../../backend/index.ts)). That is correct and fast for the common case:
a definable question whose answer fits in one page of well-ranked results.

Deep research is a different shape — a **loop**, not a line:

```
PLAN  → decompose the question into sub-questions / angles
FAN-OUT → run N parallel searches (one per sub-question), each its own Tavily call
GATHER → dedupe + cluster results by claim, not by URL
VERIFY → for each load-bearing claim, seek independent corroboration AND active disconfirmation
GAP-CHECK → unanswered sub-questions or unresolved conflicts? → loop back to FAN-OUT (bounded)
SYNTHESIZE → write the report grounded ONLY in gathered sources, cite [n], flag disputes
```

The single-shot path is FAN-OUT with N=1, no VERIFY, no loop. Everything below is what you add when
N=1 is not enough — and the discipline that keeps the loop from spiraling.

---

## 2. When to escalate (the decision framework)

Do **not** reach for deep research by default — it costs N× the Tavily credits, N× latency, and a
much larger token bill. Escalate only when at least one trigger fires.

| Signal in the query / context | Single-shot is fine | Escalate to deep research |
|---|---|---|
| **Breadth** | One entity / one fact | Comparison across ≥3 options, or "survey the landscape" |
| **Contested-ness** | Settled fact (capital of France) | Numbers/claims that sources disagree on (market size, death tolls, benchmarks) |
| **Stakes** | Casual / exploratory | Decision-grade (medical, financial, legal, "what should I buy/do") |
| **Composition** | Answerable from one snippet | Requires assembling many partial facts into a whole |
| **Freshness conflict** | One clear recent source | Story is developing; sources are stale at different times |
| **Source skew risk** | Neutral topic | One-sided / SEO-spammed / promotional topic where the top 10 may all echo one origin |

Heuristic line: **if you cannot name the 2-3 sub-questions whose answers compose the final answer,
the question is either trivial (single-shot) or under-specified (ask the user to narrow first — same
rule the `deep-research` skill applies before it runs).** A vague brief ("what car should I buy")
wastes a fan-out; pin budget/use-case/region first, then research.

In THIS repo the escalation lever is deliberately simple today: the finance vertical already runs a
bounded agentic loop (`stopWhen: stepCountIs(6)` in `streamFinanceAnswer`,
[`backend/index.ts`](../../../../backend/index.ts)) where the model can call `financeWebSearch`
multiple times — that is a model-driven fan-out. The Discover path is single-shot. The patterns here
describe how to build a *true* deep-research run on top of either, and the standard the standalone
`deep-research` harness holds itself to.

---

## 3. Multi-source fan-out

### 3.1 Decompose, then parallelize
Turn the question into independent sub-queries and run them **concurrently** — the same
`Promise.all` shape the follow-up path already uses to overlap history-build + search
(`Promise.all([buildConversationHistory(...), webSearch(query)])` in `/perplexity_ask/follow_up`,
[`backend/index.ts`](../../../../backend/index.ts)).

```ts
// Fan out: each sub-question is its own Tavily search, all in flight at once.
const subQuestions = await planSubQuestions(query);          // LLM decompose (generateObject + Zod)
const batches = await Promise.allSettled(                    // allSettled: one dead query ≠ dead run
  subQuestions.map((q) => webSearch(q)),                     // reuse the existing 400-char-capped search
);
const hits = batches.flatMap((b) => (b.status === "fulfilled" ? b.value.results : []));
```

Rules that carry over from the baseline:
- **Keep the 400-char cap per sub-query** (`webSearch` slices to 400 for Tavily; the LLM still sees
  the full text). Each fan-out leg is a normal Tavily call and inherits that cap.
- **`Promise.allSettled`, never `Promise.all`** for the legs — one upstream 429/timeout must not sink
  the whole run (the finance `/home` aggregate uses `allSettled` for exactly this).
- **Vary the angle, not just the words.** Good fan-outs cover *facets* (definition, latest, criticism,
  counter-evidence, primary source), not five paraphrases of the same query — paraphrases return the
  same 10 URLs and add cost with zero new information.

### 3.2 Query-shaping per leg
Different sub-questions want different Tavily settings (see `web-search-tavily.md` for the knobs):

| Sub-question intent | searchDepth | topic / days | Why |
|---|---|---|---|
| "What is the current state of X" | `basic` | `news`, `days:7-30` | recency over depth |
| "Primary/authoritative definition" | `advanced` | default | deeper extraction of one canonical source |
| "Criticisms / failure cases of X" | `basic` | default | deliberately seek the OTHER side (see §4) |
| "Reconcile the conflicting number" | `advanced` | default | need the full passage, not a snippet |

### 3.3 Dedupe + cluster by CLAIM, not URL
After fan-out you have an overlapping pile of results. Two operations before synthesis:
1. **URL dedupe** — the same page surfaces under multiple sub-queries; keep one, but remember it was
   reachable from N angles (a weak relevance signal).
2. **Claim clustering** — group snippets by the *assertion* they make ("market is $4B" vs "market is
   $12B"), so conflicts become visible. You cannot verify what you have not clustered.

Then renumber the SURVIVING, ordered set once into the `[n]` space — the same positional contract as
single-shot (`formatSearchContext` numbers `[i+1]`; the `<SOURCES>` tail must use the SAME order).
Renumber once, at the end of GATHER, never mid-synthesis.

---

## 4. Adversarial claim verification

The point that separates "fan-out search" from "research": **a corroborated claim is not a verified
claim.** Ten SEO blogs copying one press release agree perfectly and are all wrong. Verification means
actively trying to *break* each load-bearing claim before you write it.

### 4.1 The verification battery (per load-bearing claim)
| Test | Question | Pass condition |
|---|---|---|
| **Independence** | Do the agreeing sources trace to *different origins*, or one syndicated wire/PR? | ≥2 genuinely independent origins (not mirror domains) |
| **Primary proximity** | Is there a primary source (filing, paper, dataset, official statement) behind the secondary reporting? | Claim links to or is confirmed by the primary |
| **Disconfirmation** | Did you run a search *designed to find the claim WRONG* ("X debunked", "X criticism", "X retracted")? | The disconfirming search returns nothing credible — OR you surface the dispute |
| **Recency** | Is the claim current, or superseded by a newer source in the pile? | Newest credible source agrees |
| **Specificity drift** | Does the number stay constant across sources, or mutate (4B → "over 4B" → "nearly 5B")? | Stable, or you cite the range with its spread |

### 4.2 The disconfirmation search is the heart of it
For every claim you intend to assert, issue a **separate search whose intent is to refute it.** This
is the single highest-value move in the whole pattern and the one naive pipelines skip:

```ts
// Adversarial leg: don't just gather support — actively hunt for the counter-case.
const support  = await webSearch(`${claim}`);
const refute   = await webSearch(`${claim} debunked OR criticism OR retracted OR "no evidence"`);
// A claim that survives a genuine refutation search is far stronger than one that was merely echoed.
```

If the refutation search turns up a credible counter, you do **not** silently pick a side — you
report the dispute (§5.3). The model NEVER adjudicates contested facts from its own priors; that
violates the project's #1 non-negotiable (grounded ONLY in retrieved results, never invent —
`PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts)).

### 4.3 Source-quality weighting
Not all corroboration is equal. Rough tier order for trust (domain-agnostic):

```
primary (filings, papers, datasets, official statements, court records)
  > established institutions / reputable outlets with editorial standards
  > domain-expert secondary (specialist press, recognized analysts)
  > general press aggregating the above
  > forums / blogs / social (signal for sentiment, NOT for fact)
  > content farms / SEO spam / undated pages  (discount hard)
```

Undated pages and pure-promotional pages on the very topic they promote get discounted regardless of
ranking. This mirrors the R-SCALE ranking principle: real search is *matching × ranking*, and for
research the ranking axis is **credibility**, not just relevance.

---

## 5. Synthesis with citations

### 5.1 Grounded-only, still
Every rule from single-shot synthesis holds at N sources:
- **Answer ONLY from the gathered results.** If, after fan-out + verification, the evidence is thin,
  *say so* — do not backfill from model memory (`PERSONA`: "If the results are insufficient, say
  so."). Deep research that fabricates is worse than single-shot that admits a gap.
- **Cite generously with `[n]`**, numbers matching the final ordered source set, exactly as the UI
  renders it (`formatSearchContext` ↔ `sourcesImagesTail` positional contract in
  [`backend/index.ts`](../../../../backend/index.ts)). Renumber once; never reorder after citing.
- **Wrap in the same `<ANSWER>` + five `<FOLLOW_UPS>` protocol** so a deep-research answer renders in
  the existing chat view unchanged (see `answer-protocol-and-followups.md`). A longer report is still
  the same wire contract.

### 5.2 Cite at the claim, not the paragraph
In a multi-source report, attach `[n]` to the **specific sentence** the source supports, and use
**multiple citations on a contested claim** (`The market is estimated at $4-12B [3][7][9]`). A trailing
"Sources: [1][2][3]" dump is an anti-pattern — it makes verification impossible for the reader.

### 5.3 Surface disputes; don't launder them
When verification found a real conflict, the synthesis must show it, not hide it behind a confident
single number:

> Estimates of the market size diverge sharply: $4B per the 2025 industry report [3], versus
> $11B in the vendor's own white paper [7] — the latter uses a broader category definition.

This is where deep research earns its cost: a single-shot answer would have grabbed whichever number
ranked first and presented it as fact.

### 5.4 Structure the report for skimmability
Match the markdown rules of the answer protocol (headings, bold lead-in bullets, comparison tables —
see `answer-protocol-and-followups.md`). For comparisons, a table beats prose. Lead with the bottom
line, then the evidence, then the caveats/disputes.

---

## 6. Quality bars (what "deeply researched" means)

A run does not get to call itself deep research unless it clears these. State plainly which it meets.

| Bar | Threshold | How to check |
|---|---|---|
| **Source diversity** | Load-bearing claims rest on ≥2 *independent origins* (not mirrors/syndication) | Trace each cited domain to its publisher; collapse mirrors |
| **Cross-verification** | Every contested or decision-grade claim ran a disconfirmation search | One refutation query logged per such claim |
| **Coverage** | Every planned sub-question is answered or explicitly marked unanswered | Diff sub-questions vs. the synthesis |
| **Primary proximity** | Key figures link to or are confirmed by a primary source | Each headline number has a primary or a stated caveat |
| **Recency fit** | For time-sensitive topics, newest credible source wins; staleness is dated | Spot-check publish dates; this path skips the semantic cache anyway (`isTimeSensitive`) |
| **Honest gaps** | Thin areas are stated, not papered over | The report contains the words "no reliable source found for…" when true |
| **Citation integrity** | `[n]` positions line up with the `<SOURCES>` tail; claim-level, not paragraph-dump | Render and click a few |

Time-sensitive deep research (anything matching `TIME_SENSITIVE` in
[`backend/index.ts`](../../../../backend/index.ts) — prices, news, "today", a year) must **never** be
served from or written to the semantic cache. The fan-out is the whole point of asking again.

---

## 7. Bounding the loop (cost & termination)

Deep research without a budget is an infinite money pit. Bound every axis:

| Axis | Bound | Mirror in repo |
|---|---|---|
| Fan-out width | Cap sub-questions (e.g. ≤6) per round | finance `stepCountIs(6)` bounds tool round-trips |
| Loop depth | Cap re-search rounds (e.g. ≤2 gap-fill loops) | — escalate to "report what we have" past the cap |
| Per-vendor calls | Stay under Tavily's plan rate; `allSettled` so a 429 leg degrades | finance per-minute `withinBudget` is the analogous guard |
| Wall-clock | Abort on client disconnect | `disconnectSignal(res)` already threads into `streamText` |
| Token cost | Slice each source to ~1200 chars in context | `formatSearchContext` already `.slice(0, 1200)` |
| Termination | Stop when gap-check finds no unanswered sub-Qs OR caps hit | gap-check is the loop's exit condition |

**Termination rule:** the loop ends on *coverage*, not on *certainty*. If two more rounds won't close
a gap, write the report WITH the gap flagged — never loop forever chasing a fact the web doesn't hold.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Escalating every query to a fan-out "to be thorough." | Single-shot is the default; escalate only on a §2 trigger. Fan-out costs N× everything. |
| Five paraphrases of the same query as the "fan-out." | Fan out by *facet* (definition / latest / criticism / primary / counter-evidence), not by synonym. |
| Treating agreement among sources as verification. | Run a disconfirmation search; check the agreeing sources are *independent origins*, not one wire echoed. |
| Letting the model pick the "right" number from its priors when sources conflict. | Report the dispute with citations; never adjudicate contested facts from memory (`PERSONA`). |
| `Promise.all` over the fan-out legs. | `Promise.allSettled` — one dead leg must not sink the run (like finance `/home`). |
| Renumbering / reordering sources mid-synthesis. | Renumber ONCE at end of GATHER; `[n]` stays positional through the `<SOURCES>` tail. |
| Trailing "Sources: [1][2][3]" dump under the whole report. | Cite at the claim; multiple `[n]` on contested claims. |
| Backfilling thin sections from model knowledge. | State the gap ("no reliable source found"); thin-but-honest beats confident-but-fabricated. |
| Unbounded re-search loops chasing certainty. | Cap width + depth + wall-clock; terminate on coverage, flag remaining gaps. |
| Caching/replaying a time-sensitive research run. | `isTimeSensitive` excludes it; the whole value is the fresh fan-out. |
| Skipping the 400-char cap on a "smarter" composite query. | Each leg is a normal Tavily search and inherits the cap; the LLM still sees full text. |
| Reusing one request's abort signal inside a shared/parallel fetch. | Cancel at the orchestration level, not inside a de-duped shared fetch (the finance abort-signal rule). |

---

## 9. Putting it together — a deep-research turn

```
/perplexity_ask {query, deep:true}                       // a future escalation flag on the Discover path
  1. PLAN     planSubQuestions(query)         → generateObject + Zod (sub-Qs + per-leg intent)
  2. FAN-OUT  Promise.allSettled(subQs.map(webSearch))    // concurrent, 400-cap each, allSettled
  3. GATHER   URL-dedupe → cluster by claim → rank by credibility tier
  4. VERIFY   for each load-bearing claim: support search + DISCONFIRMATION search
  5. GAP      unanswered sub-Q or unresolved conflict? loop to FAN-OUT (≤2 rounds), else continue
  6. NUMBER   renumber the final ordered source set ONCE into [n] space
  7. WRITE    streamText, grounded-only, claim-level [n], disputes surfaced,
              <ANSWER> + 5 <FOLLOW_UPS>, then sourcesImagesTail(sources, images)
  8. PERSIST  persistTurns BEFORE res.end()    // Vercel can freeze on close
              (skip the semantic cache — research runs are time-sensitive by nature)
```

Every numbered step has a direct analogue already in [`backend/index.ts`](../../../../backend/index.ts):
the search shaping (`webSearch`), the concurrent gather (`Promise.all` on the follow-up path), the
numbered context (`formatSearchContext`), the wire tail (`sourcesImagesTail`), the disconnect bound
(`disconnectSignal`), and the persist-before-end rule (`persistTurns`). Deep research is those
primitives, looped and held to the §6 bars — not a new stack.
