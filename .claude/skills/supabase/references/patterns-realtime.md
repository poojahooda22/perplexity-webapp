# Supabase Realtime — Postgres Changes, Broadcast, and Presence

> The three primitives, their lifecycle, RLS authorization, payload shapes, event filtering, scaling
> economics, reconnection semantics, and TanStack Query cache integration — without refetch storms.
> Generic/reusable; Lumina's live-finance Broadcast path is the worked example throughout.

---

## 1. The Three Primitives

Supabase Realtime is a standalone Elixir/Phoenix service that multiplexes three distinct features
over **one WebSocket connection per client**. Picking the wrong primitive is the single most common
mistake. The decision rule in one sentence: **if the data must survive a browser refresh, it belongs
in a table and you use Postgres Changes (or a DB-triggered Broadcast); if it is transient "who/
where/what right now" data, use Broadcast or Presence and never touch the database.**

| Primitive | Source of truth | RLS-checked | Durable | Typical use |
|-----------|-----------------|-------------|---------|-------------|
| **Postgres Changes** | Database WAL | Yes — per row, per subscriber | Yes | New persisted message, order-status update, enrollment created |
| **Broadcast** | The sender | Authorization on channel join only (not per message) | No — ephemeral | Live prices, cursor positions, typing dots, high-frequency ticks |
| **Presence** | Each client's tracked state, CRDT-synced | Channel-topic authorization | No — state cleared on disconnect | Online roster, "N people viewing", typing indicators in small rooms |

### Architecture in brief

**Postgres Changes** taps the `supabase_realtime` logical-replication publication. For every change
on a published table, Realtime **impersonates each connected subscriber and runs the table's `SELECT`
RLS policy** against the changed row to decide who may see it. This is the critical and often-missed
fact: the RLS check executes per-change × per-subscriber. Five thousand subscribers watching one
table yields five thousand policy evaluations for every row insert.

**Broadcast** has no database round-trip. A client (or a trusted server via REST) sends a message;
Realtime fans it out to everyone on the same topic. Authorization is a one-time join check, not a
per-message check. This is why Broadcast is the right primitive for high-frequency ephemeral data —
Lumina's live finance ticks are the canonical example.

**Presence** uses Phoenix Presence (a CRDT) to merge each client's state into one shared map and
diff it to everyone. State vanishes automatically on disconnect.

All three ride one WebSocket per client, established lazily on the first `channel.subscribe()`.

---

## 2. Channel Lifecycle

A **channel** is a named topic string. You create it from the client, attach listeners with `.on()`,
then call `.subscribe()` exactly once. A channel can carry any mix of the three primitives.

```ts
import { supabase } from '@/lib/supabase'

const channel = supabase.channel('finance:prices:top', {
  config: {
    broadcast: { self: false, ack: false },
  },
})

channel
  .on('broadcast', { event: 'tick' }, ({ payload }) => {
    // ephemeral price tick arrived
  })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, (payload) => {
    // durable row arrived
  })
  .subscribe((status, err) => {
    switch (status) {
      case 'SUBSCRIBED':
        // Joined. Now safe to track presence, send broadcast, start senders.
        break
      case 'CHANNEL_ERROR':
        // Join rejected — RLS/auth failure on a private channel, or malformed config.
        console.error('[channel] error', err)
        break
      case 'TIMED_OUT':
        // Server didn't ack the join in time; the client will retry with backoff.
        break
      case 'CLOSED':
        // Channel was removed or the socket closed.
        break
    }
  })
```

**Channel naming conventions:**

- Use a stable, scoped convention so two clients that should communicate join the exact same string:
  `entity:id`, `entity:id:subroom`. E.g. `prices:top`, `conversation:abc-123`.
- Do not prefix with `realtime:` — it is added internally.
- Stick to lowercase, colons, and dashes; avoid characters Phoenix reserves.
- One channel per logical room. If a component needs INSERT and UPDATE on the same table for the
  same scope, attach two `.on('postgres_changes', ...)` to one channel; do not open two channels.
- `supabase.getChannels()` returns all open channels. `supabase.removeChannel(ch)` closes one.
  `supabase.removeAllChannels()` closes all — useful on sign-out.

**Idempotency:** call `.subscribe()` exactly once per channel object. Calling it twice is undefined
behavior. To re-subscribe after an auth change, `removeChannel` the old one and create a fresh
`supabase.channel(topic)`.

---

## 3. The Subscription Handle — removeChannel vs unsubscribe

Always store the channel reference returned by `supabase.channel()` and call `removeChannel` in the
cleanup, not `channel.unsubscribe()`. The distinction is important:

- `channel.unsubscribe()` — sends the leave message but leaves the dead channel registered on the
  client. `getChannels()` still lists it; a future `supabase.channel(sameTopic)` may collide.
- `supabase.removeChannel(channel)` — unsubscribes **and** deregisters the channel from the client.
  This is always the correct cleanup in React effects.

