# Redis Streams and Pub/Sub — Durable Queues, Fire-and-Forget Messaging, and the Lumina Fan-Out Caveat

> Generic reference for Redis Streams (XADD, XREADGROUP, XACK, XAUTOCLAIM, dead-letter handling) and classic Pub/Sub (SUBSCRIBE/PUBLISH). Covers delivery semantics, consumer groups, back-pressure, and when each primitive is the right tool. Includes the **Lumina-specific caveat**: Upstash REST cannot hold a persistent SUBSCRIBE, so live browser fan-out in Lumina uses **Supabase Realtime via the worker/**, not Redis Pub/Sub.

---

## 1. The Messaging Primitives: A Comparison Table

Redis has three messaging-adjacent primitives. Choosing wrong is one of the most common Redis mistakes.

| Primitive | Durability | Delivery guarantee | Consumer model | Use it for |
|---|---|---|---|---|
| **Streams** (`XADD`/`XREADGROUP`/`XACK`) | Stored in keyspace; persisted (RDB/AOF); replicated | **At-least-once** with `XACK`; replayable from any offset | Consumer groups: each message delivered to one consumer in a group; multiple groups = fan-out | Durable background job queues, ordered event logs, anything that must survive worker restart or crash |
| **Pub/Sub** (`PUBLISH`/`SUBSCRIBE`) | None — not stored, not persisted, not replicated | **At-most-once**, fire-and-forget | Every live subscriber receives every message (broadcast) | Ephemeral live signals: presence pings, cache-invalidation hints, real-time UI ticks — where dropping a frame is harmless |
| **Lists as queues** (`LPUSH`/`RPOP`) | Stored; persisted; replicated | At-most-once-per-pop (work-stealing) | One message → one consumer | Simple FIFO queues without group semantics, no replay |

> **Decision rule:** If you find yourself adding retries, acknowledgement logic, or "did they get it?" code on top of Pub/Sub, you have chosen the wrong primitive. Stop and use a Stream.

---

## 2. Streams — Durable Background Queues

### 2.1 What a Stream is

A Redis Stream is an **append-only log** whose entries are immutable, auto-IDed, and stored in the keyspace. Unlike a List queue (pop destroys the entry) or Pub/Sub (messages are never stored), a Stream entry persists until the stream is explicitly trimmed or the key is deleted. Multiple consumer groups can read the same stream independently, each tracking its own position.

The stream entry ID has the form `<millisecond-timestamp>-<sequence>` (e.g., `1719100000000-0`). The auto-generated `*` form guarantees monotonic order within a stream.

### 2.2 XADD — writing to a stream

```ts
// Append a job to the queue. '*' auto-generates a timestamp-based ID.
// MAXLEN ~ 100000 caps the stream at approximately 100k entries (the ~ is "approx" — faster).
const id = await redis.xadd(
  "lumina:jobs:discover-refresh",
  { MAXLEN: ["~", "100000"] },
  "*",
  {
    type: "refresh-feeds",
    userId: "usr_abc",
    category: "science",
    enqueuedAt: Date.now().toString(),
  },
);
// id: "1719100000000-0"
```

Key options on XADD:

| Option | Example | Effect |
|---|---|---|
| `*` | `XADD key * field val` | Auto-generate ID (recommended) |
| `MAXLEN ~ N` | `MAXLEN ~ 100000` | Approximate cap at N entries; old entries evicted as new ones arrive |
| `MAXLEN = N` | `MAXLEN = 100000` | Exact cap — slower; prefer `~` |
| `MINID ~` | `MINID ~ <id>` | Remove entries older than a given ID (time-based rotation) |
| `NOMKSTREAM` | — | Only append if key already exists; don't create |

### 2.3 XREAD — simple reading without consumer groups

`XREAD` is a stateless read from one or more streams. The caller supplies the last-seen ID; Redis returns all entries after it. There is no server-side cursor — the caller must track its position.

```ts
// Read up to 10 new entries since ID "0" (beginning):
const entries = await redis.xread([{ key: "lumina:jobs:discover-refresh", id: "0" }], {
  COUNT: 10,
});
// entries: [{ name: "lumina:jobs:...", messages: [{ id, message: { type, userId, ... } }] }]

// Read only NEW entries ($ = "only entries arriving after this XREAD call"):
const newEntries = await redis.xread([{ key: "lumina:jobs:discover-refresh", id: "$" }], {
  COUNT: 10,
  BLOCK: 5000, // wait up to 5s for new entries — NOT available on Upstash REST
});
```

**Upstash REST limitation:** `BLOCK > 0` (blocking XREAD) is not available over REST. Blocking calls require a persistent TCP connection. On Upstash, poll at a short interval instead (see §2.7).

### 2.4 Consumer groups — at-least-once delivery

Consumer groups are the core at-least-once mechanism. A group tracks:
- **Delivered-but-unacknowledged** entries in a **Pending Entries List (PEL)** per consumer.
- **Last-delivered-ID** so the next `XREADGROUP` picks up from where the group left off.

```
Stream: lumina:jobs:discover-refresh
  entry-1 (refreshType=science)
  entry-2 (refreshType=health)
  entry-3 (refreshType=academic)

Group: "workers"
  Consumer A → currently processing entry-1 (in PEL)
  Consumer B → currently processing entry-2 (in PEL)
  entry-3 → not yet delivered to any consumer
```

**Create a consumer group:**

```ts
// "MKSTREAM" creates the stream if it doesn't exist.
// "0" starts reading from the beginning; "$" starts from the current tail (new entries only).
await redis.xGroupCreate("lumina:jobs:discover-refresh", "workers", "0", { MKSTREAM: true });
```

**XREADGROUP — claim the next undelivered entries:**

```ts
// ">" means "give me entries not yet delivered to any consumer in this group"
const entries = await redis.xReadGroup(
  "workers",           // group name
  "worker-instance-1", // consumer name (unique per worker instance)
  [{ key: "lumina:jobs:discover-refresh", id: ">" }],
  { COUNT: 5 },        // max entries to claim per call
);

if (!entries || entries.length === 0) {
  // Queue empty — back off and poll again
  return;
}

for (const { id, message } of entries[0].messages) {
  try {
    await processJob(message); // your business logic
    // XACK removes the entry from this consumer's PEL
    await redis.xAck("lumina:jobs:discover-refresh", "workers", id);
  } catch (err) {
    console.error(`[worker] job ${id} failed:`, err);
    // Do NOT XACK on error — the entry stays in the PEL
    // XPENDING / XAUTOCLAIM will requeue it after the visibility timeout
  }
}
```

### 2.5 XPENDING and XCLAIM / XAUTOCLAIM — reclaiming stalled entries

When a consumer dies mid-job, its PEL entries are never acknowledged. They stay in the PEL indefinitely unless another consumer claims them. This is the at-least-once recovery mechanism.

**Inspect the PEL:**

```ts
// Summary: how many pending per consumer, and the oldest idle entry
const summary = await redis.xPending("lumina:jobs:discover-refresh", "workers");
// { pending: 3, minId: "...", maxId: "...", consumers: [{ name: "worker-1", pending: 3 }] }

// Detail: list pending entries with idle time (ms since last delivery)
const detail = await redis.xPending(
  "lumina:jobs:discover-refresh",
  "workers",
  "-",   // min ID
  "+",   // max ID
  10,    // count
);
// [{ id, name (consumer), idle (ms), deliveryCount }]
```

**XCLAIM — explicitly steal an entry from a dead consumer:**

```ts
// Claim entries idle for > 30 seconds into "worker-instance-2"
const IDLE_THRESHOLD_MS = 30_000;

const pending = await redis.xPending("lumina:jobs:discover-refresh", "workers", "-", "+", 100);

for (const entry of pending) {
  if (entry.idle > IDLE_THRESHOLD_MS) {
    const claimed = await redis.xClaim(
      "lumina:jobs:discover-refresh",
      "workers",
      "worker-instance-2", // the new owner
      IDLE_THRESHOLD_MS,
      [entry.id],
    );
    for (const { id, message } of claimed) {
      // process as normal, then XACK
    }
  }
}
```

**XAUTOCLAIM — atomic idle-scan + claim in one command (Redis 6.2+):**

```ts
// Scan the PEL for entries idle > 30s and deliver up to 10 to "worker-instance-2".
// Returns [nextStartId, claimedEntries, deletedIds] (deletedIds are entries whose data was lost).
const [nextId, entries, deleted] = await redis.xAutoClaim(
  "lumina:jobs:discover-refresh",
  "workers",
  "worker-instance-2",
  30_000,  // min idle ms
  "0-0",   // start of PEL scan; use lastNextId from previous call to page
  { COUNT: 10 },
);

for (const { id, message } of entries) {
  try {
    await processJob(message);
    await redis.xAck("lumina:jobs:discover-refresh", "workers", id);
  } catch {
    // stays in PEL
  }
}
// Store nextId to continue scanning on the next iteration if nextId !== "0-0"
```

`XAUTOCLAIM` is the preferred reclaim primitive: it is atomic, produces a continuation cursor, and handles the PEL walk for you. Use it in a periodic health-check loop or as the first step of each worker poll.

### 2.6 Capped streams and MAXLEN

Streams grow unboundedly unless trimmed. Always set `MAXLEN`:

```ts
// On every XADD — cap at ~100k entries (approximate is fine and much faster)
await redis.xAdd("lumina:jobs:discover-refresh", "*", jobFields, { MAXLEN: ["~", "100000"] });

// Standalone trim (e.g. from a cron maintenance job)
await redis.xTrim("lumina:jobs:discover-refresh", "MAXLEN", "~", 50000);
```

Approximate trimming (`~`) uses Redis's internal radix-tree structure to trim in batches, with near-zero per-entry overhead. Exact trimming (`= N`) walks the entire head, which is significantly slower for large streams. Use `~` unless you have a hard cap requirement.

What size cap is appropriate? Consider: each stream entry is a few hundred bytes. 100k entries ≈ ~50 MB RAM. A cron that fires every 5 minutes and enqueues ~10 jobs would take years to hit 100k entries — cap generously. If entries are large payloads, reduce the cap and store the payload separately in a Redis Hash or Postgres, referencing the ID.

### 2.7 Dead-letter handling

A job that consistently fails will be re-delivered each time it is reclaimed. The `deliveryCount` field from `XPENDING` detail tells you how many times an entry has been delivered. Above a threshold, move it to a dead-letter stream:

```ts
const MAX_DELIVERY_ATTEMPTS = 5;
const DLQ_KEY = "lumina:jobs:dlq";

async function processWithDLQ(
  streamKey: string,
  group: string,
  consumer: string,
  id: string,
  message: Record<string, string>,
  deliveryCount: number,
) {
  if (deliveryCount > MAX_DELIVERY_ATTEMPTS) {
    // Move to DLQ — keep the original payload + metadata
    await redis.xAdd(DLQ_KEY, "*", {
      ...message,
      originalStream: streamKey,
      originalId: id,
      failedAt: Date.now().toString(),
      deliveryCount: deliveryCount.toString(),
    });
    // ACK the original so it leaves the PEL (not to be re-tried)
    await redis.xAck(streamKey, group, id);
    console.error(`[dlq] job ${id} moved to DLQ after ${deliveryCount} attempts`);
    return;
  }

  try {
    await processJob(message);
    await redis.xAck(streamKey, group, id);
  } catch (err) {
    // stays in PEL; will be reclaimed again after idle threshold
    console.warn(`[worker] attempt ${deliveryCount} failed for ${id}:`, err);
  }
}
```

The DLQ stream is a regular stream. An ops engineer (or a future recovery cron) can read from it with `XRANGE lumina:jobs:dlq - + COUNT 50`, inspect failures, fix the root cause, and re-enqueue or discard entries manually.

### 2.8 Polling loop (no BLOCK on Upstash REST)

Because Upstash REST cannot block on `XREAD`, a worker on a persistent host (Fly.io, a VPS) should use a poll loop with adaptive back-off:

```ts
// worker/jobs-consumer.ts (on Fly.io — NOT on Vercel)
const STREAM_KEY = "lumina:jobs:discover-refresh";
const GROUP = "workers";
const CONSUMER = `worker-${process.env.FLY_MACHINE_ID ?? "local"}`;
const IDLE_RECLAIM_MS = 30_000;
const POLL_INTERVAL_IDLE_MS = 2_000;
const POLL_INTERVAL_BUSY_MS = 100;

async function poll(): Promise<boolean> {
  // 1. Reclaim any stalled entries from dead consumers
  const [, stalled] = await redis.xAutoClaim(STREAM_KEY, GROUP, CONSUMER, IDLE_RECLAIM_MS, "0-0", {
    COUNT: 5,
  });
  for (const { id, message, deliveryCount } of stalled) {
    await processWithDLQ(STREAM_KEY, GROUP, CONSUMER, id, message, deliveryCount ?? 1);
  }

  // 2. Claim new undelivered entries
  const entries = await redis.xReadGroup(GROUP, CONSUMER, [{ key: STREAM_KEY, id: ">" }], {
    COUNT: 10,
  });
  if (!entries || entries[0]?.messages.length === 0) return false; // nothing to do

  for (const { id, message } of entries[0].messages) {
    await processWithDLQ(STREAM_KEY, GROUP, CONSUMER, id, message, 1);
  }
  return true; // had work — poll again immediately
}

async function runLoop() {
  while (true) {
    const hadWork = await poll();
    const delay = hadWork ? POLL_INTERVAL_BUSY_MS : POLL_INTERVAL_IDLE_MS;
    await new Promise((r) => setTimeout(r, delay));
  }
}

runLoop().catch((e) => { console.error("[consumer] fatal:", e); process.exit(1); });
```

This pattern is appropriate for a Fly.io always-on process. For a Vercel cron, fire `XREADGROUP` once per invocation (no loop), process a fixed batch, and return — the cron's scheduler provides the repetition.

---

## 3. Classic Pub/Sub — At-Most-Once Fan-Out

### 3.1 What it is and what it is not

Redis Pub/Sub is **fire-and-forget**. A publisher sends a message to a channel name; every client currently subscribed to that channel receives a copy. No storage, no acknowledgement, no replay. If nobody is subscribed when you publish, the message evaporates. If a subscriber disconnects for 100ms, those 100ms of messages are permanently gone.

This is the exact opposite of Streams. Pub/Sub is for situations where:
- Dropping a message is acceptable (UI tick, cached-value ping, typing indicator).
- Low latency matters more than durability (best-effort is fine).
- Every listener needs the same message, not work-stealing (broadcast, not queue).

### 3.2 The core commands

```
SUBSCRIBE channel [channel ...]     # subscribe to exact channel name(s)
UNSUBSCRIBE [channel ...]           # leave (all if no args)
PSUBSCRIBE pattern [pattern ...]    # subscribe to a glob pattern
PUNSUBSCRIBE [pattern ...]
PUBLISH channel message             # send; returns number of receivers
```

`PUBLISH` returns an integer: how many clients received the message at the moment of publish. It says nothing about whether those clients successfully processed the message.

A subscriber receives a 3-element array: `["message", channelName, payload]`. For pattern subscriptions it is 4 elements: `["pmessage", pattern, channelName, payload]`.

### 3.3 Simple example — cache invalidation ping

A common low-stakes use: after a cron refreshes the market summary cache in Redis, it publishes a tiny ping so any connected dashboard instances can refresh their local state. Losing one ping is fine because the next scheduled refresh will arrive in 60 seconds anyway.

```ts
// Publisher (the cron refresh job, running on a persistent host):
await redis.publish("lumina:cache:invalidate", JSON.stringify({ key: "finance:summary:sp500" }));

// Subscriber (another worker process with a persistent TCP connection):
// NOTE: SUBSCRIBE requires a dedicated connection — it puts the connection
// into subscribe-only mode (no GET/SET allowed on the same connection).
const subRedis = new IORedis(/* TCP connection params */);
subRedis.subscribe("lumina:cache:invalidate");
subRedis.on("message", (channel, payload) => {
  const { key } = JSON.parse(payload);
  localCache.delete(key); // drop the local in-memory copy, next read re-fetches
});
```

### 3.4 Pattern subscriptions

`PSUBSCRIBE` matches channels against a glob:

```ts
// Subscribe to all invalidation channels with a single subscription:
subRedis.psubscribe("lumina:cache:invalidate:*");
subRedis.on("pmessage", (pattern, channel, payload) => {
  // pattern = "lumina:cache:invalidate:*"
  // channel = "lumina:cache:invalidate:finance:summary:sp500"
  const key = channel.replace("lumina:cache:invalidate:", "");
  localCache.delete(key);
});
```

### 3.5 When Pub/Sub is acceptable

| Acceptable | Not acceptable |
|---|---|
| Cache-invalidation hints (drop stale local copy, next request re-fetches) | Job dispatch (use Streams) |
| Presence / heartbeat pings between workers | Payment events, order state transitions |
| "Dashboard data refreshed, poll now" nudge | Anything requiring acknowledgement |
| Internal control signals at low rate | High-volume per-user notifications (lost on disconnect) |
| A dropped message degrades gracefully | A dropped message causes user harm or data loss |

### 3.6 At-most-once: every way a message is silently lost

1. **No subscriber at publish time.** `PUBLISH` returns `0`; the message is gone.
2. **Subscriber disconnected.** During any gap (deploy, network blip, crash), all messages to that subscriber are lost. Auto-resubscribe on reconnect restores _future_ delivery only.
3. **Slow consumer overflow.** Redis enforces `client-output-buffer-limit pubsub` (default `32mb 8mb 60s`). If the subscriber's event loop is blocked and the buffer fills, Redis disconnects the client — silently dropping every message until reconnect.
4. **Handler throws.** If you throw in a message handler without a try/catch, you can crash the listener or lose messages. Always wrap handlers.

```ts
subRedis.on("message", (channel, payload) => {
  try {
    handleInvalidation(channel, payload);
  } catch (e) {
    console.warn("[pubsub] handler error:", e); // log, don't rethrow
  }
});
```

---

## 4. THE LUMINA CAVEAT — Upstash REST Cannot Subscribe

> **This is the single most important section in this document for Lumina development.**

Upstash Redis uses an **HTTP/REST transport**. Every command is a single HTTPS round-trip: request in, response out, connection closed. The model is fundamentally stateless and request/response, not connection-and-push.

`SUBSCRIBE` and `PSUBSCRIBE` require the opposite: a **persistent connection** that the Redis server pushes messages into, asynchronously, for as long as the client is alive. Over REST this is structurally impossible. Upstash does not support it.

This means:
- `redis.subscribe(...)` will not work with `@upstash/redis` on Vercel.
- `BLPOP` / `BRPOP` (blocking list pops) similarly do not work — they require a blocking connection.
- `XREAD` with `BLOCK > 0` does not work for the same reason.

**This is the confirmed behavior for Lumina's `backend/lib/cache.ts`** — the existing `cache.ts` (at `backend/lib/cache.ts`) and `ratelimit.ts` (at `backend/lib/ratelimit.ts`) use only non-blocking commands (`get`, `set`, `del`, `scan`) that work perfectly over REST. The `SKILL.md` Non-Negotiable #9 states this explicitly:

> *"No persistent `SUBSCRIBE` over REST — live fan-out goes through Supabase Realtime / the worker, not Redis Pub/Sub."*

### 4.1 How Lumina actually does live browser fan-out

The existing architecture (in `worker/index.ts`) demonstrates the correct pattern:

```
Finnhub WebSocket (trade ticks)
        │
        ▼
