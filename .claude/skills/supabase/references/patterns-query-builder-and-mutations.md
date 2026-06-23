# supabase-js Query Builder and Mutations

> Generic reference for `@supabase/supabase-js` v2 `select`, `insert`, `upsert`, `update`, and
> `delete` — filters, embedded selects, returning rows, bulk ops, and error handling.
> **In Lumina this is the non-default path:** Prisma owns all persistent data. This knowledge
> applies when writing a Supabase Edge Function, a lightweight worker script, or any project that
> uses supabase-js as its primary data client.

---

## Context: the non-default path in Lumina

Lumina's `backend/client.ts:9-20` creates a supabase-js client exclusively for
`auth.getUser(token)` — there is no `from('table')` call anywhere in the production backend.
All reads and writes go through Prisma over `DATABASE_URL`. The reasons are documented in
`lumina-supabase-in-this-repo.md`:

1. RLS policies must be maintained for every table exposed through the supabase-js client, or
   the service-role key's bypass is a data breach waiting to happen.
2. `from('table').select()` returns `any[]` without type generation; Prisma generates a
   fully-typed client from `schema.prisma` at build time.
3. For a server with a direct `DATABASE_URL` connection, Prisma adds zero network hops;
   supabase-js routes through PostgREST (HTTP) for every query.

**When does this reference apply in Lumina?**

- A Supabase Edge Function (Deno runtime, no `DATABASE_URL`) that needs a data query.
- A lightweight script or cron that runs outside the Express backend.
- A new side feature where setting up Prisma is disproportionate.
- Any project where supabase-js IS the primary data client.

If you are working in `backend/` or `worker/` and Prisma is available, use Prisma. This
document is for completeness and for the cases above.

---

## The `{ data, error }` shape and error handling

Every supabase-js query method returns a `PostgrestResponse<T>`:

```ts
const { data, error } = await supabase.from('users').select('*');
```

**supabase-js does not throw on query errors.** It returns a result object where exactly one
of `data` and `error` is non-null (or both are null on an empty result set with no error).

```ts
interface PostgrestResponse<T> {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;   // populated when { count: 'exact' } is requested
  status: number;         // HTTP status from PostgREST (200, 201, 404, 409…)
  statusText: string;
}

interface PostgrestError {
  message: string;        // human-readable
  details: string;        // additional detail from Postgres
  hint: string;           // Postgres hint, if any
  code: string;           // Postgres error code, e.g. "23505" (unique violation)
}
```

### Always check `error` before using `data`

```ts
const { data: conversations, error } = await supabase
  .from('conversations')
  .select('id, title, created_at')
  .eq('user_id', userId)
  .order('created_at', { ascending: false });

if (error) {
  // Log the full error object — message, code, and details are all useful
  console.error('[conversations] select failed:', error);
  return res.status(500).json({ error: error.message });
}

// data is T[] here (non-null, guaranteed by the check above)
return res.json(conversations);
```

### Common HTTP status codes from PostgREST

| Status | Meaning | Typical cause |
|--------|---------|---------------|
| 200 | OK | Successful SELECT |
| 201 | Created | Successful INSERT with returning |
| 204 | No content | Successful DELETE / UPDATE without returning |
| 400 | Bad request | Malformed filter, wrong column name |
| 401 | Unauthorized | Missing or invalid API key / RLS policy rejects |
| 404 | Not found | `.single()` found zero rows |
| 406 | Not acceptable | `.single()` found more than one row |
| 409 | Conflict | Unique constraint violation (code `"23505"`) |
| 500 | Server error | Postgres error, bad SQL, trigger failure |

### `error.code` for programmatic handling

```ts
const { data, error } = await supabase
  .from('gmail_connections')
  .insert({ user_id: userId, google_email: email, /* … */ });

if (error) {
  if (error.code === '23505') {
    // Unique constraint — this user already has a Gmail connection
    return res.status(409).json({ error: 'Gmail already connected' });
  }
  return res.status(500).json({ error: error.message });
}
```

