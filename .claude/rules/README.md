# Operating Rules

> The always-on rules for this repo, surfaced at the start of every session by
> [`../hooks/session-start.sh`](../hooks/session-start.sh). These are **constraints that always apply** —
> distinct from [skills](../skills/README.md) (how to build) and [memory](../memory/README.md) (durable facts).

## The 7 code non-negotiables (canonical home: `CLAUDE.md` + `repo-wiki/rules/`)

These live in the root [`CLAUDE.md`](../../CLAUDE.md) and are mirrored file-by-file under
[`../repo-wiki/rules/`](../repo-wiki/index.md). **Not re-copied here** (avoids drift). In one line each:

1. **Never invent a finance number** — tools fetch, the model grounds; failed tools return typed `unavailable`/`needsKey`.
2. **`commercialOk` gate** — free tier ≠ display license → see [`commercial-ok-gate.md`](commercial-ok-gate.md).
3. **ESM `.js` imports** — relative backend imports need explicit `.js` extensions (Vercel strict resolver).
4. **Vercel can't hold sockets/timers** — WebSockets/pollers → `worker/` (Fly); scheduled work → external cron + `CRON_SECRET`.
5. **Stream → wire tail → persist BEFORE `res.end()`** — a Vercel instance can freeze on response close.
6. **Secure tool args by closure** — `userId`/secrets injected in the tool factory; the model never supplies them.
7. **New backend files need a full dev-server restart** — Bun `--hot` doesn't pick them up.

## Cross-cutting operating rules (this folder)

- [`brand-is-lumina.md`](brand-is-lumina.md) — the product is **Lumina**; never "Perplexity" in user-facing text.
- [`commercial-ok-gate.md`](commercial-ok-gate.md) — the licensing discipline + the [sources-ledger](../memory/sources-ledger.md).
- [`product-at-scale.md`](product-at-scale.md) — the R-SCALE tier discipline for lists/search/contested/spike surfaces.
- [`skill-layer-law.md`](skill-layer-law.md) — dev-skill vs runtime product-skill vs tool: where a new thing goes.
- [`confirm-before-big-work.md`](confirm-before-big-work.md) — restate intent + plan before multi-file/irreversible work.

## How these are enforced

- **SessionStart hook** prints this index every session.
- **PreToolUse guard** ([`../hooks/precheck-licensing.mjs`](../hooks/precheck-licensing.mjs)) backs the `commercialOk` gate (nudges on `commercialOk:true`, asks on `.env`).
- **`/sources-lint`** audits code for `commercialOk:true` without a GREEN ledger row.
- The rest are model-followed conventions — held to in review and by the Stop/wiki hook.