```tsx
import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

function ConversationLivePanel({ conversationId }: { conversationId: string }) {
  useEffect(() => {
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversationId=eq.${conversationId}` },
        (payload) => { /* handle */ },
      )
      .subscribe()

    return () => {
      // removeChannel: unsubscribes AND deregisters. Never use channel.unsubscribe() here.
      supabase.removeChannel(channel)
    }
  }, [conversationId])

  return null
}
```

**StrictMode double-mount:** React's StrictMode runs effects twice in development. With the pattern
above (subscribe → cleanup → subscribe) this is harmless. Without the cleanup, you get two live
channels after the first paint and duplicate event handlers. Leaked channels in development under
StrictMode are visible immediately — embrace it.

**On sign-out**, tear down everything before clearing the session so dead channels don't try to
reconnect with a stale token:

```ts
await supabase.removeAllChannels()
supabase.realtime.setAuth(null)
await supabase.auth.signOut()
```

---

## 4. Postgres Changes — Subscribing to Durable Rows

Postgres Changes streams committed DML on a table to subscribed clients. The listener config object:

| Key | Values | Notes |
|-----|--------|-------|
| `event` | `'INSERT'` \| `'UPDATE'` \| `'DELETE'` \| `'*'` | `'*'` subscribes to all three; each payload still has an `eventType` field |
| `schema` | e.g. `'public'` | Required |
| `table` | e.g. `'messages'` | Optional — omit for all tables in the schema (rarely what you want) |
| `filter` | e.g. `'userId=eq.abc'` | Optional server-side filter (see §5) |

The payload type is fully typed when you pass the row type:

```ts
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

type Message = { id: number; content: string; role: string; conversationId: string }

channel.on<Message>(
  'postgres_changes',
  { event: '*', schema: 'public', table: 'messages', filter: `conversationId=eq.${convId}` },
  (payload: RealtimePostgresChangesPayload<Message>) => {
    switch (payload.eventType) {
      case 'INSERT':
        // payload.new is Message; payload.old is {}
        break
      case 'UPDATE':
        // payload.new is Message; payload.old has only replica-identity columns by default (the PK)
        break
      case 'DELETE':
        // payload.new is {}; payload.old has only the PK by default
        break
    }
  },
)
```

**Payload gotchas — these trip everyone:**

- `payload.old` on UPDATE and DELETE contains **only the columns in the table's replica identity**,
  which is just the primary key by default. To receive the full previous row, set
  `REPLICA IDENTITY FULL` on the table (see §4.1). Without it, a DELETE gives you only the `id`.
- `payload.new` is RLS-stripped: columns the subscriber cannot read under their `SELECT` policy are
  omitted, even if the row qualifies.
- `payload.errors` is non-null when Realtime could not deliver the full row (e.g. WAL record too
  large). Always check it.
- **There is no initial snapshot.** Postgres Changes delivers events from the moment you subscribed
  onward. Fetch current state separately with a normal `select`, then merge incoming deltas
  idempotently by primary key — the TanStack Query pattern in §8 implements this correctly.

### 4.1 Enabling Realtime on a Table

Postgres Changes is off by default. A table must be a member of the `supabase_realtime` publication:

```sql
-- Add a table to the realtime publication (put this in a migration):
alter publication supabase_realtime add table public.messages;

-- Optional: get the full previous row on UPDATE/DELETE.
-- Trade-off: larger WAL volume (logs every column on every UPDATE).
-- Default (PK only) is fine when you only need payload.new, keyed by id.
alter table public.messages replica identity full;
```

To inspect what is currently published:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by 1, 2;
```

Do not add high-churn tables you don't actually stream. Every published table's changes are decoded
from the WAL before subscriber filtering; publishing a table that gets millions of writes/day with
zero subscribers still costs decoding work.

---

## 5. Event Filtering

The `filter` string is a **server-side** filter that Realtime applies before authorization,
narrowing what each subscriber receives. Syntax: `column=operator.value` (PostgREST-style).

```ts
// Only messages in a specific conversation
{ event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversationId=eq.abc-123' }

// Only notifications for this user
{ event: '*', schema: 'public', table: 'notifications', filter: 'userId=eq.' + userId }
```

Supported operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`.

**Hard limitations:**

- **One filter per listener.** No `AND`/`OR`. For two filtered slices, attach two `.on()` listeners
  to the same channel.
- **No `like`, `is`, full-text, or JSON-path filters.** Richer matching must happen in the callback
  (client-side) or via a DB-triggered Broadcast that computes the topic in SQL.
- **The filter is not a security boundary.** A client can send any filter or none. The filter is a
  throughput optimization; RLS is the security boundary. Never rely on `filter` for access control.

---

## 6. RLS Authorization for Postgres Changes

Postgres Changes is the only primitive whose payloads are filtered by Row Level Security.

**How it works:** for each change on a published table, Realtime impersonates each subscriber (using
their JWT) and runs the table's `SELECT` policy against the changed row. If the policy returns false,
that subscriber does not receive the event at all.

**Prerequisites for correct behavior:**

1. RLS must be **enabled** on the table (`ALTER TABLE t ENABLE ROW LEVEL SECURITY`).
2. A **`SELECT` policy** must exist expressing who may read each row. The same policy gates both
   `select` queries and which Realtime changes a user receives.
3. The client's channel must use the user's current JWT. `supabase-js` sends the current session
   token automatically; after a token refresh, call `supabase.realtime.setAuth(newToken)` (§9).

If a published table has RLS **disabled**, Realtime broadcasts every change to every subscriber
holding the anon key. This is a live data leak. RLS *is* the realtime ACL; there is no separate one.

**Performance note — critical for Realtime.** Because the `SELECT` policy runs per-change ×
per-subscriber, an inefficient policy is multiplied by the audience size:

```sql
-- Fast: wrap auth.uid() so Postgres evaluates it once per statement (initPlan), not per row.
create policy "read own messages"
on public.messages
for select
to authenticated
using (
  user_id = (select auth.uid())   -- the (select ...) wrapper is the key
);

