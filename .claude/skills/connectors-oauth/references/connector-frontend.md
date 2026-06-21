# Connector Frontend — the Connectors page, status hooks & connect/disconnect flow

> The browser side of a Lumina connector: the card grid + detail modal + compose box in
> [`Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx), the TanStack hooks in
> [`use-connectors.ts`](../../../../frontend/src/hooks/use-connectors.ts), the thin fetch layer in
> [`api.ts`](../../../../frontend/src/lib/api.ts), and the sidebar/route wiring. Read this when
> building or extending the Connectors UI, debugging the connect/disconnect round-trip, or adding a
> new connector card. **The load-bearing rule: tokens never touch the client** — the UI only ever
> sees status *metadata* and triggers server flows. `lumina-` ref = THIS codebase; line numbers
> drift, so re-read the live file before editing.
>
> Adjacent refs: `lumina-connectors-architecture.md` (the backend routes this UI calls),
> `oauth-flow-and-pkce.md` (what `/start` and `/callback` do server-side), `human-in-the-loop-approval.md`
> (the in-chat draft → Send/Cancel render path, distinct from this page's REST compose box),
> `adding-a-new-connector.md` (the full checklist when you add Slack/Notion/Calendar — this doc is its
> frontend half).

---

## 1. What the connector frontend is (and is not)

There are **two** ways a user sends mail in Lumina, and this page owns only one:

| Surface | Where | Auth model | This doc? |
|---|---|---|---|
| **Connectors page** — connect/disconnect + a REST "test send" compose box | [`Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx) → `POST /connectors/gmail/send` | direct REST, no LLM, no approval gate (you typed it, you sent it) | **Yes** |
| **Assistant chat** — the model proposes a draft, user clicks Send/Cancel | the chat view, `vertical:"assistant"` | AI-SDK `needsApproval` + HMAC token | No → `human-in-the-loop-approval.md` |

The page is a **management console**: it shows which connectors exist, their live connected state,
and lets the user wire/unwire Gmail. The compose box is a *smoke test* of the connection, not the
product's primary send path.

```
Sidebar "Connectors" ──navigate("/connectors")──► <Connectors/>
   │
   ├─ card grid (CONNECTORS catalog × useGmailStatus)
   ├─ post-OAuth banner  (?gmail=connected|denied|error)
   └─ <ConnectorModal>  (portal)
        ├─ Connect  ──► gmailStartUrl() ──► window.location.href = Google consent
        ├─ Disconnect ─► useGmailDisconnect() ──► DELETE /connectors/gmail
        └─ <GmailCompose> (only when connected) ─► useGmailSend() ─► POST .../send
```

---

## 2. Wiring: route + sidebar entry

| Concern | Where | Note |
|---|---|---|
| Route | `<Route path="/connectors" element={<Connectors />} />` in [`App.tsx`](../../../../frontend/src/App.tsx) | top-level, not nested under the chat shell — it's a full-page console |
| Sidebar entry | `SECONDARY_NAV` `{ id: "connectors", … icon: Plug }` + `NAV_PATHS = { connectors: "/connectors" }` in [`sidebar.tsx`](../../../../frontend/src/components/layout/sidebar.tsx) | a nav item with **no** `NAV_PATHS` entry is a deliberate no-op placeholder (`skills`, `workflows`); only `connectors` actually navigates |
| Navigation | `onClick={() => { const path = NAV_PATHS[item.id]; if (path) navigate(path); }}` (in `Sidebar`) | guard the lookup — placeholder items must not crash |

**To add a new connector to the nav** you only touch `SECONDARY_NAV` + `NAV_PATHS` if it gets its own
page; most connectors are just another **card** in the existing grid (next section), no nav change.

---

## 3. The catalog: data-driven cards

