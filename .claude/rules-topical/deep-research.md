# Deep Research Protocol

> **Status.** Topical — applies when a task requires research-grounded answers, not pattern-matched answers from training data. Read this file at the start of any task tagged "deep research", any rebuttal that requires multi-source evidence, or any architectural decision where a wrong call costs real hours.
>
> **Loading.** Read when (a) the user requests "deep research", "research this", "go deep on this", or equivalent; (b) producing or reviewing a rebuttal under `accepting-audits.md` that requires evidence; (c) making an architectural decision with no obvious precedent in the codebase; (d) the topic is at the limit of training-data freshness (recent libraries, recent specs, current production patterns, post-2024 industry shifts).

---

## The Bar — MIT + Oxford + Harvard rigor

Deep research at this seat is not "I asked the model and got an answer." It is what a tenure-track researcher at a top-three institution would produce as the literature-review section of a paper.

Every claim has a named source. Every source is verified by reading the actual content (not the abstract, not the SEO snippet). Every contradiction across sources is named and resolved in writing.

The bar is not academic credentialism — the bar is the *rigor* that produces a recommendation a senior CTO would sign off on without further investigation. If the recommendation could be torn apart by a competent skeptic in five minutes, the research was not deep.

---

## Minimum Requirements

### 1. Search volume — 30+ web searches minimum

Not one search returning ten results. Thirty distinct queries, varied phrasing, varied source-type intent.

Examples of query variation around a single topic (here, "does tool Y v4 break plugin Z"):
- The literal claim (`"tool Y v4 internalApi.moduleGraph"`)
- The mechanism it implies (`"tool Y v4 workspace API breaking change"`)
- The community discussion (`"plugin Z tool Y v4 compatibility github issue"`)
- The vendor / maintainer angle (`"tool Y v4 migration guide plugin Z"`)
- The historical context (`"tool Y v3 to v4 project API changes"`)

If after 30 searches the picture is still ambiguous, that ambiguity *is* the finding — surface it, do not paper over it.

### 2. Source diversity — touch at least FIVE of the following categories

- **GitHub repositories** — production codebases that solve the same class of problem. Read the implementation, not the README.
- **Open-source library source code** — the actual lines. The package's `dist/src/index.js`. The vendor's `src/`. Not the docs.
- **Industry-leading engineering blogs** — named senior engineers (Mario Zechner, Filippo Valsorda, Mitchell Hashimoto, Charity Majors, Kent Beck class), lab post-mortems (Cloudflare, Stripe, GitHub, Anthropic), platform team writing (Vercel, Next.js, React core).
- **Stack Exchange / Stack Overflow** — high-vote accepted answers AND the conversation in the comments. Often the real signal is in a reply to the accepted answer pointing out an edge case.
- **Specifications and standards** — W3C, IETF (HTTP / networking), TC39 (JavaScript), and the relevant standards body for the domain in question; read the spec, not a summary of it.
- **Peer-reviewed papers** — arXiv (CS), ACM Digital Library, IEEE, conference proceedings (SOSP, OSDI, PLDI, and the relevant domain venues). Cite the section + the conclusion, not just the title.
- **Vendor engineering posts** — browser team blogs (V8, WebKit, Mozilla Hacks), platform/runtime vendor docs, framework maintainer announcements.
- **Production incident post-mortems** — Cloudflare status, Stripe blog, GitHub status, AWS post-event summaries, Replit / Railway / Vercel incident pages.

If only one or two source categories were touched, the research is not deep.

### 3. Cross-verify every load-bearing claim

A claim that one source asserts is a *hypothesis*, not a fact. Find a second and third independent source before treating it as ground truth. "Independent" means not citing each other — a blog post that links to the GitHub issue and the issue itself are one source, not two.

When a claim resists corroboration after a serious search, mark it as "single-sourced; treat as hypothesis" and continue. Do not promote it to ground truth.

### 4. Surface contradictions, do not paper over them

When two reputable sources disagree:
- Name the disagreement in writing.
- Identify which is more recent, more authoritative, or operates under different assumptions.
- Pick a side with stated reasons. If you cannot pick a side, state explicitly that the answer is uncertain and what would resolve it.

The dishonest move is to cite only the side that agrees with your conclusion. The deep-research move is to acknowledge both, then defend the choice.

### 5. Cite the source for every concrete claim

Every empirical, version-specific, or behavior-specific claim carries the URL or excerpt that supports it. Examples:

- "Library X v3 deprecated `Foo` in favor of `Bar`" → commit hash or release-notes URL.
- "Tool Y v4 restructured its project API" → changelog link.
- "Plugin Z does not yet support Tool Y v4" → the upstream GitHub issue number.
- "Tree-shaking with `sideEffects: false` reduced bundle by 30%" → the benchmark, the configuration, the measurement methodology.

A claim without a citation is a hypothesis. Hypotheses are allowed in research; unverified hypotheses are not allowed in recommendations.

