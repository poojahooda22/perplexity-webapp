# Citations & DOIs — identity, metadata, formats, dedupe, open-access

> The persistent-identifier + citation-metadata layer of scholarly work: what a DOI is and why it
> beats any URL, the metadata fields you carry (authors / year / venue / citation count), how to
> render a citation in the major formats, how to link out so the card never rots, how to dedupe the
> SAME work seen across sources, and how to tell open-access from paywall. **Generic-domain** ref —
> reusable knowledge; Lumina files are cited only to show the rule in our live code
> ([`backend/discover/academic.ts`](../../../../backend/discover/academic.ts),
> [`backend/discover/shared.ts`](../../../../backend/discover/shared.ts)).
> Read this when a task touches identifiers, metadata, formatting, link-out, dedupe, or OA status.
> Adjacent refs: `openalex-and-scholarly-apis.md` (which API and which fields), `academic-search-and-ranking.md`
> (using `cited_by_count` for ranking, OA filtering), `academic-domain-coverage.md` (judging source
> quality), `lumina-academic-vertical.md` (the wiring).

---

## 1. The DOI — the one identifier that doesn't rot

A **DOI** (Digital Object Identifier) is a permanent, resolvable handle for a scholarly work.
Publisher URLs move, get paywalled, or 404; the DOI is registered once and redirected forever.

| Property | Detail |
|----------|--------|
| Shape | `10.<registrant>/<suffix>` — e.g. `10.1038/s41586-020-2649-2`. Always starts `10.`; suffix is opaque (do NOT parse meaning out of it). |
| Resolve | Prepend `https://doi.org/` → `https://doi.org/10.1038/s41586-020-2649-2`. The proxy 302s to the current publisher landing page. |
| Case | DOIs are **case-insensitive** but conventionally lowercased. Normalize to lowercase for dedupe keys. |
| Registrant | The `10.NNNN` prefix identifies the registration agency member (Crossref, DataCite, etc.), NOT the publisher and NOT the field. |
| Stability | A DOI never changes; the target it resolves to may. That indirection is the whole point. |

**Link-out priority (what every card/citation should point at):**

```
DOI  >  publisher landing page  >  source-native id (e.g. OpenAlex id)  >  (omit → skip the card)
```

This is exactly what the live fetcher does — never string-guess a URL:

```ts
// backend/discover/academic.ts — fetchAcademicDiscover
const url = w.doi || w.primary_location?.landing_page_url || w.id || "";
if (!title || !url) continue; // no real link → no card
```

> Note: OpenAlex returns `w.doi` already as a full `https://doi.org/…` URL. Other APIs (Crossref,
> Semantic Scholar) return the **bare** `10.x/...` string — you must prepend the resolver yourself.
> Detect: starts with `http` → use as-is; starts with `10.` → prepend `https://doi.org/`.

