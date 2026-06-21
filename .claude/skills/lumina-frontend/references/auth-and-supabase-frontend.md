# Auth & Supabase on the Frontend — sign-in, session, the bearer token

> How Lumina's SPA signs a user in with Supabase OAuth, keeps a session, carries that
> session's `access_token` to the backend as the `Authorization` header on **every** authed
> call, and guards the pages that need a user. `lumina-` ref = THIS codebase; cite the live
> file before changing it (line numbers drift). Read this when the task touches [`Auth.tsx`](../../../../frontend/src/pages/Auth.tsx),
> the session lifecycle, the token plumbing, or a protected-route redirect. Adjacent refs:
> **api-client-and-config.md** (the fetch wrappers `authHeader` rides on, the `BUN_PUBLIC_*`
> build-time-inline gotcha) and **lumina-frontend-architecture.md** (where the guarded pages
> mount in the shell). The backend side of the same token — `getUser(token)` + lazy Supabase
> client + the user-provisioning upsert — lives in [`backend/auth.ts`](../../../../backend/auth.ts);
> that is the **ai-sdk-agent** skill's territory, summarized here only where the contract crosses.

---

## 1. The whole flow in one picture

```
Auth.tsx                          Supabase (hosted GoTrue)            Backend (Express, on Vercel)
────────                          ────────────────────────            ───────────────────────────
signInWithOAuth({provider})  ──►  redirect to Google/GitHub
   (browser navigates away)            user consents
                                  ◄── redirect back to origin
                                       (#access_token in URL hash)
supabase-js detects the hash,
persists the session to
localStorage, fires SIGNED_IN
   │
   ▼
getSession() → { access_token, user }            ┌──────────────────────────────────────┐
   │                                             │  authHeader() reads session.access_token│
   ▼                                             │  fetch(BACKEND_URL+path,                │
fetch /conversations  ──────────────────────────┤    { headers:{ Authorization: token }})─┼─► middleware:
                                                 └──────────────────────────────────────┘    getUser(token)
                                                                                              → req.userId
```

Three moving parts, three files:
- [`frontend/src/lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts) — the **single** browser client (anon key only).
- [`frontend/src/pages/Auth.tsx`](../../../../frontend/src/pages/Auth.tsx) — the **sign-in screen** (OAuth buttons + "already signed in" bounce).
- [`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts) — `authHeader()` pulls the token onto **every** authed fetch.

The guard that redirects an unauthed user lives on the **pages**, not in routing: the
`Dashboard` and `Connectors` auth-guard effects (§5).

---

## 2. The Supabase client — anon key only, built once

[`frontend/src/lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts) is the entire client:

```ts
const supabaseUrl     = process.env.BUN_PUBLIC_SUPABASE_URL     || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = process.env.BUN_PUBLIC_SUPABASE_ANON_KEY || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_ANON_KEY);
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Supabase URL and Anon Key must be provided…");
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

Things that matter here:

| Fact | Consequence |
|------|-------------|
| Both vars are `BUN_PUBLIC_*` → **inlined at build time** (like `BACKEND_URL`; see api-client-and-config.md). | Changing them in Vercel does nothing until you **redeploy the frontend**. The `import.meta.env` fallback covers the Vite dev path. |
| It throws at module load if either is missing. | A missing env var fails the whole app **loudly at boot**, not with a mystery 401 later — keep both set in `frontend/.env.local`. |
| One exported `supabase` instance — import it, never call `createClient` again. | The session, the auth-state listener, and `localStorage` persistence are shared. A second client = a second session that drifts. |
| No options passed → defaults: `persistSession:true`, `autoRefreshToken:true`, `detectSessionInUrl:true`. | Sessions survive reload; the access_token auto-refreshes before expiry; the OAuth redirect hash is consumed automatically. Do not disable these unless you replace what they do. |

---

## 3. Tokens vs. the anon key — the distinction that prevents leaks

The browser holds **two** different secrets and they do different jobs. Confusing them is how
keys leak or auth silently breaks.

