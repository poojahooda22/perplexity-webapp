# Rule: the `commercialOk` gate

Every displayed data series carries a `Provenance` with a `commercialOk` boolean. **Default `false`.**

## The principle

**The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10Y yield fetched from
treasury.gov is public-domain GREEN; the *exact same number* from Yahoo's chart API is RED. So you
cannot reason about licensing from the data type — only from where you fetched it.

`commercialOk: true` is legal **only** when the fetch path is one of:
- public-domain (e.g. US-gov, 17 USC §105), or
- CC0 / CC-BY (with the required attribution rendered on the surface), or
- a **purchased** commercial display/redistribution tier.

**A free API tier is NOT a commercial-display license.** Neither is "a competitor displays it" — that's
the same fallacy. When a ToS is silent or ambiguous about commercial redistribution/display, the
verdict is **RED**.

## In practice

- Before setting `commercialOk: true`, confirm the fetch path has a 🟢 row in
  [`../memory/sources-ledger.md`](../memory/sources-ledger.md). If it isn't there, it isn't cleared — keep it `false`.
- A RED source can still be **built against** for an informational, attributed feature (e.g. Polymarket
  predictions) — you just keep the gate `false` and show attribution. RED gates the *display license*, not *access*.
- A GREEN source can still produce a **wrong** number (e.g. SEC EDGAR duplicate/non-comparable XBRL
  facts). GREEN-but-wrong still violates "never invent a finance number" — ground and validate.
- Failed/over-budget fetches return typed `unavailable`/`needsKey` — never a fabricated value, never a
  RED-tier backfill to "look complete."

## Enforcement

- The [PreToolUse guard](../hooks/precheck-licensing.mjs) nudges whenever an edit introduces `commercialOk:true`.
- `/sources-lint` audits the codebase for `commercialOk:true` lacking a GREEN ledger row.
