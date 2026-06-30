# 06 — The 2026 Discourse, Prior Art, and Citation Index

> Who said what, when, and how much to trust it. This is the map of the "loop engineering" movement the trend rides on, plus the full source index behind this skill. Use it to ground a claim, cite a practitioner, or separate the real signal from the LinkedIn froth. Confidence tags: **measured** (real artifact, numbers) · **convergent** (3+ independent sources agree) · **single-source** · **anecdotal/self-reported** · **hype**.

---

## The naming moment vs. the technique's real age

The *name* "loop engineering" is weeks old (June 2026); the *technique* runs back years. Don't let the viral framing imply novelty it doesn't have.

```
2022  ReAct (arXiv:2210.03629) ............... the academic while-loop agent
2023  AutoGPT / BabyAGI ....................... first mass-viral self-prompting loop
       Reflexion / Self-Refine / ToT / Voyager . the pattern literature
Jul 2025  Ralph loop (Geoffrey Huntley) ....... disciplined bash loop, filesystem-as-memory
Nov 2025  Anthropic "Effective Harnesses for Long-Running Agents" . first official multi-session loop doc
Dec 2025  Anthropic ralph-wiggum plugin ....... technique productized
Jan 2026  Gas Town (Steve Yegge) ............. multi-agent orchestration factory
~Apr 2026 /loop self-pacing ships ............. time-driven recurrence in Claude Code
Apr 30 2026  OpenAI Codex /goal ("Ralph loop++") . condition-driven continuity, other vendor
~May 2026 /goal ships in Claude Code .......... condition-driven continuity (v2.1.139)
~May 2026 dynamic workflows / ultracode ....... scripted multi-agent orchestration
Jun 8 2026  Steinberger post + Osmani essay ... the viral NAMING of "loop engineering"
```

Verify exact dates/versions against live docs before quoting — they drift, and several are reconstructed from secondary coverage.

---

## Named practitioners and what they actually claimed

| Person | Role | Claim / contribution | Confidence |
|---|---|---|---|
| **Geoffrey Huntley** | Independent | Invented the Ralph loop (Jul 2025). Built "Cursed Lang" compiler over 3 months on one prompt. $297 greenfield MVP. "Deterministically bad in a non-deterministic world." | convergent (technique); anecdotal (cost) |
| **Boris Cherny** | Head of Claude Code, Anthropic | "My job is to write loops." Deleted his IDE Nov 2025; 259 PRs in 30 days, 100% Claude-authored; 20-30 PRs/day across 5 parallel instances. "Loops are the step from agents to the next thing." | measured/self-reported |
| **Peter Steinberger** (@steipete) | OpenClaw creator → OpenAI | The viral post (Jun 8 2026, 6.5M views): "You shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents." | convergent (post text); hype ($1.3M token claim) |
| **Addy Osmani** | Google Chrome eng. | Named + gave anatomy to "loop engineering" (Jun 2026): six building blocks — Automations, Worktrees, Skills, Plugins/Connectors, Sub-agents, Memory. Named comprehension debt + cognitive surrender. "Build the loop. Stay the engineer." | convergent (the canonical taxonomy piece) |
| **Steve Yegge** | ex-Google/Sourcegraph | Gas Town (Jan 2026): Mayor + Polecats, 20-30 instances, git-backed ledger, bisecting merge queue. "Kubernetes, but for agents." "Expensive as hell." | convergent (system); anecdotal (75K LOC/17 days) |
| **Garry Tan** | YC CEO | gstack (Mar 2026): 23 slash commands; Think→Plan→Build→Review→Test→Ship→Reflect; 10-15 parallel sprints. | measured (stars); anecdotal (810× productivity, self-defined metric) |
| **Dex Horthy** | HumanLayer | Documented Ralph's history; critique that the official plugin "missed the key point of ralph — carving small bits into independent context windows." | convergent |
| **Cat Wu** | Head of Product, Claude Code | Co-architect of /loop, /goal, Routines. | single-source |
| **Andrej Karpathy** | Independent (ex-OpenAI/Tesla) | AutoResearch: ML experiments in a loop keeping only benchmark-beating changes. Noted agents "act cagy"/conservative (local-minima trap). | convergent |
| **Justin Young et al.** | Anthropic Engineering | "Effective Harnesses for Long-Running Agents" (Nov 2025): the two-agent initializer+coder shift pattern. | official |

---

## Signal vs. hype (the honest separation)

**Genuine signal (build on this):**
- The moat shifts from model to harness/loop as models commoditize. The progression prompt → context → harness → loop engineering is convergent.
- **Maker/checker separation** is the single highest-value structural rule — independently convergent across Cherny, Osmani, Squid, and the skeptics.
- **Fresh-context-per-iteration** (Ralph) is a real architectural win (O(N) vs O(N²), no context rot).
- **Falsifiable, externally-judged stop conditions** are what separate working loops from token furnaces. `/goal`'s separate-evaluator design is the productized form.
- **Comprehension debt / cognitive surrender** are concrete, named human failure modes with recovery paths.

