# Section Zero — The Plain-English User-Impact Opener on Every Plan

> **Status.** Topical, always-loaded for the trigger paths in §1. The canonical reference for Section Zero. Read before writing any plan file, before reviewing another agent's plan, and any time the next thing you write would commit the team to a change.
>
> **Loading.** Re-load when (a) about to write or open a plan under `.agents/plans/`, (b) reviewing a plan as a peer-review gate, (c) responding to the operator's request for a plan / spec / proposal, (d) about to skip Section Zero because "the task is small" or "the change is obvious."
>
> **Relationship to other rules.** The plan-making rule mandates the technical plan body (Sections 1–10); **this rule owns the Section Zero contract that opens every plan.** The research-and-plan rule mandates the research artifact for high-value surfaces; when both fire, the research comes first and Section Zero opens the plan derived from it. The project's operating rules also govern: approved plans execute in WHOLE; Section Zero carries substance, never padding; and Section Zero lives in the gitignored `.agents/` workspace, never tracked.

---

## §1 — Where Section Zero is mandatory vs recommended

| Artifact | Section Zero | Why |
|---|---|---|
| **Plans** (`.agents/plans/`) | **MANDATORY** — a plan without it is rejected on sight. | A plan that cannot say what the user gets has not earned the right to talk about implementation. |
| **Audits / research / rebuttals / post-mortems** (`.agents/`) | **RECOMMENDED** — adapt the opener to the artifact. | Same discipline: lead with who is affected and what changes for them, in plain English. |
| **Tracked code docs** (`docs/`, `README.md`) | NOT required (the docs rule governs that content). | Different audience, different IP contract. |

The hard line: **plans get Section Zero or they get rejected.**

---

## §2 — The principle

Section Zero is the first thing in every plan: a short, plain-English summary of what the end user gets after the plan ships, followed by a tight bulleted list of those outcomes from the user's point of view. It exists so anyone — the operator, a reviewer, a teammate who has never opened the codebase — understands the whole point of the plan and its impact on the person using the product before reading a single technical line.

It is deliberately not detailed. No metrics tables, no harness catalogs, no file paths, no rule numbers, no implementation. Just two things in plain English: what changes for the user, and how we'll know it worked. The detailed measurement lives below, in the plan body (Sections 1–10). Section Zero's only job is the user-impact answer and the success check at the top.

**A plan that cannot answer "what does this change for the person using the product?" and "how will we know it worked?" in plain English at the top has not earned the right to talk about implementation at the bottom.**

---

## §3 — The format

Section Zero is three parts, all plain English, all short:

1. **A 4–5 line summary** of the end-user impact — what the user gets, said plainly enough that a non-engineer grasps the plan's whole point and why it matters to them.
2. **Up to 10 bullets**, each one outcome from the end user's point of view — the goal, the achievement, the impact. One outcome per bullet, plain English: what the user can now do, see, or reach that they could not before.
3. **How we'll know it worked** — a few one-line success signals. Each is the concrete observable thing that is true if the plan worked: a behavior, a count, a check that passes. One signal per line. No tables, no harness names, no before/after matrices. If something can't be measured yet, say that in the line.

Copy this template to the top of every plan:

```markdown
## §0 — Section Zero

[A 4–5 line plain-English summary of what the end user gets after this
plan ships. A layman should understand the plan's whole point and its
impact on the person using the product from these lines alone. No file
paths, no rule numbers, no jargon, no implementation detail.]

- [End-user outcome — what they can now do / see / reach]
- [End-user outcome]
- [... up to 10 bullets, each one user-facing outcome, plain English]

**How we'll know it worked**
- [One-line success signal — the observable thing that is true if it worked]
- [... a few crisp lines, one signal each]
```

**Name the user.** Designer, developer, community viewer, end customer of the shipped product, or the team — say whose experience changes, not a generic "the user."