| | **Anon key** (`BUN_PUBLIC_SUPABASE_ANON_KEY`) | **Access token** (`session.access_token`) |
|---|---|---|
| What it is | A public, long-lived publishable key identifying the Supabase *project*. | A short-lived per-user JWT minted at sign-in, auto-refreshed by supabase-js. |
| Who it represents | Nobody — the anonymous role. | **This signed-in user** (its `sub` claim → `user.id`). |
| Where it goes | Baked into the bundle; used to construct `supabase` + to subscribe to Realtime ([`use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts)). | The `Authorization` header on **every** call to our backend. |
| Backend use | Never — our Express backend doesn't validate the anon key. | `middleware` in [`backend/auth.ts`](../../../../backend/auth.ts) calls `getClient().auth.getUser(token)` to resolve `req.userId`. |
| Safe in the browser? | **Yes** — it's designed to be public (its power is fenced by Supabase Row-Level Security, not by secrecy). | **Yes**, but it's per-user and expiring — never log it, never put it in a URL/query string (it leaks via referrer/history). |
| **Never** in the browser | The Supabase **service-role** key and every vendor key (Twelve Data, Tavily, Finnhub…). Those are server-side only. | — |

> Non-negotiable (Skill rule #2): the browser ships only the anon key + the user's access_token.
> A vendor or service-role key in the bundle is a shipping-blocker. The client always proxies
> through our backend, which holds the real keys.

The anon key is **not** an authorization to read user data — it's just the project handle.
Authorization is the access_token, validated server-side per request.

---

## 4. Sign-in — `Auth.tsx`

[`Auth.tsx`](../../../../frontend/src/pages/Auth.tsx) is a pure OAuth launcher — two providers,
no password path. The `login()` handler (`Auth.tsx:23`):

```ts
const { error } = await supabase.auth.signInWithOAuth({
  provider,                                   // "google" | "github"
  options: { redirectTo: window.location.origin },
});
if (error) throw error;
// On success the browser redirects to the provider, so we keep the spinner.
```

Key behaviors, each grounded:

- **It navigates away.** On success `signInWithOAuth` redirects the whole tab to the provider;
  there is no resolved "logged-in" state to handle here. The `loading` spinner is intentionally
  left up — the only path that clears it is the `catch` (the redirect never came back) — see the
  comment at `Auth.tsx:32`.
- **`redirectTo: window.location.origin`** sends the user back to `/` after consent — where the
  Dashboard guard (§5) takes over. This origin must be in the Supabase project's **allowed
  redirect URLs** or the callback bounces. Localhost and the prod origin are different entries.
- **`detectSessionInUrl` (client default) finishes the job.** When the provider redirects back
  with the token in the URL hash, supabase-js parses it, stores the session, and fires
  `SIGNED_IN` — no callback code in this repo. (Contrast the **Gmail connector** OAuth, which
  *does* have an explicit backend `/callback` — that's a separate Google grant, not app sign-in;
  see the connectors skill.)
- **"Already signed in" bounce** (`Auth.tsx:17`): a mount effect calls `getSession()` and
  `navigate("/")` if a session exists — so a logged-in user hitting `/auth` doesn't see the login
  screen.
- **Errors render inline** (`Auth.tsx:73`) via the `text-destructive` token; provider buttons
  disable while any provider is `loading` so you can't fire two OAuth redirects.

**Adding a provider** (e.g. `azure`): enable it in the Supabase dashboard, add its string to the
`Provider` union (`Auth.tsx:9`), and add a `<Button onClick={() => login("…")}>`. No backend
change — `backend/auth.ts` maps `app_metadata.provider === "google" ? "Google" : "Github"`, so a
*third* provider would also need a branch there or it gets stored as `"Github"`.

---

## 5. Protected routes — the guard lives on the page, not the router

[`App.tsx`](../../../../frontend/src/App.tsx) routes are **flat and unguarded** — `/`, `/auth`,
`/connectors` are all reachable. There is no `<ProtectedRoute>` wrapper. Each page that needs a
user runs its **own** guard effect.

The canonical guard is the `Dashboard` auth effect ([`Dashboard.tsx:59`](../../../../frontend/src/pages/Dashboard.tsx)):

```ts
useEffect(() => {
  let active = true;
  supabase.auth.getSession().then(({ data }) => {
    if (!active) return;
    if (!data.session) { navigate("/auth"); return; }   // no session → bounce
    setUser(data.session.user);
    setAuthChecked(true);                                // gates the UI render
  });

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) { setUser(null); navigate("/auth"); }  // sign-out / expiry → bounce
    else { setUser(session.user); setAuthChecked(true); }
  });

  return () => { active = false; sub.subscription.unsubscribe(); };
}, [navigate]);
```

Why it's two parts, not one:

| Mechanism | Catches |
|-----------|---------|
| `getSession()` once on mount | The page load / refresh case — is there a session **right now**? |
| `onAuthStateChange` subscription | **Live** transitions after mount: `SIGNED_OUT` (the user clicks sign-out elsewhere), token-refresh failure, a session that expires while the tab is open. Without it, a user who signs out would keep seeing a stale authed UI until reload. |

The two non-obvious correctness details:
- **`active` flag + `unsubscribe()` cleanup** — `getSession` is async and the listener is
  long-lived; both must no-op after unmount or you get "setState on unmounted component" and a
  leaked subscription. Always return the cleanup.
- **`authChecked` gates the render** — show a loader/nothing until the guard resolves, so the
  page never flashes authed content for a frame before the redirect. [`Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx)
  does the same: `authChecked` state (`Connectors.tsx:140`), guard at `Connectors.tsx:149`, and
  `if (!authChecked) return <loader>` at `Connectors.tsx:170`.

