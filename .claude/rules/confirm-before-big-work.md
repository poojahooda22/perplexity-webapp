# Rule: confirm before big work (light prompt protocol)

The operator often dictates by voice — prompts can be unstructured or ambiguous. To avoid burning
rounds on a wrong assumption, **restate intent + a short plan before any large or irreversible change,
and proceed directly on small/clear asks.**

## When to confirm first

Restate intent + the plan (and wait for a nod) before:
- a **multi-file** change or a new feature/sub-tab,
- anything **irreversible or outward-facing** (deletes, migrations, pushes, PRs, sending email, deploys),
- a change to **shared contracts** (the wire protocol, a public route, the DB schema, the harness itself),
- when the request is **genuinely ambiguous** about scope or target.

The restate can be brief: *Intent → Scope (files/systems) → Approach → any constraint that applies.* If
the operator already gave a detailed spec, just confirm understanding in a line or two.

## When to just act

- Small, clear, low-risk asks (a one-file fix, a question, a read/search, a localized edit).
- Continuing work already approved this session.

## Overrides

- "go" / "do it" / "proceed" / "ship it" / "just do it" → act immediately, skip the restate.
- "skip rewrite" / "don't ask" → respect it for the session. The operator is always in control.

> This is the **light** version. It is deliberately *not* rareLab's mandatory rewrite-and-wait on every
> prompt — that was considered and rejected as too heavy for this repo. The goal is catching ambiguity
> on big work, not adding ceremony to every turn.
