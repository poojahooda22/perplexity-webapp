# Rule: the Red-Team Negation Loop — R70 (on-demand)

> **On-demand.** Read in full and execute when the operator invokes it: "red-team this", "negate this",
> "run the negation loop", "prove this is junior", or by naming **R70**. This is the heavy adversarial
> procedure — distinct from [`confirm-before-big-work.md`](confirm-before-big-work.md) (the light
> always-on protocol). It is a **reconstruction** for Lumina of an external rule (Rare.lab's R70); it
> folds in that lineage's always-loaded "cynical charter" hunt posture, because this repo has no separate
> charter file — §A below IS the posture, re-grounded in this repo's own non-negotiables.

## What it is

A bounded adversarial loop that puts a plan, an implementation, an architecture decision, a feature
surface, an audit, or any research artifact in front of a **three-member team of veteran negators** whose
ONLY job is to PROVE the work is junior-level. The work is **presumed mediocre until all three, after
genuine evidence-backed effort, cannot prove it.** Surviving the negation IS the senior-staff bar — not a
self-review vibe, not a thumbs-up.

Three, not two, and **not split by lens.** Each negator receives the ENTIRE problem statement and the
ENTIRE artifact and attacks the WHOLE thing end-to-end. They do not divide the artifact between them. The
point is three independent veterans looking at the same complete target from their own vantage, so a hole
one misses, another lands. Slicing the artifact between reviewers leaves every surface seen by exactly one
pair of eyes — the failure mode this rule replaced.

## The hypothesis every negator must prove

For the artifact under review, each negator independently sets out to prove, with evidence:

> "This is junior-level, vibe-coded, mediocre work. It is not the best implementation for the real
> constraint, not the most scalable or performant approach, not what industry leaders actually ship, and
> the senior vocabulary is covering junior thinking. In a finance product specifically: it either invents
> or mis-licenses a number, crosses the no-advice line, or dresses a metric with no decision value as an
> 'insight'. It will break, mislead, underperform, or balloon in cost in production."

A negator's success = proving any load-bearing part of that hypothesis with external evidence. Failure to
prove it after real effort (searches run, repos read, batteries fired) = that surface has earned the bar.

## §A — The hunt posture (the folded charter — always true during a run)

- **Be cynical. Suspect until proven correct** — every line, every number, every framing, every "insight."
  Default posture is doubt; the burden of proof is on the claim.
- **Fluency is not evidence.** Code that reads well, prose that flows, a confident dial — none of it raises
  the probability of correctness. Interrogate hardest exactly where the work reads smoothest.
- **The job is to find where it breaks, not to confirm it works.** "Does this work?" finds what the author
  already found. Ask "under what input, scale, license, or reader does this break / mislead?"
- **Empty audit on a non-trivial artifact = the negator did not look hard enough.** Re-look. Polished-junior
  is invisible until you are specifically hunting it.

## §B — The negation goals — the folded charter, inverted

Every question below is **inverted into a goal the negator actively tries to prove**, not merely ask. The
negator does not ask "is this scalable / licensed / grounded?" — it tries to prove **it is not**, and
concedes only when the proof attempt fails against real evidence. Each goal is a mini-loop: hunt, research,
attempt the proof; land it (a finding) or exhaust the attempt (that axis survives). All three negators carry
the full goal set; none gets a subset.

### B1 — The five questions (engineering)

1. **Prove it is NOT the best implementation for the real constraint (Q1).** Show it is the first thing that
   compiled, dressed to look considered. Find what senior teams shipped for this exact problem — in OSS or in
   product: **the Vercel AI SDK repo, TanStack, Prisma, Supabase, Upstash, shadcn/ui** for the stack;
   **Bloomberg, JPMorgan, Morgan Stanley, BlackRock, Stripe, Plaid, Robinhood, Koyfin, TradingView,
   Perplexity** for the finance/product shape; **Anthropic, OpenAI, Vercel** for the agent/LLM shape. Cite
   `repo@sha:file:line` or the URL. Prove ours diverges, and that the divergence is naive, not a documented
   trade-off.
2. **Prove it does NOT scale at 100× / 10,000× (Q2 — R-SCALE).** Find the ceiling. Name the tier it actually
   survives (1× demo / 100× traction / 10,000× product) and what breaks at the next. Show the scaling
   mechanism (server-side filter+paginate+index, compute-once-serve-many cache + SWR + cron-warm, atomic
   guarded write, queue fan-out) is **assumed rather than named, documented, and enforced**. Derive the break
   in measured numbers or first-principles math. "It will be fine" is the exact claim you are disproving.
   (Battery: [`product-at-scale.md`](product-at-scale.md) + `~/.claude/rules/product-scale-architecture.md`.)
3. **Prove the "industry standard" claim is hollow (Q3).** Name the leaders, open the repos / read the
   product, cite the pattern. If 3+ independent senior codebases/products do NOT solve it this way, the cited
   pattern is invented and the claim is unfalsifiable filler.
4. **Prove ours is an invented variation, not the proven pattern (Q4).** `Grep` our codebase, bridge each
   surfaced leader pattern to our `backend/...:line` / `frontend/...:line`, and prove ours diverges in a way
   that would not survive peer review.
5. **Prove the senior vocabulary is covering junior thinking (Q5).** Every "architectural concern" with no
   named finding, every "scalability surface" with no derived ceiling, every "sentiment composite" /
   "positioning" / "regime" with no decision value, every "correctness prior" with no edge case — prove it is
   filler. Words that earn nothing from what is behind them are the tell.

### B2 — The finance-product goals (this repo's charter, inverted — highest blast radius)

Each is a Lumina non-negotiable turned into a proof target. Landing any one is a **CRITICAL**.

| # | Prove that… | Anchor |
|---|---|---|
| **F1** | a displayed finance number is **invented / ungrounded** — not fetched by a tool and grounded, or a failed tool was backfilled instead of returning typed `unavailable`/`needsKey`. | non-negotiable #1; `guards/numeric-grounding.ts` |
| **F2** | a displayed series is **mis-licensed** — `commercialOk:true` without a 🟢 row in [`../memory/sources-ledger.md`](../memory/sources-ledger.md), a free tier treated as a display license, or a composite that inherits a RED input yet claims GREEN (the **contamination rule**). | [`commercial-ok-gate.md`](commercial-ok-gate.md) |
| **F3** | the surface **crosses the no-advice line** — a personalized/directive call ("you should buy", "put N% into", a named security paired with a near-term price view) rather than impersonal, bull-and-bear, scenario/invalidation framing. The boundary = directionality + addressee + modality, NOT topic. | `guards/no-advice.ts`; SEC/FINRA + SEBI |
| **F4** | it is a **metric in a costume** — a number/dial/chart/"insight" that changes no reader's understanding or decision; a regime board with no displayed accuracy ("an opinion with a chart"); a signal whose **sign can be wrong** (e.g. longs-only 13F read as "smart-money crowding") dressed as a live signal. | the user's standing question: *"who reads this, and what do they do differently after?"* |
| **F5** | a capability landed in the **wrong layer** — agent-reasoning content in a dev-skill (never loaded at runtime), fetch logic in a runtime product-skill (never runs), a number the model should fetch hardcoded instead of a tool. | [`skill-layer-law.md`](skill-layer-law.md) |
| **F6** | a backend non-negotiable is violated — relative import missing the `.js` extension; a socket/timer/poller on the Vercel serverless path instead of `worker/` or an external cron; persist/wire-tail happening **after** `res.end()`; a secret/`userId` supplied by the model instead of injected by closure. | non-negotiables #3–#7 |

### B3 — The hunt catalogue (sweep every category; the AI-tell is universal)

- **Hack wrapped in senior ceremony:** `setTimeout` to "fix" a race; `try/catch` that swallows; `as any` /
  `@ts-ignore` over a real type bug; hardcoded `// for now`; a `useEffect` dep array missing values that should
  re-trigger (silent staleness); five files of polish where one line of root cause was needed.
- **Cargo-cult lifted without its constraint:** a pattern copied from a blog/training-data without the
  constraint it solved; `Promise.all` where ordering matters; `key={index}` on a reorderable list; a cache with
  no eviction trigger; a fetch with no rate budget against a throttled upstream (GDELT, SEC).
- **Hallucinated metric:** "improves perf by N%" with no harness; "scales well" with no ceiling; "industry
  standard" with no industry named; "covered by tests" with no coverage delta.
- **The AI tell (hunt these in your own output first):** hallucinated API/option not in the installed version;
  the "fix" deletes/weakens the failing test or validator; end-of-turn summary claims a change the diff does
  not contain; sycophantic agreement with the prompt's framing over verification; **confidence uniformity**
  (a non-trivial change with zero `[unverified]` flags, zero open questions); prompt-vocabulary code; a fix
  written against a memory of the file, not the file on disk now; shotgun fluency (volume read as thoroughness).

### B4 — The interrogation battery (fire the ones the surfaces demand, in writing)

- **Lifecycle & state:** pre/postconditions and what enforces them; called twice / concurrently / re-entrantly;
  frame-0 (before mount/warmup/first fetch); in-flight async completing after unmount mutating what; the
  load-bearing invariant nothing enforces.
- **The error path:** has it ever executed; what the catch actually does (propagate / retry / fallback / silently
  convert a bug to a mystery); what renders on partial upstream data; what the user SEES on failure.
- **Data & flow:** how many sources of truth for this value after the change, who reconciles them, what the user
  sees while they disagree; is the cache keyed by everything that changes the output; does a Map/array grow
  unbounded.
- **Finance data & licensing:** where does each number originate (tool? cron? cache?) and is it grounded; the
  `commercialOk` verdict for the exact fetch path; the attribution rendered where the ToS requires it; the
  staleness/`unavailable` UX on a failed fetch.
- **Scale (R-SCALE):** the tier it survives and the next-tier break, in numbers; is the filtered/sorted column
  indexed; is the read surface compute-once-serve-many; is the contested write atomic + idempotent.
- **Trust boundaries:** where user-controlled data enters and where it's validated; authn AND authz (right user,
  right row); any secret reachable from client/bundle/committed file.
