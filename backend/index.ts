import { tavily } from '@tavily/core';
import express from 'express';
import { streamText, embed, stepCountIs } from 'ai';
import { buildSystemPrompt, buildUserPrompt, classifyQuery } from './prompt.js';
// NOTE: this file is named auth.ts, NOT middleware.ts, on purpose. Vercel treats a
// root-level `middleware.ts` as Edge Middleware (V8 isolates, no Node modules) and the
// build fails because this auth code imports Prisma/pg. Keep it off that magic filename.
import { middleware } from './auth.js';
import type { AuthenticatedRequest } from './auth.js';
import { prisma } from './db.js';
import { financeRouter, warmFinanceCache } from './finance/routes.js';
import { buildFinanceTools } from './finance/tools.js';
import { buildGmailTools } from './connectors/gmail/tools.js';
import { buildFinanceSystem } from './finance/skills.js';
import { discoverRouter } from './discover/routes.js';
import { gmailRouter } from './connectors/gmail/routes.js';
// Pure helpers extracted from this file into lib/ so they're independently unit-testable.
import { slugify } from './lib/slug.js';
import { sourcesImagesTail, formatSearchContext, buildAttachmentParts, type ContentPart } from './lib/wire.js';
import { resolveModel } from './lib/models.js';
import { isTimeSensitive } from './lib/query-policy.js';
import { createRateLimiter } from './lib/user-rate-limit.js';
import { buildConversationHistory } from './lib/compaction.js';

const app = express();

const tavily_client = tavily({
    apiKey: process.env.TAVILY_API_KEY
});

app.use(express.json({ limit: "25mb" })); // base64-encoded attachments can be large

// CORS (explicit + preflight short-circuit). Express 5's router + cors@2 don't
// reliably answer the OPTIONS preflight (it 404s), so we set the headers ourselves
// and end preflight with 204. Access-Control-Expose-Headers lets the browser read
// our custom x-conversation-id response header.
// Optional allowlist: set ALLOWED_ORIGINS="https://app.com,https://www.app.com" in prod.
// If unset we reflect the request origin (fine today — auth is header tokens, not cookies —
// but set this before switching to cookie auth).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",").map((o) => o.trim()).filter(Boolean);
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = ALLOWED_ORIGINS.length === 0
        ? (origin ?? "*")                                   // dev: reflect
        : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    res.header("Access-Control-Allow-Origin", allowed);
    // Let the browser expose detailed Resource Timing (TTFB / transfer size) for these
    // cross-origin (:3001) responses to the :3000 frontend — needed for client-side latency
    // breakdowns. Same allowlist semantics as CORS above.
    res.header("Timing-Allow-Origin", allowed);
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

// Finance tab — public market-data reads (cached + rate-limited) + cron warmer.
// Mounted before auth so these stay public; each route caches upstream calls.
app.use("/finance", financeRouter);

// Discover tabs (health / academic) — public, cached card feeds, same pattern as finance.
app.use("/discover", discoverRouter);

// Connectors — per-user Gmail OAuth + send. Mixed auth: the router applies `middleware` per
// route because /connectors/gmail/callback must stay PUBLIC (Google's browser redirect carries
// no auth header; identity rides in the encrypted OAuth `state`).
app.use("/connectors/gmail", gmailRouter);

// Per-user rate limit (20 req/min) — stopgap until real credits/billing. In-memory + per-instance.
const rateLimited = createRateLimiter(20, 60_000);




/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */


// Run a Tavily web search and shape the sources + images we stream back.
async function webSearch(query: string) {
    // Tavily caps search queries at 400 chars and 400s on longer ones. The user's FULL
    // prompt still goes to the LLM (no cap there) — we only trim the search string.
    const searchQuery = query.length > 400 ? query.slice(0, 400) : query;
    const response = await tavily_client.search(searchQuery, {
        // "basic" is ~1.5-2.5s faster than "advanced" and is plenty for general queries —
        // the single biggest latency win on the miss path. Bump back to "advanced" only
        // for query types that genuinely need deeper extraction.
        searchDepth: "basic",
        includeImages: true,
        // Wide net across the web (github, stackoverflow, reddit, youtube, docs…). Lower this
        // toward ~6 if you want a smaller prompt + faster first token at some breadth cost.
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


// AbortSignal that fires when the client disconnects mid-stream, so the model/tool loop stops
// burning tokens (and, for finance, vendor credits) on a response nobody will read.
function disconnectSignal(res: express.Response): AbortSignal {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    return ac.signal;
}

// The SSE/streaming response headers, centralized so the (subtle, Vercel-specific) set + flush
// stays identical across every streaming branch.
function writeStreamHeaders(res: express.Response, conversationId: string): void {
    res.setHeader("x-conversation-id", conversationId);
    res.header("Cache-Control", "no-cache");
    res.header("Content-Type", "text/event-stream");
    res.setHeader("X-Accel-Buffering", "no"); // defeat proxy/LB buffering so tokens stream
    res.flushHeaders?.();
}

const EMPTY_ANSWER_PLACEHOLDER =
    "⚠️ Sorry — I couldn't generate an answer for that. Please try rephrasing.";

// Persist both turns AFTER the client has its answer but BEFORE res.end() (on Vercel the
// instance can freeze the instant the response closes). Awaits the user turn first so its
// autoincrement id stays below the assistant turn's. If the model produced no prose, write a
// placeholder assistant turn so the thread never dangles (preserves the user/assistant
// alternation that compaction + Anthropic require).
async function persistTurns(
    persistUserTurn: Promise<unknown>,
    conversationId: string,
    fullAnswer: string,
    tail: string,
): Promise<void> {
    await persistUserTurn;
    const content = fullAnswer.trim() ? fullAnswer + tail : EMPTY_ANSWER_PLACEHOLDER;
    await prisma.message.create({ data: { content, role: "Assistant", conversationId } });
}

// FINANCE vertical: stream an agentic answer (streamText + the finance tool belt, multi-step
// loop) then the SAME <SOURCES> wire tail. Sources are collected from financeWebSearch tool
// calls during the stream, so the client renders finance answers exactly like Discover ones.
async function streamFinanceAnswer(opts: {
    res: import("express").Response;
    model: string;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ fullAnswer: string; tail: string; finishReason: string }> {
    const { tools, sources } = buildFinanceTools();
    const result = streamText({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools,
        stopWhen: stepCountIs(6), // bound tool round-trips per turn
        abortSignal: disconnectSignal(opts.res), // stop the tool loop if the client disconnects
        // Observe hook (pi "message/step end") — log which tools each step used.
        onStepFinish: (step) => {
            const used = (step.toolCalls ?? []).map((c) => c.toolName);
            if (used.length) console.log(`[finance-hook] step tools=[${used.join(",")}] finish=${step.finishReason}`);
        },
        onError: ({ error }) => console.error("finance streamText error:", error),
    });
    let fullAnswer = "";
    for await (const textPart of result.textStream) {
        fullAnswer += textPart;
        opts.res.write(textPart);
    }
    let finishReason: string;
    try {
        finishReason = await result.finishReason;
    } catch {
        finishReason = "error";
    }
    // `sources` was populated by financeWebSearch during the stream above.
    const tail = sourcesImagesTail(sources, []);
    opts.res.write(tail);
    return { fullAnswer, tail, finishReason };
}

// ASSISTANT vertical: a tool-calling agent over the user's connected Gmail (read-only in M2a).
// Same shape as streamFinanceAnswer but the tools close over `userId` so the model can only ever
// touch THIS user's mailbox. No web sources, so the <SOURCES>/<IMAGES> tail is empty.
function buildAssistantSystem(): string {
    const today = new Date().toISOString().slice(0, 10);
    return (
        "You are Lumina's assistant with secure, read-only access to the user's connected Gmail via " +
        "tools (unreadCount, listEmails, getEmail). Use them to answer questions about the user's email: " +
        "how many unread, what's new, who emailed, and to read or summarize specific messages. Workflow: " +
        "call listEmails to find messages (use a Gmail query like 'is:unread' or 'from:name' when helpful), " +
        "then getEmail by id to read one in full. Be concise and well-formatted — render lists of emails as " +
        "a markdown list showing sender, subject, and date. NEVER invent senders, subjects, or content; " +
        "report only what the tools return. If a tool returns an `error` about Gmail not being connected or " +
        "expired, tell the user to (re)connect Gmail on the Connectors page. You can READ email but cannot " +
        "SEND yet (sending is coming soon). Today is " + today + "."
    );
}

async function streamAssistantAnswer(opts: {
    res: import("express").Response;
    model: string;
    userId: string;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ fullAnswer: string; tail: string }> {
    const tools = buildGmailTools({ userId: opts.userId });
    const result = streamText({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools,
        stopWhen: stepCountIs(6), // bound tool round-trips per turn
        abortSignal: disconnectSignal(opts.res),
        onStepFinish: (step) => {
            const used = (step.toolCalls ?? []).map((c) => c.toolName);
            if (used.length) console.log(`[assistant-hook] step tools=[${used.join(",")}] finish=${step.finishReason}`);
        },
        onError: ({ error }) => console.error("assistant streamText error:", error),
    });
    let fullAnswer = "";
    for await (const textPart of result.textStream) {
        fullAnswer += textPart;
        opts.res.write(textPart);
    }
    const tail = sourcesImagesTail([], []); // assistant has no web sources/images
    opts.res.write(tail);
    return { fullAnswer, tail };
}






/* ────────────────────────────────────────────────────────────────────────
 * Vector / semantic-cache layer
 *
 * A GLOBAL cache (shared across users) of answered queries, keyed by the query's
 * embedding. On each /perplexity_ask we embed the query, look for a close-enough,
 * non-stale past row (cosine distance via pgvector's <=>) and, if found, replay it
 * instead of paying for a fresh Tavily search + LLM generation.
 *
 * Tunables:
 *  - DISTANCE_THRESHOLD: cosine distance (0 = identical, 2 = opposite) below which
 *    two queries count as the SAME question. Lower = stricter. 0.15 keeps genuine
 *    near-duplicates while keeping different queries apart — e.g. "learn React" vs
 *    "learn React Native" sit ABOVE this and correctly MISS. Tune against real logs.
 *  - CACHE_TTL_DAYS: how long a cached answer stays fresh; older rows are ignored.
 *
 * The cache is a pure optimization, so every function is FAIL-OPEN: any error makes
 * it behave as a miss/no-op and the live path runs. If the table doesn't exist yet
 * (migration not run), we disable the cache for the process to avoid log spam —
 * restart after migrating to re-enable.
 * ──────────────────────────────────────────────────────────────────────── */

const DISTANCE_THRESHOLD = 0.15;
const CACHE_TTL_DAYS = 7;
// After a real cache-INFRA error (table missing) we pause the cache for this long,
// then PROBE again — instead of the old "disable forever" latch. Lets the cache
// self-heal (e.g. table created after the server started) with no restart.
const CACHE_COOLDOWN_MS = 60_000;


// Cache availability — a short cooldown window, NOT a permanent kill-switch.
let cacheDownUntil = 0;
function cacheDown(): boolean {
    return Date.now() < cacheDownUntil;
}
function noteCacheError(where: string, e: unknown): void {
    const code = (e as { code?: string })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    // ONLY a genuine Postgres "undefined_table" (42P01) pauses the cache. We do NOT
    // free-text match "does not exist" — the AI gateway returns "model does not exist…"
    // for credential issues, which must never be mistaken for a DB problem.
    if (code === "42P01") {
        cacheDownUntil = Date.now() + CACHE_COOLDOWN_MS;
        console.warn(`[semantic-cache] table missing (${where}) — pausing ${CACHE_COOLDOWN_MS / 1000}s then retrying.`);
        return;
    }
    console.error(`[semantic-cache] ${where} failed:`, msg);
}

// Step A — turn the user query into an embedding vector (the cache key).
async function embedQuery(query: string): Promise<number[] | null> {
    if (cacheDown()) return null;
    try {
        // Bare string id → routed through the Vercel AI Gateway, like the chat models.
        const { embedding } = await embed({ model: "openai/text-embedding-3-small", value: query });
        return embedding;
    } catch (e) {
        // An embedding failure is just a cache MISS — it must NOT pause the cache.
        console.error("[semantic-cache] embedQuery failed:", e instanceof Error ? e.message : String(e));
        return null;
    }
}

// Step B — find a semantically-similar PAST query answered & cached FOR THE SAME MODEL.
async function findCachedAnswer(
    embedding: number[] | null,
    model: string,
): Promise<{ answer: string; sources: unknown; images: unknown } | null> {
    if (!embedding || cacheDown()) return null;
    try {
        const vec = `[${embedding.join(",")}]`;
        const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
        // Keyed on (embedding, model): a premium-model request must never be served a
        // budget-model's cached answer. TTL filter drops stale rows.
        const rows = await prisma.$queryRaw<
            Array<{ answer: string; sources: unknown; images: unknown; distance: number }>
        >`
            SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
            FROM cached_query
            WHERE model = ${model} AND created_at > ${cutoff}
            ORDER BY embedding <=> ${vec}::vector
            LIMIT 1
        `;
        const hit = rows[0];
        if (hit && hit.distance <= DISTANCE_THRESHOLD) {
            return { answer: hit.answer, sources: hit.sources, images: hit.images };
        }
        return null;
    } catch (e) {
        noteCacheError("findCachedAnswer", e);
        return null;
    }
}

// Step C — after a fresh, CLEANLY-FINISHED live answer, store it for future hits.
async function cacheAnswer(p: {
    query: string;
    embedding: number[] | null;
    model: string;
    answer: string;
    sources: unknown;
    images: unknown;
}): Promise<void> {
    if (!p.embedding || cacheDown()) return;
    try {
        const vec = `[${p.embedding.join(",")}]`;
        await prisma.$executeRaw`
            INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at)
            VALUES (
                ${crypto.randomUUID()},
                ${p.query},
                ${p.model},
                ${vec}::vector,
                ${p.answer},
                ${JSON.stringify(p.sources)}::jsonb,
                ${JSON.stringify(p.images)}::jsonb,
                NOW()
            )
        `;
    } catch (e) {
        noteCacheError("cacheAnswer", e);
    }
}


/* ────────────────────────────────────────────────────────────────────────
 * GET /conversations  — list the logged-in user's conversations (sidebar)
 * ──────────────────────────────────────────────────────────────────────── */
app.get("/conversations", middleware, async (req: AuthenticatedRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: "unauthorised" });

    const conversations = await prisma.conversation.findMany({
        where: { userId: req.userId },
        select: { id: true, title: true, slug: true },
        orderBy: { createdAt: "desc" }, // newest conversations at the top of the sidebar
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

    // step 2 - access control. Rate limit is a stopgap until a real credits/payment gateway.
    if (rateLimited(req.userId)) {
        return res.status(429).json({ error: "Too many requests — please slow down." });
    }

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

        // Persist the user's message WITHOUT blocking the search. We await it (via persistTurns)
        // only just before the assistant turn, so message order stays correct while this write
        // overlaps the search + LLM. The .catch makes it a non-rejecting promise so an error mid-
        // stream (which skips the await) can never become an unhandled rejection.
        const persistUserTurn = prisma.message
            .create({ data: { content: query, role: "user", conversationId: conversation.id } })
            .catch((e) => { console.error("[persist] user turn failed:", e); return null; });

        // FINANCE vertical → agentic tool-calling chat. No semantic cache and no pre-search
        // (the model fetches its own data via tools). Shares auth, persistence, streaming, and
        // the <ANSWER>/<SOURCES> wire format with Discover.
        if (req.body.vertical === "finance") {
            writeStreamHeaders(res, conversation.id);
            const { fullAnswer, tail } = await streamFinanceAnswer({
                res,
                model: resolveModel(req.body.model),
                system: buildFinanceSystem(),
                messages: [{ role: "user", content: query }],
            });
            await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
            res.end();
            return;
        }

        // ASSISTANT vertical → agentic Gmail tool-calling. No semantic cache / pre-search.
        if (req.body.vertical === "assistant") {
            writeStreamHeaders(res, conversation.id);
            const { fullAnswer, tail } = await streamAssistantAnswer({
                res,
                model: resolveModel(req.body.model),
                userId: req.userId,
                system: buildAssistantSystem(),
                messages: [{ role: "user", content: query }],
            });
            await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
            res.end();
            return;
        }

        // step 3 - SEMANTIC CACHE. Resolve the model up front (the cache is keyed on it).
        //          Skip the cache entirely for time-sensitive queries (prices/news/"today")
        //          and for requests with attachments (the answer depends on the upload).
        const model = resolveModel(req.body.model);
        const parts = buildAttachmentParts(req.body.attachments);
        const cacheable = !isTimeSensitive(query) && parts.length === 0;
        const embedding = cacheable ? await embedQuery(query) : null;
        const cached = cacheable ? await findCachedAnswer(embedding, model) : null;

        writeStreamHeaders(res, conversation.id);

        if (cached) {
            // Cache HIT — replay the stored answer (+ its sources/images) in the SAME wire
            // format as a live answer, so the client handles both identically. Skips Tavily
            // AND the LLM entirely → sub-second response. persistTurns runs BEFORE res.end()
            // (on Vercel the instance can freeze the moment the response closes).
            const tail = sourcesImagesTail(cached.sources, cached.images);
            res.write(cached.answer);
            res.write(tail);
            await persistTurns(persistUserTurn, conversation.id, cached.answer, tail);
            res.end();
            return;
        }

        // step 4 - MISS PATH: live web search to gather sources (Tavily)
        const { results, sources, images } = await webSearch(query);

        // step 5 - context engineering: classify the query, then assemble the prompt from
        // composable layers — persona + the matching task playbook (system) and the dated
        // web-results context (user). This is the "intelligence layer".
        const queryType = classifyQuery(query);
        const today = new Date().toISOString().slice(0, 10);
        const prompt = buildUserPrompt({ query, searchContext: formatSearchContext(results), date: today });

        // step 6 - hit the LLM and stream the answer back. With attachments, send a
        // multimodal user message (text + image/file parts) instead of a plain prompt.
        const userContent: string | ContentPart[] = parts.length
            ? [{ type: "text", text: prompt }, ...parts]
            : prompt;
        const result = streamText({
            model,   // resolved above; also the cache key
            system: buildSystemPrompt(queryType),
            messages: [{ role: "user", content: userContent }],
            abortSignal: disconnectSignal(res), // stop generating if the client disconnects
            // streamText swallows mid-stream errors by default — surface them
            onError: ({ error }) => console.error("streamText error:", error),
        });

        let fullAnswer = "";
        for await (const textPart of result.textStream) {
            fullAnswer += textPart;   // buffer so we can persist + cache it
            res.write(textPart);
        }
        // Did the model finish cleanly or break mid-stream? Only CLEAN answers get cached.
        let finishReason: string;
        try { finishReason = await result.finishReason; } catch { finishReason = "error"; }

        // step 7 - stream the references the answer cited + any images from the search
        const tail = sourcesImagesTail(sources, images);
        res.write(tail);

        // step 8 - persist BEFORE closing. On Vercel the instance can freeze the instant the
        //          response ends, so post-end DB writes (history + cache) may never run.
        await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
        // Cache ONLY a complete answer for a cacheable query — never replay a truncated/errored
        // answer (or a time-sensitive one) for the whole TTL.
        if (cacheable && finishReason === "stop" && fullAnswer.trim()) {
            await cacheAnswer({ query, embedding, model, answer: fullAnswer, sources, images });
        }

        // step 9 - close the stream
        res.end();
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
    if (rateLimited(req.userId)) {
        return res.status(429).json({ error: "Too many requests — please slow down." });
    }

    try {
        // step 1 - get the existing chat from the DB (ownership-checked), oldest message first
        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, userId: req.userId },
            include: { messages: { orderBy: { id: "asc" } } },
        });
        if (!conversation) return res.status(404).json({ error: "Conversation not found" });

        // Persist the new user turn WITHOUT blocking. History below is built from the already-
        // stored turns, so this isn't needed until the assistant reply. The .catch makes it non-
        // rejecting so a mid-stream error that skips the await can't become an unhandled rejection.
        const persistUserTurn = prisma.message
            .create({ data: { content: query, role: "user", conversationId: conversation.id } })
            .catch((e) => { console.error("[persist] user turn failed:", e); return null; });

        // FINANCE vertical → agentic tool-calling follow-up. Reuse compaction for history,
        // but skip the web pre-search (the model fetches what it needs via tools).
        if (req.body.vertical === "finance") {
            const { summary, history } = await buildConversationHistory(conversation.messages);
            const system = summary
                ? `${buildFinanceSystem()}\n\n## Earlier conversation (summary of older turns)\n${summary}`
                : buildFinanceSystem();
            writeStreamHeaders(res, conversation.id);
            const { fullAnswer, tail } = await streamFinanceAnswer({
                res,
                model: resolveModel(req.body.model),
                system,
                messages: [...history, { role: "user" as const, content: query }],
            });
            await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
            res.end();
            return;
        }

        // ASSISTANT vertical → agentic Gmail tool-calling follow-up (compacted history, no pre-search).
        if (req.body.vertical === "assistant") {
            const { summary, history } = await buildConversationHistory(conversation.messages);
            const system = summary
                ? `${buildAssistantSystem()}

## Earlier conversation (summary of older turns)
${summary}`
                : buildAssistantSystem();
            writeStreamHeaders(res, conversation.id);
            const { fullAnswer, tail } = await streamAssistantAnswer({
                res,
                model: resolveModel(req.body.model),
                userId: req.userId,
                system,
                messages: [...history, { role: "user" as const, content: query }],
            });
            await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
            res.end();
            return;
        }

        // step 2 - build bounded context (compaction) AND fetch fresh sources, concurrently.
        // Compaction strips UI blobs, keeps the last few turns verbatim, and summarizes older
        // ones — so token cost stays flat no matter how long the thread gets.
        const [{ summary, history }, { results, sources, images }] = await Promise.all([
            buildConversationHistory(conversation.messages),
            webSearch(query),
        ]);

        const today = new Date().toISOString().slice(0, 10);
        const augmentedQuery = buildUserPrompt({ query, searchContext: formatSearchContext(results), date: today });

        // step 3 - forward the (compacted) history + the augmented new query to the LLM
        writeStreamHeaders(res, conversation.id);

        const followUpParts = buildAttachmentParts(req.body.attachments);
        const followUpContent: string | ContentPart[] = followUpParts.length
            ? [{ type: "text", text: augmentedQuery }, ...followUpParts]
            : augmentedQuery;
        // Put the summary of older turns in the SYSTEM prompt (keeps `messages` a clean
        // user/assistant alternation).
        const baseSystem = buildSystemPrompt(classifyQuery(query));
        const system = summary
            ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}`
            : baseSystem;
        const result = streamText({
            model: resolveModel(req.body.model),
            system,
            messages: [...history, { role: "user" as const, content: followUpContent }],
            abortSignal: disconnectSignal(res), // stop generating if the client disconnects
            onError: ({ error }) => console.error("streamText error:", error),
        });

        // step 4 - stream the response to the user
        let fullAnswer = "";
        for await (const textPart of result.textStream) {
            fullAnswer += textPart;
            res.write(textPart);
        }
        const tail = sourcesImagesTail(sources, images);
        res.write(tail);

        // persist BEFORE closing (on Vercel the instance can freeze the instant the response ends)
        await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);
        res.end();
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
    app.listen(PORT, () => {
        console.log(`backend listening on http://localhost:${PORT}`);
        // Warm the finance cache on startup so the FIRST user fetch hits a populated cache (no
        // empty-cache cold window). Fire-and-forget; reads serve stale-while-revalidate meanwhile.
        // On Vercel there's no persistent listen — the cron route (cron-job.org) does this instead.
        void warmFinanceCache()
            .then((r) => console.log(`[warm] finance cache: ${r.filter((x) => x.ok).length}/${r.length} keys warmed`))
            .catch((e) => console.warn('[warm] finance warm failed:', e instanceof Error ? e.message : e));
    });
}

export default app;