---

## `select` — columns, filters, ordering, pagination

### Basic column selection

```ts
// All columns (avoid in production — fetches more than needed)
const { data, error } = await supabase.from('users').select('*');

// Named columns (PostgREST projects only these)
const { data, error } = await supabase
  .from('users')
  .select('id, email, name, created_at');

// Aliasing a column in the response
const { data, error } = await supabase
  .from('cached_queries')
  .select('query_text as query, answer, created_at');
```

### Filters and operators

```ts
// Equality
.eq('user_id', userId)                   // WHERE user_id = userId
.neq('status', 'deleted')                // WHERE status != 'deleted'

// Comparisons
.gt('created_at', '2026-01-01')          // WHERE created_at > '2026-01-01'
.gte('price', 100)                       // WHERE price >= 100
.lt('expires_at', new Date().toISOString())
.lte('attempts', 5)

// Set membership
.in('role', ['admin', 'moderator'])      // WHERE role IN ('admin', 'moderator')
.not('role', 'in', '("banned")')        // WHERE role NOT IN ('banned')

// Pattern matching (case-sensitive LIKE, case-insensitive ILIKE)
.like('email', '%@example.com')          // WHERE email LIKE '%@example.com'
.ilike('title', '%machine learning%')   // WHERE LOWER(title) LIKE '%machine learning%'

// NULL checks
.is('deleted_at', null)                  // WHERE deleted_at IS NULL
.not('deleted_at', 'is', null)           // WHERE deleted_at IS NOT NULL

// Range (inclusive both ends)
.gte('price', 10).lte('price', 100)     // 10 <= price <= 100

// JSON / array containment operators
.contains('tags', ['finance'])           // tags @> ARRAY['finance']
.containedBy('categories', ['A', 'B', 'C'])
```

All filter methods chain and are AND-combined by default. For OR conditions:

```ts
// OR filter — wrap in supabase.or()
const { data, error } = await supabase
  .from('articles')
  .select('id, title')
  .or('category.eq.finance,category.eq.tech');

// Complex: (status = 'active' OR status = 'pending') AND user_id = userId
const { data, error } = await supabase
  .from('tasks')
  .select('*')
  .or('status.eq.active,status.eq.pending')
  .eq('user_id', userId);
```

### `single()` and `maybeSingle()`

Both restrict the query to a single row. The choice depends on whether zero rows is an error:

```ts
// single() — throws a PostgREST error (404) if no rows; (406) if multiple rows.
// Use when you EXPECT exactly one row (e.g. fetch by primary key).
const { data: user, error } = await supabase
  .from('users')
  .select('id, email, name')
  .eq('id', userId)
  .single();

if (error) {
  if (error.code === 'PGRST116') {
    // PGRST116 = "Results contain 0 rows" — PostgREST 404
    return res.status(404).json({ error: 'User not found' });
  }
  return res.status(500).json({ error: error.message });
}
// data is User (not User[])

// maybeSingle() — returns null data (no error) when zero rows; error on multiple.
// Use when the row may legitimately not exist.
const { data: connection, error } = await supabase
  .from('gmail_connections')
  .select('*')
  .eq('user_id', userId)
  .maybeSingle();

if (error) return res.status(500).json({ error: error.message });
if (!connection) return res.json({ connected: false });
return res.json({ connected: true, email: connection.google_email });
```

### Ordering

```ts
// Single column
.order('created_at', { ascending: false })   // ORDER BY created_at DESC

// Multiple columns — chain .order() calls
.order('score', { ascending: false })
.order('title', { ascending: true })

// NULLS ordering
.order('published_at', { ascending: false, nullsFirst: false })
// → ORDER BY published_at DESC NULLS LAST
```

### Pagination with `range()`

`range(from, to)` maps to PostgREST's `Range` header. Both ends are inclusive, 0-indexed.

