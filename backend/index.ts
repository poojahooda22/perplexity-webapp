import { tavily } from '@tavily/core';
import express from 'express';
import { streamText } from 'ai';
import SYSTEM_PROMPT, { PROMPT_TEMPLATE } from './prompt';
import { middleware } from './middleware';
import type { AuthenticatedRequest } from './middleware';
import { prisma } from './db';

const app = express();

const tavily_client = tavily({
    apiKey: process.env.TAVILY_API_KEY
});

app.use(express.json());

// CORS (explicit + preflight short-circuit). Express 5's router + cors@2 don't
// reliably answer the OPTIONS preflight (it 404s), so we set the headers ourselves
// and end preflight with 204. Access-Control-Expose-Headers lets the browser read
// our custom x-conversation-id response header.
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Expose-Headers", "x-conversation-id");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});

// Vercel AI Gateway model ids (`<provider>/<model>`, dot in the model segment).
// A bare string model routes through the gateway (uses AI_GATEWAY_API_KEY), giving
// access to every provider from one key. Keep in sync with the frontend picker.
const ALLOWED_MODELS = new Set([
    "google/gemini-3.1-pro-preview",
    "google/gemini-3-pro-preview",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.5-pro",
    "openai/gpt-5.5",
    "xai/grok-4.3",
]);
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
function resolveModel(model: unknown): string {
    return typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}


/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

// URL-friendly slug from a query, e.g. "Best way to learn Rust?" -> "best-way-to-learn-rust"
function slugify(text: string): string {
    const base = text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `${base || "conversation"}-${crypto.randomUUID().slice(0, 8)}`;
}

// Run a Tavily web search and shape the sources + images we stream back.
async function webSearch(query: string) {
    // Tavily caps search queries at 400 chars and 400s on longer ones. The user's FULL
    // prompt still goes to the LLM (no cap there) — we only trim the search string.
    const searchQuery = query.length > 400 ? query.slice(0, 400) : query;
    const response = await tavily_client.search(searchQuery, {
        searchDepth: "advanced",
        includeImages: true,
        // Cast a wide net across the whole web (github, stackoverflow, reddit, youtube, docs…).
        maxResults: 10,
    });
    const results = response.results;
    const sources = results.map((r) => ({ title: r.title, url: r.url, content: r.content }));
    // Tavily returns images as bare URLs (or {url, description} with descriptions on).
    const rawImages = (response.images ?? []) as Array<string | { url: string; description?: string }>;
    const images = rawImages.map((img) =>
        typeof img === "string" ? { url: img } : { url: img.url, description: img.description },
    );
    return { results, sources, images };
}

// Stream the answer + a <SOURCES> block in the exact wire format the frontend parses.
// (Kept identical for cache HITs and live answers so the client handles both the same.)
function writeSources(res: express.Response, sources: unknown) {
    res.write("\n<SOURCES>\n");
    res.write(JSON.stringify(sources));
    res.write("\n<SOURCES>\n");
}

// The sources + images wire blocks as ONE string — written to the live stream AND
// persisted with the assistant message, so reloading a conversation from history keeps
// its links + images (the frontend parses this exact format either way).
function sourcesImagesTail(sources: unknown, images: unknown): string {
    return (
        `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
        `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
    );
}

// Render the search results as a numbered, citeable context block for the LLM, so the
// inline [n] citations it produces line up with the sources list the client shows.
function formatSearchContext(
    results: Array<{ title?: string; url: string; content?: string }>,
): string {
    return results
        .map((r, i) => `[${i + 1}] ${r.title ?? r.url}\nURL: ${r.url}\n${(r.content ?? "").slice(0, 1200)}`)
        .join("\n\n");
}


/* ────────────────────────────────────────────────────────────────────────
 * Vector / semantic-cache layer  (Step 3 — NOT implemented yet)
 *
 * These three functions are the entire vector layer. They are wired into
 * /perplexity_ask below as no-ops today (embedQuery returns null -> every
 * request is a cache MISS -> the live Tavily+LLM path runs). To turn the
 * cache ON later, you only fill in these three bodies — the endpoints below
 * never change. See the RAG plan / migration we deferred.
 * ──────────────────────────────────────────────────────────────────────── */

// Step A — turn the user query into an embedding vector.
async function embedQuery(_query: string): Promise<number[] | null> {
    // TODO(vector): import { embed } from 'ai';
    //   const { embedding } = await embed({ model: 'openai/text-embedding-3-small', value: _query });
    //   return embedding;            // 1536-dim vector, routed via the AI Gateway like gpt-4o
    return null;                      // null => "no embedding yet" => always a cache miss
}

// Step B — find a semantically-similar PAST query already answered & cached.
async function findCachedAnswer(
    embedding: number[] | null
): Promise<{ answer: string; sources: unknown } | null> {
    if (!embedding) return null;
    // TODO(vector): cosine nearest-neighbour over pgvector, e.g.
    //   const vec = `[${embedding.join(',')}]`;
    //   const rows = await prisma.$queryRaw`
    //     SELECT "answer", "sources", ("embedding" <=> ${vec}::vector) AS distance
    //     FROM "cached_query" ORDER BY "embedding" <=> ${vec}::vector LIMIT 1`;
    //   return hit within distance threshold AND not stale (TTL) ? rows[0] : null;
    return null;
}