---

## What Deep Research Produces

Deep research output is structured. The structure is the proof that the work was actually done. The structure also makes the work auditable by another senior — they can spot-check any claim by following the citation chain.

A deep-research output document (kept in the project's research/scratch area, typically gitignored) contains:

1. **The question, stated precisely** — exact scope, exact decision being informed, exact non-goals.
2. **The set of sources consulted** — URL + one-line description of what each contributed. Aim for 15-30 cited sources after the 30+ searches; one-source-per-search-page is wasteful, one-source-per-three-pages is reasonable.
3. **The set of claims, each tagged with its source(s)** — every claim mapped to its evidence. Single-sourced claims tagged as `[hypothesis]`.
4. **The contradictions surfaced and how they were resolved** — written out, not hand-waved.
5. **The recommendation with stated reasons** — which option, why, what trade-offs were accepted.
6. **The confidence level** — high / medium / low with reasoning. "Confidence is high because three independent sources converge and the production-codebase pattern matches" is honest. "Confidence is medium because the only signal is a single Stack Overflow answer from 2023" is also honest.
7. **The pre-mortem** — "what would have to be true for this recommendation to be wrong?" Answer in writing. If the answer is "nothing imaginable", confidence should be high. If the answer is "any of these five things", confidence is medium and the watch-items are listed.

---

## Anti-Patterns (instant disqualification)

Each of these reduces the research from "deep" to "pattern-fill". Catching yourself doing any of these → STOP, restart from search volume.

- **One search, one answer, ship it.** A single search is exploration, not research.
- **"I think" or "best practice" without a named source.** Generic appeals are not deep research; they are training-data echoes.
- **Quoting a tutorial blog as authority for a production architecture decision.** Tutorial blogs explain the happy path; deep research is about the unhappy paths.
- **Treating a single Stack Overflow answer as canonical.** Even high-voted answers age, and the comments often hold the real signal.
- **Skipping a contradicting source because it makes the recommendation harder.** The contradicting source is the most valuable one — it tells you what the recommendation has to defend against.
- **Stopping at the first plausible answer when the question warrants exhaustive treatment.** "Plausible" is where research begins, not where it ends.
- **Claiming a citation exists without producing the URL or excerpt.** A citation that cannot be reproduced is not a citation.
- **Reading only abstracts, summaries, or SEO snippets.** Read the actual content. The paper's discussion section, the library's source code, the post-mortem's root-cause paragraph.

---

## When NOT to do Deep Research

Deep research is expensive — 30+ searches, multiple hours, structured output. Spending that cost on a task that does not warrant it is its own form of slop.

Reserve deep research for decisions whose *wrongness* would cost real hours, real money, or real architecture rework. Specifically:

- Architectural decisions with multi-month consequences (framework choice, data-flow pattern, runtime architecture, deployment strategy).
- Rebuttals to other-agent claims where the rebuttal will be cited as project policy.
- Recommendations into the project's critical paths (anything in the core runtime, the data/persistence layer, auth, or access control).
- Library / version upgrades that touch the entire test suite or build pipeline.
- Performance investigations where the wrong fix would mask the real bottleneck.
- Security decisions, secret-handling decisions, auth-flow decisions.

Deep research is NOT warranted for:

- Trivial fixes (one-line typo, lint rule, formatting).
- Paths where the operator has explicitly decided no research is needed (honor that decision).
- Tasks where the answer is already in the codebase (read the code instead — three minutes of `Grep` beats thirty searches).
- Tasks where a two-minute test verifies the answer faster than thirty searches (run the test).
- Routine maintenance with a clear playbook (follow the playbook).

The skill is in knowing which category a task falls into. When in doubt: ask. The cost of mis-routing a deep-research task to "trivial" is far higher than the inverse.

---

## How this Rule Interacts With Others

- **The problem-solving protocol** — when the project defines a multi-step problem-solving protocol, "deep dive" is its first step; deep research IS that step when the scope requires external evidence. The protocol's later steps (alternatives, judge, plan, execute, verify) consume the research output.
- **The audit / rebuttal rule** — rebuttals require deep research; every claim in a rebuttal needs cross-verification.
- **The adversarial / red-team rule** — the hunt questions consume deep-research output. Without research backing, the cynical posture degenerates into contrarian noise.
- **The research-first pipeline** — a project that defines research tiers (e.g. First Principles → Literature & Specs → Production Codebases → Competitive Analysis) gets its *operational rigor* from this file, applied across those tiers.
- **The version-control / IP rule** — research output lives in the project's research/scratch area (typically gitignored). The research artifact does not ship to git history; the *conclusion* lands in the code or in a tracked design doc.

---

## Source

An operator directive establishing the operating standard: "30+ web searches, GitHub repos, actual open-source source code, industry-leading articles, Stack Exchange — everything verified, at MIT + Oxford + Harvard level of rigor." This file codifies that standard so future sessions inherit the bar without re-litigation.