The grid renders from a single static array, `CONNECTORS: ConnectorDef[]`, near the top of
[`Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx). One source of truth → adding a
connector is editing an array, not writing JSX.

```ts
type ConnectorState = "available" | "builtin" | "soon";
interface ConnectorDef {
  id: string; name: string; description: string;
  icon: IconType; tint: string;          // tailwind classes for the icon chip
  state: ConnectorState;
  overview: string[];                     // bullet list in the modal
  tools: { name: string; desc: string }[]; // the connector's capabilities
}
```

| `state` | Card badge | Clickable? | Meaning |
|---|---|---|---|
| `available` | `+` chip, or **Connected** pill if status says so | yes | a real, connectable connector (Gmail) |
| `builtin` | **Built-in** pill | yes | always-on, no OAuth (the commented-out Finance entry) |
| `soon` | **Soon** pill | **no** (`disabled`, `opacity-60`) | roadmap placeholder (Outlook/Slack/Notion/GitHub) |

`ConnectorCard` decides the right-side badge in priority order: `connected` → `builtin` → `soon` →
default `+`. The card is `disabled` only when `soon`; `onOpen` is itself guarded
(`onClick={() => c.state !== "soon" && setOpenId(c.id)}`) so a soon card can never open the modal.

> **Anti-pattern:** branching the JSX per connector (`if id==="gmail" …`). **Do instead:** describe
> the connector declaratively in `CONNECTORS`; the card/modal read `def.*`. Gmail-specific behavior is
> isolated behind a single `isGmail = def.id === "gmail"` flag in the modal.

---

## 4. Status: one query, shared everywhere (TanStack)

[`use-connectors.ts`](../../../../frontend/src/hooks/use-connectors.ts) mirrors the `use-finance.ts`
pattern: **server state lives in the query cache** so every card and the modal read one source of
truth, and mutations *invalidate* rather than hand-managing `useState`.

| Hook | Kind | Backend | Cache key | Notes |
|---|---|---|---|---|
| `useGmailStatus()` | `useQuery` | `GET /connectors/gmail/status` | `["connectors","gmail","status"]` | `staleTime: 30_000` (status barely changes) |
| `useGmailDisconnect()` | `useMutation` | `DELETE /connectors/gmail` | invalidates the status key `onSuccess` | one click updates **every** consumer at once |
| `useGmailSend()` | `useMutation` | `POST /connectors/gmail/send` | none | per-send; result handled in the component |
| `useInvalidateGmailStatus()` | helper | — | returns a fn that invalidates the status key | force a refetch after the OAuth round-trip |

The shape the UI is allowed to see — note there is **no token field**:

```ts
export interface GmailStatus {
  connected: boolean;
  googleEmail?: string;   // shown as "Connected as …"
  scopes?: string;
  connectedAt?: string;
}
```

This is exactly what the backend's `getConnectionStatus` returns — metadata only. The
`refreshTokenEnc` never appears in any frontend type, so it's structurally impossible to render a
token by accident. That is the non-negotiable from the SKILL made real on the client.

> **Anti-pattern:** mirroring `connected` into component `useState` and toggling it on click.
> **Do instead:** read `status.data?.connected`; mutate; invalidate. The cache is the truth; optimistic
> local state drifts from the server on every error.

---

## 5. The fetch layer ([`api.ts`](../../../../frontend/src/lib/api.ts))

Every connector call attaches the Supabase access token via `authHeader()` (`Authorization:
<jwt>`), exactly like the rest of the app. `BACKEND_URL` comes from
[`config.ts`](../../../../frontend/src/lib/config.ts) (`BUN_PUBLIC_BACKEND_URL`, inlined at build).

| Fn | Method + path | Returns / throws |
|---|---|---|
| `gmailStatus()` | `GET …/status` | `GmailStatus`; throws on non-2xx |
| `gmailStartUrl()` | `GET …/start` | `{ url }.url` — the Google consent URL |
| `gmailSend(input)` | `POST …/send` | `{ id, threadId }`; throws `data.error` on non-2xx |
| `gmailDisconnect()` | `DELETE /connectors/gmail` | `void`; throws on non-2xx |

### The single most important call: `gmailStartUrl`

```ts
// Ask the backend for the consent URL, then the CALLER navigates the browser to it.
// A server 302 would lose the Authorization header on the redirect hop.
export async function gmailStartUrl(): Promise<string> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}/connectors/gmail/start`, { headers: { Authorization: token } });
  if (!res.ok) throw new Error(`Could not start Gmail connect (${res.status})`);
  return ((await res.json()) as { url: string }).url;
}
```

**Why fetch-then-navigate instead of `<a href="…/start">`?** `/start` is *behind auth* — it needs the
user's JWT to seal `userId` into the OAuth `state`. A plain link or a server `302 → Google` redirect
strips the `Authorization` header on the hop, so the backend wouldn't know who is connecting. So the
SPA fetches the URL *with* the header, then does `window.location.href = url` to leave for Google.

