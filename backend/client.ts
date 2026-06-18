import { createClient } from "@supabase/supabase-js";


export function createSupabaseClient() {
    return createClient(
        "https://rgwdybuczqcoenmxmosd.supabase.co",
        process.env.SUPABASE_API_SECRET!
    );
}