// Step C — after a fresh live answer, store it so future similar queries hit the cache.
async function cacheAnswer(_p: {
    query: string;
    embedding: number[] | null;
    answer: string;
    sources: unknown;
    userId?: string;
}): Promise<void> {
    if (!_p.embedding) return;
    // TODO(vector): $executeRaw INSERT INTO "cached_query" (queryText, embedding, answer, sources, userId, createdAt) ...
    return;
}


/* ────────────────────────────────────────────────────────────────────────
 * GET /conversations  — list the logged-in user's conversations (sidebar)
 * ──────────────────────────────────────────────────────────────────────── */
app.get("/conversations", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    // NOTE: Conversation has no createdAt column yet, so we can't order chronologically.
    // Add `createdAt DateTime @default(now())` to the model in the next migration, then
    // switch to `orderBy: { createdAt: "desc" }`.
    const conversations = await prisma.conversation.findMany({
        where: { userId: req.userId },
        select: { id: true, title: true, slug: true },
    });

    res.json({ conversations });
});


/* ────────────────────────────────────────────────────────────────────────
 * GET /conversations/:conversationId — load one conversation + its messages
 * ──────────────────────────────────────────────────────────────────────── */
app.get("/conversations/:conversationId", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    const conversationId = String(req.params.conversationId);
    const conversation = await prisma.conversation.findFirst({
        // id + userId => also enforces ownership: you can't read someone else's chat
        where: { id: conversationId, userId: req.userId },
        include: { messages: { orderBy: { id: "asc" } } }, // Message.id autoincrements => chronological
    });

    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    res.json({ conversation });
});


/* ────────────────────────────────────────────────────────────────────────
 * PATCH /conversations/:conversationId — rename (set title)
 * Body: { title: string }
 * ──────────────────────────────────────────────────────────────────────── */
app.patch("/conversations/:conversationId", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    const conversationId = String(req.params.conversationId);
    const title = req.body?.title;
    if (typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Missing or invalid 'title'" });
    }

    // updateMany with userId in the filter enforces ownership (count 0 = not yours / not found).
    const result = await prisma.conversation.updateMany({
        where: { id: conversationId, userId: req.userId },
        data: { title: title.trim().slice(0, 120) },
    });
    if (result.count === 0) return res.status(404).json({ error: "Conversation not found" });

    res.json({ ok: true });
});


/* ────────────────────────────────────────────────────────────────────────
 * DELETE /conversations/:conversationId — delete a conversation + its messages
 * ──────────────────────────────────────────────────────────────────────── */
app.delete("/conversations/:conversationId", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    const conversationId = String(req.params.conversationId);

    // Ownership check before deleting.
    const owned = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: "Conversation not found" });

    // Messages FK is ON DELETE RESTRICT, so remove them first, then the conversation — atomically.
    await prisma.$transaction([
        prisma.message.deleteMany({ where: { conversationId } }),
        prisma.conversation.delete({ where: { id: conversationId } }),
    ]);

    res.json({ ok: true });
});


/* ────────────────────────────────────────────────────────────────────────
 * POST /perplexity_ask — the main endpoint (a fresh, single-turn search)
 * Body: { query: string, conversationId?: string }
 * ──────────────────────────────────────────────────────────────────────── */
