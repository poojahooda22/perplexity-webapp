import { createClient } from "@supabase/supabase-js";

// URL comes from env (falls back to the project URL for local dev). NOTE: confirm which
// key SUPABASE_API_SECRET holds — if it's the service-role key it bypasses row-level
// security, so this client must only ever be used for auth/token verification (as it is
// today), never for user-facing data queries.
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://rgwdybuczqcoenmxmosd.supabase.co";

export function createSupabaseClient() {
    return createClient(SUPABASE_URL, process.env.SUPABASE_API_SECRET!);
}