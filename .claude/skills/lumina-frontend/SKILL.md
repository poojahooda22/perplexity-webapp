---
name: lumina-frontend
description: >
  Build Lumina's React/Vite frontend: the app shell + routing, streaming chat rendering
  (parsing the wire protocol), TanStack Query patterns, the shadcn/Tailwind design system +
  theming, the API client + config gotchas, the composer + attachments + mic + model menu,
  and Supabase auth. Use whenever the task touches the SPA shell, the chat view, how answers
  render, data-fetching/caching on the client, the design system/theme, the search composer,
  or the sign-in flow. Consumes the backend stream — it does NOT produce it.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'frontend/src/**'
    - 'frontend/src/components/**'
    - 'frontend/src/pages/**'
    - 'frontend/src/lib/**'
    - 'frontend/src/hooks/**'
  promptSignals:
    phrases:
      - 'frontend'
      - 'react'
      - 'vite'
      - 'chat view'
      - 'tanstack'
      - 'shadcn'
      - 'tailwind'
      - 'composer'
      - 'theme'
      - 'streaming UI'
      - 'section tab'
    minScore: 3
---

# lumina-frontend

> Build Lumina's React/Vite SPA the way the live code already does it: a thin
> [`AppShell`](../../../frontend/src/components/layout/app-shell.tsx) (sidebar + top-nav +
> main) over a single [`Dashboard`](../../../frontend/src/pages/Dashboard.tsx) page whose
> `handleAsk`/`runTurn` flow drives **every** vertical, a chat view that renders by parsing
> the backend's exact wire tail, TanStack Query aligned to backend TTLs, a shadcn/Tailwind
> design system with dark-first theming, and Supabase OAuth carried to the backend as a
> bearer token. This skill is the map from any frontend task to the exact reference + file in
> [`frontend/src/`](../../../frontend/src/).

---

## Domain Identity

**This skill OWNS:**
- The app shell + routing: [`App.tsx`](../../../frontend/src/App.tsx) (`react-router` routes
  `/`, `/auth`, `/connectors`), [`app-shell.tsx`](../../../frontend/src/components/layout/app-shell.tsx),
  [`sidebar.tsx`](../../../frontend/src/components/layout/sidebar.tsx),
  [`top-nav.tsx`](../../../frontend/src/components/layout/top-nav.tsx) (the `SECTION_TABS`).
- The orchestrating page: [`Dashboard.tsx`](../../../frontend/src/pages/Dashboard.tsx) and its
  `handleAsk` → `runTurn` → `streamAsk`/`streamFollowUp` flow that every vertical funnels through.
- Streaming chat rendering: [`chat-view.tsx`](../../../frontend/src/components/chat-view.tsx)
  (incremental markdown, `[n]` citation linkify, sources/images/follow-up chips) and the wire
  parser `parseStream` in [`lib/api.ts`](../../../frontend/src/lib/api.ts).
- Client data-fetching: [`lib/query.ts`](../../../frontend/src/lib/query.ts), the hooks in
  [`hooks/`](../../../frontend/src/hooks/), and the live-prices cache merge in
  [`use-live-prices.ts`](../../../frontend/src/hooks/use-live-prices.ts).
- The design system: [`components/ui/*`](../../../frontend/src/components/ui/) (shadcn), Tailwind,
  [`theme-provider.tsx`](../../../frontend/src/components/theme-provider.tsx) + dark mode,
  [`animated-tabs.tsx`](../../../frontend/src/components/ui/animated-tabs.tsx),
  [`accordion.tsx`](../../../frontend/src/components/ui/accordion.tsx), the
  [`brand.tsx`](../../../frontend/src/components/brand.tsx) wordmark/mark.
- The API client + config: [`lib/api.ts`](../../../frontend/src/lib/api.ts),
  [`lib/config.ts`](../../../frontend/src/lib/config.ts),
  [`lib/supabase.ts`](../../../frontend/src/lib/supabase.ts).
