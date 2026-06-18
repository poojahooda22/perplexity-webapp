import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.BUN_PUBLIC_SUPABASE_URL || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = process.env.BUN_PUBLIC_SUPABASE_ANON_KEY || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_ANON_KEY);

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Supabase URL and Anon Key must be provided in environment variables.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