```ts
const PAGE_SIZE = 20;
const page = 0; // 0-indexed

const { data, error } = await supabase
  .from('conversations')
  .select('id, title, created_at')
  .eq('user_id', userId)
  .order('created_at', { ascending: false })
  .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
// Fetches rows 0–19 on page 0, 20–39 on page 1, etc.
```

For cursor-based pagination (more efficient on large tables):

```ts
// Keyset / cursor pagination: last row's created_at becomes the cursor
const { data, error } = await supabase
  .from('messages')
  .select('id, content, role, created_id')
  .eq('conversation_id', conversationId)
  .order('created_id', { ascending: false })
  .lt('created_id', cursorTimestamp)  // cursor: only rows older than the last seen
  .limit(50);
```

### Row count

Request the total count alongside data. Two options trade off latency vs accuracy:

```ts
// 'exact' — Postgres COUNT(*): accurate but adds a second query internally
const { data, error, count } = await supabase
  .from('cached_queries')
  .select('*', { count: 'exact' })
  .eq('model', 'claude-sonnet-4-5');

console.log(`Total: ${count}`); // accurate total row count

// 'estimated' — uses pg_class.reltuples: fast, approximate (safe for informational display)
const { data, error, count } = await supabase
  .from('messages')
  .select('*', { count: 'estimated', head: true }); // head: true = no rows, just count

// 'planned' — Postgres EXPLAIN estimate: even faster, less accurate
```

`head: true` tells PostgREST to issue a HEAD request — no rows returned, just metadata
including the count. Useful for pagination controls that need a total without fetching data.

### TypeScript generics with `returns<T>()`

By default `from('table').select()` returns `any[]`. Attach your own type:

```ts
// Without generated types (manual typing):
interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
}

const { data, error } = await supabase
  .from('conversations')
  .select('id, title, created_at')
  .eq('user_id', userId)
  .returns<ConversationRow[]>();

// data is now ConversationRow[] | null
```

The idiomatic Supabase approach is to generate types from the database schema using the CLI:

```bash
supabase gen types typescript --project-id <ref> --schema public > types/supabase.ts
```

Then the client is typed end-to-end:

```ts
import type { Database } from '../types/supabase.ts';
const supabase = createClient<Database>(url, key);

// supabase.from('conversations').select('id, title') → typed automatically
```

In Lumina, Prisma serves this role — `schema.prisma` generates the typed client. There is no
`types/supabase.ts`. Manual `returns<T>()` calls are the escape hatch if you ever need to query
via supabase-js.

---

## Embedded foreign-table selects (PostgREST joins)

PostgREST can join related tables in a single query using foreign key relationships. The select
string uses a nested syntax:

```ts
// Basic: conversations with nested messages
const { data, error } = await supabase
  .from('conversations')
  .select(`
    id,
    title,
    created_at,
    messages (
      id,
      content,
      role,
      created_id
    )
  `)
  .eq('user_id', userId)
  .order('created_at', { ascending: false });

// data[0].messages is Message[] (or undefined if no FK match)
```

```ts
// Many-to-one: messages with the parent conversation
const { data, error } = await supabase
  .from('messages')
  .select(`
    id,
    content,
    role,
    conversation:conversations (
      id,
      title,
      user_id
    )
  `)
  .eq('conversation_id', conversationId);
```

```ts
// Filtering on the embedded table
const { data, error } = await supabase
  .from('conversations')
  .select('id, title, messages!inner(id, role)')
  .eq('user_id', userId)
  .eq('messages.role', 'user');  // filter: only conversations with user messages
// !inner = INNER JOIN (excludes conversations with zero matching messages)
// Without !inner: LEFT JOIN (conversations with zero messages are returned with messages: [])
```

```ts
// Ordering the embedded rows
const { data, error } = await supabase
  .from('conversations')
  .select(`
    id,
    title,
    messages (id, content, role, created_id)
  `)
  .eq('user_id', userId)
  .order('created_at', { ascending: false })         // outer order
  .order('created_id', { foreignTable: 'messages', ascending: true }); // inner order
```