-- Index every column the policy filters on.
create index messages_user_id_idx on public.messages (user_id);
```

A policy that does a sequential scan is tolerable for an occasional `select`; for Realtime it runs
thousands of times per second and will saturate the database.

---

## 7. Broadcast — Ephemeral High-Frequency Messages

Broadcast sends arbitrary JSON to everyone on a topic with no database round-trip, no per-message
RLS check, and the lowest possible latency. It is the right primitive for: live price ticks, cursor
positions, typing dots, reactions, drawing strokes, WebRTC signaling, game state.

```ts
const channel = supabase.channel('prices:top', {
  config: {
    broadcast: {
      self: false, // do NOT echo your own messages back (default false)
      ack: false,  // do NOT wait for a server ack on send (default false, fire-and-forget)
    },
  },
})

channel
  .on('broadcast', { event: 'tick' }, ({ payload }) => {
    bufferTick(payload) // handle the incoming tick
  })
  .subscribe((status) => {
    if (status !== 'SUBSCRIBED') return
    // Only send after the channel is joined; pre-join sends are dropped silently.
    startSending(channel)
  })
```

**Config options:**

| Option | Default | When to flip |
|--------|---------|-------------|
| `broadcast.self` | `false` | `true` for a design where one code path handles both local and remote events (adds one round-trip of latency to your own actions) |
| `broadcast.ack` | `false` | `true` when you need delivery confirmation; costs a round-trip per send — **never** for per-frame data like ticks or cursors |

**Throttle high-frequency senders.** Pointer/scroll events fire far faster than anyone can perceive.
Cap at ~20–30 Hz (33–50 ms). This is the biggest single lever on your message bill:

```ts
function throttle<T extends (...a: unknown[]) => void>(fn: T, ms: number): T {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T>
  return ((...args: Parameters<T>) => {
    lastArgs = args
    const now = Date.now()
    const remaining = ms - (now - last)
    if (remaining <= 0) { last = now; fn(...args) }
    else if (!timer) {
      timer = setTimeout(() => { last = Date.now(); timer = null; fn(...lastArgs) }, remaining)
    }
  }) as T
}

const sendCursor = throttle((x: number, y: number) => {
  channel.send({ type: 'broadcast', event: 'cursor', payload: { x, y } })
}, 40) // ~25 Hz
```

### Private Broadcast Channels

Broadcast messages are not RLS-checked per message, but **joining a channel topic can require an
authorization policy** via `config.private: true`:

```ts
const channel = supabase.channel('orders:abc-123', {
  config: { private: true }, // joining requires a realtime.messages SELECT policy
})
```

```sql
-- Allow a user to receive broadcasts on their own order's topic.
create policy "join own order channel"
on realtime.messages
for select
to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id::text = realtime.topic()
      and o.user_id = (select auth.uid())
  )
);