- The composer + inputs: [`search-hero.tsx`](../../../frontend/src/components/search-hero.tsx),
  [`attachments.tsx`](../../../frontend/src/components/attachments.tsx),
  [`mic-button.tsx`](../../../frontend/src/components/mic-button.tsx),
  [`model-menu.tsx`](../../../frontend/src/components/model-menu.tsx).
- Auth UI: [`pages/Auth.tsx`](../../../frontend/src/pages/Auth.tsx) and the session/token plumbing.

**This skill does NOT own (route elsewhere):**
- Producing the SSE stream / the `<ANSWER>`/`<SOURCES>` wire format, tools, persona, persistence →
  **ai-sdk-agent**. This skill **consumes** that contract; it does not define it.
- The internals of each vertical's view (FinanceView card feeds, discover carousels, health
  workflows) → **finance-markets** / discover skills. This skill owns the **shared shell** those
  views plug into via `onAsk={handleAsk}`.
- Backend caching/TTL semantics, providers, licensing → **finance-markets** / **ai-sdk-agent**.
  This skill only aligns the client refetch cadence to them.

---

## Decision Tree

```
Frontend task arrives
|
+-- "Where does X live? shell, routing, the handleAsk flow?" ----> lumina-frontend-architecture.md
+-- "Render the stream / parse <ANSWER>/<SOURCES>/<IMAGES>" -----> streaming-chat-rendering.md
+-- "Fetch/cache data, query keys, refetchInterval, mutation" --> tanstack-query-patterns.md
+-- "Add a ui/* component, theme/dark mode, tabs/accordion CSS"-> shadcn-tailwind-system.md
+-- "fetch wrapper / SSE read loop / BUN_PUBLIC_* / supabase" ---> api-client-and-config.md
+-- "Composer submit, attachments, mic, the model picker" ------> composer-and-attachments.md
+-- "Sign-in, session, send the token, protected route/redirect"-> auth-and-supabase-frontend.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **`BUN_PUBLIC_BACKEND_URL` is inlined at BUILD time and must be a full `https://` URL.** Bun replaces `process.env.BUN_PUBLIC_*` with the literal string when it transpiles, so a scheme-less value (`api.foo.com`) becomes a relative path and 404s. Changing it in Vercel requires a **frontend redeploy** — a runtime env change does nothing. | [`lib/config.ts`](../../../frontend/src/lib/config.ts); falls back to `http://localhost:3001`. |
| 2 | **The browser holds only the Supabase ANON key + the user's auth token — NEVER a vendor/service key.** All upstream provider keys live server-side; the client only ever ships `BUN_PUBLIC_SUPABASE_URL` + `BUN_PUBLIC_SUPABASE_ANON_KEY` and forwards the per-user `access_token`. | [`lib/supabase.ts`](../../../frontend/src/lib/supabase.ts); `authHeader()` in [`lib/api.ts`](../../../frontend/src/lib/api.ts). |
| 3 | **Render answers by parsing the exact wire protocol and keep it in lockstep with the backend.** The stream is answer text (inside `<ANSWER>`/`<FOLLOW_UPS>` tags) then `\n<SOURCES>\n<json>\n<SOURCES>\n` then `\n<IMAGES>\n<json>\n<IMAGES>\n`. If the backend changes a tag/delimiter, `parseStream` must change with it. | `parseStream` + `SOURCES_RE`/`IMAGES_RE` in [`lib/api.ts`](../../../frontend/src/lib/api.ts); consumed by [`chat-view.tsx`](../../../frontend/src/components/chat-view.tsx). |
| 4 | **Align TanStack Query refetch cadence to the backend cache/TTL — never poll faster than the data refreshes.** The backend already caches upstream reads; the client polls *our* endpoints gently. Polling a 60s-TTL endpoint every 5s just burns our serverless budget for stale repeats. | `staleTime: 20_000`, `refetchOnWindowFocus:false` in [`lib/query.ts`](../../../frontend/src/lib/query.ts); per-hook `refetchInterval` in [`hooks/`](../../../frontend/src/hooks/). |
| 5 | **`parseStream` runs on EVERY chunk — it must be safe on a partial buffer.** A half-streamed `<SOURCES>` JSON block must not throw; `parseJsonArray` swallows parse errors and the answer region is "everything before the first tag". | `runTurn`'s `onChunk` calls it repeatedly in [`Dashboard.tsx`](../../../frontend/src/pages/Dashboard.tsx). |
| 6 | **Model ids are AI Gateway `<provider>/<model>` strings that MUST match the backend `ALLOWED_MODELS` allowlist.** A picker id the server doesn't allow silently falls back to the default — the user thinks they switched models and didn't. | `MODELS`/`DEFAULT_MODEL` in [`model-menu.tsx`](../../../frontend/src/components/model-menu.tsx). |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Setting `BUN_PUBLIC_BACKEND_URL` in Vercel and expecting it to take effect without a rebuild. | Treat it as compile-time: set it, then **redeploy** the frontend. Always a full `https://` URL. |
| Shipping any provider/service-role key to the browser "to make the fetch work." | Keys stay server-side; the client proxies through the backend with the user's Supabase token in `Authorization`. |
| Hand-rolling regex on the raw stream inside the component, or re-parsing differently from the backend's format. | Use the single `parseStream` source of truth; change it in lockstep with the backend wire format. |
| Letting `parseStream` throw on a mid-stream partial JSON block. | Guard every parse (`parseJsonArray` returns `[]` on incomplete JSON); answer = region before the first tag. |
| Polling a finance/discover endpoint every few seconds for "freshness." | Set `refetchInterval` to match the backend TTL; rely on `staleTime` + `getOrRefresh` upstream. |
| Adding a model to the picker without touching the backend allowlist. | Keep `MODELS` ⊆ backend `ALLOWED_MODELS`, or the choice silently degrades to the default. |
| Building a per-vertical bespoke ask pipeline. | Every view calls `onAsk={handleAsk}`; the `vertical` is derived from `sectionRef.current` in `runTurn` — one streaming/persistence path. |
| Hardcoding colors instead of theme tokens. | Use Tailwind semantic tokens (`bg-background`, `text-muted-foreground`); dark mode is the `.dark` class toggled by the theme provider. |
| Writing "Perplexity" anywhere user-visible. | Brand is **Lumina** — use [`brand.tsx`](../../../frontend/src/components/brand.tsx); only literal API route names (`/perplexity_ask`) keep the old word. |
| Following a backend `302` redirect for a connector flow (loses the auth header on the hop). | Fetch the URL with the header attached, read it from JSON, then `window.location` to it (see `gmailStartUrl`). |