**Important caveats:**

- Embedded selects require a foreign key in the schema. PostgREST discovers the relationship
  from `information_schema`. If the FK doesn't exist, the query fails with a 400 error.
- Deep nesting (3+ levels) multiplies response size quickly. Prefer separate queries or a
  database function for complex trees.
- In Lumina, prefer Prisma `include:` for this pattern — it is compile-time type-safe and
  the SQL is generated correctly for the `PrismaPg` driver adapter.

---

## Mutations: `insert`, `upsert`, `update`, `delete`

### `insert`

```ts
// Single row
const { data, error } = await supabase
  .from('conversations')
  .insert({
    id: crypto.randomUUID(),
    user_id: userId,
    title: 'New conversation',
    slug: generateSlug(),
  })
  .select('id, created_at')  // without .select(), data is null (204 No Content)
  .single();

if (error) { /* handle */ }
console.log(data.id); // the inserted row's id

// Insert without returning (faster when you don't need the row back)
const { error } = await supabase
  .from('messages')
  .insert({ conversation_id, content, role: 'user' });
```

**Default behavior:** `insert` without `.select()` returns `data: null` and status 201. Add
`.select()` (and optionally `.single()`) to get the inserted row(s) back.

```ts
// Bulk insert (array of objects)
const messages = [
  { conversation_id: id, content: 'Hello', role: 'user' },
  { conversation_id: id, content: 'Hi!',   role: 'assistant' },
];

const { data, error } = await supabase
  .from('messages')
  .insert(messages)
  .select('id, role');

// data is an array of { id, role } for each inserted row
```

### `upsert`

`upsert` maps to `INSERT … ON CONFLICT DO UPDATE`. Use it for idempotent writes where you
know the conflict column.

```ts
// Conflict on 'id' (default: primary key)
const { data, error } = await supabase
  .from('cached_queries')
  .upsert({
    id: existingId,
    query_text: queryText,
    model,
    answer,
    sources,
    images,
  })
  .select();

// Conflict on a specific column (onConflict)
const { data, error } = await supabase
  .from('gmail_connections')
  .upsert(
    { user_id: userId, google_email: email, refresh_token_enc: enc, iv, auth_tag: tag, scopes },
    { onConflict: 'user_id' }  // ON CONFLICT (user_id) DO UPDATE SET …
  )
  .select('id')
  .single();

// No-op update (equivalent to INSERT … ON CONFLICT DO NOTHING effectively)
const { data, error } = await supabase
  .from('users')
  .upsert(
    { id: userId, email, name, provider },
    { onConflict: 'email', ignoreDuplicates: true }  // ON CONFLICT DO NOTHING
  );
```

**`ignoreDuplicates: true`** skips the update entirely on conflict — the row is unchanged.
Useful when you only want to guarantee existence (equivalent to `INSERT … IF NOT EXISTS`).
Without it, the row is updated with the supplied values.

### `update`

`update` requires at least one filter; calling it without a filter updates every row in the
table (PostgREST rejects this by default, but always add a filter to be explicit).

```ts
// Update with returning
const { data, error } = await supabase
  .from('conversations')
  .update({ title: 'Updated title' })
  .eq('id', conversationId)
  .eq('user_id', userId)   // ownership check — always include userId to prevent cross-user writes
  .select('id, title, updated_at')
  .single();

// Update without returning (204)
const { error } = await supabase
  .from('gmail_connections')
  .update({ refresh_token_enc: newEnc, iv: newIv, auth_tag: newTag, updated_at: new Date().toISOString() })
  .eq('user_id', userId);
```

**Ownership filter pattern:** always AND the `user_id` (or equivalent ownership column) into
every update or delete filter. This prevents a user from modifying another user's rows even if
they somehow know the row's primary key.

### `delete`