worker/index.ts  (Fly.io — always-on, holds WebSocket)
  ├─ coalesces dirty symbols into one batch per FLUSH_MS (~1s)
  └─ POST /realtime/v1/api/broadcast → Supabase Realtime (HTTP broadcast API)
        │
        ▼
Supabase Realtime channel "prices:top"
        │
        ▼
Browser clients  (subscribed via @supabase/supabase-js Realtime client)
```

This is the pattern from `worker/index.ts:116-138`:

```ts
// worker/index.ts (abbreviated) — the Supabase Broadcast call
const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  },
  body: JSON.stringify({
    messages: [{ topic: CHANNEL, event: "tick", payload: { symbols } }],
  }),
});
```

The worker NEVER uses Redis Pub/Sub for the browser fan-out. It uses:
- **Supabase Realtime Broadcast** (a WebSocket-based, Supabase-managed pub/sub) as the delivery mechanism to browsers.
- The Supabase REST broadcast API (a single HTTP call per tick) from the worker side — no persistent Redis connection needed.

Redis (Upstash) in Lumina is used for **caching and rate-limiting**, not for browser messaging.

### 4.2 Cross-links for the live fan-out path

| What | Where |
|---|---|
| The worker's Finnhub → Supabase Realtime wiring | `worker/index.ts` (the full file above) |
| Supabase Realtime channel design and browser hook | `.claude/skills/supabase/references/lumina-supabase-realtime-prices.md` |
| Why the worker lives on Fly.io (not Vercel) | `.claude/repo-wiki/decisions/0002-worker-on-fly-for-websockets.md` and Cross-cutting rule #4 in `CLAUDE.md` |
| `supabase` skill | For any change to the Realtime channel, topic, or browser subscription hook |

### 4.3 What to do if you need Pub/Sub-style signals and you are not on Vercel

If you are writing code for the `worker/` process (Fly.io, persistent Node.js) and want Redis Pub/Sub for **internal** worker-to-worker coordination signals (not browser fan-out), you can use a standard TCP client:

```ts
// worker/pubsub-example.ts — only valid in worker/ (Fly.io), never on Vercel
import IORedis from "ioredis"; // NOT @upstash/redis