**Internal-only plans.** If the plan has no observable user impact (pure refactor, internal plumbing), say so honestly in the summary: "No direct user-facing change. This is internal work that unblocks [the next thing that does reach users]." Naming an internal plan honestly is higher rigor than inventing a user impact that is not there. The bullets then name what the work unblocks, and the success signals name the internal check (a parity audit stays green, the type errors are gone, the next plan's unblock is observable).

---

## §4 — Worked example (a notifications feature)

```markdown
## §0 — Section Zero

Users will now know the moment something happens to their work
without keeping the app open. When a long-running job finishes, an
item is published, a teammate comments, or an export is ready, a
notification tells them right away. The whole point of this plan is to
close the gap between "something happened" and "the user finds out," so
a result or a reply is never missed again.

- A user gets a live alert the instant a long-running job finishes, instead of checking back manually.
- A user is told the moment their published item goes live.
- A user sees a badge as soon as a teammate comments on their work.
- A user is notified when an export is packaged and ready to download.
- Every notification links straight to the thing it is about, one click away.
- Unread alerts survive closing the tab, so nothing is lost between sessions.
- A user can mute the categories they do not care about and keep the feed relevant.

**How we'll know it worked**
- A finished job lands a notification in the bell within a second, every time.
- Publishing an item fires a "went live" alert with no misses across a day of use.
- Unread counts survive a full page reload.
- Muting a category stops its alerts on the spot.
```

Why it passes: plain English throughout, names the user, a 4–5 line summary then one user-facing outcome per bullet under ten bullets, then a handful of one-line success signals — each a concrete observable, no tables, zero implementation detail.

---

## §5 — What Section Zero is NOT

- **Not implementation.** "Refactor `RenderPipeline.tsx` to use a Map" is technical body, not Section Zero.
- **Not jargon.** "Migrate the dispatch layer to the new four-class contract" → plain English: "results will look the same on a customer's site as they do in the editor."
- **Not a restatement of the prompt.** The prompt said what to do; Section Zero says what the product becomes for the user.
- **Not marketing.** Factual and restrained. "Revolutionary new experience" fails; "the user edits inline and sees the result in under a second" passes.
- **Not a metrics report.** The "how we'll know it worked" part is crisp one-line success signals, not before/after tables, harness catalogs, or threshold matrices. The detailed numbers live in the technical body's verify section.
- **Not optional.** Even one-day plans and pure refactors get Section Zero — the refactor's summary says "no direct user-facing change" honestly.

---

## §6 — Catch-yourself triggers

- *"Section Zero is obvious, I'll skip it."* → It IS the contract. Skipping it skips the user-impact answer.
- *"I'll write the body first and back-fill Section Zero."* → Section Zero shapes the body. Reverse-engineering it is rationalization.
- *"Too technical to explain plainly."* → If you cannot explain it to a smart non-engineer, you do not understand it yet. Re-read the code until you do.
- *"The user impact is obvious — they get the new feature."* → Zero substance. Name the user and the specific outcome they get.
- *"More bullets looks thorough."* → The cap is ten, and fewer real outcomes beat ten padded ones. One outcome per bullet, no filler.
- *"This is a pure refactor, Section Zero doesn't apply."* → It does. Say "no direct user-facing change" honestly and name what it unblocks.

---

## §7 — Pre-stage audit

Run before staging any plan. Each item: pass / failed-then-fixed.

1. **Summary present?** 4–5 plain-English lines a non-engineer could follow?
2. **Outcome bullets present?** Up to 10, each one user-facing outcome, one per bullet?
3. **Success signals present?** A few one-line "how we'll know it worked" signals, each a concrete observable, no tables?
4. **User named?** Designer / developer / viewer / customer / team — not generic "the user"?
5. **Plain English throughout?** No file paths, no rule numbers, no unexpanded acronyms, no implementation?
6. **Honest on internal-only plans?** No invented user impact; names what the work unblocks and the internal success check?
7. **No padding?** Would dropping a bullet or a signal lose a real outcome? If not, it was padding — cut it.

Any "failed" without "fixed" → rework. Do not stage.

---

## §8 — Why this rule exists

Plans that open with "Step 1: refactor X" make the reviewer read pages of file paths and never learn what the user gets. The work ships, and weeks later nobody can say in one sentence what it changed for the user. Section Zero fixes that by forcing the user-impact answer to the top, in plain English, before any technique.

It is kept short on purpose. A heavy, metrics-laden opener defeats its own goal — the point is that anyone can read it in fifteen seconds and understand the plan's impact on the person using the product. Crisp and concise is the requirement, not a nicety.

---

## §9 — Source

An operator directive extracting the Section Zero pattern into its own rule, later refined to the crisp form — a 4–5 line plain-English user-impact summary, up to 10 end-user-outcome bullets, and a few one-line "how we'll know it worked" success signals — after the rule had drifted into a detailed pre/post-metrics contract that worked against its own purpose. The success-check substance stays; only the table-and-harness bloat is gone, boiled down to crisp one-liners. Industry convergence on leading with user impact and a success check before mechanics: Amazon Working Backwards / PR-FAQ, Spec-Driven Development (specification before plan), Addy Osmani's spec-for-agents ("lead with user problems and business outcomes").

---

## §10 — Index entry

For the rules README Rule Index:

- **Section Zero is mandatory at the top of every plan.** A crisp, plain-English user-impact opener in three short parts: a 4–5 line summary of what the end user gets after the plan ships, then up to 10 bullets each one user-facing outcome (goal / achievement / impact), then a few one-line "how we'll know it worked" success signals (each a concrete observable). No metrics tables, no harness catalogs, no file paths, no jargon, no implementation — the detailed numbers live in the technical body (Sections 1–10). Name the user (designer / developer / viewer / customer / team); for internal-only plans, say "no direct user-facing change" honestly and name what the work unblocks plus the internal success check. A plan without Section Zero is rejected on sight. Companion to the plan-body rule (technical body) and the research-and-plan rule (research precondition on high-value surfaces).