```ts
// Delete with returning
const { data, error } = await supabase
  .from('conversations')
  .delete()
  .eq('id', conversationId)
  .eq('user_id', userId)
  .select('id')
  .single();

if (error) {
  if (error.code === 'PGRST116') {
    return res.status(404).json({ error: 'Conversation not found or not owned by you' });
  }
  return res.status(500).json({ error: error.message });
}

// Bulk delete
const { error } = await supabase
  .from('cached_queries')
  .delete()
  .lt('created_at', cutoffDate);  // DELETE WHERE created_at < cutoffDate
```

**Delete without a filter is rejected by PostgREST** by default (`PGRST105`). If you
legitimately need to truncate a table, use a database function called via `.rpc()`.

---

## Returning rows from mutations

The default for `insert` / `upsert` / `update` / `delete` in supabase-js v2 is:

| Method | Default | With `.select()` |
|--------|---------|-----------------|
| `insert` | 201, `data: null` | 201, returns inserted rows |
| `upsert` | 200/201, `data: null` | 200/201, returns upserted rows |
| `update` | 204, `data: null` | 200, returns updated rows |
| `delete` | 204, `data: null` | 200, returns deleted rows |

Chain `.select('col1, col2')` before awaiting to get the rows back. Chain `.single()` when
exactly one row is expected. Without `.select()`, `data` is always `null` on success.

```ts
// Full returning chain
const { data: newMessage, error } = await supabase
  .from('messages')
  .insert({ conversation_id, content, role: 'assistant' })
  .select('id, content, role, created_id')
  .single();
```

---

## Bulk operations

supabase-js v2 supports arrays natively in `insert` and `upsert`. For large bulk operations
there is no dedicated "bulk update" API — use a database function or raw SQL instead.

```ts
// Bulk insert (array)
const rows = items.map(item => ({
  user_id: userId,
  query_text: item.query,
  answer: item.answer,
  model: item.model,
  sources: item.sources,
  images: item.images ?? [],
}));

const { data, error } = await supabase
  .from('cached_queries')
  .insert(rows)
  .select('id');

// Bulk upsert
const { error } = await supabase
  .from('watchlist_items')
  .upsert(rows, { onConflict: 'user_id,symbol' });
```

For bulk updates (updating different values per row), use a database function:

```ts
// Call a plpgsql function for complex bulk updates
const { data, error } = await supabase
  .rpc('bulk_update_prices', { updates: priceUpdateArray });
```

**PostgREST limits:** by default PostgREST caps inserts at 1000 rows per request (configurable
in `supabase.toml`). For larger batches, chunk client-side:

```ts
async function bulkInsert<T extends object>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`Bulk insert chunk ${i / chunkSize} failed: ${error.message}`);
  }
}
```

---

## Type safety patterns

### With generated types (recommended for supabase-js-primary projects)

```ts
import type { Database } from '../types/supabase.ts';

const supabase = createClient<Database>(url, key);

// Tables['conversations']['Row'] is the full row type
type ConversationRow = Database['public']['Tables']['conversations']['Row'];
type ConversationInsert = Database['public']['Tables']['conversations']['Insert'];

// select returns ConversationRow[] | null — compile-time safe
const { data, error } = await supabase
  .from('conversations')
  .select('id, title, created_at')
  .eq('user_id', userId);
```

Generate / regenerate types after every migration:

```bash
supabase gen types typescript --project-id <ref> --schema public > src/types/supabase.ts
```

### Without generated types (Lumina's situation)

Use `returns<T>()` to narrow from `any`:

```ts
interface CachedQueryRow {
  id: string;
  query_text: string;
  model: string;
  answer: string;
  sources: unknown[];
  images: unknown[];
  created_at: string;
}

const { data, error } = await supabase
  .from('cached_queries')
  .select('id, query_text, model, answer, sources, images, created_at')
  .order('created_at', { ascending: false })
  .limit(10)
  .returns<CachedQueryRow[]>();
```

---

## Complete worked example: Edge Function using the query builder

