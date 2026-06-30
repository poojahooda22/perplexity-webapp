# Scalability — The 10× / 100× Bar on Every Edit

> **Status.** Topical, always-loaded for the trigger surfaces in §1. Read at the start of every task that touches a load-bearing surface, every architectural plan, every research artifact, and any moment an agent reaches for "this will scale fine" without naming the ceiling.
>
> **Loading.** Always re-load when (a) editing any of §1's trigger surfaces, (b) producing or reviewing an architectural plan, (c) responding to a "how does this scale" / "what's the ceiling here" / "what breaks at 10×" question, (d) adding any new endpoint, cache, queue, table, background job, or per-request resource allocation.
>
> **Companion rules.** The project's operating rules carry the matching companions: the CTO scalability lens (name the ceiling), the cynical-charter 10× / 100× hunt question, the sister `performance.md` rule (performance is per-operation latency; scalability is the shape of the curve as load grows), the three-criteria recoverability gate, the long-horizon-split discipline, the research-pipeline + no-hacks rules, and the cache-discipline / scar-tissue preferences. Treat those as the surrounding context this rule plugs into.

---

## §1 — Trigger surfaces (this rule fires on every edit to any of these)

This rule applies even to one-line edits and rename PRs on these surfaces — most scalability incidents land via a "small change" that didn't ask the 10× / 100× question first. The list below is illustrative; map it to the load-bearing paths in the current project.

| Surface | What it is | Why it scales-or-breaks |
|---|---|---|
| **Hot per-request resource pools** | Any pool of expensive, reusable runtime resources (connections, render targets, workers, buffers) | A single leak × many concurrent instances = resource exhaustion / OOM; a single failure path × many instances = a system-wide outage |
| **Large generated registries / catalogs** | A registry whose entry count grows over time (definitions, plugins, items) | Every per-entry cost becomes a registry-wide cost — design for the count an order of magnitude above today's |
| **Shared warm caches / pools** | Any cache warmed at startup or on a scope boundary | Wrong warmup scope = multi-second stall; one mis-keyed entry = the cache silently disagrees with every consumer |
| **Per-save compile / transform pipelines** | Any pipeline that runs on every save/publish | A per-item O(N²) walk × a large input = the save path stalls on every write |
| **Shipped runtime SDK / embeddable bundle** | Code that runs on every end-user page | One bad allocation per instance × many instances per page × millions of pageviews |
| **Publish + CDN path** | Immutable-blob publish + manifest/TTL | Manifest TTL math + cache-key shape decides whether 1M users hit the origin or the edge |
| **Autosave + shared-row persistence** | Any write to a shared row on a common path | Every save path is a write to a shared row — every flaw scales to every user simultaneously |
| **Database tables + row-level access** | Schema + per-tenant predicates | One unindexed column on a hot query becomes a full-table scan at 10× traffic |
| **Background job runners + DAG executors** | Async/cron-driven work with cleanup | One orphaned run × many users = unbounded growth without a reaper |
| **Rate limiters + queues** | Sliding-window / token-bucket limiters, work queues | Bucket math decides whether one client can DoS the entire pipeline |
| **Per-frame / per-tick hot loops** | Any subscription that runs on the render/event loop | One extra allocation per tick × high frequency × long session = GC pressure visible as jank |

Research artifacts are already required on most of these surfaces. This rule is what a research artifact's scalability section is grounded in.

---

## §2 — The principle: name the ceiling or you don't have an architecture

A design is not architecture until the **scaling ceiling is named in writing.** The ceiling is the load level at which the current shape stops working — not the load level at which it merely slows down. Every choice trades one ceiling for another; no choice eliminates all ceilings. The architect's job is to name the trade explicitly and pick the ceiling that gives the most runway for the cost.

**The CTO-lens question:** *Does this architecture hold at 10× the current load? At 100×? Name the ceiling concretely. What assumption in the current design is the limit? What is the architectural mechanism that scales (LRU eviction, indexed query, scoped warmup, tree-shaking, CDN tier, off-main-thread work)? If you cannot name the ceiling, you have not thought enough about scale.*