const REDIS_URL = process.env.REDIS_URL; // a real redis:// or rediss:// URL
if (!REDIS_URL) throw new Error("REDIS_URL required for pub/sub");

// DEDICATED subscriber connection — subscribe mode blocks all other commands.
const subClient = new IORedis(REDIS_URL);
const pubClient = new IORedis(REDIS_URL);

subClient.subscribe("lumina:worker:control");
subClient.on("message", (channel, message) => {
  const { command } = JSON.parse(message);
  if (command === "flush-now") triggerEarlyFlush();
});

// Publish from the other connection:
await pubClient.publish("lumina:worker:control", JSON.stringify({ command: "flush-now" }));
```

This pattern is only viable on a persistent host. On Vercel, it is structurally impossible. If you need this today and are on Vercel, re-route to Supabase Realtime (server-side) or use a Streams poll.

---

## 5. Where Streams Would Fit Lumina — Durable Background Jobs

Lumina does not currently use a Redis Stream queue, but the architecture lends itself naturally to it in several places. The trigger condition: **a cron or an API call creates work that must not be lost if the worker restarts or the request dies mid-flight**.

### 5.1 Discover feed refresh queue

Currently the cron warms the cache by calling upstream APIs directly from the cron route handler. If the Vercel function times out or the external API is slow, the refresh is lost silently. A Stream-backed approach:

```ts
// backend/discover/routes.ts — the cron writes a job, returns immediately
app.post("/discover/cron/refresh", cronAuthMiddleware, async (req, res) => {
  const categories = ["science", "health", "academic", "technology"];
  const pipe = redis.pipeline();
  for (const cat of categories) {
    pipe.xadd("lumina:jobs:discover-refresh", "*", {
      category: cat,
      requestedAt: Date.now().toString(),
    });
  }
  await pipe.exec();
  res.json({ ok: true, enqueued: categories.length });
});
```

```ts
// worker/discover-consumer.ts (Fly.io) — durable, acknowledged processing
// Polls XREADGROUP with a 2-second idle sleep; retries on failure; moves poison
// pills to lumina:jobs:dlq after 5 attempts.
```

This pattern decouples the cron (Vercel, stateless, fast to enqueue) from the actual fetch work (Fly.io worker, persistent, can retry).

### 5.2 Connector job queue (Gmail, future connectors)

When a Gmail email send is scheduled via the Connectors feature, the current flow persists the schedule in Postgres and a cron fires it. A Streams-backed queue would give at-least-once delivery:

```ts
// Enqueue a scheduled send job
await redis.xadd("lumina:jobs:gmail-send", "*", {
  userId: req.userId,
  to: body.to,
  subject: body.subject,
  body: body.body,
  scheduledFor: body.scheduledFor.toString(),
});
```

### 5.3 Academic paper ingestion pipeline

When a user pins an OpenAlex paper for deep reading, embedding generation and caching can be expensive. Queue the embedding work asynchronously:

```ts
await redis.xadd("lumina:jobs:embed-paper", "*", {
  paperId: paper.id,
  title: paper.title,
  abstract: paper.abstract.slice(0, 2000),
});
```

A worker reads from this stream and calls the embedding API (Vercel AI SDK's `embed`), stores the vector in pgvector's `cached_query`, and ACKs. On failure, the entry stays in the PEL and is reclaimed after the idle timeout.

### 5.4 The correct topology for Streams in Lumina

```
Vercel function (enqueue)           Fly.io worker (consume + process)
  ├─ XADD to lumina:jobs:*    ──►  XREADGROUP ">" → process → XACK
  └─ returns 200 immediately         └─ on fail: stays in PEL
                                     └─ XAUTOCLAIM: reclaim stalled after 30s
                                     └─ DLQ: after 5 attempts → lumina:jobs:dlq