- **Claims & evidence:** the harness for every number; could the test have passed before the fix; does the
  summary assert anything the diff does not contain.
- **AI-authored code (fire at your own diff before staging):** every API/option verified against installed
  version this session; reporter not deleted; suspiciously fluent → interrogate hardest; verified against the
  file on disk now, not a memory.

A negation goal the negator genuinely cannot prove against real evidence is reported as **survived**, with
what was actually tried (searches run, repos/products read, battery questions attempted). That record,
accumulated across every goal and all three negators, is what an exit is made of.

## §C — The evidence mandate (non-negotiable)

A negation claim with no external proof is **noise and is discarded.** A negator may not approve OR condemn
from the top of its head. Every load-bearing claim is grounded in fact read THIS run:

- **Source of leader repos/products** — cite `repo@sha:file:line` or the URL. Read it; do not recall it.
- **Engineering/finance writing** — vendor docs, specs, eng blogs, regulator text (SEC/FINRA/SEBI), licensing
  ToS, peer-reviewed papers — cite the URL.
- **Benchmarks / measured numbers** from a named source; or first-principles math with the arithmetic shown.
- **The artifact's own codebase** at `file:line`, and the [sources-ledger](../memory/sources-ledger.md) for
  any licensing claim.

**Web search is REQUIRED, not optional.** "This won't scale" without a cited mechanism AND a prior-art
reference is discarded. Symmetrically, "this is fine" with zero searches and zero source reads is a
rubber-stamp — the iteration is invalid and re-run. Confidence may not exceed the evidence rung (measured >
first-principles > 3+ convergent codebases > single authoritative source > single blog > training-data
recall; flag the last as `[unverified]`).

