# Scheduling & Cron — "send this email at 9am" without a server that's awake at 9am

> How to defer a connector write (scheduled Gmail send) on a stack that **cannot hold a timer**:
> there is no Gmail scheduled-send API, so you **store a row + let an external cron fire it**, and you
> claim each due row with **one atomic guarded `UPDATE`** so two overlapping cron ticks can't double-send.
> Read this when the task says "send later", "schedule", "cron", "atomic claim", or "idempotent send".
> Adjacent refs: `human-in-the-loop-approval.md` (the approval that gates a *scheduled* write too),
> `lumina-connectors-architecture.md` (where the route mounts), `token-vault-encryption.md` (the same
> session/refresh path the cron worker uses at fire time). The proven prior art is the finance cron in
> [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts) — copy its `CRON_SECRET` guard verbatim.

---

## 1. Why this is hard on THIS stack (the constraint that drives the whole design)

| Wish | Reality on Lumina's deploy topology | Consequence |
|------|-------------------------------------|-------------|
| "Schedule the send with Gmail." | **Gmail has no scheduled-send API.** The web UI's "Schedule send" is a Google-internal feature, not exposed on `gmail.send`. `sendGmail` in [`send.ts`](../../../../backend/connectors/gmail/send.ts) only POSTs `messages/send` (fire-now). | We own the clock. Store the intent, fire it ourselves later. |
| "Use `setTimeout`/a queue in the API." | Vercel functions are **per-request and freeze between calls** — no long-lived process, no in-memory timer survives the response. (Same reason the finance WebSocket lives in `worker/` on Fly, per `lumina-finance-architecture.md`.) | A timer set inside a request is dead the instant the function returns. |
| "Use Vercel Cron." | Vercel Cron on **Hobby = once per day, GET-only**, and it still wakes a frozen function. Minute-granularity scheduling needs a paid plan and is GET-only (can't carry a secret body cleanly). | Don't depend on Vercel Cron for sub-daily sends. Use an external scheduler. |

**The pattern (the only correct shape here):** the API call that schedules a send does a **fast DB
write** (a `scheduled_email` row, `status=PENDING`, `sendAt=…`). An **external cron** POSTs an authed
"run due" endpoint every minute; that handler **atomically claims** each due row and sends it. This is
exactly the **store-a-row + external-cron** half of Non-Negotiable #5 in the SKILL, and it reuses the
finance `POST /cron/refresh` machinery — only the work inside changes.

```
schedule time (user)          fire time (cron, minutes/hours later)
─────────────────────         ─────────────────────────────────────
POST /connectors/gmail/        cron-job.org / Fly worker
  schedule                      │  every 1 min
  → INSERT scheduled_email      ▼
    {status:PENDING, sendAt}    POST /connectors/gmail/cron/run   (Bearer CRON_SECRET)
  (returns instantly)            │
                                 ├─ SELECT due rows (sendAt<=now, status=PENDING)
                                 ├─ for each: ATOMIC CLAIM  ── lose? skip (another tick has it)
                                 │              win? → sendGmail(...) → status=SENT (or FAILED)
                                 └─ JSON {claimed, sent, failed}
```

---

## 2. The atomic claim — the one mechanism you must get right

Two cron ticks can overlap (a run takes longer than the interval; cron-job.org retries on timeout;
you run a Fly worker AND a backup scheduler). **Never read-then-write the status in app code** — the
classic "read PENDING, then set SENDING" double-sends under that race. Claim the row with a **single
guarded `UPDATE`**; the database row lock is the single ticket window (§D of R-SCALE — the same
mechanism as `UPDATE stock SET qty=qty-1 WHERE id=? AND qty>0`).

```ts
// CLAIM: only the tick whose UPDATE actually matched a PENDING row may send it.
// Prisma returns { count } — count===1 means WE won the row; count===0 means someone else did.
const claim = await prisma.scheduledEmail.updateMany({
  where: { id: row.id, status: "PENDING" },   // guard: still PENDING at the instant we write
  data:  { status: "SENDING", claimedAt: new Date() },
});
if (claim.count === 0) continue;              // lost the race — another worker owns it, skip

try {
  const r = await sendGmail({ userId: row.userId, to: row.to, subject: row.subject, body: row.body });
  await prisma.scheduledEmail.update({
    where: { id: row.id },
    data: { status: "SENT", sentMessageId: r.id, sentAt: new Date() },
  });
} catch (e) {
  // Failure path: bump attempts; terminal-fail after N so a broken row can't loop forever.
  await prisma.scheduledEmail.update({
    where: { id: row.id },
    data: { status: row.attempts + 1 >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
            attempts: { increment: 1 }, lastError: String(e).slice(0, 500) },
  });
}
```

Why each piece matters:

| Piece | Reason | R-SCALE tie |
|-------|--------|-------------|
| `where: { status: "PENDING" }` inside the `UPDATE` | The status guard IS the lock. Request #2 finds the row already `SENDING`, matches 0 rows, and skips. No row-level read race. | §D Q15 (atomic guarded write) |
| `count === 0 → skip` | The loser of the race does nothing — it must not send, not retry, not error. | §E (server arrival order; the DB orders the claims) |
| `PENDING → SENDING → SENT/FAILED` states | A send that crashes mid-flight is recoverable: a stuck-`SENDING` reaper (see §5) can re-PEND it after a TTL. | §G Q22 (order pipeline states) |
| `attempts` + `MAX_ATTEMPTS` | A permanently-bad row (revoked token, bad address) terminates instead of being re-sent every minute forever. | §G Q24 (compensating/terminal action) |

**Idempotency on top of the claim.** The claim prevents two *concurrent* sends; an **idempotency key**
prevents a *retried* send from delivering twice if the process dies *after* Gmail accepted the message
but *before* we wrote `SENT`. Store a unique `idempotencyKey` per scheduled row; on the retry, the
claim re-PENDs the row, but before re-calling `sendGmail` check whether a message with that key was
already delivered (or pass the key through and let the send path no-op a duplicate). The cheap version:
a stuck-`SENDING` reaper that only re-PENDs after a generous TTL (e.g. 10 min) accepts at-most-once for
the common case and at-least-once only for true crashes — state that tier explicitly.

---

## 3. The route — copy the finance cron guard exactly

The finance warmer in [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts) (in
`POST /cron/refresh`) already encodes the authed-cron pattern: read `CRON_SECRET` from env, accept it
as a `Bearer` token **or** an `x-cron-secret` header, and **skip the guard if the secret is unset**
(so local dev curls work). Reuse it verbatim for the send runner — only the body of work differs.

```ts
// backend/connectors/gmail/cron.ts  — mounted as POST /connectors/gmail/cron/run
// Guard copied from financeRouter.post("/cron/refresh", …) in backend/finance/routes.ts.
function checkCronSecret(req): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;                                   // unset → open (dev only)
  const auth = req.headers["authorization"];
  const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
  const provided = bearer || (req.headers["x-cron-secret"] as string | undefined);
  return provided === secret;
}

gmailRouter.post("/cron/run", async (req, res) => {       // PUBLIC route — guarded by the secret, not auth middleware
  if (!checkCronSecret(req)) return res.status(401).json({ error: "unauthorised" });
  const due = await prisma.scheduledEmail.findMany({
    where: { status: "PENDING", sendAt: { lte: new Date() } },
    take: 50,                                              // bound the batch; next tick takes the rest
    orderBy: { sendAt: "asc" },                            // oldest-due first (fair ordering)
  });
  let sent = 0, failed = 0, claimed = 0;
  for (const row of due) { /* atomic claim + send from §2; tally */ }
  res.json({ scanned: due.length, claimed, sent, failed });
});
```

**Mounting & auth posture.** Mirror how the connector router and the finance router mount in
[`backend/index.ts`](../../../../backend/index.ts) (`app.use("/connectors/gmail", gmailRouter)` near
the `/finance` mount). The cron route is **PUBLIC at the middleware layer** — like `/finance/cron/refresh`
and like the OAuth `/callback`, it carries no user auth header; its security is the `CRON_SECRET`, not
`middleware`. Keep it as a **per-route public handler** on the otherwise-`middleware`-guarded
`gmailRouter` (the same per-route pattern `/callback` uses in [`routes.ts`](../../../../backend/connectors/gmail/routes.ts)).

**At fire time, identity is the stored `userId`, never the model and never the request.** The runner
calls `sendGmail({ userId: row.userId, … })`; `sendGmail` in [`send.ts`](../../../../backend/connectors/gmail/send.ts)
re-derives the from-address from `getGmailSession(row.userId)` and mints a fresh access token from the
encrypted refresh token — there is no request user here, so the row's `userId` is the only identity.
This preserves Non-Negotiable #1 (server-bound identity) into the deferred path.

---

## 4. Who runs the cron — the decision

| Option | Granularity | Carries a secret? | Use it when | Don't |
|--------|-------------|-------------------|-------------|-------|
| **cron-job.org** (free) | down to 1 min | yes — custom `Authorization: Bearer …` header | **Default.** Same scheduler already pointed at `/finance/cron/refresh`; add a second job → `…/connectors/gmail/cron/run`. Zero new infra. | If you need second-level precision or in-process queueing. |
| **Fly worker** (`worker/`, already deployed for finance WS) | any (its own loop) | yes — env var, internal call | You already run the worker and want one place that owns timers; or you need a stuck-`SENDING` reaper on a tight loop. | As a *new* service just for this — that's over-build for minute-granularity. |
| **Vercel Cron** | **Hobby = 1×/day, GET-only** | awkwardly (GET, no body) | Never for sub-daily sends. Acceptable only for a once-a-day digest. | Anything that must fire at a user-chosen time. |
| In-process `setTimeout` / queue | — | — | **Never on Vercel** — the function freezes after the response. | Always. This is the trap the whole doc exists to prevent. |

**Decision in one line:** add a cron-job.org job (you already have the account for finance) → `POST
…/connectors/gmail/cron/run` with `Authorization: Bearer $CRON_SECRET` every 1 minute. Promote to the
Fly worker only if you need the reaper loop or sub-minute precision.

```
Need to fire a deferred send?
  ├─ user-chosen time, minute granularity? ── cron-job.org → POST /cron/run (Bearer CRON_SECRET)   ← default
  ├─ need a tight reaper / sub-minute / already in the worker? ── Fly worker loop → same endpoint or direct call
  ├─ once-a-day digest only? ─────────────── Vercel Cron is *barely* acceptable (GET, 1×/day)
  └─ "I'll just setTimeout in the route" ─── NO. The function freezes. Store a row.
```

---

## 5. The schema (proposal — mirror `GmailConnection`)

There is no `ScheduledEmail` model yet; `GmailConnection` in
[`backend/prisma/schema.prisma`](../../../../backend/prisma/schema.prisma) (around line 86) is the
shape to copy: `@@map` snake_case, `userId` FK with `onDelete: Cascade`, `@map`'d columns. Add:

```prisma
model ScheduledEmail {
  id             String        @id @default(uuid())
  userId         String        @map("user_id")                 // identity at fire time (NOT model-supplied)
  to             String
  subject        String
  body           String
  cc             String?
  bcc            String?
  sendAt         DateTime      @map("send_at")                 // when it becomes due
  status         ScheduledStatus @default(PENDING)             // PENDING→SENDING→SENT|FAILED|CANCELLED
  attempts       Int           @default(0)
  maxAttempts    Int           @default(3) @map("max_attempts")
  idempotencyKey String        @unique @map("idempotency_key") // dedupe a retried send
  claimedAt      DateTime?     @map("claimed_at")              // stuck-SENDING reaper TTL anchor
  sentAt         DateTime?     @map("sent_at")
  sentMessageId  String?       @map("sent_message_id")         // Gmail message id (audit / dedupe)
  lastError      String?       @map("last_error")
  createdAt      DateTime      @default(now()) @map("created_at")

  user           User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([status, sendAt])                                    // the due-row query hits this index
  @@map("scheduled_email")
}

enum ScheduledStatus { PENDING SENDING SENT FAILED CANCELLED }
```

Notes:
- **`@@index([status, sendAt])`** — the runner's hot query is `status=PENDING AND sendAt<=now`. Without
  this composite index it's a full-table scan every minute (R-SCALE §A Q4). Index it from day one.
- **`claimedAt`** anchors the reaper: a row stuck in `SENDING` past a TTL (process died mid-send) gets
  re-PENDed: `UPDATE … SET status='PENDING' WHERE status='SENDING' AND claimedAt < now()-TTL`.
- **Cancellation** is its own atomic guard, same shape as the claim and idempotent: `UPDATE … SET
  status='CANCELLED' WHERE id=? AND status='PENDING'`. You can only cancel before it's claimed; cancel
  while `SENDING` loses the race and the send proceeds (state that honestly to the user). Don't
  `set status` blindly from app code (R-SCALE §G Q24b).

---

## 6. Scheduling a write that needs approval

A scheduled send is still a **write**, so the HITL gate in `human-in-the-loop-approval.md` (Non-Negotiable
#4) applies — but the timing inverts: you **approve at schedule time**, then trust the row at fire time.

- The chat tool that schedules (`scheduleEmail`, a `needsApproval` write) renders the draft + the
  send-time; the user approves; the **approval is what authorizes the INSERT**. The cron runner does
  **not** re-prompt — there's no user present at 9am. The approval (HMAC-verified, per `experimental_toolApprovalSecret`)
  is the authorization that the row carries forward.
- Re-authorization at fire time is **token-level, not user-level**: `sendGmail` re-derives the session
  and will throw `GmailAuthError`/`GmailNotConnectedError` (re-exported from
  [`client.ts`](../../../../backend/connectors/gmail/client.ts) via [`send.ts`](../../../../backend/connectors/gmail/send.ts))
  if the user disconnected between scheduling and firing — that's caught in the runner's `catch` and
  marks the row `FAILED` with `lastError`. **Disconnect must not silently send from a dead connection.**

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| `setTimeout(() => sendGmail(...), delayMs)` inside the schedule request. | Store a `scheduled_email` row; an external cron fires it. The Vercel function freezes the moment it responds — the timer never runs. |
| Looking for a Gmail "schedule send" API parameter. | There isn't one on `gmail.send`. Own the clock yourself (row + cron + `messages/send` at fire time). |
| Cron handler: `SELECT … WHERE status=PENDING` then later `UPDATE … SET status=SENDING`. | One atomic `updateMany({ where:{ id, status:'PENDING' }, data:{ status:'SENDING' } })`; `count===0` ⇒ another tick won ⇒ skip. The status guard is the lock. |
| Picking due rows by a client/scheduler-supplied timestamp or "first to ask". | Order by `sendAt asc` and let the DB claim decide the winner — server/DB arrival order, not client clocks (R-SCALE §E). |
| Re-sending on every failure with no cap. | `attempts`/`maxAttempts`; terminal-`FAILED` after N. A revoked token would otherwise re-send every minute forever. |
| Re-running approval inside the cron job. | Approve at *schedule* time (the INSERT is the authorized act); the runner trusts the row. Re-auth at fire time is token-level only (catch `GmailAuthError` → `FAILED`). |
| Using Vercel Cron for minute-level sends. | cron-job.org (or the Fly worker) → authed `POST /connectors/gmail/cron/run`. Vercel Hobby cron is 1×/day, GET-only. |
| Leaving the cron route behind `middleware` (it'll 401 — the scheduler has no user token). | Make `/cron/run` a per-route PUBLIC handler guarded by `CRON_SECRET` (Bearer or `x-cron-secret`), exactly like `/finance/cron/refresh` and the OAuth `/callback`. |
| No index on the due-row query. | `@@index([status, sendAt])`; the per-minute scan must not be a full-table scan. |
| `sendGmail({ userId: req.userId, … })` in the runner. | There is no request user at fire time — use `row.userId`. Identity is the stored row (preserves server-bound identity, Non-Negotiable #1). |

---

## 8. Output contract — "scheduled send is done" when

1. Scheduling is a **fast INSERT** of a `scheduled_email` row (`PENDING`, `sendAt`, unique
   `idempotencyKey`) — no timer, no blocking work in the request.
2. A **public, `CRON_SECRET`-guarded** `POST /connectors/gmail/cron/run` exists, mounted like
   `/finance/cron/refresh`, accepting `Bearer`/`x-cron-secret`, open when the secret is unset.
3. Each due row is **claimed by one atomic guarded `UPDATE`** (`WHERE status='PENDING'`); the race
   loser skips. States flow `PENDING→SENDING→SENT|FAILED`.
4. **Idempotency**: a retry after a crash can't double-deliver (unique key + reaper TTL); failures cap
   at `maxAttempts` then terminate.
5. Fire-time identity is **`row.userId`**; `sendGmail` re-derives the session and a disconnect →
   `GmailAuthError` → row `FAILED`, never a silent send.
6. The scheduler is **cron-job.org or the Fly worker** — never Vercel Cron for sub-daily, never an
   in-process timer. The due-row query is **indexed** (`@@index([status, sendAt])`).
7. New backend files (the cron module / Prisma model) → **full restart** + `prisma db push` via the
   *session* pooler (5432), per the dev gotchas in `lumina-finance-architecture.md`.
