// Controllable fake for `@/lib/supabase`, installed globally via test-preload.ts (mock.module).
// The real module throws at import unless env is set AND would create a live client; this fake
// lets the app's REAL AuthProvider, api.ts authHeader, and useLivePrices run offline while tests
// drive the session. Tests import __setSession/makeUser/__reset from here to control it.
import type { User } from "@supabase/supabase-js";

export interface FakeSession {
  access_token: string;
  user: User;
}

type AuthListener = (event: string, session: FakeSession | null) => void;

let session: FakeSession | null = null;
const listeners = new Set<AuthListener>();

/** Build a minimal Supabase User for tests. */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "test-user-id",
    email: "tester@example.com",
    app_metadata: {},
    user_metadata: { name: "Test User" },
    aud: "authenticated",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  } as User;
}

/** Seed (or clear) the signed-in user. Pass a User to sign in, null to sign out. */
export function __setSession(user: User | null, token = "test-token"): void {
  session = user ? { access_token: token, user } : null;
  for (const cb of listeners) cb(user ? "SIGNED_IN" : "SIGNED_OUT", session);
}

/** Reset all auth state + listeners. Called from the global afterEach. */
export function __reset(): void {
  session = null;
  listeners.clear();
}

// Realtime channel stub for useLivePrices: `.on()` is chainable, `.subscribe(cb)` reports SUBSCRIBED.
function makeChannel() {
  const channel = {
    on: () => channel,
    subscribe: (cb?: (status: string) => void) => {
      cb?.("SUBSCRIBED");
      return channel;
    },
    unsubscribe: async () => ({ error: null }),
    send: async () => ({ error: null }),
  };
  return channel;
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
    onAuthStateChange: (cb: AuthListener) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    signOut: async () => {
      __setSession(null);
      return { error: null };
    },
    signInWithPassword: async () => ({ data: { session, user: session?.user ?? null }, error: null }),
    signUp: async () => ({ data: { session, user: session?.user ?? null }, error: null }),
    signInWithOAuth: async () => ({ data: { provider: "google", url: "http://localhost/oauth" }, error: null }),
    resend: async () => ({ data: {}, error: null }),
  },
  channel: (_name: string) => makeChannel(),
  removeChannel: (_ch: unknown) => {},
  from: () => ({ select: async () => ({ data: [], error: null }) }),
};
