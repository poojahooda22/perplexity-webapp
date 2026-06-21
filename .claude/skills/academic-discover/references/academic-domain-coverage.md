# Academic Domain Coverage — judging scholarly quality

> The domain knowledge a non-academic agent lacks: how scholarship is organized (field
> taxonomy/concepts), the **preprint vs peer-reviewed** spectrum, **predatory-journal** red flags,
> and what separates a high-quality, well-sourced academic answer from a confident-sounding bluff.
> Read this when the task is *judging a source or framing a research answer* — not plumbing.
> Adjacent refs: **`openalex-and-scholarly-apis.md`** (which API, which fields), **`citations-and-dois.md`**
> (DOI/OA-status mechanics, dedupe), **`academic-search-and-ranking.md`** (relevance × citations × recency,
> matching-vs-ranking). This is a **generic-domain** doc: reusable scholarly knowledge, with our files
> cited only where they make a point concrete.

The one non-negotiable carried in from the SKILL: **never fabricate a citation, author, year, or
venue.** Everything below is about ranking *real* sources by trustworthiness — not about inventing
plausible ones. A made-up DOI is the academic equivalent of a fabricated stock price.

---

## 1. Field taxonomy — how scholarship is organized

Scholarly literature is classified into a hierarchy. OpenAlex (our source) uses a four-level
**topic** tree; learn it because it drives grouping, filtering, and "related field" reasoning.

| Level | Meaning | Example | Count (≈) |
|-------|---------|---------|-----------|
| **Domain** | Broadest bucket | Health Sciences, Physical Sciences, Life Sciences, Social Sciences | 4 |
| **Field** | What a layperson calls "a subject" | Medicine, Computer Science, Environmental Science, Economics | ~26 |
| **Subfield** | A department-sized area | Oncology, Machine Learning, Climatology | ~250 |
| **Topic** | A specific research front | "CAR-T cell therapy", "transformer architectures" | ~4,500 |

Our feed groups cards by the **field** level for legibility — see
[`backend/discover/academic.ts`](../../../../backend/discover/academic.ts) (the `category` is
`w.primary_topic?.field?.display_name`, falling back to the topic name, then `"Research"`). Field is
the right grain for a browsable UI: topic is too granular (4,500 buckets), domain too coarse (4).

**Concepts vs topics:** older OpenAlex used a "concepts" graph (Wikidata-derived, multi-label,
scored). It is being deprecated in favor of the single-label **topic** hierarchy above. Prefer
`primary_topic`; treat `concepts` as legacy. Crossref/Semantic Scholar use their own subject schemes
(Crossref `subject[]`, Semantic Scholar `fieldsOfStudy[]`) — do not assume they map 1:1 to OpenAlex
fields.

**Why it matters for answers:** "latest research on X" is a *field/topic* query, not a keyword
match. Knowing the taxonomy lets you (a) widen a too-narrow query to its subfield, (b) recognize when
a result is off-topic (right keyword, wrong field), and (c) tell the user which discipline a finding
comes from — a clinical-medicine result and a health-economics result answer "is drug Y effective?"
very differently.

---

## 2. The publication-status spectrum (preprint → peer-reviewed → retracted)

Not all "papers" carry equal weight. Rank a source on this ladder *before* you trust its claim.

| Status | What it means | Trust signal | How to detect |
|--------|---------------|--------------|---------------|
| **Preprint** | Posted by authors; **no peer review yet** | Speed over scrutiny — claims unvetted | Hosted on arXiv / bioRxiv / medRxiv / SSRN / Research Square; OpenAlex `primary_location.source.type` = `repository`, not `journal`; often no journal DOI |
| **Under review** | Submitted, not accepted | Same as preprint | Rarely visible externally |
| **Peer-reviewed (published)** | Reviewers + editor vetted it | The baseline of credibility | `source.type:journal`; has a journal DOI; named venue |
| **Version of record** | The final published version | Cite this, not the preprint | DOI resolves to publisher; `is_oa` + `oa_status` populated |
| **Corrected / erratum** | Post-publication fix | Read the correction too | OpenAlex links related works; Crossref `update-to` |
| **Retracted** | Withdrawn for error/misconduct | **Do not cite as valid** | Crossref/Retraction Watch flag; OpenAlex `is_retracted` (when present) |

**Preprint ≠ junk, and peer-reviewed ≠ truth.** Preprints drove fast COVID science; many top results
appear as preprints months before the journal version. But the agent must **label the status
explicitly** — "this is a preprint (not yet peer-reviewed)" — and never silently present a preprint
claim as established fact. Conversely, peer review catches a lot but not everything: fraud, p-hacking,
and irreproducible results pass review regularly.

