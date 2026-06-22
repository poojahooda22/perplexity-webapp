// Shared test helpers: render components / hooks inside the app's REAL providers (Theme, Query,
// Router, and optionally the real AuthProvider driven by the fake Supabase session). Auth is
// included only when a `user` is passed — pure UI components omit it and skip the provider.
import type { ReactElement, ReactNode } from "react";
import { render, renderHook, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { User } from "@supabase/supabase-js";

import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth-context";
import { __setSession } from "@tests/helpers/supabase-fake";

// Fresh client per render: retries off + no cache carry-over, so a failing query rejects
// immediately instead of stalling the test through the retry/backoff window.
function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface ProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** Initial router entry. Defaults to "/". */
  route?: string;
  /** Override the QueryClient (e.g. to seed cache). Defaults to a fresh retry-off client. */
  queryClient?: QueryClient;
  /**
   * Seed the signed-in user. Provide a User (or null for signed-out) to mount the REAL
   * AuthProvider with that session. Omit entirely to skip AuthProvider (pure components).
   */
  user?: User | null;
}

function buildWrapper(route: string, queryClient: QueryClient, withAuth: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const routed = <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
    const maybeAuth = withAuth ? <AuthProvider>{routed}</AuthProvider> : routed;
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>{maybeAuth}</QueryClientProvider>
      </ThemeProvider>
    );
  };
}

/** Render `ui` in ThemeProvider → QueryClient → MemoryRouter (+ AuthProvider when `user` is set). */
export function renderWithProviders(
  ui: ReactElement,
  { route = "/", queryClient = makeTestQueryClient(), user, ...options }: ProvidersOptions = {},
) {
  const withAuth = user !== undefined;
  if (withAuth) __setSession(user ?? null);
  const Wrapper = buildWrapper(route, queryClient, withAuth);
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

/** renderHook variant wrapped in the same providers — for testing hooks (useCrypto, etc.). */
export function renderHookWithProviders<Result>(
  hook: () => Result,
  { route = "/", queryClient = makeTestQueryClient(), user }: ProvidersOptions = {},
) {
  const withAuth = user !== undefined;
  if (withAuth) __setSession(user ?? null);
  const Wrapper = buildWrapper(route, queryClient, withAuth);
  return { queryClient, ...renderHook(hook, { wrapper: Wrapper }) };
}

// One import site for tests: RTL (screen/fireEvent/waitFor/within/act) + the mock controls.
export * from "@testing-library/react";
export { mockFetch, restoreFetch, type MockResponse, type Routes } from "@tests/helpers/fetch-mock";
export { __setSession, __reset, makeUser } from "@tests/helpers/supabase-fake";
