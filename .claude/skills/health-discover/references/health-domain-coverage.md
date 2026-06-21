# Health Domain Coverage — taxonomy, source tiers, and what makes a trustworthy answer

> The reusable health-domain knowledge behind Lumina's Health vertical: how to carve the topic
> space (conditions, symptoms, wellness, nutrition, mental health, fitness, sleep), how to rank a
> source's authority (Tier S→D), and the anatomy of an answer a user can safely act on.
> Read this when deciding **what** health content to cover, **which sources** to trust or surface,
> or **how to structure** a health answer/feed category. Generic-domain doc — it teaches the field;
> Lumina files are cited only where they illustrate a rule already in the live code.
>
> Adjacent refs: **medical-info-safety.md** owns the not-advice / diagnosis / dosage / emergency
> contract (this doc tells you what's trustworthy; that one tells you what's *safe to say*).
> **health-news-sourcing.md** owns the feed plumbing + licensing for the same source lists.
> **lumina-health-vertical.md** is the wiring map.

---

## 1. Why a taxonomy at all

A health query is not one thing. "Is my chest pain serious?" (symptom triage), "what is type 2
diabetes?" (condition education), "how much protein per day?" (nutrition), and "I can't sleep"
(behavioral/sleep) need different sources, different framings, and different safety floors. A flat
"health" bucket gives every one the same generic answer and the same generic feed. Carving the
space lets you (a) route to the right authoritative source tier, (b) apply the right safety gate
(symptom/emergency content is far higher-stakes than a wellness tip), and (c) build feed categories
and workflow prompts that match how people actually search.

Lumina's feed currently ships **one** "health" category (`category: "health"` in
[`backend/discover/health.ts`](../../../../backend/discover/health.ts) `fetchHealthNewsData`). The
taxonomy below is the map for splitting it into real sub-feeds and for tagging chat-agent answers.

---

## 2. The health-topic taxonomy

Seven top-level domains. Each row: what it covers, the canonical query shape, the **stakes** (how
much harm a wrong answer does → drives the safety floor), and the source tier you should reach for
(see §3).

| Domain | Covers | Canonical query shape | Stakes | Reach for |
|--------|--------|----------------------|--------|-----------|
| **Conditions / diseases** | Definitions, causes, prognosis, standard-of-care overview, prevalence | "what is X", "is X serious", "X vs Y" | High | Tier S/A (MedlinePlus, Mayo, NHS, disease-specific orgs) |
| **Symptoms / triage** | What a symptom can mean, red-flags, when to seek care | "why does X hurt", "should I worry about X" | **Critical** | Tier S/A + **emergency framing always** |
| **Medications / treatments** | Drug purpose, common/serious side effects, interactions, generic vs brand | "what is drug X for", "X side effects" | **Critical** | Tier S (DailyMed/FDA label, drugs.com cross-check) — **never dosage advice** |
| **Nutrition / diet** | Macros, micronutrients, dietary patterns, food safety, RDAs | "how much protein", "is X healthy" | Medium | Tier S/A (NIH ODS, USDA, EFSA, Harvard Nutrition Source) |
| **Mental health** | Conditions, coping, therapy types, crisis resources | "how to manage anxiety", "signs of depression" | **Critical** (self-harm) | Tier S/A + **crisis-line surfacing** (988/local) |
| **Fitness / movement** | Exercise types, guidelines, recovery, injury basics | "how often should I exercise" | Low–Medium | Tier A (WHO/CDC activity guidelines, ACSM) |
| **Sleep / lifestyle / preventive** | Sleep hygiene, screening schedules, vaccines, habits | "how to sleep better", "when to get a colonoscopy" | Medium | Tier S/A (CDC, USPSTF for screening) |

**Cross-cutting modifiers** that change the right answer regardless of domain — capture them when
present and let them raise the safety floor:

| Modifier | Effect |
|----------|--------|
| **Pregnancy / breastfeeding** | Many "safe" answers flip; route to specialist sources, add "discuss with your OB/clinician". |
| **Pediatric (child/infant)** | Dosing, normal ranges, red-flags all differ; never generalize from adult info. |
| **Age (elderly)** | Comorbidity + drug-interaction sensitivity. |
| **Chronic condition stated** | Personalization risk — stay general, defer to the user's care team. |
| **Acute / "right now" / severe** | Triage + emergency path before education. |

> Decision rule: **classify the domain AND scan for modifiers BEFORE choosing sources or framing.**
> A nutrition question with "pregnant" in it is no longer a low-stakes nutrition question.

---

## 3. Source-quality tiers

Authority in health is not "a website said so" — it's evidence hierarchy + institutional
accountability. Rank every source S→D. **Surface and cite high; demote or exclude low.**