**Our feed's stance:** the journal feed filters `primary_location.source.type:journal` at the
OpenAlex query (see `filters[]` in `fetchAcademicDiscover`), so preprints are excluded by design from
the "latest research" cards. If you add a preprint lane (the commented "Next lanes: arXiv preprint
freshness"), it **must** be visibly labeled "preprint" and kept in a separate carousel — never mixed
unmarked into the journal feed (that's a flagged anti-pattern in the SKILL).

---

## 3. Venue quality & impact — reading the signals (and their limits)

A real venue still varies wildly in rigor. Useful signals, each with a caveat:

| Signal | What it indicates | The catch |
|--------|-------------------|-----------|
| **Peer-reviewed journal** (named, indexed) | Baseline editorial process | Some "journals" are predatory (see §4) |
| **`cited_by_count`** (OpenAlex) | How much the field engaged with it | Lags 1–3 yrs; recent good papers score 0; fields cite at different rates |
| **Citation percentile** for its field+year | Normalizes the above | Better than raw count for cross-field comparison |
| **Journal reputation** (impact factor, h-index, quartile) | Venue's track record | Gameable; high-IF ≠ every article is good; we do **not** store IF |
| **Indexing** (Scopus / Web of Science / PubMed / DOAJ) | Passed a curator's bar | Absence isn't proof of low quality, but presence is reassuring |
| **OA status** (`oa_status`: gold/green/hybrid/bronze/closed) | Can the user read it? | Orthogonal to quality — OA says *accessible*, not *good* |
| **Replication / consensus** | Multiple independent confirmations | The strongest signal; rarely in one record |

**Citation count is recency-biased and field-relative.** A 2026 breakthrough has near-zero citations;
a mediocre 2010 review has thousands. For ranking, combine recency × citation impact × relevance (see
`academic-search-and-ranking.md` and finance **R-SCALE §H** matching-vs-ranking) — never raw
`cited_by_count` alone. The cleanest single number is the **field-normalized citation percentile**
when available.

---

## 4. Predatory-journal awareness

Predatory publishers charge an article-processing fee, perform **little or no real peer review**, and
exist to extract money. They mimic legitimate journals well enough to fool a keyword match. Treating
their output as peer-reviewed is a credibility failure — the agent must screen for it.

**Red flags (any one warrants suspicion; several = treat as non-peer-reviewed):**

| Red flag | Why it's suspicious |
|----------|---------------------|
| Not in **DOAJ / Scopus / Web of Science / PubMed / Medline** | Real journals get curated into at least one |
| Name nearly identical to a famous journal ("Internatonal Journal of…") | Deliberate brand confusion / hijacked title |
| Promises **publication in days**, "guaranteed acceptance" | Real review takes weeks–months |
| Spam solicitation emails to authors | Legit journals don't cold-email for submissions |
| **APC** prominent, peer-review process vague/absent | Fee-first business model |
| Fake/unverifiable editorial board, fake impact factor ("Global Impact Factor") | Manufactured legitimacy |
| Broad, incoherent scope ("medicine, engineering & humanities") | Volume over focus |
| Bad copy-editing, no clear corrections/retractions policy | No real editorial machinery |

**How to screen in practice:** check membership/indexing — **DOAJ** (open-access whitelist), **COPE**
(publication-ethics membership), **Scopus/WoS** coverage. The historical **Beall's List** named
predatory publishers but is unmaintained and archived — use it as a hint, not gospel. Cabells'
Predatory Reports is the maintained paid equivalent. When unsure, **downgrade trust and say so**:
"published in a venue I can't verify as peer-reviewed."

**Hijacked & paper-mill variants:** a *hijacked journal* clones a legitimate journal's name/ISSN to
sell fake acceptances; *paper mills* sell authorship on fabricated studies. Both produce records that
look real (DOI, venue, authors) — which is exactly why `has_doi:true` and `source.type:journal`
(our two source-side filters) are necessary but **not sufficient** quality gates.

---

## 5. What makes a high-quality academic answer

A good academic answer is judged like a good source: by its sourcing discipline, not its fluency.

| Property | Do | Don't |
|----------|-----|-------|
| **Grounded** | Every non-obvious claim cites a real work (DOI/landing page) | State findings with no source |
| **Status-honest** | Label preprint vs peer-reviewed; flag retracted | Present a preprint as settled science |
| **Recency-aware** | Note publication year; flag if the field has moved on | Cite a 2009 paper as "current" without caveat |
| **Consensus-aware** | Distinguish a single study from a meta-analysis/review/consensus | Generalize one small study to "research shows" |
| **Magnitude/uncertainty** | Convey effect size, sample size, CI, "in mice" vs "in humans" | Drop the n=12, the p, the species |
| **Scope-honest** | Say what the evidence does and does **not** cover | Overclaim beyond the studied population |
| **Field-attributed** | Name the discipline a finding comes from | Blend clinical, in-vitro, and economic claims |
| **No advice (where it applies)** | Health/finance-adjacent → informational, not prescriptive | Tell the user what to take/buy/do |

**The evidence hierarchy (cite the strongest available):**

```
Systematic review / meta-analysis        ← strongest: synthesizes many studies
  └─ Randomized controlled trial (RCT)
       └─ Cohort / case-control (observational)
            └─ Case series / case report
                 └─ Expert opinion, mechanistic ("in mice", in-vitro)
                      └─ Preprint / unreviewed   ← weakest: unvetted
```

When two sources conflict, prefer the higher tier and the more recent meta-analysis; when only
low-tier evidence exists, say "early/limited evidence suggests…". One study is an anecdote at scale —
the answer that says "a 2025 RCT (n=2,400) found…" beats "studies show…" every time.

**Decision framework — should this source carry weight in the answer?**

```
A source/paper is in hand
|
+-- Is it retracted?  ───────────────────► YES → exclude (or cite only as "retracted")
+-- Real DOI + named, verifiable venue? ──► NO  → treat as unverified; downgrade, label it
+-- Venue indexed (DOAJ/Scopus/WoS/PubMed)? NO  → predatory risk → don't call it peer-reviewed
+-- Preprint (repository, no journal DOI)? YES → cite WITH "preprint, not yet peer-reviewed"
+-- Single small study vs review/RCT?  ───► single → hedge ("one study…"); prefer higher tier
+-- Effect size / n / CI present?  ───────► report them; absence → flag the uncertainty
|
└─► Passes → cite with year, venue, and status; rank by relevance × citation impact × recency
```

---

## 6. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Writing a paper title, author, year, or DOI "that sounds right" from memory. | Fetch a real work (OpenAlex) or run the cited web-search flow; link the DOI/landing page; missing → say so. |
| Treating a preprint as peer-reviewed because it has a DOI. | A preprint DOI ≠ journal acceptance. Check `source.type`; label "preprint, not yet peer-reviewed." |
| Citing a paper because it's in a "journal" — keyword-matched. | Confirm the venue is indexed (DOAJ/Scopus/WoS/PubMed); screen for predatory red flags (§4). |
| Ranking by raw `cited_by_count`. | It's recency- and field-biased. Use field-normalized percentile + recency + relevance (see ranking ref / R-SCALE §H). |
| "Studies show…" from a single n=20 study. | State the design, sample, and tier; prefer a meta-analysis/RCT; hedge low-tier evidence. |
| Quoting a finding without its scope ("cures cancer" from an in-mice result). | Carry the population/conditions ("in mice", "n=…", "early-phase"); don't extrapolate. |
| Citing a retracted paper as valid. | Check retraction status; exclude or cite explicitly as retracted. |
| Blending clinical, in-vitro, and economic claims into one "research says." | Attribute each finding to its field and study type; let the user weigh them. |
| Mixing preprints into the peer-reviewed feed unmarked. | Keep `source.type:journal` for the journal feed; preprints in a separate, labeled lane. |
| Over-restricting OpenAlex display "to be safe." | OpenAlex is CC0 (`commercialOk:true`) — display the title freely; the *quality* judgment is separate from the *licensing* judgment. |

---

## 7. Quick reference — signal cheat sheet

| Question | Look at |
|----------|---------|
| Is it peer-reviewed? | `primary_location.source.type` = `journal` (vs `repository`/`conference`) |
| What field? | `primary_topic.field.display_name` (our `category`) |
| How impactful? | `cited_by_count` + field-normalized percentile (recency-adjusted) |
| Can the user read it free? | `open_access.is_oa` / `oa_status` (gold/green/hybrid/bronze/closed) |
| Is the venue legitimate? | Indexed in DOAJ / Scopus / WoS / PubMed? predatory red flags? |
| Is it still valid? | Not retracted; check for erratum/correction |
| How strong is the claim? | Evidence tier (meta-analysis > RCT > observational > case > opinion > preprint) |

For the *mechanics* of reading those fields and resolving DOIs/OA status, see
[`citations-and-dois.md`](./citations-and-dois.md) and
[`openalex-and-scholarly-apis.md`](./openalex-and-scholarly-apis.md). For turning these quality
signals into a ranked result set, see [`academic-search-and-ranking.md`](./academic-search-and-ranking.md).