-- Allow a user to send broadcasts on their own order's topic.
create policy "send to own order channel"
on realtime.messages
for insert
to authenticated
with check (
  exists (
    select 1 from public.orders o
    where o.id::text = realtime.topic()
      and o.user_id = (select auth.uid())
  )
);
```

Use private channels for any Broadcast or Presence room whose membership is sensitive.

### Server-Side Broadcast (Service-Role REST API)

A trusted server process can publish to a channel without holding a WebSocket connection. This is
how Lumina's `worker/` pushes finance ticks — see §10 for the full flow. The endpoint is a plain
`fetch` POST to `${SUPABASE_URL}/realtime/v1/api/broadcast` with the service-role key:

```ts
await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
  },
  body: JSON.stringify({
    messages: [
      {
        topic: 'prices:top',
        event: 'tick',
        payload: { symbols: [{ s: 'AAPL', p: 213.45, t: 1719000000000 }] },
      },
    ],
  }),
})
```

The service-role key authorizes the broadcast server-side. Browsers never see it — they subscribe
with only the anon key over their existing Realtime WebSocket.

---

## 8. Broadcast vs Postgres Changes for Fan-Out (Scaling)

This is the core scaling decision and the most common architecture mistake.

**Postgres Changes does not fit high-fanout ticks.** The reason is the per-subscriber RLS
multiplication: a table with 5,000 connected subscribers triggers 5,000 policy evaluations per
row insert. At Finnhub's tick rate during US market hours (hundreds of trades/second), the RLS
evaluator would saturate the database instantly.

**DB-triggered Broadcast inverts the cost model.** The trigger runs once and decides the topic(s)
the change belongs to; all subscribers on that topic receive a plain Broadcast. The authorization
check happens once at join time, not per-change per-subscriber.

```sql
-- Trigger that broadcasts to a per-conversation topic when a message is inserted.
create or replace function public.broadcast_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''   -- always pin search_path in SECURITY DEFINER functions
as $$
begin
  perform realtime.broadcast_changes(
    'conversation:' || new."conversationId",
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return new;
end;
$$;

create trigger on_message_insert
after insert on public.messages
for each row
execute function public.broadcast_new_message();
```

The client subscribes to a private Broadcast channel and authorizes the join once:

```ts
const channel = supabase
  .channel(`conversation:${conversationId}`, { config: { private: true } })
  .on('broadcast', { event: 'INSERT' }, ({ payload }) => {
    appendMessage(payload.record)
  })
  .subscribe()
```

**Decision table:**

| Dimension | Postgres Changes | DB-triggered Broadcast |
|-----------|-----------------|------------------------|
| Authorization cost | Per change × per subscriber (RLS re-run) | Once at join |
| Payload control | Full row (RLS-stripped columns omitted) | Whatever the trigger includes (can redact) |
| Scales to large audiences | No (past a few hundred subscribers) | Yes |
| Best for | Low-fanout, simple cases, prototypes | Production fan-out with many subscribers |

For Lumina's live finance ticks, the decision is even clearer: the worker publishes via the REST API
(not a trigger), and the frequency (hundreds of trades/second) makes Postgres Changes structurally
impossible regardless of audience size.

---

## 9. Presence — Online Roster and Typing Indicators

Presence answers "who is here right now and what are they doing." Each client `track()`s a small
state object; Realtime merges all states (CRDT) and emits `sync`/`join`/`leave` diffs. State
disappears automatically on disconnect — no cleanup row needed.

```ts
type RoomPresence = { userId: string; name: string; typing: boolean }

const channel = supabase.channel('room:42', {
  config: { presence: { key: me.id } }, // unique key per user; groups tabs from the same user
})

channel
  .on('presence', { event: 'sync' }, () => {
    // presenceState() is keyed by presence key; each value is an array (one entry per tab/device)
    const state = channel.presenceState<RoomPresence>()
    const everyone = Object.values(state).flat()
    renderOnlineList(everyone)
  })
  .on('presence', { event: 'join' }, ({ key, newPresences }) => {
    console.log('joined', key, newPresences)
  })
  .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
    console.log('left', key, leftPresences)
  })
  .subscribe(async (status) => {
    if (status !== 'SUBSCRIBED') return
    // Must track AFTER subscribed; pre-join track calls are dropped.
    await channel.track({ userId: me.id, name: me.name, typing: false } satisfies RoomPresence)
  })
```

**Typing indicator via Presence (fine for small rooms):**

```ts
let typingTimer: ReturnType<typeof setTimeout> | null = null
function onKeystroke() {
  channel.track({ ...myState, typing: true })
  if (typingTimer) clearTimeout(typingTimer)
  typingTimer = setTimeout(() => channel.track({ ...myState, typing: false }), 2000)
}
```

For large rooms, prefer **Broadcast** for the typing ping (cheaper than re-syncing the whole
presence map) and reserve Presence for the stable online roster.

**Caveats:**
- Keep presence state **small** (id, name, a flag). Each `track()` syncs the entire merged map to
  all subscribers; large payloads multiply bandwidth and can hit size limits.
- Presence is **not durable**. "Last seen" timestamps must be persisted to a table separately.
- Debounce UI that reacts to `leave` events — a 200 ms network blip can cause rapid join/leave on
  reconnect, flickering avatars out.

---

## 10. Lumina Tie-In: Live Finance Prices via Broadcast

This is the only Realtime feature Lumina actively uses today. It exemplifies every principle above.

### The architecture

```
Finnhub WS ──► worker/index.ts (Fly.io, always-on)
                │  coalesces ticks into dirty Set, calls
                ▼
       POST /realtime/v1/api/broadcast  (service-role key)
                │  payload: { messages: [{ topic, event:"tick", payload:{symbols:[...]} }] }
                ▼
       Supabase Realtime — fans out to all channel subscribers
                ▼
       Browser WebSocket (@supabase/supabase-js)
                ▼
       useLivePrices hook — buffers ticks, flushes to TanStack cache at 4 Hz
