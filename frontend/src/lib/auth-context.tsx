import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { User } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";

interface AuthState {
  /** The signed-in user, or null when signed out. Same reference across token refreshes. */
  user: User | null;
  /** True until the initial session check resolves. */
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

/**
 * App-wide auth. Reads the Supabase session ONCE and subscribes to changes a single time,
 * so pages don't each re-run getSession()/onAuthStateChange (the old per-page duplication in
 * Dashboard + Connectors). The session itself lives in the Supabase client singleton +
 * localStorage; this provider just mirrors it into React.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // Initial check — a cheap LOCAL read (not a network re-auth).
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // onAuthStateChange re-fires on token refresh / tab refocus with a NEW user object each
    // time. Keep the SAME reference when the identity hasn't changed, so downstream effects /
    // query keys keyed on user.id don't churn.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.user ?? null;
      setUser((prev) => (prev?.id === next?.id ? prev : next));
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(() => ({ user, loading }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Read the current auth state. */
export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Gate a page on auth: once the session check has resolved and there's no user, redirect to
 * /auth. Returns { user, loading } so the page can render a spinner until ready.
 */
export function useRequireAuth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate("/auth");
  }, [loading, user, navigate]);

  return { user, loading };
}