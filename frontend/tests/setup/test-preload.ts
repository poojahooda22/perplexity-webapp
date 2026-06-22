// FIRST test preload (see bunfig.toml [test].preload order). Two jobs, both BEFORE any test
// module imports the data layer:
//   1. Stabilize BUN_PUBLIC_* env so any code that still reaches the real client/config is sane.
//   2. Replace the real Supabase client with the controllable fake, so importing @/lib/supabase
//      (which otherwise throws without creds) is safe and tests can drive auth + realtime.
import { mock } from "bun:test";
import * as supabaseFake from "../helpers/supabase-fake";

process.env.BUN_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.BUN_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.BUN_PUBLIC_BACKEND_URL ||= "http://localhost:3001";

// Relative specifier resolves to frontend/src/lib/supabase.ts — the SAME absolute module that
// `@/lib/supabase` and api.ts's `./supabase` resolve to, so this one mock covers every importer.
mock.module("../../src/lib/supabase", () => supabaseFake);
