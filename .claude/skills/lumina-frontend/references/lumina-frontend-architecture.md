# Lumina Frontend Architecture — the SPA wiring map

> The whole React/Vite SPA, file by file: the `AppShell` layout, `react-router` routes, the three
> pages (Dashboard/Auth/Connectors), the section-tab switcher, and the one `handleAsk` → `runTurn`
> flow that **every** vertical funnels through. Read this first when you're lost in the frontend or
> wiring a new surface. `lumina-` ref = THIS codebase; cite the live file before you change it (line
> numbers drift — phrasing names functions so you can re-find them).
>
> Adjacent refs: `streaming-chat-rendering.md` (how `parseStream` output renders in `chat-view`),
> `api-client-and-config.md` (the `streamAsk`/`streamFollowUp` fetch internals + `BUN_PUBLIC_*`),
> `auth-and-supabase-frontend.md` (the Supabase session + bearer-token plumbing this page guards on),
> `composer-and-attachments.md` (`search-hero` + the model menu that feed `handleAsk`).

---

## 1. The shape of the app — one page, many verticals

Lumina looks like a multi-section product (Discover / Finance / Health / Academic / Assistant) but is
**one routed page** ([`Dashboard`](../../../../frontend/src/pages/Dashboard.tsx)) whose body swaps on a
single `section` state, wrapped in a layout-only [`AppShell`](../../../../frontend/src/components/layout/app-shell.tsx).
There is no per-vertical route, no per-vertical ask pipeline — every "search" in every vertical calls
the **same** `handleAsk`, and the backend `vertical` is derived from which section tab is active.

```
                                BrowserRouter (App.tsx)
                                        │
        ┌───────────────────────────────┼────────────────────────────┐
      "/"  Dashboard              "/auth"  Auth              "/connectors"  Connectors
        │  (auth-guarded)               (sign-in)                  (auth-guarded)
        │
   ┌────┴───────────────────────────── AppShell ─────────────────────────────┐
   │  sidebar = <Sidebar/>     header = <TopNav/>      main = (body, below)    │
   └──────────────────────────────────────────────────────────────────────────┘
        │
   inChat? ── yes ─► <ChatView turns activeTab onFollowUp busy/>
        │ no
        ├─ section==="Finance"  ─► <FinanceView  onAsk={handleAsk}/>
        ├─ section==="Academic" ─► <AcademicView onAsk={handleAsk}/>
        ├─ section==="Health"   ─► <HealthView   onAsk={handleAsk}/>
        └─ else (Discover/Assistant) ─► <SearchHero onSubmit={handleAsk}/>

   handleAsk(query, attachments) ─► runTurn(query, fresh=true) ─► streamAsk / streamFollowUp
                                          │ vertical = f(sectionRef.current)
                                          └─► onChunk → parseStream → ChatView re-render
```

**The single most important fact:** `inChat` (`turns.length > 0`) is what flips the whole main pane
from a vertical's landing view to the streaming `ChatView`. The first ask in *any* vertical pushes a
turn, so the section landing view is replaced by the shared chat surface — and `TopNav` switches its
center tabs from the section switcher to Answer/Links/Images at the same moment.

---

## 2. File-by-file

### Routing & providers
- [`frontend/src/App.tsx`](../../../../frontend/src/App.tsx) — the root. Nests, outside-in:
  [`ThemeProvider`](../../../../frontend/src/components/theme-provider.tsx) (dark-first class toggle)
  → `QueryClientProvider` (the shared [`queryClient`](../../../../frontend/src/lib/query.ts))
  → `BrowserRouter` → `Routes`. Exactly **three** routes: `/` → `Dashboard`, `/auth` → `Auth`,
  `/connectors` → `Connectors`. Note `import { BrowserRouter, Route, Routes } from "react-router"` —
  this is **react-router v7's flat `react-router` package**, NOT `react-router-dom`; import from the
  wrong one and the build breaks. No nested/layout routes — the shell is a component, not a route.

### Layout (the shell)
- [`app-shell.tsx`](../../../../frontend/src/components/layout/app-shell.tsx) — pure layout, zero
  logic. Takes `{sidebar, header, children}` as `ReactNode` slots and renders
  `flex h-screen` (sidebar | (header / `<main>` scroll region)). It owns no state and knows nothing
  about verticals — Dashboard injects the real components. This is the seam: **a new top-level
  surface mounts here, not a parallel layout.**
- [`sidebar.tsx`](../../../../frontend/src/components/layout/sidebar.tsx) — collapsible aside
  (`w-52` ↔ `w-[58px]`). Holds: the Lumina brand mark, "New" button (`onNewChat`), `SECONDARY_NAV`
  (Connectors/Skills/Workflows), conversation **History** (rename/delete via a Radix dropdown,
  optimistic), and the footer `ProfileMenu` + sign-out. Navigation is **map-driven**: `NAV_PATHS`
  only contains `connectors: "/connectors"`; nav items without an entry are deliberate placeholders
  that no-op until they ship (`if (path) navigate(path)`). History rows call back up to
  `onSelectConversation` — the sidebar holds no conversation data, only renders the props Dashboard
  passes.