**Anti-pattern — fabricating or guessing a DOI.** A made-up DOI is the academic equivalent of a
fabricated stock price. Never construct `https://doi.org/10.xxxx/<title-slug>`; use only the value
the API returned, and skip the work if it has none. (Non-Negotiable #1 in the SKILL.)

---

## 2. Other persistent identifiers (when there is no DOI, or for dedupe)

| ID | Looks like | Resolves via | Use |
|----|-----------|--------------|-----|
| DOI | `10.1038/...` | `https://doi.org/` | Primary. Preprints and datasets have them too (DataCite). |
| arXiv id | `2401.01234` / `cs.CL/0211002` | `https://arxiv.org/abs/<id>` | Preprints (often pre-DOI). Mark as **preprint**, not peer-reviewed. |
| PMID | `34567890` (pure int) | `https://pubmed.ncbi.nlm.nih.gov/<id>/` | Biomedical. Distinct from PMCID. |
| PMCID | `PMC1234567` | `https://www.ncbi.nlm.nih.gov/pmc/articles/<id>/` | The PubMed Central **full-text** (often OA). |
| OpenAlex id | `https://openalex.org/W2741809807` (`W`+digits) | itself | Our last-resort link; great as a stable **dedupe key**. |
| ISSN | `1476-4687` | journal-level | Identifies the **venue**, not the article; use for grouping/venue dedupe. |
| ORCID | `0000-0002-1825-0097` | `https://orcid.org/<id>` | Disambiguates **authors** across name variants — the real fix for "J. Smith" collisions. |

Rule of thumb: **DOI for the article, ORCID for the author, ISSN for the venue.** Match/dedupe on
the strongest ID present, fall back to weaker signals (see §6).

---

## 3. Citation metadata — the fields you carry, and their gotchas

The data behind any citation. Our card keeps a thin slice (`DiscoverArticle` in
[`backend/discover/shared.ts`](../../../../backend/discover/shared.ts)); a full citation needs more.

| Field | Source field (OpenAlex) | Gotcha |
|-------|-------------------------|--------|
| Title | `title` / `display_name` | Carries **JATS/HTML markup** (`<scp>DNA</scp>`, `<i>…`). Strip tags before display: `title.replace(/<[^>]+>/g, "")`. |
| Authors | `authorships[].author.display_name` | Order matters (first author ≠ alphabetical). Disambiguate via ORCID, not name. `et al.` after the format's author cap. |
| Year | `publication_year` / `publication_date` | A work can have an **online** year ≠ **issue** year. Future dates exist (OpenAlex has 2050-rows) — bound `to_publication_date:<today>`. |
| Venue | `primary_location.source.display_name` | The journal/conference name. May be null for preprints → fall back to repository name, never invent. |
| Volume / issue / pages | `biblio.{volume,issue,first_page,last_page}` | Often partial for online-first / preprints. Omit missing parts; don't pad. |
| DOI | `doi` | See §1. The citation's anchor. |
| Citation count | `cited_by_count` | A **velocity/impact signal, not truth** — grows over time, field-relative, gameable. Use for ranking (`academic-search-and-ranking.md`), never as quality proof. |
| OA status | `open_access.{is_oa,oa_status}` | See §7. |

**Never fabricate any of these.** If a field is missing, omit it — an incomplete-but-true citation
beats a complete-but-invented one. Our fetcher only ever keeps real values and `continue`s past
rows missing the essentials.

**`cited_by_count` realities** (so you don't over-trust it):
- A 2015 paper with 400 cites is not "better" than a strong 2024 paper with 10 — age dominates.
- Citation norms differ wildly by field (a top CS paper vs a top math paper differ by an order of
  magnitude). Normalize within field+year if you rank on it.
- Self-citations and citation rings inflate it. It is a signal in a blend, never a verdict.

---

## 4. Citation formats — render the same metadata five ways

A citation = one metadata record projected into a style's grammar. You do NOT need a heavy library
for the common styles; you need the fields above and the style's field-order + punctuation rules.

| Style | Used by | Author form | Date | Distinctive |
|-------|---------|-------------|------|-------------|
| **APA** 7 | social sci, psych, education | `Surname, F. M.` | `(2020).` after authors | sentence-case title; italic journal+volume; DOI as URL |
| **MLA** 9 | humanities | `Surname, First.` | year near end | Title in "quotes"; *Journal* italic; `pp.` |
| **Chicago** (notes / author-date) | history, some sciences | `Surname, First.` | varies by variant | footnote vs author-date split |
| **Vancouver / NLM** | medicine, biomed | `Surname FM` (no periods) | year after journal | numbered; journal abbreviated; "et al." after 6 authors |
| **BibTeX** | CS, physics, math (LaTeX) | `Last, First and Last, First` | `year = {2020}` | machine record, not a rendered string; let LaTeX format it |

```
Same record → two styles
APA:  Doe, J., & Roe, A. (2020). On widgets. Nature, 580(7803), 12–18. https://doi.org/10.1038/xyz
MLA:  Doe, John, and Ann Roe. "On Widgets." Nature, vol. 580, no. 7803, 2020, pp. 12–18.
```

**Decision — build vs fetch a formatted citation:**

| Need | Do |
|------|-----|
| One style, a few fields, display only | Format inline from the metadata you already hold. Cheap, no dep. |
| Many styles / correct edge cases (et-al caps, name particles "van der") | Use a CSL engine (`citation-js` / `citeproc-js`) with CSL style files — it encodes the rules so you don't. |
| The publisher's own formatted string, any style | Crossref content negotiation: `Accept: text/x-bibliography; style=apa` on `https://doi.org/<doi>` (or DataCite). Authoritative, zero formatting code. |
| Bulk export (a reference manager) | Emit **BibTeX** or **RIS** — let the user's tool render. |

**Anti-pattern — hand-rolling APA with regex on a title.** Edge cases (corporate authors, name
particles, no-DOI, "et al." thresholds per style) will bite. For anything beyond a single simple
style, defer to CSL or Crossref content negotiation.

---

## 5. Linking out correctly (so the click always lands)

| Do | Why |
|----|-----|
| Link the **DOI resolver** (`https://doi.org/<doi>`) as the primary href. | Survives publisher URL changes; the canonical citation link. |
| Fall back landing page → native id, then **skip** if none. | A card with no real destination is worse than no card. |
| Open scholarly links in a new tab from the app, but expose the raw DOI/URL too. | Researchers copy the DOI; don't hide it behind a button. |
| Prefer the **OA full-text** link when one exists (PMC, repository, `oa_url`). | Sends the user to something they can actually read (see §7). |
| Set `User-Agent` / polite-pool `mailto` on API fetches. | OpenAlex/Crossref favor identified clients; courtesy, not auth. See `openalex-and-scholarly-apis.md`. |

**Anti-pattern — linking the publisher's tracking/search URL or a Google Scholar query** instead of
the DOI. It's brittle and non-canonical. The DOI is the stable contract.

---

## 6. Deduping the SAME work across sources

The same paper appears as a preprint (arXiv) AND the published version (journal DOI) AND a
repository copy — different URLs, near-identical metadata. Dedupe before display/ranking or the feed
shows the same study three times.

**Match key precedence (strongest first):**

```
1. Normalized DOI           (lowercase; strip resolver prefix)         → exact, authoritative
2. arXiv id / PMID / PMCID  (other persistent IDs)                     → exact
3. Canonical URL            (host lowercased, tracking params stripped) → near-exact
4. Normalized title         (lowercased, trimmed; ideally + first-author + year) → fuzzy, last resort
```

Lumina's shared `finalizeArticles` already does keys **3 + 4** for the card feeds, plus drops
link/title-less rows and caps the list:

```ts
// backend/discover/shared.ts — finalizeArticles
const urlKey = canonicalUrl(a.url);            // host-lowercased, utm_*/fbclid/hash stripped
const titleKey = a.title.toLowerCase().trim();
if (seen.has(urlKey) || seen.has(titleKey)) continue;
```

`canonicalUrl` strips `utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid`, `igshid`, hash, and trailing slash so the same paper
under two tracking links collapses to one. To harden dedupe for a multi-source academic feed, **add a
DOI-normalized key ahead of the URL/title keys** (key #1) so the preprint and the published DOI
version merge even when titles differ slightly.

```ts
// Strengthening pattern: prefer a DOI key when present
const doiKey = a.doi ? a.doi.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() : null;
const keys = [doiKey, canonicalUrl(a.url), a.title.toLowerCase().trim()].filter(Boolean);
if (keys.some((k) => seen.has(k))) continue;
keys.forEach((k) => seen.add(k));
```

**When two copies match, keep the better one** — prefer the **peer-reviewed journal DOI** over the
preprint, and the **OA copy** for the readable link, but keep the DOI as the canonical href.

**Anti-pattern — title-only dedupe with no normalization.** Casing, trailing whitespace, JATS
markup, and "A study of X" vs "A Study of X." defeat it. Always normalize (lowercase + trim +
strip-tags), and prefer an ID key when you have one.

---

## 7. Open-access vs paywall status

OA tells the user whether the click leads to a readable PDF or a paywall, and tells YOU whether you
can legally display more than a title.

**OpenAlex `oa_status` ("the OA color"):**

| Status | Meaning | Readable? | Notes |
|--------|---------|-----------|-------|
| `gold` | Published OA in a fully-OA journal | Yes | Often CC-BY. |
| `hybrid` | OA article in a subscription journal (APC paid) | Yes | Publisher-hosted free version. |
| `green` | Self-archived copy (repository / PMC) | Yes (the copy) | Journal version may still be paywalled; link the `oa_url`. |
| `bronze` | Free to read on publisher site, **no open licence** | Yes to read | Free ≠ reusable. Don't assume reuse rights. |
| `closed` | Paywalled | No free full text | Link the DOI; show only metadata. |

Fields to read: `open_access.is_oa` (bool), `open_access.oa_status` (above), `open_access.oa_url`
(the free full-text link, when any). `best_oa_location` gives the best free copy with its own
licence.

**Two different licences — don't conflate them:**

| Licence on... | Governs | In our stack |
|---------------|---------|--------------|
| The **metadata** (title/authors/abstract via OpenAlex) | What WE may display | OpenAlex aggregated metadata is **CC0** → `commercialOk:true`; we may show the title (and could show abstracts). Attribution is courtesy. |
| The **article full text** (the PDF behind the DOI) | What the READER may do | The publisher's licence (CC-BY, "all rights reserved", etc.). We never re-host it — we link out. |

```ts
// backend/discover/academic.ts — the metadata licence, set correctly (not "false to be safe")
const provenance: Provenance = {
  source: "OpenAlex",
  commercialOk: true, // OpenAlex data is CC0 — free to display, attribution courtesy only
  attribution: "Latest research via OpenAlex (CC0) — cards link to the paper / DOI",
};
```

**Anti-patterns / do-instead:**

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Treating "free to read" (`bronze`) as "free to reuse". | Check the licence; bronze grants reading, not redistribution. |
| Re-hosting OA PDFs/abstracts because "it's open access". | Link the `oa_url`/DOI. OA governs the reader's access, not your right to re-host. |
| Flipping `commercialOk:false` "to be safe" on CC0 metadata. | CC0 = public domain; `commercialOk:true` is correct and earned. Over-restricting hides legal content. |
| Showing a paywalled DOI as if it were free. | Surface OA status; when `is_oa`, prefer the `oa_url` as the readable link. |

---

## 8. Decision framework — "I have a work, what do I do with it?"

```
Got a scholarly work
|
├─ Need a link?         → DOI > landing page > native id > SKIP. Never guess a DOI.        (§1, §5)
├─ Bare 10.x string?    → prepend https://doi.org/ . Already http? use as-is.             (§1)
├─ No DOI at all?       → arXiv/PMID/PMCID/OpenAlex id; mark preprint if not peer-reviewed.(§2)
├─ Rendering a card?    → strip JATS from title; carry authors/year/venue truthfully;
|                         omit (never invent) missing fields.                              (§3)
├─ Need a citation str? → 1 simple style → inline; many/edge cases → CSL or Crossref
|                         content negotiation; bulk → BibTeX/RIS.                          (§4)
├─ Multiple sources?    → dedupe by DOI > other ID > canonical URL > normalized title;
|                         keep the journal+OA copy.                                        (§6)
├─ Readable / legal?    → read open_access.{is_oa,oa_status,oa_url}; metadata=CC0 (display
|                         the title), full text = publisher licence (link out).           (§7)
└─ Ranking later?       → carry cited_by_count as a signal, not a verdict → academic-search-and-ranking.md
```

---

## 9. Quick reference — field map (OpenAlex → what it's for)

| Need | OpenAlex path | Notes |
|------|---------------|-------|
| Stable link | `doi` → else `primary_location.landing_page_url` → else `id` | The live `url` ladder in `academic.ts`. |
| Display title | `title` ?? `display_name`, then strip `<[^>]+>` | JATS markup present. |
| Venue label | `primary_location.source.display_name` | Card `source`; falls back to `"OpenAlex"`. |
| Date | `publication_date` → `toIso(...)`; bound `[since, today]` | Future-date footgun; `toIso` in `shared.ts`. |
| Field/category | `primary_topic.field.display_name` ?? `primary_topic.display_name` | Broad grouping (Medicine / CS / …). |
| Impact signal | `cited_by_count` | Ranking only; not currently carried on the card. |
| OA | `open_access.{is_oa,oa_status,oa_url}` | §7; not currently carried — add when surfacing OA badges. |
| Author disambig | `authorships[].author.orcid` | ORCID over name string. |

---

## 10. Pitfalls cheat sheet

- DOIs are case-insensitive — **lowercase before using as a dedupe key**, or duplicates slip through.
- A bare `10.x` is not a URL — prepend the resolver; never display the bare string as a link.
- `cited_by_count` is age- and field-biased — normalize before ranking; never cite it as quality.
- "Free to read" ≠ "open licence" — `bronze` OA can't be re-hosted.
- Metadata licence (CC0, ours to display) ≠ full-text licence (publisher's, link-out only).
- Future-dated and JATS-titled rows are real in OpenAlex — bound the date window and strip tags.
- One canonical href = the DOI. Landing pages and search URLs rot; the DOI doesn't.