| Tier | What it is | Examples (global / India) | Use it for |
|------|-----------|---------------------------|------------|
| **S — Primary authority** | Government/intergovernmental health bodies, official drug labels, systematic-review libraries. Accountable, updated, evidence-graded. | WHO, CDC, NIH/NLM (MedlinePlus, PubMed), FDA/DailyMed, NHS, Cochrane / ICMR, MoHFW, PIB | The backbone of any factual claim; primary citation |
| **A — Reputable clinical / academic** | Major academic medical centers, peer-reviewed journals, professional societies. | Mayo Clinic, Cleveland Clinic, Johns Hopkins, *Nature*, *NEJM*, *Lancet*, Medscape, Harvard Health | Patient-friendly explanation, corroboration |
| **B — Quality health media / consumer health** | Editorially-reviewed consumer health sites with medical review boards; credible health journalism. | Healthline, Medical News Today, STAT News, KFF Health News | Plain-language framing, context, news |
| **C — General news / mixed** | Mainstream press health desks — fine for *events* (an outbreak, a policy), weak for *medical fact*. | TOI/The Hindu/Indian Express/NDTV (health desks), general dailies | Timeliness of news only; don't cite as medical authority |
| **D — Exclude / never cite** | Forums, anecdote, supplement-seller blogs, AI-generated content farms, paywalled-snippet aggregators, anti-vax/quackery. | Reddit threads, "miracle cure" sites, affiliate review mills | Never. Filter out. |

Lumina's trusted-domain lists in
[`backend/discover/health.ts`](../../../../backend/discover/health.ts) (`GLOBAL_HEALTH_DOMAINS` /
`INDIA_HEALTH_DOMAINS`) are exactly a Tier-S→B allowlist used to scope the Tavily fallback —
`who.int`/`cdc.gov`/`nih.gov`/`icmr.gov.in`/`mohfw.gov.in` (S), `nature.com`/`medscape.com` (A),
`healthline.com`/`statnews.com`/`kffhealthnews.org` (B). The Indian list deliberately adds C-tier
press (TOI/The Hindu/NDTV) for *event* coverage where S-tier Indian sources are sparser. **When you
add a domain to those lists, place it by tier — never add a D-tier site to make the feed look
fuller.**

### Within-tier signals (how to rank two S/A sources)

- **Recency vs evidence type.** A 2010 systematic review can outrank a 2025 single observational
  study. Prefer guidelines/reviews over single studies; note the date either way.
- **Geographic relevance.** Use ICMR/MoHFW for India-specific guidance (vaccine schedules, dengue,
  TB), CDC/NHS for their jurisdictions. Don't quote US screening ages to an Indian user without
  flagging it.
- **Conflict of interest.** Industry-funded ≠ disqualifying, but disclose it; a supplement maker's
  page on its own supplement is C/D regardless of polish.
- **Medical review.** Tier-B consumer sites earn their tier only if they carry a named medical
  reviewer + last-reviewed date. No review board → treat as C.

---

## 4. What makes a trustworthy health answer

A health answer is trustworthy when a non-expert can act on it without being misled. Eight
properties — treat them as an output contract for any agent prose or workflow result.

| # | Property | Concretely |
|---|----------|-----------|
| 1 | **Grounded, not generated** | Every factual claim traces to a Tier-S/A source with an inline `[n]` citation. Live/"today" claims come from web search, never the model's memory. |
| 2 | **Sourced + dated** | Name the body (WHO/CDC/MedlinePlus) and the as-of/last-reviewed date. Medicine changes; an undated answer is a liability. |
| 3 | **Calibrated uncertainty** | "Evidence is mixed / limited / strong." Don't launder a single study into "studies show." Distinguish established fact from emerging research. |
| 4 | **General, never personal** | Explains the topic; does not diagnose *this person*, prescribe, or give a dosage. Routes to a clinician for anything individual. (Owned by **medical-info-safety.md**.) |
| 5 | **Emergency-aware** | Red-flag symptoms (chest pain + breathlessness, stroke FAST signs, suicidal ideation) trigger an immediate "seek urgent care / call your local emergency number / 988" line **before** education. |
| 6 | **Context-adjusted** | Honors the §2 modifiers — pregnancy, pediatric, chronic condition, geography — instead of one-size-fits-all. |
| 7 | **Balanced** | Presents standard of care + meaningful alternatives + trade-offs; doesn't cherry-pick. Flags controversy where it exists. |
| 8 | **Bounded** | States what it does NOT cover and where to go next, rather than over-reaching into advice. |

### Answer skeleton (general health question)

```
1. Direct, plain-language answer to the question asked.
2. Key facts, each cited [n] to a Tier-S/A source, with the as-of/reviewed date.
3. Important nuance: who it differs for (modifiers), what's uncertain/emerging.
4. (If any red-flag present) emergency line, surfaced near the top — not buried.
5. "This is general information, not medical advice — discuss your situation with a
   qualified clinician." + named authoritative bodies to read further.
```