**Werner Vogels (Amazon CTO):** *"Giving developers operational responsibilities has greatly enhanced the quality of the services… You build it, you run it."* The operational lesson: the team that ships the design must own the page at 3am when it breaks. Scaling decisions made by people who never touch the on-call rotation are the decisions that cost the most when they fail. ([ACM Queue interview](https://queue.acm.org/detail.cfm?id=1142065))

**Martin Kleppmann (Designing Data-Intensive Applications):** scalability is not a single number; it is a function. A system "scales well" only with respect to a named axis of load (concurrent users, payload size, geographic distribution, write throughput, query complexity). Conflating axes is the most common scalability mistake. ([dataintensive.net](https://dataintensive.net/))

**Donald Knuth, in context (the quote everyone misuses):** *"We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3%."* Knuth was arguing **for** rigorous attention to the 3% that matters, **against** wasted effort on the 97% that does not. Cargo-cult citation of the first half to avoid measurement is the opposite of what he meant. ([ACM Computing Surveys, 1974 — Laws of Software Engineering](https://lawsofsoftwareengineering.com/laws/premature-optimization/))

The bar this rule installs: **every load-bearing edit names its ceiling, its assumed mechanism, and its measured (or first-principles-derived) cost.** A design that cannot answer the three is not finished — it is a guess in formal clothing.

---

## §3 — The eight scalability dimensions (every architecture answers each)

Scalability is not one axis. It is eight. Every load-bearing design states what it does on each. Most do not need active intervention on most axes — but stating "we accept N as the ceiling on this axis because Y" is what separates an architecture from a vibe.

| # | Dimension | The question | The lever |
|---|---|---|---|
| 1 | **Concurrent users** | How many simultaneous sessions before the system degrades? | Statelessness + horizontal scaling + session externalization |
| 2 | **Data volume** | How large can the per-tenant / per-table data grow before queries slow? | Indexing, partitioning, sharding, read replicas |
| 3 | **Write throughput** | How many writes per second before the primary saturates? | Async queues, batched writes, eventual consistency, CQRS in bounded contexts |
| 4 | **Read throughput** | How many reads per second before the cache layer saturates the origin? | Multi-level caching, edge CDN, read replicas, content-addressed immutability |
| 5 | **Geographic distribution** | How does latency change for a user 200ms away from the origin? | Edge compute, regional replicas, conflict-free replication |
| 6 | **Per-tenant complexity** | How much state can a single user's document / project grow before it stops working? | Bounded data structures, virtualization, paging, server-side filtering |
| 7 | **Operational scale** | How many engineers can change this code without coordinating? | Module boundaries, type contracts, test isolation, monorepo with task-level caching |
| 8 | **Specialized resource scale** | How many of the scarce runtime resource (connections, GPU contexts, file handles, sockets) before the platform exhausts or evicts? | Pooling, content-addressed dedup, LRU eviction, budget-aware allocation |

Every research artifact's recommended-direction section names where the proposed design sits on each axis and where the ceiling is. Anything else is filler.

### §3.1 — Ceilings already named in THIS codebase (the working numbers; verify before citing, they drift)

This table is the project-local instance of the principle: the concrete, named ceilings for the surfaces this codebase actually has. Populate it from the current project's docs and budgets; the rows below are placeholders showing the shape, **not** values to cite.

| Surface | Named ceiling | Where named |
|---|---|---|
| Per-request resource memory budget | `<budget per device/instance class>` | `<the pool manager + config doc>` |
| Concurrent specialized resources per page/process | `<platform eviction limit>` | `<the shared-resource manager>` |
| Per-tenant document complexity | `<typical / max / super-max>` | `<product complexity limits>` |
| Generated registry size | `<count today (drifts); design target>` | `<the generated catalog>` |
| Loader / entry bundle | `<KB gzip>` | `<SDK / CI bundle gate>` |
| Full runtime bundle | `<KB gzip budget>` | `<CI bundle gate>` |
| Per-frame / per-tick work budget | `<draw calls / ops per tick>` | `<the hot-loop budget>` |

A proposal that moves any of these without naming the move is a silent ceiling change — surface it. A proposal citing one of these from memory without re-verifying is citing a number that may have drifted.

### §3.2 — The scale interrogation (fire at every load-bearing diff, in writing)

1. What is N for this code today — and what is N at 10× and 100×? (N = items, documents, users, rows, jobs, resources, subscribers.)
2. What is the per-N cost — bytes allocated, queries issued, work units submitted, listeners registered, rows scanned?
3. Which resource exhausts FIRST as N grows — memory, the scarce specialized resource, connections, main-thread time, queue depth? That resource is the ceiling; name it.
4. When the ceiling is hit, does the system degrade (slower, sheds load) or detonate (resource lost, OOM, outage)? Detonation needs a guard, not a hope.
5. Who evicts? Every cache, pool, queue, and table named in the diff has an eviction / cleanup / reaper answer or it is unbounded growth.
6. What is the backpressure signal when producers outrun consumers — and who reads it?
7. Is the cost per-operation or per-tick? Per-tick costs multiply by the loop frequency × session-hours; treat a per-tick allocation as orders of magnitude larger than its apparent size over a session.
8. What does this do on the 100th simultaneous instance — embedded on a page with many instances, a user with thousands of items, a document at the super-max complexity?

---

## §4 — The pattern catalogue (what senior-staff teams actually ship)

For each dimension, the patterns that 3+ independent senior-staff codebases converge on. Cite the pattern and the team that proved it; do not invent new patterns when the convergent one fits.

### §4.1 — Stateless services + horizontal scaling (Dimension 1)

The 12-Factor App's Processes principle, operationalized everywhere from Heroku to serverless to Netflix: **services are stateless and share-nothing; any persistent state lives in a backing service (database, Redis).** Sticky sessions are an architectural debt — they make instances non-fungible, defeating the entire premise of horizontal scaling.

**Netflix:** *"Each service is stateless and independently deployable. Session data lives in EVCache, never in application process memory."* If a server fails, no work is lost because no work was held there. ([Netflix System Design Architecture Guide](https://grokkingthesystemdesign.com/guides/netflix-system-design/), [ByteByteGo: Scaling Netflix](https://blog.bytebytego.com/p/a-brief-history-of-scaling-netflix))

**Hootsuite:** moved millions of user sessions from MySQL+Memcached to Redis specifically to eliminate sticky sessions. Production result: load balancer can distribute round-robin; any server handles any request; Redis is the single source of session truth. ([Moving Millions of User Sessions — Hootsuite Engineering](https://medium.com/hootsuite-engineering/moving-millions-of-user-sessions-from-mysql-to-redis-ce709a4e93e9))

**In this codebase:** any per-user token (CSRF, rate-limit counters) belongs in a shared backing store (e.g. Redis) precisely so any compute instance can serve any user without affinity. Optimistic-concurrency tokens belong in the database precisely so no session is bound to a single server. **Do not add server-affinity-requiring features** (sticky-session-requiring caches, in-process state, file-system writes on the request path) without explicit operator approval — every such feature converts the platform from horizontally scalable to vertically capped.

### §4.2 — Data layer (Dimensions 2, 3, 4)

**Postgres connection pooling is mandatory at production scale.** Postgres's process-per-connection model forks a 5+ MB OS process per connection. Without pooling, the connection count is the scaling ceiling. PgBouncer in **transaction-pool mode** is the historical standard; **Supavisor** (Supabase's Elixir-based pooler) demonstrates 500,000 concurrent connections on a 64-core instance at 20,000 QPS sustained with no degradation. ([Supabase: Supavisor 1M Connections](https://supabase.com/blog/supavisor-1-million), [PlanetScale: Scaling Postgres with PgBouncer](https://planetscale.com/blog/scaling-postgres-connections-with-pgbouncer), [Percona: PgBouncer for PostgreSQL](https://www.percona.com/blog/pgbouncer-for-postgresql-how-connection-pooling-solves-enterprise-slowdowns/))

**Read replicas before sharding.** The Supabase scaling progression is the canonical path: seed → Series A (single tuned Postgres + pooler handles all load up to ~100GB); Series B → Growth (2–5 read replicas + time-range partitioning on hot tables up to ~1TB); only beyond 1TB does sharding (Vitess) or distributed (Spanner) become justifiable. Supabase Read Replicas auto-balance reads across the cluster with a single API call. ([Supabase: Introducing Read Replicas](https://supabase.com/blog/introducing-read-replicas), [7 Ways to Scale PostgreSQL — VeloDB](https://www.velodb.io/glossary/ways-to-scale-postgresql))

**CQRS only where the read/write asymmetry is demonstrated.** Martin Fowler: *"For most systems CQRS adds risky complexity and should be used with caution… More specifically, CQRS should only be used on specific portions of a system."* The criteria: reads vastly outnumber writes, read and write models are genuinely distinct, independent scaling provides measurable value. ([Martin Fowler: CQRS](https://martinfowler.com/bliki/CQRS.html), [Azure Architecture: CQRS Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs))

**What each named distributed system solves (do not confuse them):**
- **Vitess** (YouTube → Slack, Square, JD.com): MySQL sharding with application transparency. VTGate routes queries; apps stay shard-unaware. Atomic shard split/merge. ([GitHub: vitessio/vitess](https://github.com/vitessio/vitess))
- **Spanner** (Google, OSDI '12): externally-consistent ACID across geo-distributed shards, enabled by TrueTime (bounded clock uncertainty). The only production database with strong consistency at global scale. ([Spanner OSDI '12 paper](https://research.google.com/archive/spanner-osdi2012.pdf))
- **TAO** (Facebook, USENIX ATC '13): graph-aware two-tier cache (objects + associations) over sharded MySQL. 1B reads/sec over petabyte-scale graph. Explicitly trades strong consistency for availability — read replicas may serve slightly stale data, acceptable for social-graph display. ([TAO paper — USENIX](https://www.usenix.org/system/files/conference/atc13/atc13-bronson.pdf))

**In this codebase:** every write to a shared row should carry an optimistic-concurrency token — that is the architectural guarantee that read-after-write races never silently overwrite. Every per-user query has its `user_id` indexed because row-level access implies a per-row predicate on every read. **Adding a new table without an index on `(user_id, ...)` is a 10×-load-ceiling-breaker on day one.**

### §4.3 — Caching architectures (Dimension 4, plus the specialized-resource lane in §4.4)

**Jeff Dean's latency hierarchy (the foundation for why every cache layer is justified):** L1 cache = 1 ns; L2 = 4 ns; RAM = 100 ns; SSD = 100 µs; network round-trip = 500 µs; database insert = ~1 ms. Each order-of-magnitude latency difference is the reason another cache layer earns its complexity. ([Jeff Dean latency numbers](https://brenocon.com/dean_perf.html))

**The L1/L2/CDN stack:**

| Layer | Storage | Latency | Bounded by | Eviction |
|---|---|---|---|---|
| **L1** | In-process Map/HashMap | sub-ms | process memory | **LRU with explicit `maxSize`** — non-negotiable |
| **L2** | Redis / Memcached | low ms | cluster memory | LRU / TTL / explicit `maxmemory-policy` |
| **CDN** | Edge cache | sub-ms (regional) | edge bandwidth | TTL + tag-based purge |

**Cache invalidation patterns (3 production patterns to choose from, never invent a fourth):**

1. **Stale-while-revalidate.** CDNs honor the `stale-while-revalidate` `Cache-Control` directive — within the stale window, serve the expired content immediately, revalidate asynchronously in background. Eliminates user-visible latency spike of synchronous revalidation. ([Cloudflare Revalidation docs](https://developers.cloudflare.com/cache/concepts/revalidation/))

2. **Tag-based purge.** `Cache-Tag` response headers group assets for bulk invalidation; single API call purges all tagged assets across all edge POPs simultaneously. The CMS / user-content-driven invalidation pattern. ([Cloudflare: Rethinking Cache Purge](https://blog.cloudflare.com/part1-coreless-purge/))

3. **Content-addressed immutability.** Hash the content, embed the hash in the URL, set `Cache-Control: public, max-age=31536000, immutable`. Asset never needs invalidation; the *manifest* (which points to the current hash URL) has a short TTL and is the only file that needs purging on deploy. The architecture Bazel Remote Cache, object-store manifest patterns, and asset hashing all share. ([Bazel Remote Caching](https://bazel.build/remote/caching))

**A content-addressed publish path implements pattern 3 exactly:** blobs write to a versioned, immutable key (long TTL); the manifest is short-TTL and the only thing that needs revalidation on republish. Adding a new asset type to the publish path → use the same content-addressed shape. Do not invent a fourth invalidation strategy.

**The bounded-cache invariant (most-violated rule on this dimension):** **every in-process cache (`Map`, `Set`, `WeakMap` where keys are strong-referenced elsewhere) has an explicit `maxSize` set at construction time and an explicit eviction policy.** A `Map` without eviction is not a cache — it is a memory leak with a vocabulary problem. Python distinguishes `functools.cache` (unbounded, memory-leak shape) from `functools.lru_cache(maxsize=N)` (bounded, real cache). JavaScript has no built-in distinction; the discipline must be enforced by hand. ([Python Cache vs lru_cache — Webeyez](https://webeyez.com/insights/guides/python-cache-vs-lru_cache), [Ehcache: Cache Eviction Algorithms](https://www.ehcache.org/documentation/2.8/apis/cache-eviction-algorithms.html))

A two-pool resource manager is the canonical in-codebase shape: a scratch pool (per-operation ephemeral, recycled within the operation) + a cache pool (LRU eviction, content-hash keyed). Every new cache follows the same shape. The project's cache-discipline scar-tissue rules — type-lie cache split, delete-then-rebuild on key change, alias-then-swap, and in-flight tracking — exist to prevent the most expensive cache-design failures already paid for; read them before designing any new cache.

### §4.4 — The scarce specialized resource (Dimension 8)

Most platforms have one scarce, expensive runtime resource that exhausts before anything else — database connections, OS file handles, GPU contexts, worker threads, sockets. The discipline is the same regardless of which resource it is: there is a hard cap, exceeding it is silent (the platform evicts or refuses rather than raising a clean error), and every resource must be pooled, budgeted, and reclaimed.

**Know the hard cap, query it at runtime, never assume.** The spec-guaranteed minimum is the floor, not the value to design against; query the real limit at startup and size the pool against it.

**On loss, every dependent resource is invalidated and must be rebuilt.** When the scarce resource is reclaimed by the platform (a lost GPU context, a dropped connection, a closed handle), every resource derived from it becomes invalid. The canonical pattern: a loss handler (that prevents the default tear-down where possible) plus a restore handler that rebuilds all dependent state. Graceful recovery, not a crash. ([Khronos: HandlingContextLost](https://wikis.khronos.org/webgl/HandlingContextLost) — the WebGL instance of this general pattern.)

**Exhaustion is often not surfaced as an error — the platform evicts instead.** Compute the per-instance allocation ceiling from a budget formula (e.g. for a screen-bound resource: `availWidth × availHeight × devicePixelRatio² × bytesPerInstance`) and size pools against the smallest device/instance class you support. Exceeding the budget is an exhaustion / eviction bug waiting for a user's device to expose it.

**The scaling levers (every production engine converges on these):**

1. **Batch / instance many into one.** Submit N similar work units in one call instead of N calls — the per-call overhead is usually the dominant cost (the GPU instance of this is instanced rendering: 10,000 identical objects in one draw call; the DB instance is batched inserts; the network instance is request coalescing). ([MDN best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices))

2. **Cull / skip work that has no effect.** Do not pay for work whose result is never observed — a cheap CPU-side test that skips the expensive path (frustum/occlusion culling for graphics; predicate pushdown / short-circuit for queries; level-of-detail swaps). Near-zero cost test, large savings. ([Babylon.js: Optimizing Your Scene](https://doc.babylonjs.com/features/featuresDeepDive/scene/optimize_your_scene))

3. **Content-hash dedup.** N references to the same content = 1 allocation. Hash the content, allocate once, share the handle. ([PixiJS: Performance Tips](https://pixijs.com/8.x/guides/concepts/performance-tips))

**Budget the per-tick work.** There is a hard per-tick budget (a frame is ~16ms at 60Hz; a request has its own latency budget). Submit fewer, larger work units; minimize the most expensive item first. ([GameDevJS: Optimizing WebGL Game Performance](https://gamedevjs.com/articles/best-practices-of-optimizing-game-performance-with-webgl/))

**Allocate scarce resources at warm-up, not per-tick.** Allocating the expensive resource inside the hot loop pays its setup cost every tick and churns the allocator. Allocate once at warm-up and reuse across cycles. ([MDN: WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices))

**In this codebase:** the pooled-resource manager IS this pattern. Allocating a new scarce resource directly (instead of acquiring from the pool) is a 10×-load failure on day one — at many simultaneous instances the platform hits its cap and evicts, losing everything.

### §4.5 — Frontend (Dimension 1, 4, 6 — perception + load)

**Bundle size budgets (web.dev consensus):** initial-route JavaScript **under 200 KB gzipped** as the floor; under 100 KB is excellent. Per-route bundle matters more than total app size.

**`sideEffects: false` in `package.json` enables tree-shaking at build time** (webpack, Turbopack, esbuild). Documented production cases report 60% bundle reductions from publishing ESM with `sideEffects: false`. **Barrel files (`index.ts` re-exports) defeat tree-shaking in most configurations** — for internal packages, import direct paths, not from barrel. ([Tree-shaking + barrel files](https://lightrun.com/answers/vercel-next-js-tree-shaking-doesnt-work-with-typescript-barrel-files))

**Serverless concurrency + warm-instance reuse:** modern serverless platforms let a single function instance handle multiple requests concurrently and prioritize warm instances before spawning new ones, eliminating cold-start cost. The compute-placement principle: *run compute closer to where your data already lives rather than attempting unrealistic replication across every edge location.*

**React concurrent features (use deliberately, not as a perf-blanket):**
- `useTransition` marks updates non-urgent; React may interrupt their render for urgent events (keypress, click). Use cases: search-result filtering, large list sorting, expensive re-renders on user input.
- `useDeferredValue` provides a "lagging copy" of a value; UI stays interactive while heavy work catches up.
- **Critical:** these are perceived-performance optimizations via scheduling, not raw-performance optimizations. They cause double-renders and add scheduling overhead. Do not blanket-apply. ([React Concurrency Deep Dive — DEV](https://dev.to/a1guy/react-19-concurrency-deep-dive-mastering-usetransition-and-starttransition-for-smoother-uis-51eo))

**Virtualization above ~500 items.** DOM render cost is proportional to total item count, not visible count. `react-window` (smaller, faster successor to `react-virtualized`) renders only visible rows + configurable overscan; handles 100,000+ items at stable 60 fps. ([web.dev: Virtualize long lists with react-window](https://web.dev/articles/virtualize-long-lists-react-window))

**In this codebase:** any long palette, list, or grid (counts drift; never cite frozen) must scroll at 60fps; any large catalog must scroll thousands of items at 60fps; any pannable canvas must stay smooth with many nodes. Any new list / grid / scroll surface over ~500 items virtualizes — non-negotiable. A scoped (not global) warmup discipline for shared pools is the same principle applied below the UI: bound the work to the visible surface.

### §4.6 — CDN / edge architecture (Dimensions 4, 5)

**Edge object stores** route a request to the POP nearest the user, fetch the encryption key, then read from a storage cluster within the configured region, replicating within-region for durability. Decoupling writes from the home region (write to the nearest POP, asynchronously replicate to the bucket region) can cut cross-region write latency dramatically. ([Cloudflare: How R2 works](https://developers.cloudflare.com/r2/how-r2-works/))

**Edge stateful primitives** (e.g. Cloudflare Durable Objects) solve the stateless-edge problem: globally-unique, single-threaded instances that maintain state and handle requests sequentially, collocated with compute at the edge. Pattern: stateless workers handle routing/auth/validation; the stateful primitive handles state requiring strong consistency. ([Cloudflare: Introducing Workers Durable Objects](https://blog.cloudflare.com/introducing-workers-durable-objects/))

**In this codebase:** the CDN serves all published immutable blobs; the versioned-key + manifest pattern is the content-addressed immutability of §4.3 plus the regional Gateway routing of this section. Adding a new published asset type → same content-addressed shape. **Be cautious about platform-coupled edge state (Durable Objects, edge KV) for portable content** — it couples you to a single platform and a single state model; an immutable-blob shape is what keeps the runtime platform-agnostic.

### §4.7 — Async / queue patterns (Dimension 3)

**Production job queue patterns (BullMQ for Node, Inngest / cloud queues for cloud-native):**

1. **Idempotency.** Every handler safe to run multiple times with the same input. BullMQ provides stable `job.id` that persists through retries. Inngest's `step.run()` memoizes results across retries — built-in idempotency. ([BullMQ — Background Job Processing in Node — DEV](https://dev.to/young_gao/background-job-processing-in-nodejs-bullmq-queues-and-worker-patterns-31d4))

2. **Backpressure.** Unbounded concurrency — `Promise.all` over N async ops, or workers with no concurrency cap — is a common production failure class. Configure a concurrency cap; use queue depth as the signal to slow upstream producers. ([Node Queueing Patterns: Backpressure — Medium](https://medium.com/@2nick2patel2/node-queueing-patterns-backpressure-that-works-581d8b82cd89))

3. **Dead letter queues.** Jobs exhausting all retries must NOT silently disappear — they land in a DLQ for manual inspection or automated alerting. Silent disappearance is a data loss event. ([BullMQ Ultimate Guide — DragonflyDB](https://www.dragonflydb.io/guides/bullmq))

**In this codebase:** a run-table + run-events + cron reaper IS this pattern (idempotent run IDs, bounded concurrency per user, reaper handles orphaned runs as a DLQ analogue). Adding a new background job (a reaper, a version GC, an orphan sweep, a generation queue) → all three patterns are mandatory. Unbounded `Promise.all` over N user records in a single endpoint handler is the failure mode this section names; chunked / batched / queue-driven is the production answer.

### §4.8 — Organizational / code scalability (Dimension 7)

**Monorepo wins for shared-version + atomic-cross-package-commit + simpler code sharing.** Google, Meta, React, Next.js, Yarn, Babel all monorepo. The build-time cost is solved by content-addressed task caching (same principle as Bazel): **Turborepo v2** in Rust hashes task inputs; identical inputs → cached output returned instantly; Remote Cache means CI never repeats work. ([Turborepo docs](https://turborepo.dev/))

**Type system as scale constraint.** TypeScript strict mode reduces vulnerability rates 3–7× vs untyped (the project's operating rules cite the empirical paper). At code scale: module boundaries with explicit type contracts surface breaking changes at compile time, not in production. `@ts-nocheck` is the load-bearing path's anti-pattern — it holes the defense precisely where it provides most protection.

**God objects (Wikipedia): *"an object that references a large number of distinct types, has too many unrelated or uncategorized methods, or some combination of both."*** The canonical code-scalability anti-pattern. Creates tight coupling, prevents modular scaling, makes change blast radius unpredictable. Any single file growing to thousands of lines as "the X system" is approaching this ceiling — a planned extraction sequence is the active scaling work. ([Wikipedia: God Object](https://en.wikipedia.org/wiki/God_object))

**In this codebase:** if a monorepo task graph is in use, adding a new package → it joins the existing task graph with proper inputs/outputs declared (so caching works). Adding a new internal package without proper task-output declaration breaks every other package's cache hit rate — a measurable cost to every CI run thereafter.

---

## §5 — Anti-pattern catalogue (the failure modes that have shipped and broken)

Every row has a named source. Catching yourself reaching for any of these mid-edit → STOP.

| Anti-pattern | What ships | Why it fails at scale | Source |
|---|---|---|---|
| **Microservices before demonstrated need** | "We split it for scalability" — without measured bottleneck | Adds orchestration overhead at every boundary. Prime Video: 90% cost reduction after collapsing back to monolith. Segment: years to undo. | [Prime Video monolith reversal — DEVClass](https://devclass.com/2023/05/05/reduce-costs-by-90-by-moving-from-microservices-to-monolith-amazon-internal-case-study-raises-eyebrows/), [Segment goodbye microservices — Twilio](https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices) |
| **Sticky sessions instead of session externalization** | Load balancer with session-affinity rules | Instances become non-fungible; horizontal scaling defeated; one node failure = N users logged out | [Hootsuite Redis sessions](https://medium.com/hootsuite-engineering/moving-millions-of-user-sessions-from-mysql-to-redis-ce709a4e93e9) |
| **In-process `Map` cache without `maxSize` + eviction** | "It's just a small cache" → unbounded memory growth in long-lived process | Cache becomes memory leak; OOM kills process; restart cycle becomes the only "eviction" | [Python lru_cache vs cache — Webeyez](https://webeyez.com/insights/guides/python-cache-vs-lru_cache), [Ehcache eviction docs](https://www.ehcache.org/documentation/2.8/apis/cache-eviction-algorithms.html) |
| **Caching to mask N+1 query** | Slow page → "let's cache it" → ship | N grows; cache layer hides growth until the cache miss rate inverts, then origin saturates instantly | [Scout: Understanding N+1 Queries](https://www.scoutapm.com/blog/understanding-n1-database-queries), [Solving N+1 — DEV](https://dev.to/vasughanta09/solving-the-n1-query-problem-a-developers-guide-to-database-performance-321c) |
| **Unbounded job queue / no backpressure** | `await Promise.all(records.map(handler))` over thousands of records | Load spike → queue depth grows faster than drain rate → OOM or downstream cascade | [Node Queueing Patterns — Medium](https://medium.com/@2nick2patel2/node-queueing-patterns-backpressure-that-works-581d8b82cd89) |
| **Postgres without connection pooling (PgBouncer / Supavisor)** | Direct app → Postgres connections | Process-per-connection ceiling at 100–500 conns/instance; vertical-scale-only ceiling | [PlanetScale PgBouncer at Scale](https://planetscale.com/blog/scaling-postgres-connections-with-pgbouncer), [Supabase Supavisor](https://supabase.com/blog/supavisor-1-million) |
| **Allocating the scarce resource inside the hot loop** | A fresh connection / render target / buffer allocated per tick | Setup + completeness check kills the per-tick budget; alloc churn triggers GC; the resource pool exhausts | [MDN best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) |
| **Exceeding the scarce-resource cap (e.g. >8 GPU contexts on a page)** | One scarce resource allocated per sub-component | Platform evicts the oldest → all derived resources invalid → the surface breaks | [Khronos: HandlingContextLost](https://wikis.khronos.org/webgl/HandlingContextLost) |
| **Barrel-file imports breaking tree-shaking** | `import { X } from '~/components'` everywhere | Bundle includes every export from the barrel even if X is the only used; per-route bundle inflates | [Tree shaking + barrel files](https://lightrun.com/answers/vercel-next-js-tree-shaking-doesnt-work-with-typescript-barrel-files) |
| **CQRS / event sourcing applied to the whole system** | "Modern architecture" reflex on every bounded context | Most contexts don't have read/write asymmetry; CQRS adds operational complexity without value | [Martin Fowler: CQRS bliki](https://martinfowler.com/bliki/CQRS.html) |
| **Citing Knuth to avoid measurement** | "Premature optimization is the root of all evil" → ship without profiling | Misreads Knuth (he advocated FOR the critical 3%); ships obvious anti-patterns under the cover of the quote | [Laws of Software Engineering: Premature Optimization](https://lawsofsoftwareengineering.com/laws/premature-optimization/) |
| **God object accumulating responsibilities** | One file / class becomes "the X system" — grows to thousands of lines | Change blast radius becomes the whole subsystem; testing isolates nothing | [Wikipedia: God Object](https://en.wikipedia.org/wiki/God_object) |
| **"We'll shard later"** | Schema designed assuming single Postgres forever | Sharding requires data-model surgery; deferring it makes the cost grow superlinearly with table size | [DDIA Ch. 6 — Partitioning](https://dataintensive.net/) |
| **Vibe-claimed "scales well" with no ceiling named** | Architecture doc says "scalable" with no number | The ceiling is whatever happens to be true today; nobody knows when it fails until production reveals it | the project's cynical-charter 10× question + CTO scalability lens |

---

## §6 — Catch-yourself triggers (you are about to ship a junior-level scalability take if you think any of these)

- *"This will scale fine."* — Name the ceiling. If you cannot name a concrete number on a concrete axis, you do not have a scalability claim; you have a vibe.
- *"Let's add a cache here."* — What is the eviction policy? What is `maxSize`? What is the invalidation trigger? If any of the three is "we'll figure it out later," the cache is a memory leak.
- *"We can microservice this for scale."* — Has the bottleneck been measured? Is the orchestration cost named? Read the Prime Video and Segment reversal stories before this proposal goes any further.
- *"It's just a small `Map`, we don't need eviction."* — Long-lived processes turn every unbounded `Map` into a memory leak. Always set `maxSize`.
- *"Premature optimization is the root of all evil."* — Knuth was arguing FOR rigor on the critical 3%, AGAINST waste on the 97%. If you have not measured which side of that line this is on, you cannot cite the quote.
- *"We'll shard later if we need to."* — Sharding-later is a 100× cost compared to schema-aware-from-day-one. Either pick single-tenant-Postgres scale ceiling consciously (acceptable; name it) or design for the shard now.
- *"Just `Promise.all` over the records."* — How many records? What happens at 10×? At 100×? Without bounded concurrency and a backpressure signal, this is a load-spike-triggered outage waiting for production.
- *"This pattern works at our current scale."* — Current scale is the floor of the ceiling derivation, not the ceiling itself. The question is what fails at 10× and 100×.
- *"The CDN will handle it."* — CDN only helps if cache hit rate is high. Cacheable requests with `Vary: *` or per-user cookies are not cacheable. Confirm the cache hit rate is real before relying on the CDN.
- *"The framework handles that for us."* — Frameworks have ceilings too. A renderer does not magically scale to 10,000 dynamic objects without instancing. React does not magically render 100,000-item lists at 60fps without virtualization. The framework gives you the lever; you have to pull it.
- *"Let's add a queue to make it async."* — A queue without idempotency, backpressure, and a DLQ is a slower synchronous call with extra failure modes. Name all three before adding the queue.
- *"Just add an index"* (proposed without `EXPLAIN ANALYZE` evidence) — indexes have cost (write amplification, storage, plan-cache pressure). Adding indexes by vibe creates the next perf incident.

---

## §7 — Pre-ship scalability audit (run before staging any diff on a §1 trigger surface)

For every load-bearing edit, the diff sweeps these in writing. The output goes into the PR description, the plan file, or the end-of-turn summary — depending on scope.

1. **Dimensions touched.** Which of §3's eight axes does this change move the ceiling on? Name each.
2. **Current ceiling.** What load level does the current code break at, on each touched dimension? Cite the mechanism (LRU bound, resource pool size, connection pool, per-tick budget, bundle KB).
3. **New ceiling after change.** Same question, after the diff. Better / same / worse on each axis?
4. **Mechanism named.** What architectural mechanism explains the new ceiling (LRU eviction, indexed query, scoped warmup, tree-shaking, CDN tier, off-main-thread)?
5. **Pair-contract sweep.** Any of the project's paired-contract operating rules touched? Mirror sites updated?
6. **Anti-pattern check.** Cross-walk every row of §5. Any apply? If yes, justify (with evidence) or rework.
7. **Cynical question.** *Has a senior-staff team at Netflix / a major cloud vendor / Google / Meta solved this exact problem? What did they ship? Cite the repo / blog / paper.* If you cannot answer, the research was shallow — go back to the research pipeline.
8. **Honest "I don't know."** Anything on the eight axes not assessed → flag explicitly. Hidden uncertainty is worse than named uncertainty.

Any "no" on 4 / 5 / 7, or any unjustified "yes" on 6 → rework. Do not ship.

---

## §8 — Why this rule exists

Pre-launch posture seduces every agent toward *"we'll deal with scale when we have users."* The seduction is wrong for two reasons:

**First, the architectural cost of fixing scalability later compounds non-linearly.** A `Map` without `maxSize` shipped today and discovered at 10K users requires touching every caller. An unindexed `(user_id, ...)` column on a hot table discovered at 100K rows requires a `CREATE INDEX CONCURRENTLY` that locks the production write path. A scarce-resource-per-sub-component pattern discovered at the platform's cap is a runtime architecture rewrite. The Prime Video / Segment reversal stories ([§5](#5--anti-pattern-catalogue-the-failure-modes-that-have-shipped-and-broken)) are not edge cases — they are the modal outcome of "we'll shard later" thinking.

**Second, the product narrative depends on the architecture holding at 10× and 100× the demoed scale.** A serious product assumes its published output serves millions of users across millions of pageviews. A platform whose ceiling is "looks fine in the demo" is a small product, not a scale product. Every resource that doesn't pool, every cache without eviction, every query without an index, every queue without backpressure — each is a known-tomorrow-incident that strips the scale narrative of its load-bearing claim.

The bar this rule installs: every load-bearing edit names its ceiling, names the mechanism, cites the senior-staff team that proved the pattern, and sweeps for the anti-patterns in §5. **Scalability is not what you add later. It is the shape of every decision from day one. The discipline that ships pre-launch is the discipline that ships at scale; the discipline that does not ship pre-launch never magically appears under load.**

Werner Vogels closed it best: *"The first and foremost lesson is a meta-lesson: If applied, strict service orientation is an excellent technique to achieve isolation; you come to a level of ownership and control that was not seen before."* The discipline is the architecture. ([All Things Distributed](https://www.allthingsdistributed.com/index.html))

---

## §9 — Source

Research basis: 20+ web searches across 10 dimensions (horizontal scaling, data layer, caching, the scarce specialized resource, frontend, CDN / edge, async / queue, organizational / code, anti-patterns, named-expert positions). Source categories satisfied: (1) production codebases (Vitess, Three.js, Babylon, PixiJS, Turborepo, BullMQ) — (2) industry-leader engineering blogs (Netflix, Supabase, Cloudflare, Vercel, Hootsuite, Twilio, Amazon Prime Video, Segment) — (3) books / papers (DDIA, Spanner OSDI '12, TAO USENIX ATC '13, Knuth 1974) — (4) vendor docs (MDN, Khronos, Cloudflare, Supabase, web.dev) — (5) Stack Exchange / GitHub issues (tree-shaking, FBO completeness, lru_cache discussions). Industry consensus established on the load-bearing claims; disagreements named where reputable sources differ (Fowler vs Young on CQRS scope; Knuth's misuse).

Anti-pattern catalogue, named-expert quotes, and ceiling-derivation framing all trace directly to research findings. The eight scalability dimensions framing (§3) is the operational distillation that lets this rule be invocable as a checklist rather than read as a manifesto.

---

## §10 — Index entry

For the rules index:

- **scalability.md — The 10× / 100× bar on every edit.** Every load-bearing edit names its ceiling, names the architectural mechanism, cites the senior-staff team that proved the pattern, and sweeps the §5 anti-pattern catalogue. Eight scalability dimensions (concurrent users / data volume / write throughput / read throughput / geographic distribution / per-tenant complexity / operational scale / specialized resource scale) are answered on every architecture. Pre-launch posture of "we'll scale later" is the failure mode this rule names — pre-launch discipline is the only path to post-launch scale. Companion to `performance.md`.
