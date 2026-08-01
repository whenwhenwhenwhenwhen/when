import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLockedSlotSnapshot,
  buildSummaryMessage,
  DiscordApiError,
  fetchGuildChannels,
  getMissingDiscordInstallConfiguration,
  postChannelMessage,
  SummaryInput,
} from "./discordHelpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Discord schedule summaries across timezones", () => {
  const input: SummaryInput = {
    schedule: {
      _id: "schedule",
      title: "Timezone summary",
      type: "recurring",
      creatorTimezone: "America/New_York",
      lockedSlots: [{ dayKey: "1", timeSlot: "09:00" }],
      isLocked: true,
    },
    profileNames: {
      alice: "Alice",
      bob: "Bob",
      charlie: "Charlie",
    },
    selections: [
      {
        profileId: "alice",
        dayKey: "1",
        timeSlot: "09:00",
        timezone: "America/New_York",
        state: "can-do",
      },
      {
        profileId: "bob",
        dayKey: "1",
        timeSlot: "23:00",
        timezone: "Australia/Melbourne",
        state: "maybe",
      },
      {
        profileId: "charlie",
        dayKey: "1",
        timeSlot: "09:00",
        timezone: "Australia/Melbourne",
        state: "cant-do",
      },
    ],
    referenceDate: "2026-07-29",
    appBaseUrl: "https://example.com",
  };

  it("matches and tallies nominations in the schedule timezone", () => {
    const snapshot = buildLockedSlotSnapshot(input);
    expect(snapshot).toContain("alice:can-do");
    expect(snapshot).toContain("bob:maybe");
    expect(snapshot).not.toContain("charlie:cant-do");

    const payload = buildSummaryMessage(input);
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("Bob");
    expect(rendered).toContain("America/New_York");
  });
});

describe("Discord REST failures", () => {
  it("surfaces a rejected initial message instead of returning false success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 50013, message: "Missing Permissions" }),
          { status: 403 },
        ),
      ),
    );

    await expect(postChannelMessage("channel", { embeds: [] })).rejects.toEqual(
      expect.objectContaining<Partial<DiscordApiError>>({
        status: 403,
        code: 50013,
      }),
    );
  });

  it("surfaces guild-channel fetch failures to the install callback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 0, message: "401: Unauthorized" }),
          { status: 401 },
        ),
      ),
    );

    await expect(fetchGuildChannels("guild")).rejects.toEqual(
      expect.objectContaining<Partial<DiscordApiError>>({ status: 401 }),
    );
  });
});

describe("Discord install configuration", () => {
  it("reports every missing backend credential without exposing its value", () => {
    vi.stubEnv("DISCORD_APP_ID", "");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    expect(getMissingDiscordInstallConfiguration()).toEqual([
      "DISCORD_APP_ID",
      "DISCORD_CLIENT_SECRET",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("is ready when all callback credentials are present", () => {
    vi.stubEnv("DISCORD_APP_ID", "app");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "secret");
    vi.stubEnv("DISCORD_BOT_TOKEN", "token");

    expect(getMissingDiscordInstallConfiguration()).toEqual([]);
  });
});
