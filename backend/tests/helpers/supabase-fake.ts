import type { SupabaseClient, User } from "@supabase/supabase-js";

// Controllable fake Supabase admin client. `createSupabaseClient()` (mocked over the real one in
// preload) returns a client whose auth.getUser(token) yields whatever __setUser last set.
let currentUser: User | null = null;
let getUserError: unknown = null;

export function __setUser(u: User | null) {
  currentUser = u;
  getUserError = null;
}

/** Make getUser reject (network/credential failure path). */
export function __setGetUserError(e: unknown) {
  getUserError = e;
}

export function resetSupabase() {
  currentUser = null;
  getUserError = null;
}

/** A realistic Supabase user; override any field. */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-123",
    email: "test@example.com",
    aud: "authenticated",
    app_metadata: { provider: "google" },
    user_metadata: { full_name: "Test User" },
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as User;
}

export function createSupabaseClient(): SupabaseClient {
  return {
    auth: {
      getUser: async (_token: string) => {
        if (getUserError) throw getUserError;
        return { data: { user: currentUser }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}