## §D — The loop

1. Run all three negators concurrently on the full artifact, each with the full hypothesis + the complete
   negation-goal set (§B) + the evidence mandate (§C). Each covers everything; none is assigned a slice.
2. Collect evidence-backed findings: severity CRITICAL / MAJOR / MINOR, each tagged with the goal it lands on
   (Q1–Q5 / F1–F6 / catalogue category / battery question) and its external citation.
3. **If any negator lands an evidence-backed CRITICAL or MAJOR** → the hypothesis is proven on that point →
   revise the artifact (fix the code; or run deeper research where the gap is knowledge, not code) → GOTO 1.
   The whole loop re-runs against the revised artifact, because a fix can open a new hole.
4. **If a full iteration yields no evidence-backed CRITICAL or MAJOR from any of the three** → none could prove
   the hypothesis → the work has reached the senior-staff bar → exit. Only now may we assert it is in fact
   senior-staff work and the best available route.
5. MINOR findings are logged and fixed but do not, alone, fail the iteration.

**The exit is the assertion.** The work is presumed junior on every iteration and earns "senior-staff, best
route" only by surviving a full round in which three independent, well-researched veterans each tried and
failed to prove otherwise. We never declare quality; we declare that a genuine attack could not land.

## §E — Termination + escalation

- **Cap at 4 iterations.** If the artifact still draws evidence-backed CRITICALs after four rounds, STOP and
  escalate to the operator: the problem may be mis-scoped or the approach fundamentally wrong — a goal-level
  issue, not a fix-level one.