```

Vercel functions are the **producers** (fast XADD, no blocking). The Fly.io `worker/` is the **consumer** (holds a persistent TCP connection for polling, or uses a blocking `XREAD` if it has a native Redis TCP endpoint rather than Upstash REST).

**Important:** if the Fly.io worker connects to Upstash REST (same `UPSTASH_REDIS_REST_URL`), it still cannot use `XREAD BLOCK`. It must poll. If you want blocking XREAD in the worker, provision a standard Redis instance (e.g. Fly Redis, a self-hosted Redis on the same Fly network) and connect with `ioredis` over TCP. Upstash REST and persistent TCP are separate infrastructure choices.

---

## 6. Choosing the Right Primitive — Decision Checklist

Work through these questions top-to-bottom and stop at the first match:

```
1. Must the message survive a worker crash / process restart?
   YES → Stream (at-least-once with XACK)

2. Must each message be processed by exactly one worker (work-stealing)?
   YES → Stream consumer group (XREADGROUP)

3. Must multiple independent consumers each process every message (fan-out)?
   YES → Stream with multiple consumer groups (one group per consumer type)

4. Is the payload time-sensitive to the point where stale delivery is useless?
   YES (sub-second live ticks, UI presence) → Pub/Sub — accept drops
   NO (jobs, events that matter) → Stream