This pattern applies when writing a Supabase Edge Function (Deno) that needs to query app
data without Prisma. Note that Edge Functions run inside Supabase's infrastructure, so
the service-role key is appropriate here (passed via `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`).

```ts
// supabase/functions/purge-old-cache/index.ts (Deno)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Delete cached_query rows older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error, count } = await supabase
    .from('cached_queries')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    console.error('Purge failed:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ purged: count }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```

**Why not use Prisma in an Edge Function?** Prisma requires a Node.js (or Bun) runtime and the
`@prisma/adapter-pg` driver. Edge Functions run in Deno with V8 isolates — no Node modules,
no `pg` native driver. supabase-js is the correct data client for Edge Function code.

---

## Error handling patterns — reference table

```ts
// Reusable error handler (generic utility)
function handleSupabaseError(
  error: PostgrestError,
  context: string,
): { status: number; message: string } {
  switch (error.code) {
    case '23505': // unique_violation
      return { status: 409, message: 'Resource already exists' };
    case '23503': // foreign_key_violation
      return { status: 400, message: 'Referenced resource not found' };
    case '23514': // check_violation
      return { status: 400, message: `Constraint violated: ${error.message}` };
    case 'PGRST116': // zero rows for .single()
      return { status: 404, message: `${context} not found` };
    case 'PGRST301': // JWT expired
      return { status: 401, message: 'Session expired' };
    default:
      console.error(`[${context}] Supabase error:`, error);
      return { status: 500, message: 'Internal error' };
  }
}

// Usage
const { data, error } = await supabase
  .from('conversations')
  .select('*')
  .eq('id', id)
  .single();

if (error) {
  const { status, message } = handleSupabaseError(error, 'Conversation');
  return res.status(status).json({ error: message });
}
```

---

## Key rules (summary)

| Rule | Why |
|------|-----|
| Always check `error` before using `data` — the library does not throw | A null `data` with a non-null `error` is a success from JS's perspective; you must check manually |
| Add `.select()` to mutations if you need the returned row | Without it, `data` is always null on insert/update/delete |
| Always include an ownership filter (`user_id = userId`) in update/delete | PostgREST has no built-in user scoping; forgetting it allows cross-user mutations |
| Prefer `maybeSingle()` over `single()` when zero rows is legitimate | `single()` returns a 404 error on zero rows; `maybeSingle()` returns `null` data instead |
| Use `onConflict` explicitly in `upsert` calls | Relying on the implicit PK conflict can mask schema mismatches |
| Chunk large bulk inserts (>500 rows) | Default PostgREST row limit; chunking is safer across configurations |
| In Lumina: use Prisma unless in an Edge Function or outside the Express backend | Prisma is typed, faster (direct TCP), and does not require RLS maintenance |

---

## See also

**Within the supabase skill:**
- `lumina-supabase-in-this-repo.md` — why Lumina uses Prisma for data and supabase-js only for auth; the division of labor
- `theory-supabase-architecture.md` — PostgREST, GoTrue, the key model; why the query builder routes through HTTP
- `patterns-rls-policies.md` — required reading before exposing any table through the supabase-js client
- `patterns-edge-functions.md` — the Deno runtime context where the query builder is the primary data client
- `patterns-database-functions-triggers-rpc.md` — `.rpc()` for complex queries and bulk updates the builder can't express
- `patterns-client-setup-and-config.md` — `createClient`, key selection, lazy init pattern

**Other skills:**
- `prisma` — the primary data layer in Lumina; `$queryRaw`/`$executeRaw` for pgvector; `backend/db.ts:1-10`
- `rag-retrieval` — semantic cache reads/writes via Prisma raw SQL on the `cached_queries` table
- `backend-testing` — the `supabase-fake.ts` seam and how to mock auth in tests
- `connectors-oauth` — `GmailConnection` model and the encrypted token vault (written via Prisma, not supabase-js)
- `lumina-frontend` — TanStack Query patterns for data fetching from Lumina's Express API (not direct supabase-js queries from the browser)
