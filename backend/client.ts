import { createClient } from "@supabase/supabase-js";

// URL comes from env (falls back to the project URL for local dev). NOTE: confirm which
// key SUPABASE_API_SECRET holds — if it's the service-role key it bypasses row-level
// security, so this client must only ever be used for auth/token verification (as it is
// today), never for user-facing data queries.
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://rgwdybuczqcoenmxmosd.supabase.co";

export function createSupabaseClient() {
    // This client is ONLY used for auth.getUser(token) — validating a user's JWT. Either the
    // service-role key (SUPABASE_API_SECRET) or the anon key (SUPABASE_KEY) authenticates that
    // call, so accept whichever the environment provides. (We never query user data through this
    // client — Prisma owns DB access — so the service key's RLS-bypass isn't needed here.)
    const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY;
    if (!key) {
        throw new Error(
            "Supabase key missing: set SUPABASE_API_SECRET (service role) or SUPABASE_KEY (anon) in the environment",
        );
    }
    return createClient(SUPABASE_URL, key);
}