- [`top-nav.tsx`](../../../../frontend/src/components/layout/top-nav.tsx) — the header. Its center is
  **mode-switched** (see §4): `mode==="chat"` renders the `CHAT_TABS` (Answer/Links/Images),
  `mode==="home"` renders the `SECTION_TABS` switcher. Both use the shared `Tabs`/`TabsList`/
  `TabsTrigger` animated tabs (`type="underline"`, shared-layoutId spring indicator). The section
  switcher is `hidden md:block` (mobile hides it). Right side: a "Scheduled" pill (home only) +
  `ThemeToggle`. **`SECTION_TABS` and `Section` are exported from here** and are the source of truth
  for the vertical list — `Dashboard` imports `type Section` from this file.

### Pages
- [`pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) — the orchestrator. Owns ALL
  app state (user, conversations, turns, conversationId, busy, model, activeTab, section) and every
  handler. Detailed in §3.
- [`pages/Auth.tsx`](../../../../frontend/src/pages/Auth.tsx) — the sign-in screen.
  `supabase.auth.signInWithOAuth({provider, options:{redirectTo: window.location.origin}})` for
  `google` | `github`; on success the browser leaves to the provider so the spinner stays up.
  Already-signed-in users are bounced to `/` on mount. See `auth-and-supabase-frontend.md`.
- [`pages/Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx) — a standalone page (NOT
  inside `AppShell`; its own `max-w-5xl` container). A static `CONNECTORS` catalog (Gmail = real;
  Outlook/Slack/Notion/GitHub = `state:"soon"` disabled cards) → card grid → portal modal with a
  Gmail compose/test-send box. Connect leaves the app via `window.location.href = await
  gmailStartUrl()` (see the §6 redirect anti-pattern); post-OAuth it reads `?gmail=connected|denied|
  error` and shows a one-shot banner, then strips the param. Same auth guard as Dashboard.

---

## 3. Dashboard — the orchestrator

`Dashboard` is the brain. Everything else is a controlled child.

### State it owns
| State | Purpose |
|-------|---------|
| `user` / `authChecked` | Supabase session; gate the render (spinner until checked, redirect if none). |
| `conversations` / `loadingConversations` | History list for the sidebar. |
| `turns` / `conversationId` / `busy` | The active chat: the Q/A turns, the server conversation id, in-flight flag. |
| `model` | Selected AI Gateway model id (`DEFAULT_MODEL` from `model-menu`). |
| `activeTab` | `ChatTab` for the chat-mode TopNav (Answer/Links/Images). |
| `section` | The active vertical (`Section` from `top-nav`) — drives both the body and the backend `vertical`. |

### The ref trio — why it exists (subtle, load-bearing)
```ts
const convIdRef = useRef<string|null>(null);
const modelRef  = useRef<string>(model);
const sectionRef = useRef<Section>(section);
useEffect(() => { convIdRef.current = conversationId; }, [conversationId]);
useEffect(() => { modelRef.current = model; }, [model]);
useEffect(() => { sectionRef.current = section; }, [section]);
```
`runTurn` is a long-lived async closure (`useCallback` deps = `[refreshConversations]` only). Its
streaming callbacks fire over seconds while React re-renders. Reading `conversationId`/`model`/
`section` from **refs** lets the in-flight stream see the *current* value without re-binding `runTurn`
on every keystroke/model-switch. **Anti-pattern:** adding `model`/`section` to `runTurn`'s deps —
you'd rebuild the callback mid-stream and stale-close bugs follow. Keep the ref mirror.

### `runTurn(query, fresh, attachments?)` — the one ask path (in `runTurn`, Dashboard.tsx)
1. Mint a client `id` (`crypto.randomUUID()`), push a `{question, full:"", status:"streaming"}` turn
   (replace-all if `fresh`, append otherwise). `setBusy(true)`.
2. **Derive the vertical from the section ref**, not props:
   ```ts
   const vertical = sectionRef.current === "Finance" ? "finance"
                  : sectionRef.current === "Assistant" ? "assistant"
                  : "discover";   // Discover, Academic, Health all use the discover web-search path
   ```
   This is the hinge: Finance routes to the tool-calling finance agent, Assistant to the assistant
   path, everything else (incl. Academic/Health) to the Discover web-search path — **server-side**,
   over the same streaming + persistence + history machinery, so a finance thread saves and replays
   like any other.
