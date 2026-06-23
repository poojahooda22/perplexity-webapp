# Rule: the product is Lumina

The product is **Lumina**. **Never** write "Perplexity" in user-visible text or in new prose
(UI strings, docs, generated answers, marketing copy).

**The only exception:** pre-existing internal API route names like `/perplexity_ask` and
`/perplexity_ask/follow_up` — these are wire-level identifiers, not user-facing, and renaming them
would break the contract. Don't add new ones.

When in doubt, the user sees "Lumina"; the code may carry the legacy route name.
