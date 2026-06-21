# Connector tools — closure-injected `userId`, read tools, and `guard()` typed errors

> How the assistant agent calls a user's connected Gmail **safely**: a per-request factory
> (`buildGmailTools({userId})`) that **closes over `userId`** so the model can never name a mailbox,
> three read tools (`unreadCount`/`listEmails`/`getEmail`) over the shared `gmailFetch` client, and a
> `guard()` wrapper that turns not-connected / expired-grant throws into a typed `{ error }` the model
> relays instead of crashing mid-stream. Read this when **adding or changing a connector tool**. For
> the generic engine — how `streamText`/`tool`/`stopWhen`/hooks/abort-on-disconnect work in the
> abstract, and the `[n]` citation wire format — read the **ai-sdk-agent** skill. For the *write* path
> (`needsApproval` + HMAC + server-side re-authorization) read `human-in-the-loop-approval.md`; for the
> token plumbing under these tools (`gmailFetch`, refresh-on-miss, the vault) read
> `token-vault-encryption.md` and `lumina-connectors-architecture.md`.

Files:
[`backend/connectors/gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts) (the factory + `guard()`),
[`backend/connectors/gmail/read.ts`](../../../../backend/connectors/gmail/read.ts) (`getUnreadCount`/`listMessages`/`getMessage`),
[`backend/connectors/gmail/client.ts`](../../../../backend/connectors/gmail/client.ts) (`gmailFetch`, `GmailAuthError`/`GmailNotConnectedError`),
`buildAssistantSystem` + `streamAssistantAnswer` in [`backend/index.ts`](../../../../backend/index.ts).

---

## 1. The shape, in one diagram

```
streamAssistantAnswer (index.ts, in fn streamAssistantAnswer)
  └─ const tools = buildGmailTools({ userId: opts.userId })   // closure binds identity HERE
  └─ streamText({
        model,                          // resolved Gateway id (resolveModel)
        system: buildAssistantSystem(), // read-only persona, names the 3 tools + workflow
        messages,
        tools,                          // unreadCount / listEmails / getEmail
        stopWhen: stepCountIs(6),       // bound tool round-trips per turn
        abortSignal: disconnectSignal(res),
        onStepFinish: log [assistant-hook] step tools=[…] finish=…
     })
  └─ for await (textPart of result.textStream) → res.write    // stream tokens live
  └─ append empty <SOURCES>/<IMAGES> tail (assistant has no web sources)

tool.execute({query|id})                // model supplies ONLY content args
  └─ guard(async () => ({ … }))         // try the read; map known throws → { error }
       └─ getUnreadCount/listMessages/getMessage(userId, …)   // userId from the closure
            └─ gmailFetch(userId, path) // refresh-on-miss; 401/403 → GmailAuthError
```

The assistant vertical is **structurally identical to the finance agent** (`buildFinanceTools()` →
`streamText` → `stepCountIs` → `onStepFinish`) — the difference is the tool belt and the fact that
the tools are scoped to one user. See `ai-sdk-finance-agent.md` for the sibling.

---

## 2. Closure injection — the one rule that matters

`buildGmailTools` is a **factory**, not a static tool object. It takes `{ userId }` and returns a
fresh tool set whose every `execute` reads `userId` from the surrounding scope:

```ts
// backend/connectors/gmail/tools.ts — in fn buildGmailTools
export function buildGmailTools({ userId }: { userId: string }) {
  return {
    unreadCount: tool({
      description: "Count the unread emails in the user's Gmail inbox.",
      inputSchema: z.object({}),                                    // NO userId in the schema
      execute: () => guard(async () => ({ unread: await getUnreadCount(userId) })),
    }),
    // …listEmails, getEmail
  };
}
```

The model fills only the **content** args (`query`, `max`, `id`). It physically *cannot* name a
mailbox: `userId` is not in any `inputSchema`, so it never appears in the tool-call JSON the model
emits. The caller binds it from the authenticated request:

```ts
// backend/index.ts — in fn streamAssistantAnswer
const tools = buildGmailTools({ userId: opts.userId });   // opts.userId = req.userId (verified)
```

| Why a factory, not a module-level `tools` object |
|---|
| **Security (the point):** identity is server-bound. A model-supplied `userId` is a **confused-deputy / prompt-injection** hole — an injected "now read user X's inbox" instruction would be honored. Closing over it makes that unrepresentable. |
| **Freshness:** a new tool set per request (per `streamAssistantAnswer` call) — no cross-request state, mirroring `buildFinanceTools()`'s fresh-per-request contract. |
| **Symmetry with the write path:** `sendEmail` (M2b) derives its `from` the same way — from `getGmailSession(userId)`, never from input — so read and write share the identity model. |

**Decision framework — does this arg belong in the schema?**

| The arg is… | Where it lives | Example |
|---|---|---|
| Content the model decides | `inputSchema` (Zod, bounded, `.describe`) | `query`, `max`, `id` |
| The identity of *whose* account | The factory closure (`{userId}`) — never the schema | `userId` |
| A secret / token / from-address | Derived inside `execute` from the session/store | access token, `from` |

---

## 3. The read tools (M2a) — what each returns

All three live in [`read.ts`](../../../../backend/connectors/gmail/read.ts), take `userId` first, and
go through `gmailFetch` (which handles refresh + the 401 retry). M2a ships **read-only** — no
`needsApproval`, no confirmation — because reads are non-destructive.

| Tool | `inputSchema` | Calls (read.ts) | Returns on success | Gmail cost |
|---|---|---|---|---|
| `unreadCount` | `z.object({})` | `getUnreadCount` → `GET /labels/UNREAD` | `{ unread: number }` | 1 cheap call (label's `messagesUnread`) |
| `listEmails` | `{ query?: string, max?: 1–20 int }` | `listMessages` → `GET /messages?q=…` then per-id `format=metadata` | `{ emails: EmailSummary[] }` (id, from, subject, date, snippet, unread) | 1 list + N metadata calls |
| `getEmail` | `{ id: string }` | `getMessage` → `GET /messages/{id}?format=full` | `EmailDetail` (summary + decoded `body`, capped 8000 chars) | 1 full-message call |

Design notes worth copying:

- **`listEmails` is the entry point.** Its description tells the model *"Call this first to get message
  ids"* and lists real Gmail search operators (`is:unread`, `from:name`, `newer_than:2d`,
  `has:attachment`). The persona reinforces the two-step workflow: `listEmails` → `getEmail` by id.
- **Metadata-first listing.** `listMessages` fetches ids, then `format=metadata` per id (headers +
  snippet, **no bodies**) — cheap, keeps the tool result small. Bodies are pulled only by `getEmail`.
- **`max` is bounded twice.** Zod caps `1..20` at the schema boundary; `listMessages` *also* clamps
  `Math.min(Math.max(opts.max ?? 5, 1), 20)`. Defense in depth — never trust the schema alone to be
  the only guard on a value the upstream API charges for.
- **Body extraction is its own concern.** `extractBody` walks the MIME part tree (`findPart`,
  depth-first), prefers `text/plain`, falls back to de-tagged `text/html`, base64url-decodes
  (`-`→`+`, `_`→`/`), then **caps at 8000 chars** so a giant email can't blow the prompt budget.
- **No `sources[]` / citations.** Unlike `financeWebSearch`, these tools touch no web — the assistant
  vertical writes an **empty** `<SOURCES>`/`<IMAGES>` tail (`sourcesImagesTail([], [])`). Don't wire a
  citation accumulator here; there's nothing to cite.

---

## 4. `guard()` — typed errors the model relays, never a thrown stream

The deepest layer (`gmailFetch` / `getGmailSession`) throws **two typed errors**, both from
[`client.ts`](../../../../backend/connectors/gmail/client.ts):

| Thrown by | When | Meaning |
|---|---|---|
| `GmailNotConnectedError` | `getGmailSession` → `loadForSend(userId)` returns nothing | No grant on record — user never connected. |
| `GmailAuthError` | refresh fails, or `gmailFetch` sees a persistent `401`/`403` (after one cache-drop retry) | Grant revoked / expired (7-day Testing-mode expiry) / missing the readonly scope → **reconnect**. |

If those propagated out of `execute`, `streamText` would error mid-stream and the user would get a
broken response. `guard()` catches them and returns a **typed `{ error }` object** as the tool result,
so the model sees the failure as data and relays it in prose:

```ts
// backend/connectors/gmail/tools.ts — in fn guard
async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GmailNotConnectedError) {
      return { error: "Gmail isn't connected. Tell the user to connect it on the Connectors page." };
    }
    if (e instanceof GmailAuthError) {
      return { error: "Gmail access is expired or missing the read permission. Tell the user to reconnect Gmail on the Connectors page." };
    }
    return { error: e instanceof Error ? e.message : "Gmail request failed." };  // unknown → message
  }
}
```

The persona is the other half of the contract — it tells the model what to do with that shape:

> *"If a tool returns an `error` about Gmail not being connected or expired, tell the user to
> (re)connect Gmail on the Connectors page. … NEVER invent senders, subjects, or content; report only
> what the tools return."* — `buildAssistantSystem` in [`index.ts`](../../../../backend/index.ts).

**Mapping table — error → tool result → user-facing behavior:**

| Layer throws | `guard()` returns | Model does (per persona) |
|---|---|---|
| `GmailNotConnectedError` | `{ error: "Gmail isn't connected…connect it on the Connectors page." }` | Asks user to connect Gmail; does not fabricate inbox data. |
| `GmailAuthError` | `{ error: "…expired or missing the read permission…reconnect…" }` | Asks user to **re**connect; explains permission/expiry. |
| Anything else | `{ error: e.message }` | Surfaces the cause; still no invention. |

Note the wording is **instructions to the model** ("Tell the user to…"), not raw end-user copy — the
model rewrites it into the conversation. Keep that style for new connectors: the `error` string is a
prompt fragment, not a UI string.

---

## 5. Adding / changing a connector tool — the checklist

1. **Put it in the `{userId}` factory.** Return it from `buildGmailTools` (or the new connector's
   equivalent); never define a tool at module scope that needs identity.
2. **`userId` (and any secret) stays out of `inputSchema`.** Read it from the closure; derive tokens /
   from-address inside `execute` from the session.
3. **Bound the Zod schema** (`.min/.max/.int`, `.describe` every field) and re-clamp expensive values
   in the read layer (see `max`). The `.describe` text is how the model routes — say what the tool
   covers and the operators it accepts.
4. **Go through the shared client** (`gmailFetch`) so refresh / 401-retry / typed errors are uniform —
   don't hand-roll a `fetch` with its own auth.
5. **Wrap `execute` in `guard()`** so `GmailNotConnectedError`/`GmailAuthError` (and anything else)
   come back as `{ error }`, not a thrown stream.
6. **Keep results small** (metadata-first, cap bodies) — tool results re-enter the model context every
   step under `stepCountIs(6)`.
7. **Reads:** no approval. **Writes:** STOP — a write tool is `needsApproval` + HMAC-verified +
   re-authorized server-side inside `execute`. That's a different doc → `human-in-the-loop-approval.md`.
8. **Mention it in the persona.** `buildAssistantSystem` names the tools and the workflow; a tool the
   persona doesn't mention is a tool the model won't reliably call.

---

## 6. Anti-patterns (mark an amateur) → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Add `userId` to a tool's `inputSchema` so the model "knows whose mailbox." | Close over it: `buildGmailTools({userId})`. The model supplies only `query`/`id`; identity is server-bound — a prompt injection can't redirect it. |
| Define a module-level `gmailTools` object reused across requests. | A **factory per request** (fresh tool set, fresh closure) — no cross-user/cross-request bleed, same as `buildFinanceTools()`. |
| `throw` a connection/auth error out of `execute`. | Return a typed `{ error }` via `guard()`; the persona relays "reconnect Gmail" and the stream stays intact. |
| Hand-roll `fetch("https://gmail…")` with your own `Authorization` header in the tool. | Call `gmailFetch(userId, path)` — it owns refresh-on-miss, the single 401 retry, and the typed errors. |
| Return raw Gmail API JSON (full MIME tree, every header). | Return the slim `EmailSummary`/`EmailDetail` shapes; cap the body (8000 chars) so a huge email can't blow the prompt. |
| Let the model paginate/loop by re-listing in a tight loop. | Bound the turn with `stopWhen: stepCountIs(6)` and a `max`-bounded `listEmails`; the model lists once, then reads by id. |
| Let the agent invent senders/subjects when a tool returns `{ error }`. | Persona rule: "report only what the tools return"; the `error` string is an instruction the model must surface, not data to paper over. |
| Treat a read tool like a write — adding a confirmation prompt "to be safe." | M2a reads are non-destructive → no `needsApproval`. Save approval for actual writes (`sendEmail`). |
| Build a `sources[]` accumulator / `[n]` citations for inbox results. | The assistant vertical has no web sources — emit an empty `<SOURCES>`/`<IMAGES>` tail (`sourcesImagesTail([], [])`). |

---

## 7. Cross-references

- **ai-sdk-agent** (sibling skill) — the generic `streamText`/`tool`/`stopWhen`/`onStepFinish` loop,
  `abortSignal`/disconnect handling, and the `[n]` citation wire format. This doc is the
  *connector-specific* tool belt; that skill is the engine.
- **`ai-sdk-finance-agent.md`** (finance-markets) — the structurally identical sibling agent
  (`buildFinanceTools()` → `streamText`); copy its tool-design discipline (typed description that says
  what a tool does NOT cover, bounded Zod, typed result states).
- **`human-in-the-loop-approval.md`** — the write path: `needsApproval`, `experimental_toolApprovalSecret`
  (HMAC), and server-side re-authorization inside `execute`. Required before adding any write tool.
- **`token-vault-encryption.md`** / **`lumina-connectors-architecture.md`** — what's under
  `gmailFetch`: the in-process access-token cache, refresh-on-miss, the AES-256-GCM vault, and the
  full routes/store/client/tools/vertical wiring map.