3. Choose endpoint: a follow-up (`!fresh && existingId`) → `streamFollowUp(existingId, query, …)`;
   else a new ask → `streamAsk(query, …)`. Both get `{onChunk, model: modelRef.current, attachments,
   vertical}`.
4. `onChunk(full)` replaces the active turn's `full` with the running buffer — `ChatView` re-renders
   and re-runs `parseStream` on every chunk.
5. On resolve: capture `result.conversationId` into both state and `convIdRef` (so an immediate
   follow-up has the id), mark the turn `done`, `refreshConversations()`.
6. On throw: mark the turn `status:"error"` with the message. `finally → setBusy(false)`.

### The handler surface (all `useCallback`)
| Handler | Does |
|---------|------|
| `handleAsk(query, attachments)` | **Fresh** turn: clear `conversationId` (state + ref), reset `activeTab` to `answer`, `runTurn(query, true)`. This is the prop every vertical view receives. |
| `handleFollowUp(query, attachments)` | `runTurn(query, false)` — append to the current conversation. Passed to `ChatView`. |
| `handleNewChat` | Clear turns + conversationId (state + ref) + tab. Sidebar "New". |
| `handleSelectConversation(id)` | Fetch `fetchConversation(id)`, rebuild `Turn[]` by pairing user→assistant messages, set turns. (Replays history into the same chat surface.) |
| `handleRename/DeleteConversation` | Optimistic local mutation → API → `refreshConversations()`. |
| `handleSignOut` | `supabase.auth.signOut()` → `navigate("/auth")`. |

### Auth guard (in the first `useEffect`)
On mount, `supabase.auth.getSession()`: no session → `navigate("/auth")`; else set `user` +
`authChecked`. Also subscribes to `onAuthStateChange` (sign-out elsewhere → redirect). Until
`authChecked && user`, the component returns a full-screen spinner — **no app chrome renders for an
unauthenticated user**. `Connectors` uses the same guard pattern (without the `onAuthStateChange`
subscription).

---

## 4. The TopNav mode switch — home vs chat

`TopNav` has one prop that changes its entire center region: `mode`. Dashboard sets it from `inChat`:

```tsx
<TopNav mode={inChat ? "chat" : "home"} activeTab={activeTab} onTabChange={setActiveTab}
        section={section} onSectionChange={setSection} />
```

| `mode` | Center tabs | Driven by | Effect |
|--------|-------------|-----------|--------|
| `"home"` (`turns.length===0`) | `SECTION_TABS` (Discover/Finance/Health/Academic/Assistant) | `section` / `onSectionChange={setSection}` | Switching a tab changes which landing view renders **and** the next ask's `vertical`. |
| `"chat"` (`turns.length>0`) | `CHAT_TABS` (Answer/Links/Images) | `activeTab` / `onTabChange={setActiveTab}` | Switches the `ChatView` pane between prose, sources list, and images — all parsed from the **same** streamed buffer. |

So a user picks a vertical (home tabs) → asks → the first turn flips `inChat` → the same header now
shows the answer/links/images view tabs. There is no navigation; it's all one component tree
re-rendering on `turns.length`.

---

## 5. Body selection — the render switch

The main slot is a single chained ternary in Dashboard's JSX (`inChat ? … : section === …`):

```tsx
{inChat ? (
  <ChatView turns={turns} activeTab={activeTab} onFollowUp={handleFollowUp} busy={busy} />
) : section === "Finance"  ? <FinanceView  onAsk={handleAsk} />
  : section === "Academic" ? <AcademicView onAsk={handleAsk} />
  : section === "Health"   ? <HealthView   onAsk={handleAsk} />
  : <SearchHero onSubmit={handleAsk} model={model} onModelChange={setModel} />}
```

| Section | Landing component | Ask prop | Notes |
|---------|-------------------|----------|-------|
| Discover / Assistant | `SearchHero` | `onSubmit={handleAsk}` | The plain composer; also owns the model picker (`model`/`onModelChange`). |
| Finance | `FinanceView` | `onAsk={handleAsk}` | Card feeds + a docked composer; view internals → **finance-markets**. |
| Academic | `AcademicView` | `onAsk={handleAsk}` | Aliased import of `topic-discover-view` (`import { AcademicView } from "@/components/discover/topic-discover-view"`). |
| Health | `HealthView` | `onAsk={handleAsk}` | `@/components/discover/health-view`; carousels + workflows. |
| (any, after first ask) | `ChatView` | `onFollowUp={handleFollowUp}` | Shared chat surface for all verticals. |

**Contract for any new vertical view:** accept an `onAsk: (query, attachments?) => void` prop, call
it on submit, render nothing about streaming/persistence yourself. The shell handles the rest. The
view's *internals* live in another skill; the *wiring* (a new `SECTION_TABS` entry + a ternary branch
+ the `vertical` mapping in `runTurn`) is this skill's territory.

---