5. Is the environment Vercel serverless?
   YES → neither SUBSCRIBE (Pub/Sub) nor BLOCK XREAD works.
         Use Stream + poll (non-blocking XREADGROUP from a cron/Fly worker).
         Use Supabase Realtime for browser fan-out.

6. Is this a real-time browser notification (price ticks, live feed updates)?
   → Supabase Realtime Broadcast (via worker/). Not Redis. See §4 above.
```

---

## 7. Stream Observability and Introspection

```ts
// Stream length (total stored entries)
const len = await redis.xLen("lumina:jobs:discover-refresh");

// Range of entries (for debugging / manual inspection)
const entries = await redis.xRange("lumina:jobs:discover-refresh", "-", "+", { COUNT: 10 });

// Consumer group info — delivery counts, pending counts
const groups = await redis.xInfoGroups("lumina:jobs:discover-refresh");
// [{ name, consumers, pending, lastDeliveredId, ... }]

// Consumer-level detail within a group
const consumers = await redis.xInfoConsumers("lumina:jobs:discover-refresh", "workers");
// [{ name, pending, idle, ... }]

// Pending entries summary for a group
const pending = await redis.xPending("lumina:jobs:discover-refresh", "workers");
// { pending, minId, maxId, consumers: [{ name, pending }] }
```

Key metrics to alert on:
- **Stream length > 10× normal enqueue rate**: consumer is falling behind.
- **PEL (pending) growing without shrinking**: consumers are failing and not recovering; check DLQ and increase reclaim aggressiveness.
- **DLQ stream non-empty**: jobs hitting the retry cap; inspect payloads for a systematic failure mode.

---

## 8. Anti-Patterns

| Anti-pattern | Why it hurts | Do instead |
|---|---|---|
| Using Pub/Sub for job dispatch | Messages lost if worker is restarted, deployed, or briefly offline | Stream + consumer group |
| Using a Stream when a simple cache key + cron poll suffices | Unnecessary complexity; Streams add operational overhead | `getOrRefresh` + cron `forceRefresh` |
| `SUBSCRIBE` on `@upstash/redis` (Vercel) | Structurally impossible over REST; will error or hang | Supabase Realtime for browser fan-out; poll Streams from Fly worker |
| Unbounded stream with no `MAXLEN` | Stream grows forever; memory exhaustion | `XADD key MAXLEN ~ N * ...` on every append |
| Acknowledging before processing is complete | If the process crashes after XACK but before finishing, the job is silently lost | XACK only after successful completion |
| Not handling the PEL | A crashed consumer's jobs sit in the PEL indefinitely; silent queue freeze | XAUTOCLAIM loop in every worker's poll cycle |
| Moving all fan-out through Redis Pub/Sub for live UX | Drops messages on disconnect; hard to debug; wrong for Lumina | Supabase Realtime for live UX; Streams for durable background work |
| Handler that throws without try/catch in Pub/Sub listener | Can crash the subscriber process or leave the listener in an undefined state | Always wrap Pub/Sub handlers in try/catch |

---

## 9. Quick-Reference Cheat Sheet

```ts
import { Redis } from "@upstash/redis"; // Upstash REST — Vercel + Fly.io
// import IORedis from "ioredis";        // TCP — only valid on Fly.io or self-hosted

