---
name: health-discover
description: >
  Build Lumina's Health vertical: the health news/content feeds
  ([`backend/discover/health.ts`](../../../backend/discover/health.ts) via NewsData.io →
  Tavily fallback), the health-view UI + Discover carousel
  ([`frontend/src/components/discover/health-view.tsx`](../../../frontend/src/components/discover/health-view.tsx)),
  the guided health workflows + lab-report document upload (which becomes multimodal content for
  the chat agent via `buildAttachmentParts`), medical-information safety/disclaimers (informational,
  never diagnosis or treatment), and the licensing of health content (headline + link-out only,
  `commercialOk:false`). Use whenever the task touches the Health tab, health news cards, the
  /discover/health route, health workflows, uploading a report/lab result, medical safety framing,
  or who/cdc/nih/icmr source quality.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/discover/health.ts'
    - 'backend/discover/shared.ts'
    - 'backend/discover/routes.ts'
    - 'frontend/src/components/discover/health-view.tsx'
    - 'frontend/src/components/discover/discover-parts.tsx'
    - 'frontend/src/hooks/use-discover.ts'
    - 'frontend/src/lib/discover-api.ts'
  promptSignals:
    phrases:
      - 'health'
      - 'medical'
      - 'health news'
      - 'newsdata'
      - 'symptom'
      - 'wellness'
      - 'health workflow'
      - 'upload report'
      - 'lab results'
      - 'health vertical'
      - 'health tab'
      - 'medical advice'
    minScore: 3
---

# health-discover

> Build Lumina's Health vertical the way the live code does: a cached card feed on the shared
> Discover pattern (NewsData.io → Tavily fallback, headline + link-out only), guided "Health
> Workflows" that open the chat agent, a lab-report upload that becomes multimodal content for the
> agent, and a hard safety contract — informational, never diagnosis or treatment. This skill maps
> any Health task to the exact reference + the exact file in
> [`backend/discover/`](../../../backend/discover/) and
> [`frontend/src/components/discover/`](../../../frontend/src/components/discover/).

---

## Domain Identity

**This skill OWNS:**
- The health **feeds**: [`backend/discover/health.ts`](../../../backend/discover/health.ts)
  (`fetchHealthDiscover` orchestrator → `fetchHealthNewsData` / `fetchHealthTavily`), the global vs
  India trusted-domain lists, and its `Provenance` (`commercialOk:false`).
- The health **routes**: the `/discover/health` branch + cron warmer in
  [`backend/discover/routes.ts`](../../../backend/discover/routes.ts).
- The health **UI**: [`frontend/src/components/discover/health-view.tsx`](../../../frontend/src/components/discover/health-view.tsx)
  (search box, `WORKFLOWS` cards, the file-upload right rail, the Discover carousel + market toggle),
  rendered via the shared [`discover-parts.tsx`](../../../frontend/src/components/discover/discover-parts.tsx),
  hooked by `useHealthDiscover` in [`use-discover.ts`](../../../frontend/src/hooks/use-discover.ts).
- The health **workflows + document upload** UX: `fileToAttachment` →
  [`buildAttachmentParts`](../../../backend/index.ts) (multimodal `image`/`file` parts).
- **Medical-information safety** for everything above (not-advice framing, authoritative sources).
- Health-content **licensing & attribution**.

**This skill does NOT own (route elsewhere):**
- The shared discover/chat answer pipeline (web search → `streamText` → `[n]` citations on
  `/perplexity_ask`) → **research-agent**. The workflow/search box just calls `onAsk`; that skill
  owns what happens after.
- The AI-SDK engine itself (`streamText`, tools, hooks, how `buildAttachmentParts` content is
  consumed by the model) → **ai-sdk-agent**.
- The generic app shell, sidebar, routing, chat-view render → **lumina-frontend**.
- The Finance Discover feed + market-data licensing mechanics → **finance-markets** (this skill
  reuses its ship-rule; that skill owns its data).

---

## Decision Tree