```

**Why Broadcast, not Postgres Changes:** Finnhub emits hundreds of trade events per second during US
market hours. Writing each tick to a database table and relying on WAL replication would cost O(ticks
× subscribers) RLS evaluations and add database round-trip latency to something that must feel
instant. Ticks are also ephemeral — a price superseded by the next one has zero value; there is no
reason to persist every individual trade event.

**Why the publisher is in `worker/` (Fly.io), not on Vercel:** cross-cutting rule — Vercel
serverless functions cannot hold a persistent socket or a long-lived timer. A Finnhub WebSocket
connection requires staying alive between requests, which Vercel functions cannot do.

### `use-live-prices.ts` — the subscriber

`frontend/src/hooks/use-live-prices.ts` (105 lines) is the complete shipped hook. Key design
decisions:

**Tick buffering — never write ticks directly to React state.** Incoming ticks are buffered into two
`useRef<Map<string, number>>` objects (`stockBuf`, `cryptoBuf`). Writing to a ref does not schedule
a re-render, so a burst of 50 ticks in 100 ms does not cause 50 re-renders.

```ts
// use-live-prices.ts:38-51
ch.on("broadcast", { event: "tick" }, (msg) => {
  const symbols = (msg.payload as { symbols?: Tick[] } | undefined)?.symbols;
  if (!symbols?.length) return;
  const now = Date.now();
  for (const t of symbols) {
    const base = cryptoBase(t.s);
    if (base) {
      cryptoBuf.current.set(base, t.p);
      lastCrypto.current = now;
    } else {
      stockBuf.current.set(t.s, t.p);
      lastStock.current = now;
    }
  }
})
```

**4 Hz flush into TanStack cache.** A `setInterval` at 250 ms drains both buffers and writes
directly into the TanStack Query cache with `setQueryData`. Components subscribed to those keys
re-render automatically — zero HTTP refetch, zero flicker:

```ts
// use-live-prices.ts:59-89
const flush = setInterval(() => {
  if (stockBuf.current.size) {
    const ticks = stockBuf.current;
    stockBuf.current = new Map(); // swap before the updater so concurrent ticks accumulate fresh
    qc.setQueryData<QuotesPayload>(["finance", "stocks", "us"], (prev) =>
      prev
        ? { ...prev, items: prev.items.map((q) =>
            ticks.has(q.symbol) ? { ...q, price: ticks.get(q.symbol)! } : q
          )}
        : prev,
    );
  }
  if (cryptoBuf.current.size) {
    const ticks = cryptoBuf.current;
    cryptoBuf.current = new Map();
    qc.setQueryData<CryptoPayload>(["finance", "crypto"], (prev) =>
      prev
        ? { ...prev, coins: prev.coins.map((c) =>
            ticks.has(c.symbol) ? { ...c, price: ticks.get(c.symbol)! } : c
          )}
        : prev,
    );
  }
}, 250);
```

**Key alignment is mandatory.** `setQueryData` writes at a specific cache key; if the key does not
exactly match what `useQuery` used to fetch the data, no component receives the update:

| Data | Query key (`use-finance.ts`) | `setQueryData` key (`use-live-prices.ts:64,76`) |
|------|-----------------------------|-------------------------------------------------|
| US stocks | `["finance", "stocks", "us"]` | `["finance", "stocks", "us"]` |
| Crypto | `["finance", "crypto"]` | `["finance", "crypto"]` |

India market data (`market=in`) stays on the 60-second REST poll. The hook explicitly skips it
(comment at `use-live-prices.ts:63`): India stocks have no live worker feed.

**Cleanup — leak avoidance:**

```ts
// use-live-prices.ts:97-101
return () => {
  clearInterval(flush);
  clearInterval(statusTimer);
  if (ch) supabase.removeChannel(ch);  // removeChannel, not ch.unsubscribe()
};
```

The effect depends on `[channel, qc]` — both stable across the finance page lifetime. If `channel`
changes, the effect re-runs: cleanly tears down the old subscription and opens the new one.

**Status reporting (`LiveStatus`):** a second `setInterval` at 2 s polls `lastStock.current` and
`lastCrypto.current` against a 15-second freshness window and updates the `stockStatus` /
`cryptoStatus` state that the finance UI uses to show live/idle/off indicators.

For the full end-to-end implementation detail — worker coalescing, reconnection backoff, watchdog,
server-side broadcast REST call, symbol classifier, environment variables — see
`lumina-supabase-realtime-prices.md`.

---

## 11. Reconnection and At-Most-Once Delivery Semantics

Supabase Realtime reconnects the WebSocket automatically on drop, using **exponential backoff with
jitter**. Open channels are re-joined on reconnect; you do not manage the socket directly.

**Token refresh trap.** The socket authenticates with the JWT held at connect time. When the user's
access token refreshes (every hour with PKCE), the socket's token goes stale. For RLS-gated Postgres
Changes and private channels, a stale token causes changes to silently stop arriving. Fix:

```ts
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
    supabase.realtime.setAuth(session?.access_token ?? null)
  }
  if (event === 'SIGNED_OUT') {
    supabase.removeAllChannels()
    supabase.realtime.setAuth(null)
  }
})
```

Modern `supabase-js` versions call `setAuth` internally on token refresh, but explicitly wiring it
is the safe, version-portable practice.

**Delivery semantics — Broadcast is at-most-once.** A message sent while a subscriber is
disconnected (between reconnects) is lost. There is no message queue or replay. For durable data,
use Postgres Changes (or write to a table and use Changes/DB-Broadcast). For the live-price use
case, a missed tick is fine — the next tick supersedes it, and the TanStack cache still holds the
last known price.

**Post-reconnect resync.** For Postgres Changes, you may have missed events while offline. The
robust pattern is to invalidate the query once on `SUBSCRIBED` to fill the gap, then resume delta
application:

```tsx
channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    // One resync to cover any gap since we were last connected.
    queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
  }
})
```

**Client-side backoff configuration:**

```ts
export const supabase = createClient(url, key, {
  realtime: {
    reconnectAfterMs: (tries: number) => Math.min(1000 * 2 ** tries, 30_000),
    heartbeatIntervalMs: 25_000,
    params: { eventsPerSecond: 20 }, // client-side cap on outgoing message rate
  },
})
```

`eventsPerSecond` is a client-side ceiling on how many messages a single client may emit per second.
It is not a substitute for throttling per-listener (§7), but it provides a safety net.

---

## 12. Scaling: Connection-Count Economics

Realtime is billed and capped on concurrent connections, concurrent channels, and delivered messages.

| Unit | What it counts |
|------|----------------|
| Concurrent connections | Number of clients with an open WebSocket (one per browser tab with ≥1 channel) |
| Concurrent channels | Sum of channels across all clients (one client in 5 rooms = 5 channels on 1 connection) |
| Messages | Every event delivered per recipient (Broadcast to 100 subscribers = 100 messages) |

**The fan-out multiplier is the trap.** A cursor channel at 25 Hz with 50 people in a room:
`25 × 50 senders × 50 recipients = 62,500 messages/second`. This is why throttling and right-sizing
are not optional at scale.

**Rules:**

1. One connection per client, many channels. Don't open parallel sockets; `supabase-js` already
   multiplexes.
2. **Throttle senders** (§7). The biggest lever on message volume.
3. Prefer **DB-triggered Broadcast over Postgres Changes for large audiences** (§8) — eliminates the
   per-subscriber RLS multiplier.
4. **Shard large rooms.** A 10,000-person cursor/presence room is an anti-pattern. Partition into
   sub-rooms, or broadcast aggregates ("247 viewers") on a timer instead of per-person events.
5. **Don't publish high-churn tables you don't stream.** WAL decoding cost accumulates even with
   zero subscribers.
6. **Close channels you don't need.** A modal that opens a presence channel must close it on
   dismiss. Audit `supabase.getChannels().length` in development.
7. For analytics-style features like a live viewer count, send one number on a timer — not a
   Presence sync per viewer.

---

## 13. Integrating Realtime with TanStack Query

TanStack Query owns server-state caching; Realtime delivers deltas. The naive integration —
`invalidateQueries` on every event — causes a refetch storm: N inserts → N full-list network
fetches. The correct integration **applies the delta to the cache in-memory** with `setQueryData`
and only refetches as a fallback.

### The wrong way (refetch storm)

```tsx
// ❌ Every realtime event hits the network.
channel.on('postgres_changes', { event: '*', /* ... */ }, () => {
  queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
})
```

Thirty messages arriving in a burst → 30 refetches of the full list. Wrong.

### The right way (apply delta in cache)

Extract the reducer as a pure function so it is testable independently of the realtime plumbing:

```ts
// Pure reducer — testable with zero network or supabase dependency.
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