---

## Output Contract (what "done" looks like)

A frontend change is done when:
1. **Shell-routed:** new surfaces mount inside [`AppShell`](../../../frontend/src/components/layout/app-shell.tsx) (sidebar/header/main) and, if a vertical, drive asks via `onAsk={handleAsk}` — not a parallel pipeline.
2. **Config-safe:** every backend call goes through `BACKEND_URL` from [`lib/config.ts`](../../../frontend/src/lib/config.ts); no scheme-less URLs; no vendor keys in the bundle.
3. **Authed:** authenticated requests carry the Supabase `access_token` in `Authorization` via `authHeader()`; protected pages redirect to `/auth` when there's no session.
4. **Stream-correct:** rendering goes through `parseStream`, is safe on partial buffers, linkifies `[n]` citations, and surfaces sources/images/follow-ups; the parser matches the current backend wire format.
5. **Cache-aligned:** queries set a sensible `staleTime`/`refetchInterval` matched to the backend TTL; live data uses the `use-live-prices` merge, not a tight poll.
6. **On-system:** UI uses `components/ui/*` + Tailwind semantic tokens + the theme provider; dark mode works; brand surfaces use the Lumina wordmark/mark.
7. **Model-consistent:** any picker change keeps `MODELS` aligned with the backend `ALLOWED_MODELS`.
8. **Verified:** `bun run dev` (or the Vite build) compiles; the page renders in both themes; a real ask streams and renders end-to-end.

---

## Bundled References (7 files)

Read the one or two the task needs — never the whole folder.

