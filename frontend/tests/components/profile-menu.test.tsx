// Pure component: <ProfileMenu/> takes user + onSignOut as props (no AuthProvider needed; it only
// consumes ThemeProvider + Router, both supplied by renderWithProviders). The Radix dropdown portals
// into document.body, so menu items are queried via screen.* after clicking the trigger.
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent, waitFor, makeUser } from "@tests/helpers/utils";
import { ProfileMenu } from "@/components/profile-menu";

// Open the Radix dropdown trigger. Radix reacts to a pointerdown; happy-dom needs it dispatched
// explicitly, then a click to settle the open state.
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("ProfileMenu", () => {
  test("shows the user's name and avatar initial on the trigger", () => {
    const user = makeUser({ email: "tester@example.com", user_metadata: { name: "Ada Lovelace" } });
    renderWithProviders(<ProfileMenu user={user} onSignOut={mock()} />);

    // Name is visible in the (expanded) trigger label.
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // Avatar fallback shows the initials (image never loads in happy-dom).
    expect(screen.getByText("AL")).toBeInTheDocument();
    // Accessible trigger name reflects the user.
    expect(screen.getByRole("button", { name: "Open user menu for Ada Lovelace" })).toBeInTheDocument();
  });

  test("derives the name from the email local-part when no metadata name is set", () => {
    const user = makeUser({ email: "tester@example.com", user_metadata: {} });
    renderWithProviders(<ProfileMenu user={user} onSignOut={mock()} />);

    // name falls back to email.split("@")[0] = "tester"; initials "TE".
    expect(screen.getByText("tester")).toBeInTheDocument();
    expect(screen.getByText("TE")).toBeInTheDocument();
  });

  test("opening the menu reveals the account details and the Sign out item", async () => {
    const user = makeUser({ email: "tester@example.com", user_metadata: { name: "Ada Lovelace" } });
    renderWithProviders(<ProfileMenu user={user} onSignOut={mock()} />);

    openMenu(screen.getByRole("button", { name: /open user menu/i }));

    // The portaled content shows the email and the menu entries.
    expect(await screen.findByText("tester@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /connectors/i })).toBeInTheDocument();
    // Appearance theme toggles are present.
    expect(screen.getByRole("menuitem", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /dark/i })).toBeInTheDocument();
  });

  test("clicking Sign out invokes onSignOut", async () => {
    const onSignOut = mock();
    const user = makeUser({ email: "tester@example.com", user_metadata: { name: "Ada Lovelace" } });
    renderWithProviders(<ProfileMenu user={user} onSignOut={onSignOut} />);

    openMenu(screen.getByRole("button", { name: /open user menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));

    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
  });

  test("collapsed hides the name label but keeps an accessible trigger", () => {
    const user = makeUser({ email: "tester@example.com", user_metadata: { name: "Ada Lovelace" } });
    renderWithProviders(<ProfileMenu user={user} onSignOut={mock()} collapsed />);

    // In collapsed mode the visible name span + chevron are not rendered (the avatar remains).
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByText("AL")).toBeInTheDocument();
    // The trigger is still reachable by its aria-label.
    expect(screen.getByRole("button", { name: "Open user menu for Ada Lovelace" })).toBeInTheDocument();
  });

  test("expanded (default) renders the visible name label", () => {
    const user = makeUser({ email: "tester@example.com", user_metadata: { name: "Ada Lovelace" } });
    renderWithProviders(<ProfileMenu user={user} onSignOut={mock()} collapsed={false} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });
});