type Msg = { id: number; content: string; role: string }

export function applyMessageChange(
  list: Msg[],
  payload: RealtimePostgresChangesPayload<Msg>,
): Msg[] {
  switch (payload.eventType) {
    case 'INSERT': {
      const row = payload.new
      // Upsert-by-id: idempotent, so duplicate or out-of-order delivery is harmless.
      if (list.some((m) => m.id === row.id)) return list.map((m) => (m.id === row.id ? row : m))
      return [...list, row]
    }
    case 'UPDATE': {
      const row = payload.new
      return list.map((m) => (m.id === row.id ? row : m))
    }
    case 'DELETE': {
      const id = (payload.old as Partial<Msg>).id
      return list.filter((m) => m.id !== id)
    }
    default:
      return list
  }
}
```

Wire it to the cache with `setQueryData`:

```tsx
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { applyMessageChange } from './applyMessageChange'
import type { Msg } from './types'

export function useLiveMessages(conversationId: string) {
  const qc = useQueryClient()
  const key = ['messages', conversationId] as const

  useEffect(() => {
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on<Msg>(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `conversationId=eq.${conversationId}` },
        (payload) => {
          qc.setQueryData<Msg[]>(key, (prev) => applyMessageChange(prev ?? [], payload))
        },
      )
      .subscribe((status) => {
        // Resync once on every (re)connect to cover any gap.
        if (status === 'SUBSCRIBED') qc.invalidateQueries({ queryKey: key })
      })

    return () => { supabase.removeChannel(channel) }
  }, [conversationId, qc])
}
```

Pair it with a normal query for the initial snapshot:

```tsx
function useMessages(conversationId: string) {
  const query = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('id, content, role, conversationId')
        .eq('conversationId', conversationId)
        .order('createdAt', { ascending: true })
      if (error) throw error
      return data
    },
  })
  useLiveMessages(conversationId) // keeps the cache current; no per-event refetch
  return query
}
```

**Why this is correct:**

- Initial `useQuery` fetches once. Realtime then mutates the cached array in-memory — zero extra
  network requests per event.
- **Upsert-by-id** makes application idempotent: ordering between the initial fetch and the first
  Realtime event does not matter; the cache converges to one copy regardless.
- The one `invalidateQueries` on `SUBSCRIBED` fills any gap from a reconnect without refetching on
  every steady-state event.

### When to still invalidate (the fallback)

Use `invalidateQueries` only when a delta is insufficient:

| Situation | Action |
|-----------|--------|
| INSERT/UPDATE/DELETE with all needed columns in payload | `setQueryData` (apply delta) |
| Payload is RLS-stripped and the UI needs more columns | Debounced `invalidateQueries` |
| Derived/aggregate query (counts, sums) | Debounced `invalidateQueries` or a separate aggregate |
| Just (re)subscribed `SUBSCRIBED` | One `invalidateQueries` to cover the gap |
| `payload.errors` non-null | One `invalidateQueries` (data may be incomplete) |
| High-frequency Broadcast (ticks, cursors) | Never touch TanStack Query — keep in local state or refs |

**Debounce burst invalidations** so a burst of changes collapses into one refetch:

```tsx
function useDebouncedInvalidate(key: readonly unknown[], ms = 300) {
  const qc = useQueryClient()
  return useMemo(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    return () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => qc.invalidateQueries({ queryKey: key as unknown[] }), ms)
    }
  }, [qc, key, ms])
}
```

---

## 14. Reusable React Hooks

Encapsulate the lifecycle once and reuse. These are StrictMode-safe and typed.

### usePostgresChanges

```tsx
import { useEffect, useRef } from 'react'
import type { RealtimePostgresChangesPayload, RealtimePostgresChangesFilter } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