This mirrors Lumina's existing posture: the `WORKFLOWS` prompts in
[`frontend/src/components/discover/health-view.tsx`](../../../../frontend/src/components/discover/health-view.tsx)
are deliberately framed as guidance ("Explain how to read…", "evidence-based ways to…"), and the
report-upload prompt adds "Note anything I should discuss with a doctor" — never "tell me what I
have." The taxonomy + tiers here
are what make those guidance answers *correct*; the safety framing is what makes them *safe*.

---

## 5. Decision framework — query → coverage path

```
Health query arrives
│
├─ 1. CLASSIFY domain (§2 table) + SCAN for modifiers (pregnancy/pediatric/age/chronic/acute)
│
├─ 2. STAKES check
│      ├─ Critical (symptom-triage / meds / mental-health / self-harm)
│      │     → emergency/crisis scan FIRST; Tier-S sources only; strict no-advice
│      ├─ Medium (nutrition / sleep / preventive)
│      │     → Tier-S/A; general guidance; cite RDAs/guidelines with date
│      └─ Low (general fitness / lifestyle education)
│            → Tier-A/B ok; still cite + date
│
├─ 3. SOURCE by tier (§3): reach S→A; allow B for plain-language; C only for *news events*; drop D
│
├─ 4. ANSWER by the §4 skeleton: grounded, dated, calibrated, general, emergency-aware, bounded
│
└─ 5. If "today/latest/outbreak" → it's a LIVE query → route to web-search pipeline
       (research-agent), never answer dated facts from memory.
```

---

## 6. Mapping the taxonomy onto Lumina (where it plugs in)

| Taxonomy artifact | Where it lands in this repo |
|-------------------|----------------------------|
| Domain sub-feeds (split the single "health" category) | `category` field per `DiscoverArticle` in [`health.ts`](../../../../backend/discover/health.ts); tag NewsData `category[]` / scope Tavily queries per domain. |
| Tier allowlist | `GLOBAL_HEALTH_DOMAINS` / `INDIA_HEALTH_DOMAINS` in `health.ts` — add by tier (§3). |
| Geographic relevance | The `market` param + `INDIA_HEALTH_DOMAINS` (ICMR/MoHFW/PIB) vs global list. |
| Workflow prompts per domain | `WORKFLOWS` in `health-view.tsx` — frame each as guidance, raise the safety floor for critical domains. |
| Answer skeleton + safety floor | Enforced in agent prose via the persona/safety contract — see **medical-info-safety.md**. |

---

## 7. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Treating "health" as one flat bucket; same sources + framing for a sleep tip and chest pain. | Classify the §2 domain + modifiers first; route stakes → source tier → safety floor. |
| Citing a C-tier news desk or a B-tier blog as if it were medical authority. | Cite the underlying Tier-S/A source (WHO/CDC/MedlinePlus); use C only for the *event*, never the medical fact. |
| Letting a single study become "studies show" / "research proves." | Calibrate: name the study, prefer reviews/guidelines, say "limited/mixed/strong evidence." |
| Adding a domain to the trusted-domain list because it ranks well / fills the feed. | Place every domain by tier; never admit D-tier (forums, supplement sellers, content farms). |
| Quoting US screening ages / vaccine schedules to an Indian user (or vice versa). | Honor geography: ICMR/MoHFW for India, CDC/NHS for theirs; flag jurisdiction. |
| Ignoring pregnancy/pediatric/chronic modifiers and giving the generic adult answer. | Detect modifiers; raise the floor, route to specialist sources, defer to the user's clinician. |
| Burying or omitting the emergency line on a red-flag symptom. | Surface "seek urgent care / call your local emergency number / 988" near the TOP, before education. |
| Answering "latest outbreak / today's guidance" from the model's memory. | Live query → web-search pipeline (research-agent); never fabricate health facts or dates. |
| Undated, unsourced confident prose. | Name the body + as-of/last-reviewed date + inline `[n]`; medicine changes. |
| Drifting into "you should take X mg" / "you have Y." | Stay general + route to a clinician. The no-advice contract is non-negotiable — **medical-info-safety.md**. |

---

## 8. Quick reference card

- **Domains (7):** conditions · symptoms/triage · meds/treatments · nutrition · mental health ·
  fitness · sleep/preventive. **Modifiers:** pregnancy · pediatric · age · chronic · acute.
- **Tiers:** S = WHO/CDC/NIH/FDA/NHS/Cochrane/ICMR/MoHFW · A = Mayo/Hopkins/journals/Medscape ·
  B = Healthline/MNT/STAT/KFF · C = general news (events only) · D = exclude.
- **Trustworthy answer (8):** grounded · sourced+dated · calibrated · general · emergency-aware ·
  context-adjusted · balanced · bounded.
- **Golden rule:** classify → stakes → tier → skeleton → (if live) web search. Higher stakes ⇒
  higher tier ⇒ stricter safety floor.