// ----- STREAMS -----

// Append a job (capped stream, auto-ID)
await redis.xadd("lumina:jobs:discover-refresh", { MAXLEN: ["~", 100_000] }, "*", {
  category: "science",
  enqueuedAt: Date.now().toString(),
});

// Create group (once, on setup)
await redis.xGroupCreate("lumina:jobs:discover-refresh", "workers", "0", { MKSTREAM: true });

// Poll for work (non-blocking — required on Upstash REST)
const entries = await redis.xReadGroup("workers", "consumer-1", [
  { key: "lumina:jobs:discover-refresh", id: ">" },
], { COUNT: 10 });

// Acknowledge success
await redis.xAck("lumina:jobs:discover-refresh", "workers", entryId);

// Reclaim stalled entries (> 30s idle)
// Returns [nextStartId, claimedEntries, deletedIds]
const [nextCursor, stalled, _deleted] = await redis.xAutoClaim(
  "lumina:jobs:discover-refresh", "workers", "consumer-1", 30_000, "0-0", { COUNT: 5 },
);

// Inspect pending
await redis.xPending("lumina:jobs:discover-refresh", "workers");

// ----- PUB/SUB (TCP client only — NOT @upstash/redis) -----
// Only valid in worker/ on Fly.io with ioredis or node-redis.
//
// subClient.subscribe("lumina:worker:control");
// subClient.on("message", (channel, msg) => { ... });
// pubClient.publish("lumina:worker:control", JSON.stringify({ command: "flush-now" }));

