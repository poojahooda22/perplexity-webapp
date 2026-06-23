---
description: Audit the codebase for commercialOk:true that lacks a GREEN row in the sources-ledger
argument-hint: "[optional path to scope the audit, e.g. backend/finance]"
allowed-tools: Grep, Read, Bash
---

# /sources-lint — licensing audit

Audit the codebase against [`.claude/memory/sources-ledger.md`](../memory/sources-ledger.md) (the
`commercialOk` truth table). Goal: **no `commercialOk: true` whose fetch path lacks a 🟢 GREEN ledger row.**

Scope: `$ARGUMENTS` if given, else the whole repo (focus `backend/`).

Do this:
1. Grep for every `commercialOk: true` (and `commercialOk:true`) in the code. For each hit, read enough
   surrounding context to identify the **fetch path / provider** it describes.
2. Load the sources-ledger and, for each hit, find the matching source row.
3. Flag any hit where the matching row is **not 🟢 GREEN** (RED / YELLOW / REJECT / missing). Each flag =
   a potential licensing violation of the [commercial-ok gate](../rules/commercial-ok-gate.md).
4. Also flag the inverse drift: any **ledger source used in code** whose provenance still says
   `commercialOk: false` but the ledger row is 🟢 (a safe under-claim worth noting), and any provider
   referenced in code that has **no ledger row at all** (add one).
5. Report a short table: `file:line · provider · code says · ledger says · verdict (OK / FIX / ADD-ROW)`.
   Do **not** edit code unless asked — this is an audit. End with the count of FIX-level findings.

Default to RED when a fetch path can't be matched to a ledger row — silence is not a license.