**Sign-out** is one call + a redirect (`Dashboard.tsx:235`):
```ts
await supabase.auth.signOut();   // clears the session + localStorage; fires SIGNED_OUT
navigate("/auth");
```
The `signOut()` triggers `onAuthStateChange(null)` everywhere, so even other open tabs/pages
that mounted the guard will redirect themselves. Don't manually clear `localStorage` — let
`signOut()` own that.

**New protected page checklist:** copy the `Dashboard` guard effect (both `getSession` +
`onAuthStateChange`, the `authChecked` gate, the cleanup). Do **not** invent a new guard shape.

---

## 6. Carrying the token to the backend — `authHeader()`

Every authenticated backend call funnels through one helper in [`api.ts`](../../../../frontend/src/lib/api.ts):

```ts
async function authHeader(): Promise<string> {       // api.ts:35
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}
```

Then each request attaches it:
```ts
const token = await authHeader();
const res = await fetch(`${BACKEND_URL}/conversations`, { headers: { Authorization: token } });
```

Conventions to honor (all visible in `api.ts`):

| Convention | Detail |
|-----------|--------|
| **Raw token, no `Bearer ` prefix.** | The frontend sends the bare JWT; the backend reads `req.headers.authorization` and passes it straight to `getUser(token)` (`backend/auth.ts:47`, header read at `:36`). If you add `Bearer `, the backend's lookup must change too — they're a matched pair. |
| **Read the token *per request*, fresh.** | `authHeader()` calls `getSession()` each time so it always picks up the **auto-refreshed** token. Never cache the token in a module variable — it expires and supabase-js rotates it. |
| **`?? ""` on no session.** | A missing token sends an empty `Authorization`; the backend replies `401 {error:"unauthorised"}` (`backend/auth.ts:37`). The guard (§5) should have redirected first, so this is a backstop, not the happy path. |
| **Streaming calls carry it too.** | `streamPost` (`api.ts:106`) sets `Authorization: token` on the POST to `/perplexity_ask` exactly like the JSON calls — there's no special streaming auth. |
| **Mutations add `Content-Type`.** | `renameConversation`/`gmailSend` etc. send both `Content-Type: application/json` **and** `Authorization` — don't drop one when copying. |

**The 302 trap (Gmail connector).** Do **not** rely on the backend redirecting you to an external
URL while authed — a browser-followed `302` drops the `Authorization` header on the hop. The fix
is in `gmailStartUrl()` (`api.ts:235`): fetch the consent URL **with the header attached**, read
it from JSON, then `window.location` to it. Apply the same pattern for any "send me somewhere"
authed endpoint.

---

## 7. The backend half of the contract (summary — owned by ai-sdk-agent)

