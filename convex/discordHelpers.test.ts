import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLockedSlotSnapshot,
  buildSummaryMessage,
  discordMessageMatchesSchedule,
  DiscordApiError,
  exchangeDiscordOAuthCode,
  findPinnedScheduleMessage,
  fetchDiscordCurrentUser,
  fetchGuildChannels,
  getDiscordNewMessageAfterMs,
  getMissingDiscordInstallConfiguration,
  postChannelMessage,
  shouldPostNewDiscordMessage,
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

    const payload = buildSummaryMessage(input, "will-update");
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("Bob");
    expect(rendered).toContain("America/New_York");
    expect(rendered).toContain("Will update");
    expect(JSON.stringify(buildSummaryMessage(input, "one-time"))).toContain(
      "One time message",
    );
  });
});

describe("Discord pinned schedule messages", () => {
  it("recognises only this app's schedule embeds", () => {
    vi.stubEnv("DISCORD_APP_ID", "when-app");
    expect(
      discordMessageMatchesSchedule(
        {
          id: "message",
          author: { id: "when-app", bot: true },
          embeds: [{ url: "https://when.example/schedule/schedule-1" }],
        },
        "schedule-1",
      ),
    ).toBe(true);
    expect(
      discordMessageMatchesSchedule(
        {
          id: "message",
          author: { id: "another-bot", bot: true },
          embeds: [{ url: "https://when.example/schedule/schedule-1" }],
        },
        "schedule-1",
      ),
    ).toBe(false);
  });

  it("keeps the current update target when it is pinned", async () => {
    vi.stubEnv("DISCORD_APP_ID", "when-app");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "current-message",
          pinned: true,
          author: { id: "when-app", bot: true },
          embeds: [{ url: "https://when.example/schedule/schedule-1" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findPinnedScheduleMessage("channel", "schedule-1", "current-message"),
    ).resolves.toEqual(expect.objectContaining({ id: "current-message" }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the most recently pinned matching summary when the current target is unpinned", async () => {
    vi.stubEnv("DISCORD_APP_ID", "when-app");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "current-message",
            pinned: false,
            author: { id: "when-app", bot: true },
            embeds: [{ url: "https://when.example/schedule/schedule-1" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                pinned_at: "2026-08-01T00:00:00.000Z",
                message: {
                  id: "pinned-message",
                  pinned: true,
                  author: { id: "when-app", bot: true },
                  embeds: [
                    { url: "https://when.example/schedule/schedule-1" },
                  ],
                },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      findPinnedScheduleMessage("channel", "schedule-1", "current-message"),
    ).resolves.toEqual(expect.objectContaining({ id: "pinned-message" }));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/channels/channel/messages/pins?limit=50",
    );
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

describe("Discord OAuth identity", () => {
  it("returns the exchanged access token", async () => {
    vi.stubEnv("DISCORD_APP_ID", "app");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "user-token" }), {
          status: 200,
        }),
      ),
    );

    await expect(
      exchangeDiscordOAuthCode("code", "https://example.com/callback"),
    ).resolves.toBe("user-token");
  });

  it("loads the authorizing Discord user with the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "discord-user", username: "lee" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDiscordCurrentUser("user-token")).resolves.toEqual({
      id: "discord-user",
      username: "lee",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      { headers: { Authorization: "Bearer user-token" } },
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

describe("Discord message refresh policy", () => {
  it("defaults to six hours and accepts a deployment override", () => {
    vi.stubEnv("DISCORD_NEW_MESSAGE_AFTER_MS", "");
    expect(getDiscordNewMessageAfterMs()).toBe(6 * 60 * 60 * 1000);
    vi.stubEnv("DISCORD_NEW_MESSAGE_AFTER_MS", "3600000");
    expect(getDiscordNewMessageAfterMs()).toBe(60 * 60 * 1000);
    vi.stubEnv("DISCORD_NEW_MESSAGE_AFTER_MS", "-1");
    expect(getDiscordNewMessageAfterMs()).toBe(-1);
  });

  it("posts a new message only after the configured age", () => {
    const now = 10 * 60 * 60 * 1000;
    expect(
      shouldPostNewDiscordMessage(
        now - 7 * 60 * 60 * 1000,
        6 * 60 * 60 * 1000,
        now,
      ),
    ).toBe(true);
    expect(
      shouldPostNewDiscordMessage(
        now - 5 * 60 * 60 * 1000,
        6 * 60 * 60 * 1000,
        now,
      ),
    ).toBe(false);
    expect(shouldPostNewDiscordMessage(now - 7, 0, now)).toBe(false);
    expect(shouldPostNewDiscordMessage(now - 7, -1, now)).toBe(false);
  });
});