`gmailSend` is the one call that reads the error body even on failure — it surfaces the backend's
typed `{ error }` (e.g. invalid address, message too large, "reconnect Gmail") straight into the
compose box's result line.

---

## 6. The connect / disconnect / OAuth-return round-trip

The whole flow is **three browser navigations** plus one banner. Tokens are minted, encrypted, and
stored entirely on the server during step 3; the SPA only ever holds a status boolean.

```
1. CONNECT (in ConnectorModal.handleConnect):
     setConnecting(true)
     window.location.href = await gmailStartUrl()   // leaves the SPA entirely → Google consent
       │  (on throw: show error, setConnecting(false) — we never left, so recover in place)
       ▼
2. Google consent screen  →  redirects to backend  GET /connectors/gmail/callback  (PUBLIC route)
     backend: openState(state) → exchangeCode (PKCE) → encrypt+store refresh token
       ▼
3. backend redirects browser back to the SPA:  /connectors?gmail=connected | denied | error
       ▼
4. <Connectors> mount effect reads ?gmail=…, shows CALLBACK_BANNERS[result], strips the param
   (setParams(..., { replace:true })) so a refresh doesn't re-show it.
```

```ts
// The post-OAuth banner map (Connectors.tsx)
const CALLBACK_BANNERS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true,  text: "Gmail connected." },
  denied:    { ok: false, text: "Connection cancelled — you declined the Google consent screen." },
  error:     { ok: false, text: "Something went wrong connecting Gmail. Please try again." },
};
```

**Disconnect** is in-app (no navigation): `disconnect.mutate()` → `DELETE /connectors/gmail` (server
deletes the row **and** revokes at Google) → `onSuccess` invalidates the status key → the card flips
from **Connected** back to `+` and the modal swaps the Disconnect button for Connect. The button
shows a spinner via `disconnect.isPending`.

### Where the banner refetch *should* come from

The page currently shows the `?gmail=connected` banner immediately, and `useGmailStatus`'s
`staleTime: 30_000` plus a full-page reload (the OAuth return is a hard navigation, not a SPA route
change) means status is refetched fresh on mount — so the **Connected** pill appears without extra
work. `useInvalidateGmailStatus` exists for the case where you make connect a soft navigation (no full
reload); call it after detecting `?gmail=connected` to force the refetch. Until then it's the
escape hatch, not the hot path.

---

## 7. The detail modal (`ConnectorModal`)

Rendered via `createPortal(..., document.body)` so it escapes any overflow/transform ancestor.
Behaviors that make it feel native:

| Behavior | Implementation |
|---|---|
| Backdrop click closes | `<div className="absolute inset-0 …" onClick={onClose} />` behind a `z-10` panel |
| Escape closes | `keydown` listener added on mount, removed on unmount |
| Scroll lock | sets `document.body.style.overflow = "hidden"`, restores prior value on cleanup |
| Enter animation | `motion.div` (`motion/react`) opacity+scale+y, 0.15s |
| Header actions | Gmail only: Connect **or** Disconnect (by `gmailConnected`), plus a close `X` |
| Body sections | error line · "Connected as {email}" · Overview bullets · Tools list · `<GmailCompose>` (connected only) |

The modal takes `gmailConnected` and `gmailEmail` as **props from the page** (which read
`status.data`), so it doesn't re-subscribe to the query — one fetch, passed down. Local `useState`
in the modal is only for *transient* UI (`connecting`, `error`) that has no server truth.

> **Anti-pattern:** calling `useGmailStatus()` again inside the modal. **Do instead:** lift the single
> query to the page and pass `connected`/`email` down — avoids duplicate fetches and split-brain state.

---

## 8. The compose / test-send box (`GmailCompose`)

Renders only when Gmail is connected (`isGmail && gmailConnected`). A controlled form (`to`,
`subject`, `body`) gated by `canSend = to.trim() && (subject.trim() || body.trim())`. On submit it
calls `send.mutate(input, { onSuccess, onError })`:

```ts
function handleSend() {
  setResult(null);
  send.mutate(
    { to: to.trim(), subject, body },
    {
      onSuccess: () => { setResult({ ok: true, text: `Sent to ${to.trim()}.` }); setSubject(""); setBody(""); },
      onError: (e) => setResult({ ok: false, text: e instanceof Error ? e.message : "Send failed." }),
    },
  );
}
```

