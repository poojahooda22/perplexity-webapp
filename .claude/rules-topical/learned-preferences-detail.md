# Learned Preferences — Detail

> On-demand companion to the always-loaded `.claude/rules/learned-preferences.md`. These are
> path-specific scar-tissue rules — read the matching one before editing its subsystem (the project's
> routing maps each path to the rules it needs). Each is a codified incident with **mechanism,
> application, and rationale**. Cross-cutting rules live in the always-loaded file, not here.
>
> This file is a **template + a small set of genuinely cross-domain rules**. As a project accumulates
> its own incidents, append them here in the same four-part shape: **Problem → Rule → Why → How to
> apply → Source**. The domain-specific examples a project lands (subsystem contracts, render/IO
> pipelines, framework gotchas) belong here too; keep them in this format so each is a self-contained,
> diagnosable lesson rather than tribal knowledge.

## The shape of a learned-preference rule

Every entry below follows the same structure. Reuse it for new entries:

- **Problem** — the concrete incident: what broke, under what input, why it was non-obvious.
- **Rule** — the codified preference, stated as an imperative the next editor can follow.
- **Why** — the mechanism. *Why* the rule is true, not just *that* it is — so it survives refactors.
- **How to apply** — the trigger ("when editing X…") and the action, so it fires at the right moment.
- **Source** — the incident/commit it came from, so it can be re-verified against live code.

---

## LP1 — Type-lie caches crash on the cleanup path (split caches by value type)

**Problem:** A map declared as `Map<string, A>` was used to hold both `A` instances and a second,
unrelated value type `B`. It "worked" until a teardown/cleanup loop hit a `B` entry and called an
`A`-only method on it (`x.dispose is not a function` / `x.close is not a function`). Adding a runtime
guard (`typeof x.dispose === 'function'`) is a hack-wrapped-in-ceremony that hides the type lie instead
of fixing it.

**Rule:** **A typed cache (`Map<K, V>` / `Set<V>` / typed array) holds exactly the value type its
declaration claims.** If two value types share storage today, split into two typed caches. Never paper
over the lie with a runtime `typeof` guard, an `any` cast, or an `as unknown as A` cast on a value that
is not actually `A`.

**Why:** Type lies survive review (the compiler is happy) but blow up at runtime in the worst place —
disposal/teardown, where the bug surfaces as "everything broke" instead of a localized error. Splitting
caches by value type is a one-time migration cost; living with the lie compounds debt every time a new
caller assumes the declared type.

**How to apply:**
- Spot the lie at code review: any `as unknown as <DeclaredType>` cast on a value that is not actually
  that type is a lie.
- Migration shape: introduce a second typed map (e.g. a dedicated `Map<string, B>`) with its own
  ownership lifecycle, route reads/writes there, remove the cast.
- Wire the new typed cache through the shared context/loader types so all consumers see the same
  authoritative shape.

**Source:** Generic TypeScript discipline. (Replace this line with the project's own incident + commit
when the rule is re-derived locally.)

---

## LP2 — Invalidate the per-frame/per-render cache after an async load completes

**Problem:** A render/compute loop computes a per-item hash at the top of every cycle from the item's
current properties, and skips re-work on a cache hit. When an async loader (image, file, network fetch)
completes **mid-cycle** and writes a new value to the asset cache, the hash for that item has already
been computed for the current cycle — the cache shows a hit, the item skips re-render, and the new value
never appears until something else changes the hash. User sees: "I picked a new X but it doesn't show up
until I change some other property."

**Rule:** **Every async load callback that mutates a value behind a hash/memo cache MUST invalidate that
item's cache entry immediately after the write** (e.g. `hashMap.delete(itemId)`). The delete forces the
next cycle to recompute the hash, see a miss, and re-render with the freshly-loaded value.

**Why:** Without the kick, async-load completion is invisible to the cache layer. The fix is one line at
every load callback. The symptom — "stale visual until the user pokes the panel" — masquerades as a UI
bug but is actually a cache-invalidation bug.

**How to apply:**
- Every loader that calls `cache.set(...)` in an async callback also invalidates the corresponding
  hash/memo entry.
- Forward the cache/invalidation handle through the loader context so loaders don't need to know about
  the consuming instance.
- The pattern is identical for every async asset class — apply it uniformly.