| File | Load when |
|------|-----------|
| `lumina-frontend-architecture.md` | You need the wiring map: the app shell ([`app-shell`](../../../frontend/src/components/layout/app-shell.tsx), [`sidebar`](../../../frontend/src/components/layout/sidebar.tsx), [`top-nav`](../../../frontend/src/components/layout/top-nav.tsx) section tabs), routing ([`react-router` in `App.tsx`](../../../frontend/src/App.tsx)), pages (Dashboard/Auth/Connectors), and the `Dashboard` `handleAsk`→`runTurn` flow that drives every vertical. Start here when lost. |
| `streaming-chat-rendering.md` | Working on [`chat-view.tsx`](../../../frontend/src/components/chat-view.tsx): consuming the SSE stream, incrementally rendering markdown, and parsing the `<ANSWER>`/`<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>` wire tail into the UI (sources list, images, follow-up chips, `[n]` citation links). Cross-ref **ai-sdk-agent** streaming for the producer side. |
| `tanstack-query-patterns.md` | Data-fetching: [`query.ts`](../../../frontend/src/lib/query.ts) setup, query keys, caching, `refetchInterval` aligned to backend TTL, the [`use-live-prices`](../../../frontend/src/hooks/use-live-prices.ts) cache merge, and mutations. Cross-ref the **rareLab tanstack-query** skill for deeper patterns. |
| `shadcn-tailwind-system.md` | Design system: the [`ui/*`](../../../frontend/src/components/ui/) shadcn components, Tailwind usage, [`theme-provider`](../../../frontend/src/components/theme-provider.tsx) + dark mode, [`animated-tabs`](../../../frontend/src/components/ui/animated-tabs.tsx) + [`accordion`](../../../frontend/src/components/ui/accordion.tsx) (the `acc-content` keyframes in `index.css`), and the [`brand`](../../../frontend/src/components/brand.tsx) component conventions. |
| `api-client-and-config.md` | The client plumbing: [`lib/api.ts`](../../../frontend/src/lib/api.ts) (fetch wrappers, the SSE read loop, error handling), [`config.ts`](../../../frontend/src/lib/config.ts) (the `BUN_PUBLIC_BACKEND_URL` build-time-inline gotcha), and [`supabase.ts`](../../../frontend/src/lib/supabase.ts) (anon key + auth token in headers). |
| `composer-and-attachments.md` | The input surface: the [`search-hero`](../../../frontend/src/components/search-hero.tsx) composer (submit→`handleAsk`), [`attachments.tsx`](../../../frontend/src/components/attachments.tsx) (base64 encode, image/file), [`mic-button`](../../../frontend/src/components/mic-button.tsx) (speech), and [`model-menu`](../../../frontend/src/components/model-menu.tsx) (the picker, kept in sync with backend `ALLOWED_MODELS`). |
| `auth-and-supabase-frontend.md` | Auth: [`Auth.tsx`](../../../frontend/src/pages/Auth.tsx), Supabase OAuth (sign-in, session), passing the token to the backend (`Authorization` header), protected routes/redirects (the `Dashboard` auth guard), and tokens vs the anon key. |

---

## Cross-repo prior art / cross-skill routing

- **ai-sdk-agent** owns the stream **producer** + the `<ANSWER>`/`<SOURCES>` wire contract this skill
  parses — change them together. **finance-markets** + the discover skills own each vertical's view
  internals; this skill owns the shared shell they mount in via `onAsk={handleAsk}`.
- **rareLab tanstack-query** skill (`E:\Development\Portfolio-phase2\react\.claude\skills\…` neighborhood)
  is the deeper prior art for query keys/caching/mutations — translate its patterns onto our
  `lib/query.ts` + `hooks/` setup.
- The **fintech-webapp** repo (`e:\Development\Portfolio-phase2\fintech-webapp\.claude`) has React UI
  prior art (Next.js/Tailwind/shadcn); translate any Next.js-isms onto our Vite + `react-router` shell.
- Project memory: `brand-is-lumina` (never ship "Perplexity"), `finance-tab-build`, `discover-tabs-build`
  capture decisions behind the current shell. Verify any `file:line` against live code before relying on it.