type Handler<T extends Record<string, unknown>> = (p: RealtimePostgresChangesPayload<T>) => void

export function usePostgresChanges<T extends Record<string, unknown>>(
  topic: string,
  filter: RealtimePostgresChangesFilter<'*'>,
  onChange: Handler<T>,
  enabled = true,
) {
  const handlerRef = useRef(onChange)
  useEffect(() => { handlerRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!enabled) return
    const channel = supabase
      .channel(topic)
      .on<T>('postgres_changes', filter, (p) => handlerRef.current(p as RealtimePostgresChangesPayload<T>))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [topic, enabled, filter.event, filter.schema, filter.table, filter.filter])
}
```

### useBroadcast

```tsx
import { useCallback, useEffect, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export function useBroadcast<P extends Record<string, unknown>>(
  topic: string,
  event: string,
  onMessage: (payload: P) => void,
  opts: { private?: boolean; self?: boolean } = {},
) {
  const channelRef = useRef<RealtimeChannel | null>(null)
  const handlerRef = useRef(onMessage)
  useEffect(() => { handlerRef.current = onMessage }, [onMessage])

  useEffect(() => {
    const channel = supabase.channel(topic, {
      config: { private: opts.private ?? false, broadcast: { self: opts.self ?? false } },
    })
    channel
      .on('broadcast', { event }, ({ payload }) => handlerRef.current(payload as P))
      .subscribe()
    channelRef.current = channel
    return () => {
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [topic, event, opts.private, opts.self])

  // Stable sender; guards against pre-join sends.
  const send = useCallback(
    (payload: P) => {
      const ch = channelRef.current
      if (!ch) return Promise.resolve('not-ready' as const)
      return ch.send({ type: 'broadcast', event, payload })
    },
    [event],
  )

  return { send }
}
```

### usePresence

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export function usePresence<S extends Record<string, unknown>>(
  topic: string,
  presenceKey: string,
  initialState: S,
) {
  const [others, setOthers] = useState<S[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)
  const stateRef = useRef<S>(initialState)

  useEffect(() => {
    const channel = supabase.channel(topic, { config: { presence: { key: presenceKey } } })
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<S>()
        setOthers(Object.values(state).flat())
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel.track(stateRef.current)
      })
    channelRef.current = channel
    return () => {
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [topic, presenceKey])

  const update = useCallback(async (patch: Partial<S>) => {
    stateRef.current = { ...stateRef.current, ...patch }
    await channelRef.current?.track(stateRef.current)
  }, [])

  return { others, update }
}
```

---

## 15. Choosing the Right Primitive

The litmus test: *"If every client disconnected and reconnected, should this data still be there?"*
Yes → durable → Postgres Changes or DB-triggered Broadcast. No → ephemeral → Broadcast/Presence.

| You want to… | Primitive | Why |
|--------------|-----------|-----|
| Push live price ticks at high frequency | **Broadcast** (worker → REST API) | Ephemeral, must not hit the DB; Postgres Changes at tick rate would saturate WAL + RLS evaluator |
| Show a new persisted chat message | **Postgres Changes** (small rooms) or **DB-triggered Broadcast** (large rooms) | Message is durable; Broadcast trigger eliminates per-subscriber RLS cost |
| Render a remote cursor at 30 Hz | **Broadcast** | Ephemeral, high-frequency, never needs persisting |
| Show "Pooja is typing…" | **Broadcast** (large rooms) or **Presence** (small rooms) | A typing ping is ephemeral; Presence re-syncs the whole map per change |
| Show the list of people currently online | **Presence** | Auto-clears on disconnect; no cleanup row |
| Notify a user their query completed | **DB-triggered Broadcast** on `user:{id}` private channel | Server writes a row; trigger broadcasts to the user's private topic |
| Show a "saved" badge when a row updates | **Postgres Changes** | Low fanout, durable, RLS-gated for free |

---

## 16. Anti-Patterns

**Using Postgres Changes for high-frequency ephemeral data (ticks, cursors, typing).** Every event
pays a WAL decode and per-subscriber RLS evaluation for data nobody will ever query. At Finnhub's
tick rate this destroys the database. Fix: Broadcast for ephemeral data.

**Using Broadcast/Presence for data that must survive a refresh.** The message is never stored; a
user who refreshes sees nothing. Fix: if "should this still exist after reconnect?" is yes, write to
a table and stream via Changes or a DB trigger.

**Calling `invalidateQueries` on every Realtime event.** Turns Realtime into a refetch storm. Fix:
apply deltas with `setQueryData` (§13); debounce fallback invalidations; resync once on `SUBSCRIBED`.

**Not calling `removeChannel` on unmount (leaked channels).** Each leaked channel holds a server
subscription, fires duplicate handlers, captures stale closures, and counts against your concurrent-
channel limit. StrictMode makes this visible immediately. Fix: always
`return () => supabase.removeChannel(channel)` from the effect.

**Calling `.subscribe()` more than once on a channel, or reusing a removed channel.** Double-
subscribe is undefined behavior; reused channels collide. Fix: one `subscribe()` per channel object;
`removeChannel` the old one to re-subscribe.

**Relying on the `filter` string for access control.** The filter is a throughput optimization; a
client can send any filter or none. RLS is the security boundary. Fix: enforce visibility with a
`SELECT` policy; the filter is UX, not security.

**Exposing a published table with RLS disabled.** Postgres Changes broadcasts every change to every
anon-key holder — a live data leak. Fix: enable RLS and write a `SELECT` policy on every published
table before adding it to the publication.

**Sending unsupported pre-join messages.** `channel.send(...)` before `status === 'SUBSCRIBED'` is
silently dropped. Guard senders inside the subscribe callback or after checking channel state.

**Forgetting `setAuth` after token refresh / sign-out.** The socket's connect-time JWT goes stale
after an hour; RLS-gated changes silently stop. Fix: wire `onAuthStateChange` to `setAuth` (§11).

**Stuffing large objects into Presence state.** Presence syncs the merged map to everyone on every
`track()`; big payloads multiply bandwidth and can hit size limits. Fix: keep Presence state tiny
(id, name, one flag). Move bulk data to a table fetched on demand.

**One giant room for thousands of users with per-user events.** Fan-out is O(senders × recipients);
at scale this is millions of messages per second. Fix: shard into sub-rooms, send server-computed
aggregates on a timer, cap rendered per-user events.

---

## See also

**Same skill (`supabase`) — read the one the task needs:**
- `lumina-supabase-realtime-prices.md` — the complete end-to-end live-finance architecture: worker
  WebSocket internals, coalescing, reconnection backoff, watchdog, server-side broadcast REST call,
  `use-live-prices.ts` in full depth, status reporting, environment variables, failure diagnosis
- `lumina-supabase-in-this-repo.md` — how Lumina actually uses Supabase: lazy client factory, auth
  middleware, token cache, user provisioning, Prisma vs Supabase division of labor
- `theory-supabase-architecture.md` — Postgres-as-platform, PostgREST, GoTrue, the key model (anon
  vs service-role), JWT structure, project topology
- `theory-row-level-security-model.md` — the authorization mental model governing Postgres Changes:
  `USING` vs `WITH CHECK`, `auth.uid()`, threat model, why Lumina enforces authz in Express + Prisma
- `patterns-rls-policies.md` — writing and indexing the `SELECT` policies that gate realtime
  visibility; `SECURITY DEFINER` helpers; performance testing
- `patterns-auth-flows.md` — `onAuthStateChange`, session lifecycle, wiring `realtime.setAuth`
- `patterns-database-functions-triggers-rpc.md` — the `plpgsql` triggers used for DB-triggered
  Broadcast; pinned `search_path` in `SECURITY DEFINER`

**Other skills:**
- `finance-markets` — Finnhub WS event types, symbol lists, provider licensing, Redis cache
  (`backend/lib/cache.ts`), backend `/finance/*` routes; owns *what* price data flows
- `lumina-frontend` — TanStack Query setup, `QueryClient` provider, how `setQueryData` fits into
  the render pipeline
- `react-typescript` — `useRef` for non-reactive buffers, `useEffect` dependency correctness,
  interval cleanup patterns, stale-closure fixes
- `backend-testing` — how to mock `@supabase/supabase-js` in Bun tests; the `supabase-fake` seam
- `rag-retrieval` — pgvector (lives on Supabase Postgres); cosine retrieval, semantic cache
- `connectors-oauth` — separate Gmail OAuth grant; also uses the Supabase client for auth token
  retrieval but is a distinct concern from Realtime