So the round trip is complete, what the token hits server-side ([`backend/auth.ts`](../../../../backend/auth.ts)):

- `middleware` runs on **every** authed route (`/conversations*`, `/perplexity_ask*`,
  `/connectors/gmail/*` except the public `/callback`). The public `/finance/*` and `/discover`
  read routes are mounted **before** auth — no token needed (`backend/index.ts:54`).
- It reads `req.headers.authorization`, then `getClient().auth.getUser(token)` → the Supabase
  user → `req.userId`.
- The Supabase client is built **lazily** (first authed request), not at module load, so a
  missing auth env var can't crash the whole function — including the public finance routes
  (`getClient()` in `backend/auth.ts`, ~`:12`). Same lazy-init discipline as the frontend client throwing at load is
  *not* wanted server-side.
- Two caches cut per-request cost: a 5-min token→userId cache (`TOKEN_TTL_MS`) and a
  `provisionedUsers` set so the user-row upsert runs once per process, not per search.

Implication for the frontend: a token rejected as expired returns `401`; the frontend's
`onAuthStateChange` will independently catch the session loss and redirect. You don't need
custom 401-retry logic — but if you add it, refresh via `getSession()` (it auto-rotates), never
by re-running the OAuth flow.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Putting any vendor/service-role key in the browser "to make a fetch work." | Browser holds anon key + the user's access_token only; proxy through the backend, which holds the real keys (Skill rule #2). |
| Caching `access_token` in a module-level variable and reusing it. | Call `authHeader()` (→ `getSession()`) per request so you always get the auto-refreshed token. |
| Sending `Authorization: Bearer <jwt>`. | Send the **raw** token — the backend passes it straight to `getUser` with no prefix stripping. |
| Guarding routes with a `<ProtectedRoute>` wrapper bolted onto `App.tsx`. | Match the existing pattern: a per-page `getSession` + `onAuthStateChange` guard effect with an `authChecked` render gate. |
| Only checking `getSession()` once and trusting it forever. | Also subscribe to `onAuthStateChange` so sign-out/expiry redirects live, and `unsubscribe()` on cleanup. |
| Rendering the page before the guard resolves (auth content flashes, then redirects). | Gate render on `authChecked` (show a loader) until the session check completes. |
| Following a backend `302` to an external OAuth URL while authed. | Fetch the URL with the header attached, read it from JSON, then `window.location` to it (`gmailStartUrl`). |
| Constructing a second `createClient(...)` somewhere for "convenience." | Import the single `supabase` from `lib/supabase.ts`; one client = one shared session + listener. |
| Manually clearing `localStorage` to "log out." | `await supabase.auth.signOut()` — it clears storage and fires `SIGNED_OUT` to every mounted guard. |
| Setting `BUN_PUBLIC_SUPABASE_*` in Vercel and expecting it live. | It's compile-time inlined — set it, then **redeploy** the frontend (api-client-and-config.md). |
| Logging the token or putting it in a query string. | Headers only; never URL/console — it's a per-user credential that leaks via history/referrer. |

---

## 9. "Done" checklist for an auth-touching change

1. **Single client:** everything imports `supabase` from [`lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts); no second `createClient`.
2. **Token, fresh, raw:** authed fetches use `authHeader()` (per-request `getSession`) and send the **bare** JWT in `Authorization`.
3. **Guarded + gated:** any new authed page has both guard halves (`getSession` + `onAuthStateChange`), the `authChecked` render gate, and the cleanup (`active` flag + `unsubscribe`).
4. **No key leak:** the bundle ships only `BUN_PUBLIC_SUPABASE_URL` + `…ANON_KEY` (+ the user token at runtime) — grep the build for any vendor/service-role key.
5. **Redirect URLs registered:** any new `redirectTo` origin is in the Supabase project's allow-list (localhost **and** prod are separate).
6. **New provider, both sides:** a new OAuth provider is added to the `Provider` union *and* the backend `provider` mapping in `backend/auth.ts`.
7. **Verified:** sign in with Google **and** GitHub; a real authed call (`/conversations`) returns 200; sign out from one tab redirects the page; an expired/cleared session bounces to `/auth`.