Note what the form does **not** send: no `from`, no `userId`. The backend derives the from-address
from the connected session (`getGmailSession(userId)`); the client *cannot* spoof a sender. That's the
frontend mirror of Non-Negotiable #1 — identity is server-bound, never a form field.

The button reflects `send.isPending` with a spinner; the result line shows the success text or the
backend's typed error (relayed by `gmailSend`).

---

## 9. Decision framework — where does my UI change go?

| I want to… | Touch | Don't touch |
|---|---|---|
| Add a roadmap-only connector tile | append a `state:"soon"` entry to `CONNECTORS` | hooks, api, routes |
| Add a real, connectable connector | `CONNECTORS` entry (`available`) **+** sibling of the Gmail hooks/api fns **+** backend routes | the card/modal JSX (data-driven) |
| Add a new field to status (e.g. `quotaLeft`) | extend `GmailStatus` in `api.ts` → render in modal | the query key/staleTime |
| Make connect a soft (no-reload) navigation | after `?gmail=connected`, call `useInvalidateGmailStatus()` | the banner map |
| Change what "connected" shows | `ConnectorCard` badge logic / modal header | the query — `connected` is server truth |
| A second write action (e.g. label) | a new mutation hook + api fn + a section in the modal | `useGmailStatus` |

**The rule of thumb:** *display* config → `CONNECTORS`; *server state* → a TanStack hook; *network* →
an `api.ts` fn. Never a fourth place.

---

## 10. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Linking `<a href="…/connectors/gmail/start">` or letting `/start` `302` to Google. | `fetch` the URL *with* the auth header, then `window.location.href = url`. A redirect drops `Authorization` → server can't seal `userId` into `state`. |
| Storing/rendering a token, refresh token, or `refreshTokenEnc` in the SPA. | The only client type is `GmailStatus` (metadata). Tokens live server-side; the UI shows `connected`/`googleEmail` and nothing more. |
| Putting a `from` (or `userId`) field on the compose form. | Send only `to/subject/body`; the backend re-derives `from` from the session. A client-supplied sender is a confused-deputy hole. |
| Mirroring `connected` into `useState` and toggling on click. | Read `status.data?.connected`; mutate; invalidate the status key. The cache is the source of truth. |
| Calling `useGmailStatus()` in the page **and** the modal. | Lift one query to the page; pass `connected`/`email` as props. |
| Hardcoding `if (id==="gmail")` branches through the card/modal JSX. | Drive the grid from `CONNECTORS`; gate Gmail-only bits behind one `isGmail` flag. |
| Leaving `?gmail=connected` in the URL after showing the banner. | `params.delete("gmail"); setParams(params, { replace:true })` so a refresh doesn't re-fire it. |
| Making a `state:"soon"` card clickable / openable. | `disabled` the button **and** guard `onOpen` (`c.state !== "soon"`). |
| `window.location.href = url` without a `try/catch`. | On throw, `setError` + `setConnecting(false)` — you haven't left the app yet, so recover in place. |
| Forgetting scroll-lock cleanup in the modal effect. | Capture `prev = document.body.style.overflow` and restore it on unmount (and remove the keydown listener). |

---

## 11. Output contract — a connector-frontend change is "done" when

1. **Catalog:** the connector is a declarative `CONNECTORS` entry; the card renders its badge from
   `state` + live status, and `soon` tiles are non-interactive.
2. **Status:** a single `useGmailStatus`-style query owns connected state; cards/modal read it (or its
   props), never a local `useState` copy.
3. **Connect:** clicking Connect fetches the `/start` URL *with* the auth header and navigates the
   browser to Google; failures recover in place.
4. **Return:** the `?<connector>=connected|denied|error` param drives a one-shot banner that is then
   stripped from the URL.
5. **Disconnect:** the mutation hits `DELETE`, and `onSuccess` invalidates the status key so every
   consumer flips at once.
6. **Tokens:** no token, refresh token, or sender address exists in any frontend type, form, or render
   path — verified by reading the `*Status` interface and the send input.
7. **Verified:** connect → banner "connected" → card shows **Connected** / "Connected as {email}" →
   test-send returns ids → disconnect flips back. (Backend round-trip per `oauth-flow-and-pkce.md`.)
