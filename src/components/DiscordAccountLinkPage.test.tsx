// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordAccountLinkPage } from "./DiscordAccountLinkPage";

const mocks = vi.hoisted(() => ({
  completeLink: vi.fn(),
  navigate: vi.fn(),
  session: {
    discordUsername: "discord-user",
    expiresAt: Date.now() + 15 * 60 * 1000,
  } as { discordUsername?: string; expiresAt: number } | null,
  profile: {
    _id: "profile-id",
    displayName: "When User",
  } as { _id: string; displayName: string } | null,
}));

vi.mock("convex/react", () => ({
  useMutation: () => mocks.completeLink,
  useQuery: (_reference: unknown, args: unknown) => {
    if (
      typeof args === "object" &&
      args !== null &&
      "sessionToken" in args
    ) {
      return mocks.session;
    }
    return mocks.profile;
  },
}));

vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../hooks/useAnonymousUser", () => ({
  useAnonymousUser: () => ({ anonymousId: "anonymous-id" }),
}));

vi.mock("../lib/googleAuth", () => ({
  useGoogleAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

vi.mock("./Header", () => ({ Header: () => null }));

describe("DiscordAccountLinkPage", () => {
  beforeEach(() => {
    mocks.completeLink.mockReset();
    mocks.navigate.mockReset();
    mocks.session = {
      discordUsername: "discord-user",
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    mocks.profile = { _id: "profile-id", displayName: "When User" };
    window.history.replaceState({}, "", "/discord/link-account?token=token");
  });

  it("confirms the active When profile before linking", async () => {
    mocks.completeLink.mockResolvedValue({ ok: true });
    render(<DiscordAccountLinkPage />);

    expect(screen.getByText(/@discord-user/)).toBeTruthy();
    expect(screen.getByText("When User")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Link accounts" }));

    await waitFor(() =>
      expect(mocks.completeLink).toHaveBeenCalledWith({
        sessionToken: "token",
        anonymousId: "anonymous-id",
      }),
    );
    expect(screen.getByText("Discord account linked")).toBeTruthy();
  });

  it("explains how to request a replacement for an expired link", () => {
    mocks.session = null;
    render(<DiscordAccountLinkPage />);

    expect(screen.getByText("Discord link expired")).toBeTruthy();
    expect(screen.getByText(/Run \/when in Discord/)).toBeTruthy();
  });
});