// ----- LIVE BROWSER FAN-OUT — NOT REDIS -----
// Use Supabase Realtime Broadcast from the worker (worker/index.ts:116-138):
//
// await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
//   method: "POST",
//   headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
//   body: JSON.stringify({ messages: [{ topic: "prices:top", event: "tick", payload }] }),
// });
```

---

## See also

**Same skill (redis):**
- `SKILL.md` — decision tree and non-negotiables; routes every Redis task to the right reference
- `patterns-upstash-rest-client.md` — the `@upstash/redis` REST client in depth; what commands are available and which are structurally impossible on Vercel serverless

**Other skills:**
- `supabase` — the Supabase Realtime architecture; see `references/lumina-supabase-realtime-prices.md` for the exact Lumina live-price fan-out wiring (worker → Supabase Broadcast → browser hook)
- `finance-markets` — the Finance tab's cron warmer and cache refresh strategy; where Streams would replace direct cron-to-upstream calls
- `connectors-oauth` — scheduled Gmail sends; the connector job queue shape described in §5.2 above
- `backend-testing` — how to mock Redis Stream calls in `bun:test` without a real Redis instance
- `ai-sdk-agent` — the agent runtime; background embedding jobs (§5.3) feed the semantic cache used by the agent
- `rag-retrieval` — the pgvector semantic cache; async embedding jobs queued via Streams (§5.3) write into this layer
- `lumina-frontend` — TanStack Query + the `use-live-prices` hook; the browser side of the Supabase Realtime fan-out chain