**Froth (discount it):**
- "The loop is the product" / "🔥 this is the future" posts that teach none of the verifier, stop condition, or cost model — i.e., most LinkedIn restatements of Steinberger's one sentence.
- Self-reported personal productivity metrics presented as benchmarks (Cherny's 259 PRs, Tan's 810×) — directionally interesting, not measurements you can plan against.
- Same-day SEO-opportunistic rephrasings of the Osmani essay across generic tutorial sites.
- Unsourced figures ("~4% of public GitHub commits", "68% of agents run ≤10 steps", "520 credential leaks") — flagged single-source/unverified until traced to a primary.

---

## Citation index

**Official Anthropic / Claude Code docs (code.claude.com/docs):**
- Scheduled tasks (`/loop`): `/en/scheduled-tasks` · Goal (`/goal`): `/en/goal` · Routines (`/schedule`): `/en/routines` · Dynamic workflows: `/en/workflows` · Agent loop (SDK): `/en/agent-sdk/agent-loop` · Agent teams: `/en/agent-teams` · Commands: `/en/commands` · What's new: `/en/whats-new`
- Anthropic Engineering: *Effective Harnesses for Long-Running Agents* (anthropic.com/engineering/effective-harnesses-for-long-running-agents, Nov 26 2025) · *Building Effective Agents* (anthropic.com/research/building-effective-agents, Dec 2024) · *Effective Context Engineering for AI Agents* (anthropic.com/engineering/effective-context-engineering-for-ai-agents, Sep 2025) · *Claude Code auto mode* (anthropic.com/engineering/claude-code-auto-mode) · *April-23 postmortem* (anthropic.com/engineering/april-23-postmortem)

**Ralph & the practitioner movement:**
- ghuntley.com/ralph/ (Jul 14 2025) · ghuntley.com/loop/ (Jan 2026) · github.com/ghuntley/how-to-ralph-wiggum · github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md · humanlayer.dev/blog/brief-history-of-ralph · zerosync.co/blog/ralph-loop-technical-deep-dive · joshowens.dev/ralph-wiggum-subagents/ · linearb.io/blog/dex-horthy-humanlayer-rpi-methodology-ralph-loop

**Loop-engineering naming + discourse:**
- addyosmani.com/blog/loop-engineering/ · thenewstack.io/loop-engineering/ · explainx.ai/blog/loop-engineering-coding-agents-claude-code-guide-2026 · bdtechtalks.com/2026/06/22/ai-loop-engineering/ (loopmaxxing critique) · alphasignalai.substack.com/p/most-developers-do-not-need-agent (four-conditions test) · latent.space/p/ainews-loopcraft-the-art-of-stacking · howborisusesclaudecode.com · newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny · digg.com/ai/7ifyvmb9 (Steinberger recap) · medium.com/@meghanaharishankara/the-ai-loops-fight-isn-t-about-ai-loops

**Orchestration systems:**
- steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 + github.com/gastownhall/gastown · github.com/garrytan/gstack · decodingai.com/p/squid-my-agentic-coding-setup-may-2026

**Practical tutorials:**
- freecodecamp.org/news/how-to-build-a-production-safe-agent-loop-from-exit-conditions-to-audit-trails · dev.to/javatarz/multi-agent-development-workflows-with-claude-code-n23 · dev.to/samhath03/how-i-stopped-claude-code-from-hallucinating-on-day-4 · mindstudio.ai/blog/how-to-build-an-agentic-loop-claude-code · gaodalie.substack.com/p/how-to-build-a-claude-loop-engineering · damiangalarza.com/posts/2026-02-13-linear-agent-loop · medium.com/@souma.paul/building-an-agentic-rag-with-claude-code

**Cost & failure analysis:**
- leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026 · makeuseof.com/someone-left-claude-code-running-overnight-and-it-cost-6000 · ralphable.com/blog/claude-code-infinite-loop-bug-how-to-spot-stop-fix · getgodmode.dev/blog/claude-code-skips-tests.html · buildtolaunch.substack.com/p/claude-code-token-optimization · alex000kim.com/posts/2026-03-31-claude-code-source-leak · developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows

**Academic foundations (arXiv):**
- ReAct 2210.03629 · Reflexion 2303.11366 · Self-Refine 2303.17651 · Tree of Thoughts 2305.10601 · Plan-and-Solve 2305.04091 · Voyager 2305.16291 · Goal Drift 2505.02709 · Plan-and-Act 2503.09572 · HTN structural complexity 2401.14174

**Cross-vendor (for contrast):**
- OpenAI Codex `/goal` (v0.128.0, Apr 30 2026; Greg Brockman "built-in Ralph loop++"); a16z Andrew Chen's 14-hour `/goal` device-driver run.

---

## How to use this file

- Citing a claim in a plan/review → pull the source + confidence tag from here; never state a confidence above the tag.
- Someone cites a viral post as proof → check it against the signal-vs-hype split; self-reported metrics are not benchmarks.
- Need the primary mechanism → official docs first (rung 4), the practitioner write-ups for patterns (rung 3-5), arXiv for the foundations (rung 4 peer-reviewed). This harness's own tool definitions outrank all of them (rung 1) for how `/loop`, `/goal`, `ScheduleWakeup`, and `Workflow` actually behave here.