**Source:** Async-load cache-invalidation incident class. (Re-derive with the local commit/file when seen
in this project.)

---

## LP3 — Alias-then-swap for flicker-free async asset replacement

**Problem:** When a user swaps an asset (preset, image, file), the naive sequence is
`oldValue.dispose(); cache.delete(oldKey); load(newKey)`. Between dispose and load completion
(tens-to-hundreds of ms on a cold cache), the consumer renders with a null/dummy fallback — a visible
blank/flash. This applies to any async-replaced asset where the user expects visual continuity.

**Rule:** **For async asset swaps where flicker is unacceptable, alias the new key to the OLD value
immediately, kick off the new load, and dispose the old value only AFTER the new one lands.** Pattern:
`cache.set(newKey, oldValue); requestLoad(newKey); onSuccess: cache.set(newKey, newValue); oldValue.dispose()`.

**Why:** The consumer reads `cache.get(currentKey)` every cycle. If `currentKey` always resolves to a
valid value (alias to old → real new), there is no cycle where it renders empty. The old value stays
alive across the load window because the alias holds a reference; dispose runs only on the success path
after the swap. A "keep-alive" escape clause in the standard cleanup loop must retain the aliased key
while it is in use, so the sweep doesn't dispose it as "stale" before the new value lands.

**How to apply:**
- When the rule applies: any async-loaded asset behind a user-facing dropdown/picker where a blank
  frame is unacceptable.
- The success callback owns the dispose (`cache.set(newKey, newValue)` then `oldValue.dispose()`).
- Pair with LP2 (invalidate the hash) so the swapped value actually paints.

**Source:** Async asset-swap flicker incident class. (Re-derive with the local commit/file.)

---

## LP4 — In-flight tracking + compare-and-commit for async replace-races

