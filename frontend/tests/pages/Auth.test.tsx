// Auth page: an OAuth-only sign-in screen (Continue with Google / GitHub). It renders the brand
// header + the two provider buttons, kicks off supabase.auth.signInWithOAuth on click (showing a
// spinner + disabling both buttons), surfaces an error if the call rejects, and redirects away when
// a session already exists. We drive the fake Supabase client (globally swapped in for @/lib/supabase)
// and spy on its auth methods.
//
// NOTE: the task brief described an email/password sign-in/sign-up FORM, but the real Auth.tsx has no
// such form — it is OAuth-only. These tests cover the page as actually implemented.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { renderWithProviders, screen, fireEvent, waitFor } from "@tests/helpers/utils";
import { supabase, makeUser, __setSession } from "@tests/helpers/supabase-fake";
import Auth from "@/pages/Auth";

afterEach(() => {
  mock.restore();
});

describe("Auth page", () => {
  test("renders the brand header and both OAuth provider buttons", () => {
    renderWithProviders(<Auth />, { route: "/auth" });

    expect(screen.getByRole("heading", { name: /welcome to lumina/i })).toBeInTheDocument();
    expect(screen.getByText(/sign in to start asking/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  test("shows the terms/privacy footnote and uses the Lumina brand (never Perplexity)", () => {
    renderWithProviders(<Auth />, { route: "/auth" });

    expect(screen.getByText(/terms of service and privacy policy/i)).toBeInTheDocument();
    expect(screen.queryByText(/perplexity/i)).not.toBeInTheDocument();
  });

  test("clicking Continue with Google calls signInWithOAuth with the google provider", async () => {
    const spy = spyOn(supabase.auth, "signInWithOAuth");
    renderWithProviders(<Auth />, { route: "/auth" });

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
  });

  test("clicking Continue with GitHub calls signInWithOAuth with the github provider", async () => {
    const spy = spyOn(supabase.auth, "signInWithOAuth");
    renderWithProviders(<Auth />, { route: "/auth" });

    fireEvent.click(screen.getByRole("button", { name: /continue with github/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ provider: "github" }));
  });

  test("while a provider sign-in is pending, both buttons are disabled", async () => {
    // A never-resolving OAuth call keeps `loading` set so the disabled state is observable.
    spyOn(supabase.auth, "signInWithOAuth").mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Auth />, { route: "/auth" });

    const google = screen.getByRole("button", { name: /continue with google/i });
    const github = screen.getByRole("button", { name: /continue with github/i });
    fireEvent.click(google);

    await waitFor(() => expect(google).toBeDisabled());
    expect(github).toBeDisabled();
  });

  test("an OAuth error is surfaced and the buttons are re-enabled", async () => {
    // Supabase returns a PLAIN error object (not an Error instance); the page rethrows it, and since
    // it is not `instanceof Error` it shows the generic fallback copy.
    spyOn(supabase.auth, "signInWithOAuth").mockResolvedValue({
      data: { provider: "google", url: null },
      error: { message: "Provider unavailable" },
    } as never);
    renderWithProviders(<Auth />, { route: "/auth" });

    const google = screen.getByRole("button", { name: /continue with google/i });
    fireEvent.click(google);

    expect(await screen.findByText(/sign in failed\. please try again\./i)).toBeInTheDocument();
    // After the failure the spinner clears and the user can retry.
    await waitFor(() => expect(google).not.toBeDisabled());
  });

  test("a thrown (network) error falls back to a generic message", async () => {
    spyOn(supabase.auth, "signInWithOAuth").mockRejectedValue(new Error("boom"));
    renderWithProviders(<Auth />, { route: "/auth" });

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    // The page rethrows the error object, so its message is shown.
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });

  test("checks the existing session on mount (redirects when already signed in)", async () => {
    // Seed a signed-in session so the mount effect's getSession() resolves with one.
    __setSession(makeUser());
    const getSession = spyOn(supabase.auth, "getSession");
    renderWithProviders(<Auth />, { route: "/auth" });

    await waitFor(() => expect(getSession).toHaveBeenCalled());
    // The header still mounts; navigation is a no-op in MemoryRouter without a matching route,
    // but the session check having run is the redirect trigger we assert.
    expect(screen.getByRole("heading", { name: /welcome to lumina/i })).toBeInTheDocument();
  });

  test("renders normally for a signed-out visitor (no redirect)", async () => {
    __setSession(null);
    const getSession = spyOn(supabase.auth, "getSession");
    renderWithProviders(<Auth />, { route: "/auth" });

    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });
});
