# Rule: build at product scale (R-SCALE)

Lumina is a **real shipping product**, not a demo. Any feature on a **scale surface** — lists/browse,
search, contested inventory/money, traffic spikes, order/transaction pipelines — must state, in
writing, which tier it survives and what breaks at the next one.

| Tier | Load | Example |
|---|---|---|
| 1× | demo data | 100–1,000 items, 1 user |
| 100× | early traction | 10k–100k items, thousands of users |
| 10,000× | the product working | 1M+ items, lakhs concurrent, spike day |

> The failure this prevents: **shipping a Tier-1 implementation while believing it's Tier-3.** Building
> only Tier-1 for a demo is fine — *believing* it's production is the bug.

## The checks that bite in this repo

- **Lists** (screener, watchlist, predictions, discover): server-side filter + paginate + virtualize +
  **index the filtered/sorted columns**. Never ship the universe to the client; never client-side
  filter an in-memory full set. A multi-column sort needs an index per sortable facet.
- **Search**: matching **and** ranking. Tier-1 = client fuzzy; Tier-2 = Postgres FTS/`pg_trgm`; Tier-3 =
  a real engine. Debounce input; instrument click/CTR signals from day one (you can't rank by signals
  you never stored).
- **Read spikes**: compute-once-serve-many. The finance home/cards are cron-warmed into Redis
  (`getOrRefresh` + stale-while-revalidate + in-flight de-dupe) — print the flyer once, don't
  hand-write it per user.
- **Contested writes** (rare here, but: per-user watchlist quota, any counter): atomic guarded update
  (`UPDATE … WHERE … AND qty > 0`), never read-then-write from app code; idempotency on retries.
- **Heavy ingest** (e.g. nightly EDGAR XBRL): lives in `worker/` on a cron, **not** the serverless
  route (non-negotiable #4). State the ingest runtime + partial-failure behavior.

The global rule `~/.claude/rules/product-scale-architecture.md` has the full battery; the
`finance-markets` skill's `finance-at-scale-rscale.md` reference applies it to this codebase.
