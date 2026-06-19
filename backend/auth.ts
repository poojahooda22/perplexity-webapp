import type { Request, Response, NextFunction } from "express";
import { createSupabaseClient } from "./client";
import { prisma } from "./db";

const client = createSupabaseClient();

export interface AuthenticatedRequest extends Request {
    userId?: string;
}

// Auth still runs on EVERY request (correct — like Perplexity). What we remove is
// the per-request *cost*: two caches keep the same token from hitting Supabase and
// the same user from being re-provisioned on every search.

// token -> userId, valid for a short TTL. A repeat request within the window skips
// the network call to Supabase entirely. Short TTL keeps revocation reasonably fast.
// (In-memory: cleared on restart. Good enough for this project; swap for Redis later.)
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const tokenCache = new Map<string, { userId: string; expiresAt: number }>();

// Users we've already mirrored into our DB this process — the upsert is idempotent,
// so it only needs to run once, not on every request.
const provisionedUsers = new Set<string>();

export async function middleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "unauthorised" });

    // Fast path: token validated recently -> no Supabase call, no DB write.
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
        req.userId = cached.userId;
        return next();
    }

    // Slow path: validate the token with Supabase (first request, or after TTL).
    const data = await client.auth.getUser(token);
    const user = data.data.user;
    if (!user) return res.status(401).json({ error: "unauthorised" });

    // Provision the user row once per process (idempotent upsert; skip the DB
    // round trip when we've already done it).
    if (!provisionedUsers.has(user.id)) {
        try {
            await prisma.user.upsert({
                where: { email: user.email! },
                update: {},
                create: {
                    id: user.id,
                    email: user.email!,
                    provider: user.app_metadata.provider === "google" ? "Google" : "Github",
                    // full_name can be missing for some providers; fall back to email
                    // so the required `name` column never gets undefined.
                    name: user.user_metadata.full_name ?? user.email!,
                    supabaseId: user.id,
                },
            });
            provisionedUsers.add(user.id);
        } catch (e) {
            // Fail loudly: if we can't ensure the user row exists, downstream writes
            // (conversation/message FKs) would fail confusingly two steps later. Don't
            // cache the token or continue — surface it here.
            console.error("[auth] user provisioning failed:", e);
            return res.status(500).json({ error: "Could not provision user" });
        }
    }

    tokenCache.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL_MS });
    req.userId = user.id;
    next();
}