**Problem:** User picks value A; the loader fires. Before A's callback completes, the user picks value B;
B's loader fires too. Both callbacks resolve. With a naive `loadedKeys.has(key)` short-circuit, the
second loader sees the key already loaded (because A's set landed) and silently no-ops; the user keeps
seeing A even though they picked B. Same class for any property that drives an async fetch the user can
change faster than the fetch round-trips.

**Rule:** **Track in-flight async loads in a separate `Set<key>` distinct from the loaded-keys set, and
use compare-and-commit semantics in the success callback** so that only the latest request wins.

Pattern:
1. `inFlight.add(key)` before firing the loader; capture a `valueAtFire` snapshot of the property that
   determined the load target.
2. In the success callback: re-read the property's current value; if `currentValue !== valueAtFire`, the
   user changed their mind → discard this result, do not mutate the cache.
3. If still current, commit: `cache.set`, invalidate the hash (LP2), `inFlight.delete(key)`.

**Why:** The naive pattern conflates "load in progress" with "load completed and cached" — two different
states with different correctness properties. Separating them lets the success callback know it is racing
and safely lose if it is not the latest request. Without compare-and-commit, the user has to refresh to
see their newest choice.

**How to apply:**
- Add an `inFlight: Set<string>` (or per-asset-class equivalent) to the loader context.
- All loaders for properties the user can change pointer-fast follow the pattern.
- Slow, human-paced changes (e.g. dropdown picks) may not need in-flight tracking — they pair with the
  alias-then-swap retention of LP3 instead.

**Source:** Rapid async-replace race incident class. (Re-derive with the local commit/file.)

---

## LP5 — Use a main-thread-resilient path for loading/progress UI

**Problem:** During a heavy operation (first paint, compile, large compute, cold load) the main JS thread
is starved. A loading indicator implemented as a JS-driven animation (rAF, JS-stepped values,
layout-affecting transforms) stalls visibly during exactly that window — the user sees a frozen UI when
the underlying work is actually progressing.

**Rule:**
- **Loading/progress motion uses a path that survives a busy main thread** — e.g. CSS compositor-thread
  animation (`transform`/`opacity`) rather than JS-driven per-frame stepping. Animation that stalls when
  the thread is busy is the failure mode this rule prevents.
- **Isolate any layout scaling to the element that needs it.** Do not wrap the indicator and surrounding
  copy in the same scaled/composited container, so the indicator avoids being fused into the heavy
  rendering path.
- **Keep loading glyphs at their true intended scale** — don't substitute oversized primitives for small
  typographic elements; it reads as UI chrome and breaks the intended design.

**Why:** The compositor thread (CSS `transform`/`opacity`) is independent of the JS thread. JS-driven
animations share execution with compile, network, layout, and framework reconciliation — exactly the
cohort of work that runs hot during heavy operations. The visible indicator must live on a path that does
not contend.

**How to apply:**
- Editing splash / loading components → compositor-thread animation for motion, isolated transform on
  only the element that needs it.
- A route-level `loading` fallback is acceptable **only** as an **invisible** boundary fallback for the
  framework's loading/prefetch machinery; primary in-app navigation must feel instantaneous, not show a
  spinner.

**Source:** Heavy-operation loading-stall incident class. (Re-derive with the local component/commit.)

---

## LP6 — Recovery-first git workflow after merge/revert chaos

**Problem:** After merge or revert chaos in git history, the right move is recovery-first — establish a
safety anchor, reconcile against a known-good baseline at **file granularity**, and explicitly confirm
that newer local work is retained — not "fix forward and hope."

**Rule:**
1. **Tag a safety anchor** (e.g. `git tag safety-recovery-$(date +%Y%m%d-%H%M%S)`) before any further
   history modification.
2. **Reconcile file by file** against a pre-merge baseline. For each file, classify: ours-newer,
   theirs-newer, both-edited.
3. **Explicitly confirm with the operator** that newer local work is retained before any destructive
   resolution.

**Why:** Merge/revert chaos costs real hours when handled with bulk strategies. File-by-file
reconciliation is slower per step but never silently overwrites local work. A safety tag means any
mistake during reconciliation is recoverable.

**How to apply:**
- Post-chaos git work → safety tag first, then file-by-file classification, then explicit confirmation.
- Never resolve with a bulk `--ours` / `--theirs` until each file has been classified.

**Source:** Merge-chaos recovery incident class.

---

## LP7 — Bisect-by-revert when static review can't prove correctness on a large refactor

**Problem:** On a large extraction-class refactor (many lines of diff splitting one big code path into
several files), the type checker / lint passes at baseline but runtime/behavioral verification reports
regressions across multiple paths. Static review of the diff does not surface the bug. Two responses are
available:
1. Hypothesis-driven surgical fix — add logging, guess at the cause, push a "fix" without proof, risk
   compounding the regression.
2. Bisect-by-revert — revert one unit at a time, verify after each, let the revert sequence name the
   culprit.

**Rule:** **When extraction-class refactors fail behavioral verify and static review cannot prove the
root cause, default to bisect-by-revert before any speculative fix.** Each revert is a one-liner
(`git revert <hash>`); the working tree returns to a known-good shape; the verify cycle costs ~N cycles
for an N-unit bisect; the result is mathematically definitive.

**Why:** Hard-to-reproduce bugs frequently look like the extracted code but are actually transient state
(hot-reload, a stale cache, a browser/runtime cache). Hypothesis-driven fixes on large surfaces compound
regression risk because the original cause may not be in code at all. Bisect-by-revert isolates the
variable: if reverting commit X restores broken-behavior to working, X is the cause; if X is reverted and
the behavior is still broken, X is not the cause and the bug is elsewhere (likely transient state).
Either outcome is information.

**How to apply:**
- Establish the verification scenario **in writing** before starting, so the test is consistent across
  iterations.
- Revert in reverse chronological order, smallest-blast-radius first. After each revert, reset the
  runtime to a clean state (full reload / clear caches / restart) and re-run the verify scenario.
- The first revert that restores broken→working names the culprit. The first revert that restores
  nothing tells you the bug is not in that commit.
- After bisect: if no commit was the cause, the regression was transient — re-apply the reverts
  (`git revert <revert-hash>`) and move on. If a commit was the cause, diff the reverted file against the
  original line by line to find the exact divergence; do not re-extract until the divergence is named.

**Source:** Large-refactor regression-isolation incident class.

---

## Index

LP1 — Type-lie caches crash on the cleanup path (split caches by value type)
LP2 — Invalidate the per-frame/per-render cache after an async load completes
LP3 — Alias-then-swap for flicker-free async asset replacement
LP4 — In-flight tracking + compare-and-commit for async replace-races
LP5 — Main-thread-resilient path for loading/progress UI
LP6 — Recovery-first git workflow after merge/revert chaos
LP7 — Bisect-by-revert when static review can't prove correctness on a large refactor
