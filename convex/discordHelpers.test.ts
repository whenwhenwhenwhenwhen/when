import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordDstNotice,
  buildDiscordProjectionSnapshot,
  buildLockedSlotSnapshot,
  buildSummaryMessage,
  deleteChannelMessage,
  discordMessageMatchesSchedule,
  DiscordApiError,
  exchangeDiscordOAuthCode,
  findPinnedScheduleMessage,
  fetchDiscordCurrentUser,
  fetchGuildChannels,
  getDiscordNewMessageAfterMs,
  getDiscordRetryDelayMs,
  getMissingDiscordInstallConfiguration,
  postChannelMessage,
  shouldPostNewDiscordMessage,
  verifyDiscordSignature,
  DISCORD_SIGNATURE_TOLERANCE_MS,
  SummaryInput,
} from "./discordHelpers";

afterEach(() => {
  vi.useRealTimers();
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
    expect(rendered).toContain("<t:");
    expect(rendered).toContain("Times display in your Discord timezone");
    expect(rendered).toContain("Will update");
    expect(JSON.stringify(buildSummaryMessage(input, "one-time"))).toContain(
      "One time message",
    );
  });

  it("groups contiguous half-hour cells into localized Discord time blocks", () => {
    const payload = buildSummaryMessage(
      {
        ...input,
        schedule: {
          ...input.schedule,
          lockedSlots: [
            { dayKey: "1", timeSlot: "09:00" },
            { dayKey: "1", timeSlot: "09:30" },
            { dayKey: "1", timeSlot: "10:00" },
          ],
        },
        selections: [
          ...input.selections.filter((selection) => selection.profileId !== "alice"),
          ...["09:00", "09:30", "10:00"].map((timeSlot) => ({
            profileId: "alice",
            dayKey: "1",
            timeSlot,
            timezone: "America/New_York",
            state: "can-do" as const,
          })),
        ],
      },
      "will-update",
    );
    const fields = (
      payload.embeds as Array<{
        fields: Array<{ name: string; value: string }>;
      }>
    )[0].fields;
    const locked = fields.find((field) => field.name === "Locked-in times");
    expect(locked?.value.match(/🔒/g)).toHaveLength(1);
    expect(locked?.value.match(/<t:/g)).toHaveLength(2);
    expect(locked?.value).toContain("Alice");
  });

  it("detects an upcoming participant DST shift and displaced availability", () => {
    const dstInput: SummaryInput = {
      schedule: {
        _id: "dst-schedule",
        title: "DST schedule",
        type: "recurring",
        creatorTimezone: "UTC",
        lockedSlots: [{ dayKey: "1", timeSlot: "13:00" }],
      },
      profileNames: { alice: "Alice" },
      selections: [
        {
          profileId: "alice",
          dayKey: "1",
          timeSlot: "09:00",
          timezone: "America/New_York",
          state: "can-do",
        },
      ],
      referenceTimeMs: Date.parse("2026-10-30T12:00:00Z"),
      appBaseUrl: "https://example.com",
    };
    const previousProjection = JSON.stringify({
      occurrences: { "1|13:00": 0 },
      availability: { "1|13:00": { alice: "can-do" } },
    });
    const notice = buildDiscordDstNotice(dstInput, previousProjection);

    expect(notice?.participantShifts).toEqual([
      expect.objectContaining({
        name: "Alice",
        timezone: "America/New_York",
        offsetChangeMinutes: -60,
      }),
    ]);
    expect(notice?.noLongerAvailable).toEqual(["Alice"]);
    expect(
      JSON.stringify(buildSummaryMessage(dstInput, "will-update", notice)),
    ).toContain("Upcoming DST change");
    expect(buildDiscordProjectionSnapshot(dstInput)).toContain(
      '"1|13:00"',
    );
  });

  it("keeps the footer inside Discord's 6,000-character embed total", () => {
    const payload = buildSummaryMessage(
      {
        ...input,
        schedule: {
          ...input.schedule,
          title: "T".repeat(400),
          description: "D".repeat(5_000),
        },
        profileNames: {
          alice: "A".repeat(2_000),
          bob: "B".repeat(2_000),
          charlie: "C".repeat(2_000),
        },
      },
      "will-update",
    );
    const embed = (
      payload.embeds as Array<{
        title?: string;
        description?: string;
        footer?: { text?: string };
        fields?: Array<{ name: string; value: string }>;
      }>
    )[0];
    const total =
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text?.length ?? 0) +
      (embed.fields ?? []).reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      );
    expect(total).toBeLessThanOrEqual(6_000);
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
  it("deletes the bot's own tracked messages and treats an absent message as clean", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 10008, message: "Unknown Message" }),
          { status: 404 },
        ),
      );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteChannelMessage("channel", "message"),
    ).resolves.toBeUndefined();
    await expect(
      deleteChannelMessage("channel", "already-gone"),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "DELETE" }),
    );
  });

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

  it("honours retry_after before retrying a short rate limit", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 20028,
            message: "Channel write rate limit",
            retry_after: 0.05,
          }),
          {
            status: 429,
            headers: {
              "Retry-After": "0.05",
              "X-RateLimit-Bucket": "write-bucket",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": "0.05",
              "X-RateLimit-Scope": "shared",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "message" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = postChannelMessage(
      "short-rate-channel",
      { embeds: [] },
      "stable-nonce",
    );
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({ id: "message" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        nonce: "stable-nonce",
        enforce_nonce: true,
      }),
    );
  });

  it("surfaces long rate limits with parsed metadata for a durable retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "You are being rate limited.",
          retry_after: 12.5,
          global: false,
        }),
        {
          status: 429,
          headers: {
            "X-RateLimit-Bucket": "user-bucket",
            "X-RateLimit-Scope": "user",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await postChannelMessage("long-rate-channel", {
      embeds: [],
    }).catch((caught: unknown) => caught);
    expect(error).toEqual(
      expect.objectContaining<Partial<DiscordApiError>>({
        status: 429,
        failureKind: "rate_limit",
        retryAfterMs: 12_500,
        retryable: true,
      }),
    );
    expect((error as DiscordApiError).rateLimit).toEqual(
      expect.objectContaining({ global: false, scope: "user" }),
    );
    expect(getDiscordRetryDelayMs(error as DiscordApiError, 0)).toBeGreaterThan(
      12_500,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("waits for an exhausted success bucket before the next request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "first" }), {
          status: 200,
          headers: {
            "X-RateLimit-Bucket": "success-bucket",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset-After": "0.05",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "second" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postChannelMessage("success-bucket-channel", { embeds: [] }),
    ).resolves.toEqual({ id: "first" });
    const second = postChannelMessage("success-bucket-channel", { embeds: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    await expect(second).resolves.toEqual({ id: "second" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Discord 5xx responses with bounded backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Gateway unavailable" }), {
          status: 502,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "recovered" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = postChannelMessage("server-retry-channel", { embeds: [] });
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ id: "recovered" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent permission failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ code: 50013, message: "Missing Permissions" }),
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await postChannelMessage("permission-channel", {
      embeds: [],
    }).catch((caught: unknown) => caught);
    expect(error).toEqual(
      expect.objectContaining<Partial<DiscordApiError>>({
        failureKind: "permission",
        retryable: false,
      }),
    );
    expect(getDiscordRetryDelayMs(error as DiscordApiError, 0)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("Discord interaction signatures", () => {
  const bytesToHex = (bytes: ArrayBuffer): string =>
    [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

  const signedRequest = async (timestamp: string, body: string) => {
    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(timestamp + body),
    );
    return {
      publicKeyHex: bytesToHex(
        await crypto.subtle.exportKey("raw", keyPair.publicKey),
      ),
      signatureHex: bytesToHex(signature),
    };
  };

  const signedAtSeconds = 1_800_000_000;
  const signedAtMs = signedAtSeconds * 1000;
  const timestamp = String(signedAtSeconds);
  const body = JSON.stringify({ type: 1 });

  it("accepts a fresh signature and rejects a tampered one", async () => {
    const { publicKeyHex, signatureHex } = await signedRequest(timestamp, body);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        body,
        signedAtMs,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        JSON.stringify({ type: 2 }),
        signedAtMs,
      ),
    ).resolves.toBe(false);
  });

  it("tolerates clock skew in both directions inside the window", async () => {
    const { publicKeyHex, signatureHex } = await signedRequest(timestamp, body);
    const skewMs = DISCORD_SIGNATURE_TOLERANCE_MS - 1_000;

    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        body,
        signedAtMs + skewMs,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        body,
        signedAtMs - skewMs,
      ),
    ).resolves.toBe(true);
  });

  it("rejects a replayed request once the freshness window has passed", async () => {
    const { publicKeyHex, signatureHex } = await signedRequest(timestamp, body);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const staleMs = DISCORD_SIGNATURE_TOLERANCE_MS + 1_000;

    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        body,
        signedAtMs + staleMs,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        signatureHex,
        timestamp,
        body,
        signedAtMs - staleMs,
      ),
    ).resolves.toBe(false);
  });

  it("fails closed on malformed input", async () => {
    const { publicKeyHex, signatureHex } = await signedRequest(timestamp, body);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const badTimestamp of ["", "not-a-timestamp", "17e", "Infinity"]) {
      await expect(
        verifyDiscordSignature(
          publicKeyHex,
          signatureHex,
          badTimestamp,
          body,
          signedAtMs,
        ),
      ).resolves.toBe(false);
    }
    await expect(
      verifyDiscordSignature(
        "zz",
        signatureHex,
        timestamp,
        body,
        signedAtMs,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature(
        publicKeyHex,
        "not-hex",
        timestamp,
        body,
        signedAtMs,
      ),
    ).resolves.toBe(false);
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/v10/users/@me",
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer user-token");
    expect(headers.get("User-Agent")).toContain("DiscordBot");
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