## 6. Conventions, gotchas & anti-patterns

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Building a per-vertical ask pipeline (own fetch/persist for Finance, etc.). | Every view calls `onAsk={handleAsk}`; the `vertical` is derived from `sectionRef.current` in `runTurn` — one streaming/persistence path, one history. |
| Adding `model`/`section`/`conversationId` to `runTurn`'s `useCallback` deps. | Mirror them into refs and read `…Ref.current` inside the async closure; keep `runTurn` deps minimal so an in-flight stream isn't rebuilt. |
| Importing routing from `react-router-dom`. | This repo is react-router v7: import `BrowserRouter`/`Routes`/`Route`/`useNavigate`/`useSearchParams` from `"react-router"`. |
| Adding a new top-level surface as a sibling layout (new flex shell). | Mount it inside `AppShell`'s `sidebar`/`header`/`children` slots, or add a route in `App.tsx` for a standalone page like `Connectors`. |
| Hardcoding the vertical list in two places. | `SECTION_TABS` + `type Section` are exported from `top-nav.tsx` — import them; don't re-declare. |
| Wiring a sidebar nav item by adding an `onClick` with a hardcoded `navigate`. | Add the path to `NAV_PATHS`; `NavRow`'s `onClick` looks it up (`if (path) navigate(path)`) so placeholders stay inert. |
| Following a backend `302` for the Gmail connect (the auth header is dropped on the redirect hop). | `gmailStartUrl()` fetches the URL **with** the auth header, reads it from JSON, then `window.location.href = …` to it. |
| Rendering app chrome before the session is known (flash of authed UI). | Gate on `authChecked && user`; return the full-screen spinner until then; redirect to `/auth` on no session. |
| Calling `parseStream` only when the stream ends. | `onChunk` runs it on every chunk; `parseJsonArray` swallows partial-JSON errors so a half-streamed `<SOURCES>` block is safe (see `streaming-chat-rendering.md`). |
| Writing "Perplexity" in any user-visible string. | Brand is **Lumina** (`LuminaMark`/brand). The only "perplexity" left is the literal API route name `/perplexity_ask` inside `streamAsk`/`streamFollowUp`. |

**Dev reality:** the SPA is Vite + Bun; `BUN_PUBLIC_BACKEND_URL` is inlined at **build** time and must
be a full `https://` URL (a scheme-less value becomes a relative path → 404s) — changing it in Vercel
needs a **frontend redeploy**. See `api-client-and-config.md`.

---

## 7. Where to add things (cheat sheet)

| Task | Do |
|------|----|
| **New vertical/section** | Add to `SECTION_TABS` in `top-nav.tsx` → add a `section === "X"` branch in Dashboard's body ternary mounting `<XView onAsk={handleAsk}/>` → add the `vertical` mapping in `runTurn` (if it needs a non-discover backend path) → build the view internals in the owning skill. |
| **New standalone page** (like Connectors) | Add a `<Route>` in `App.tsx`; guard with the Dashboard auth pattern; if it should be reachable from the rail, add `id → path` to `NAV_PATHS` in `sidebar.tsx`. |
| **New chat sub-tab** (e.g. a 4th panel) | Extend `ChatTab` in `chat-view.tsx` + `CHAT_TABS` in `top-nav.tsx`; render the panel in `ChatView`. |
| **Change what a section sends to the backend** | Edit the `vertical` ternary in `runTurn` (Dashboard.tsx) — that's the single mapping from UI section → backend `vertical`. |
| **New header control** | Add to `TopNav`'s right-controls group; gate by `mode` if it's home- or chat-only (like the "Scheduled" pill). |
| **New sidebar action** | Add to `SECONDARY_NAV` + `NAV_PATHS` (route) or pass a new `on*` callback prop down from Dashboard (state-bearing action). |

---

## 8. Cross-references

- **How the streamed buffer renders** (markdown, `[n]` citation linkify, sources/images/follow-up
  chips, the `parseStream` consumer) → `streaming-chat-rendering.md`.
- **`streamAsk`/`streamFollowUp` internals**, the SSE read loop, `BUN_PUBLIC_BACKEND_URL`, the auth
  header → `api-client-and-config.md`.
- **The producer side** of the `<ANSWER>`/`<SOURCES>`/`<IMAGES>` wire contract `parseStream` reads,
  plus the `vertical:"finance"|"assistant"|"discover"` branches on the backend → **ai-sdk-agent** /
  **research-agent** / **finance-markets**.
- **Supabase session, OAuth, bearer token, protected-route redirects** (the guard this page runs) →
  `auth-and-supabase-frontend.md`.
- **The composer, attachments, mic, model menu** that feed `handleAsk` → `composer-and-attachments.md`.
- Project memory: `brand-is-lumina` (never ship "Perplexity"). Verify any `file:line` against live
  code before relying on it.