```
Health task arrives
|
+-- "How is the whole Health vertical wired? where does X live?" --> lumina-health-vertical.md
+-- "Add/change a health news SOURCE; categories; cadence; can we display it?" -> health-news-sourcing.md
+-- "Disclaimers / not-advice / diagnosis / dosage / emergency framing" ------> medical-info-safety.md
+-- "Upload a report → multimodal; how a file reaches the agent; privacy" ----> health-workflows-and-upload.md
+-- "The shared Discover card-feed pattern (shared.ts) used by health+academic" -> discover-feed-architecture.md
+-- "What health TOPICS to cover; source-quality tiers; trustworthy answer" --> health-domain-coverage.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Informational, NOT medical advice.** Never diagnose, prescribe, give a dosage, or tell an individual what treatment to take. Frame in general terms; point to a clinician and authoritative bodies (WHO/CDC/NIH/ICMR). Surface emergencies ("seek urgent care / call your local emergency number"). | The `WORKFLOWS` prompts in `health-view.tsx` are deliberately framed as guidance ("Explain how to read…", "evidence-based ways to…", "Note anything I should discuss with a doctor"), never "tell me what I have." See `medical-info-safety.md`. |
| 2 | **News is transformative synthesis + link-out citations — never republished article text.** A card exposes only headline + source + outbound link + (hotlinked, never re-hosted) image + timestamp. The publisher body/snippet/abstract is NEVER stored or displayed. | Enforced in `health.ts`: `DiscoverArticle` has no `content` field; the Tavily lane explicitly drops `r.content`. Cross-ref `health-news-sourcing.md` + the `discover-news-licensing` memory + finance licensing. |
| 3 | **`commercialOk` stays `false` for all publisher-derived health content** until a display licence is signed — free API tier ≠ commercial-display licence. | `fetchHealthNewsData`/`fetchHealthTavily` both hardcode `commercialOk:false` in their `Provenance`. Build-and-demo-only; never cleared for public launch on that basis. |
| 4 | **Uploaded reports are user PHI-adjacent.** Handle carefully, never leak across users, never log file bytes. The file flows as a base64 multimodal part to the model **for that request only** — there is no health-file store, and it must not enter the shared semantic cache. | `fileToAttachment` (base64, strips data-URL prefix) → `buildAttachmentParts` builds `image`/`file` parts. The model must be vision/doc-capable (Claude/Gemini/GPT) — Sonar can't read them. See `health-workflows-and-upload.md`. |
| 5 | **The feed must NEVER go dark.** NewsData (real per-article images) is primary; on missing key / failure / empty result it falls back to a Tavily search scoped to trusted health domains. | `fetchHealthDiscover` try/catch → `fetchHealthTavily`. The carousel always has news. |
| 6 | **Backend-proxied keys only.** `NEWSDATA_API_KEY` / `TAVILY_API_KEY` are read from `process.env` server-side; the browser only hits `/discover/health`. | `newsdataKey()` reads env; the frontend `useHealthDiscover` hits the cached route. |
| 7 | **Health is informational reads — `?market=us|in` serves a SEPARATE cache key** (`discover:in:health` vs `discover:health`), 10-min TTL, kept hot by the cron warmer. India uses Indian trusted domains (ICMR/PIB/MoHFW + Indian press). | `discoverRoute` + `TTL.health=600` + `/cron/refresh` in `routes.ts`; `INDIA_HEALTH_DOMAINS` in `health.ts`. |
| 8 | **New backend files need a full dev-server restart** — Bun `--hot` does not pick them up. Relative imports need explicit `.js` extensions or Vercel's ESM resolver fails the build. | Recurring gotcha across the repo. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| A workflow that says "tell me what disease I have" / outputs a diagnosis or a drug dose. | Frame as guidance + "discuss with a doctor"; explain general ranges, route to authoritative bodies, surface emergencies. (Mirror the existing `WORKFLOWS` prompts.) |
| Storing/displaying the article body or NewsData/Tavily snippet to look richer. | Headline + source + link-out + hotlinked image + timestamp only. The card type has no body field by design. |
| Flipping `commercialOk:true` because "the NewsData call worked." | It gates *legal display*, not technical access. Stays `false` until a display licence is signed. |
| Persisting an uploaded lab report to disk/DB, logging its bytes, or caching the answer. | Pass it as a per-request base64 multimodal part only; exclude health-upload answers from the semantic cache; never log file contents. |
| Re-hosting the publisher's image on our origin. | Hotlink the source's own `og:image` (browser UA via `fetchOgImage`); blockers → `null` → clean placeholder. |
| Letting the health feed 500 / go blank when NewsData is keyless or rate-limited. | Orchestrator falls back to the trusted-domain Tavily search; `getOrRefresh` serves stale on error. |
| Treating India like the US path (US publishers, no country filter). | `market==="in"` → `country=in&category=health`, `INDIA_HEALTH_DOMAINS`, and a separate `discover:in:health` cache key. |
| Sending an uploaded PDF/image to a non-vision model (Sonar). | Route uploads to a vision/doc-capable model (Claude/Gemini/GPT); `buildAttachmentParts` emits `image`/`file` parts those models read. |
| Re-implementing dedup/canonicalization/date parsing in `health.ts`. | Reuse `canonicalUrl`/`hostOf`/`toIso`/`finalizeArticles` from `shared.ts` — every Discover vertical shares them. |
| Answering a "today / latest outbreak" health query from the model's memory. | That's the research pipeline's job (live web search) — route via `onAsk`; never fabricate health facts or dates. |

---

## Output Contract (what "done" looks like)

A Health change is done when:
1. **Feed:** any new source returns the shared `DiscoverArticle` shape (no body field), carries a
   `Provenance` with `commercialOk:false` + an attribution string, runs through `finalizeArticles`,
   and has a NewsData→Tavily (or equivalent) fallback so the carousel never goes dark.
2. **Route + cache:** served via `getOrRefresh` on a `discover:health` / `discover:in:health` key
   with a sensible TTL, behind `financeRateLimit`, and added to the cron warmer's job list.
3. **Safety:** workflow prompts and any health prose are informational only — no diagnosis, dosage,
   or personalized treatment; emergencies are surfaced; authoritative bodies are named; the
   not-advice framing is present.
4. **Upload:** an uploaded report becomes a multimodal part via `fileToAttachment` →
   `buildAttachmentParts`, is routed to a vision/doc-capable model, is NOT persisted or cached, and
   never crosses users.
5. **Licensing:** you can state in one sentence whether the content is cleared for public display
   (it isn't, until licensed) and what attribution renders.
6. **UI:** the market toggle, workflow cards, upload rail, and carousel render via `discover-parts`;
   `useHealthDiscover` polls aligned to the 10-min cache; failure shows the rate-limited/down state.
7. **Verified:** `GET /discover/health?market=us|in` returns 200 with articles; a workflow click and
   an upload both reach the chat answer. New backend files → full restart done.

---

## Bundled References (6 files)

Read the one or two the task needs — never the whole folder.

| File | Load when |
|------|-----------|
| `lumina-health-vertical.md` (project-grounded) | You need the full wiring map: `health.ts` feeds, the `/discover/health` route + cron warmer, the `health-view` + `discover-parts` UI, `useHealthDiscover`, and the workflows/upload feature. Start here when lost. |
| `health-news-sourcing.md` (project-grounded) | Choosing/debugging a health feed source: NewsData.io (filtered vs keyword retry, `image=1`/`removeduplicate=1`), the Tavily fallback, the trusted-domain lists, categories, cadence/caching, and the licensing reality (free-tier-display trap, transformative synthesis). Cross-ref finance licensing + `discover-news-licensing` memory. |
| `medical-info-safety.md` (generic) | Anything about safety framing: not-advice disclaimers, avoiding diagnosis/dosage, naming authoritative sources (WHO/CDC/NIH/ICMR), expressing uncertainty, emergency framing, and age/condition sensitivity. |
| `health-workflows-and-upload.md` (project-grounded) | The workflows + document upload: how an uploaded report becomes multimodal content for the agent (`fileToAttachment` → `buildAttachmentParts`), model capability requirements, processing, and privacy (PHI-adjacent, no persistence, no cache). Cross-ref ai-sdk-agent multimodal. |
| `discover-feed-architecture.md` (project-grounded) | The shared Discover feed pattern in `shared.ts` used by health + academic: the card shape, `canonicalUrl`/`finalizeArticles`/`fetchOgImage`/`toIso`, the fetch→shape→cache flow, the market-aware cache key, and how it differs from the chat pipeline. Cross-ref research-agent. |
| `health-domain-coverage.md` (generic) | A health-topic taxonomy (conditions, symptoms, wellness, nutrition, mental health, fitness, sleep), source-quality tiers, and what makes a trustworthy health answer. |

---

## Cross-repo prior art / cross-skill routing

- **research-agent** owns the shared search→answer pipeline that every Health workflow + search box
  triggers via `onAsk`; **ai-sdk-agent** owns the engine that consumes the multimodal parts this
  skill builds.
- **finance-markets** is the closest sibling: the Health feed is a direct generalization of finance
  Discover (`backend/finance/news.ts`), reusing the same ship-rule and `Provenance`/card shapes —
  read its `data-licensing-and-compliance.md` for the deep licensing rationale.
- **lumina-frontend** owns the app shell/routing that mounts `HealthView`.
- Project memory: `discover-tabs-build` (the Health + Academic tabs as shipped),
  `discover-news-licensing` (the legal ship-rule + the free-tier-display trap), and `brand-is-Lumina`.
  Verify against live code before relying on any `file:line`.