app.post("/perplexity_ask", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    // step 1 - get the query from the user
    const query = req.body.query;
    const conversationId: string | undefined = req.body.conversationId;

    if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing or invalid 'query' in request body" });
    }

    // step 2 - TODO: make sure the user has access/credits to hit the endpoint (payment gateway)

    try {
        // Resolve the conversation: continue an existing one (ownership-checked) or start a new one.
        let conversation;
        if (conversationId) {
            conversation = await prisma.conversation.findFirst({
                where: { id: conversationId, userId: req.userId },
            });
            if (!conversation) return res.status(404).json({ error: "Conversation not found" });
        } else {
            conversation = await prisma.conversation.create({
                data: {
                    title: query.slice(0, 80),
                    slug: slugify(query),
                    userId: req.userId,
                },
            });
        }

        // Persist the user's message.
        await prisma.message.create({
            data: { content: query, role: "user", conversationId: conversation.id },
        });

        // step 3 - SEMANTIC CACHE: try to answer from a similar past query before paying
        //          for a Tavily search + an LLM generation. (No-op until the vector layer is filled in.)
        const embedding = await embedQuery(query);
        const cached = await findCachedAnswer(embedding);

        // Tell the client which conversation this is (read via the exposed header).
        res.setHeader("x-conversation-id", conversation.id);
        res.header("Cache-Control", "no-cache");
        res.header("Content-Type", "text/event-stream");

        if (cached) {
            // Cache HIT — replay the stored answer, skip Tavily + the LLM entirely.
            res.write(cached.answer);
            writeSources(res, cached.sources);
            res.end();
            await prisma.message.create({
                data: { content: cached.answer, role: "Assistant", conversationId: conversation.id },
            });
            return;
        }

        // step 4 - MISS PATH: live web search to gather sources (Tavily)
        const { results, sources, images } = await webSearch(query);

        // step 5 - context engineering: stuff the web results + query into the prompt template
        const prompt = PROMPT_TEMPLATE
            .replace("{{WEB_SEARCH_RESULTS}}", formatSearchContext(results))
            .replace("{{USER_QUERY}}", query);

        // step 6 - hit the LLM and stream the answer back
        const result = streamText({
            // bare string id → routed through the Vercel AI Gateway (uses AI_GATEWAY_API_KEY)
            model: resolveModel(req.body.model),
            prompt,
            system: SYSTEM_PROMPT,
            // streamText swallows mid-stream errors by default — surface them
            onError: ({ error }) => console.error("streamText error:", error),
        });

        let fullAnswer = "";
        for await (const textPart of result.textStream) {
            fullAnswer += textPart;   // buffer so we can persist + cache it
            res.write(textPart);
        }

        // step 7 - stream the references the answer cited + any images from the search
        const tail = sourcesImagesTail(sources, images);
        res.write(tail);

        // step 8 - close the stream
        res.end();

        // step 9 - persist the FULL payload (answer + sources + images) so a history reload
        //          keeps the links/images, then populate the cache. Skip empty (failed) answers.
        if (fullAnswer.trim()) {
            await prisma.message.create({
                data: { content: fullAnswer + tail, role: "Assistant", conversationId: conversation.id },
            });
            await cacheAnswer({ query, embedding, answer: fullAnswer, sources, userId: req.userId });
        }
    } catch (err) {
        console.error("Request failed:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        } else {
            // headers already flushed mid-stream — just close
            res.end();
        }
    }
});


/* ────────────────────────────────────────────────────────────────────────
 * POST /perplexity_ask/follow_up — continue a conversation WITH full history
 * Body: { conversationId: string, query: string }
 *
 * Difference vs /perplexity_ask: this forwards the prior chat turns to the LLM
 * so the model has context ("it", "that", "the second one" all resolve).
 * (No semantic cache here: a follow-up's meaning depends on the whole thread,
 *  so a cache keyed on the latest query alone would serve wrong answers.)
 * ──────────────────────────────────────────────────────────────────────── */
app.post("/perplexity_ask/follow_up", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    const { conversationId, query } = req.body as { conversationId?: string; query?: string };

    if (!conversationId || typeof conversationId !== "string") {
        return res.status(400).json({ error: "Missing or invalid 'conversationId'" });
    }
    if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing or invalid 'query'" });
    }

    try {
        // step 1 - get the existing chat from the DB (ownership-checked), oldest message first
        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, userId: req.userId },
            include: { messages: { orderBy: { id: "asc" } } },
        });
        if (!conversation) return res.status(404).json({ error: "Conversation not found" });

        // Map stored turns into LLM chat messages (DB enum 'Assistant' -> 'assistant').
        const history = conversation.messages.map((m) => ({
            role: m.role === "Assistant" ? ("assistant" as const) : ("user" as const),
            content: m.content,
        }));

        // Persist the new user turn.
        await prisma.message.create({
            data: { content: query, role: "user", conversationId: conversation.id },
        });

        // Follow-ups still benefit from fresh sources, so web search the new query too.
        const { results, sources, images } = await webSearch(query);
        const augmentedQuery = PROMPT_TEMPLATE
            .replace("{{WEB_SEARCH_RESULTS}}", formatSearchContext(results))
            .replace("{{USER_QUERY}}", query);

        // step 2 - forward the full history + the augmented new query to the LLM
        res.setHeader("x-conversation-id", conversation.id);
        res.header("Cache-Control", "no-cache");
        res.header("Content-Type", "text/event-stream");

        const result = streamText({
            model: resolveModel(req.body.model),
            system: SYSTEM_PROMPT,
            messages: [...history, { role: "user" as const, content: augmentedQuery }],
            onError: ({ error }) => console.error("streamText error:", error),
        });

        // step 3 - stream the response to the user
        let fullAnswer = "";
        for await (const textPart of result.textStream) {
            fullAnswer += textPart;
            res.write(textPart);
        }
        const tail = sourcesImagesTail(sources, images);
        res.write(tail);
        res.end();

        // persist the FULL payload (answer + sources + images); skip empties from a failed generation
        if (fullAnswer.trim()) {
            await prisma.message.create({
                data: { content: fullAnswer + tail, role: "Assistant", conversationId: conversation.id },
            });
        }
    } catch (err) {
        console.error("Follow-up failed:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        } else {
            res.end();
        }
    }
});


if (!process.env.VERCEL) {
    const PORT = Number(process.env.PORT) || 3001;
    app.listen(PORT, () => console.log(`backend listening on http://localhost:${PORT}`));
}

export default app;