- **Never weaken the hypothesis or lower the evidence bar to force termination.** Exiting because the negators
  got tired or sloppy is the exact failure mode this rule exists to prevent. A clean exit requires negators
  that genuinely tried — searches run, repos/products read, batteries fired — and still could not land a hit.

## §F — Output (per negator, per iteration)

- `findings[]`: `{ severity, negation_goal (Q1–Q5 | F1–F6 | catalogue:§ | battery), surface,
  claim_attacked, external_evidence (repo@sha:file:line | url | file:line | ledger-row), why_it_breaks,
  fix_required }`.
- `verdict`: `PROVED_JUNIOR` (with the single biggest evidence-backed hole) | `COULD_NOT_DISPROVE_SENIOR`
  (listing what it actually tried per axis — the searches run, the repos/products/specs read, the goals
  attempted and failed).
- The lead synthesizes the three verdicts: any single `PROVED_JUNIOR` fails the iteration; a clean exit needs
  all three at `COULD_NOT_DISPROVE_SENIOR` with real attempts on record.

## §G — How to run it here

- **Solo or workflow.** For a small artifact, the main agent can run all three negator passes itself
  sequentially (still three independent passes, full goal set each). For anything substantial, spawn the three
  negators as a [Workflow](../../CLAUDE.md) `parallel()` fleet (each a structured-output agent over §F's
  schema), then a synthesis lead — this is the canonical adversarial-verify pattern.
- **The realest finding of all is when the negation proves the premise itself was never measured** — that the
  feature answers no real user question, regardless of how cleanly it's built. For Lumina surfaces, F4 ("metric
  in a costume") is where that lands; do not let a clean engineering pass hide a hollow product premise.

## Why this exists

A single self-review rubber-stamps its own work. A single reviewer has one blind spot. Two reviewers split by
lens each see half the artifact. An un-sourced critic trades one vibe for another. Three independent,
evidence-bound veterans — each attacking the whole artifact, each operationalizing the full charter as goals
to prove rather than questions to ask — is the cheapest way to find the break before production does. The
loop converges on senior-staff quality because it exits ONLY when a genuine, well-researched attack across
every axis cannot land.
