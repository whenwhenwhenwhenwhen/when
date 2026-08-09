import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  DiscordApiError,
  exchangeDiscordOAuthCode,
  fetchDiscordCurrentUser,
  getMissingDiscordInstallConfiguration,
  verifyDiscordSignature,
} from "./discordHelpers";
import { getMissingDiscordPermissions } from "./discordPermissions";
import { googlyAuth } from "./lib/auth";

const http = httpRouter();
googlyAuth.registerRoutes(http);

// ---------------------------------------------------------------------------
// Google Calendar OAuth callback (incremental scope for calendar.readonly)
// ---------------------------------------------------------------------------

http.route({
  path: "/auth/google/calendar-callback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "/";
    const error = url.searchParams.get("error");
    const siteUrl = process.env.SITE_URL!;

    if (error || !code) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=${encodeURIComponent(error || "no_code")}&state=${encodeURIComponent(state)}`,
        },
      });
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        redirect_uri: `${process.env.CONVEX_SITE_URL}/auth/google/calendar-callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      console.error("Calendar token exchange failed:", await tokenResponse.text());
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=token_exchange_failed&state=${encodeURIComponent(state)}`,
        },
      });
    }

    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
    };

    if (!tokens.refresh_token || !tokens.access_token) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=no_refresh_token&state=${encodeURIComponent(state)}`,
        },
      });
    }

    let availableCalendars: { id: string; summary: string }[];
    let identityId: string | null;
    try {
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      const [calListRes, userInfoRes] = await Promise.all([
        fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
          headers,
        }),
        fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers }),
      ]);
      if (!calListRes.ok) {
        console.error(
          "Google calendar list fetch failed:",
          calListRes.status,
          await calListRes.text(),
        );
        throw new Error(`Google calendar list returned ${calListRes.status}`);
      }
      if (!userInfoRes.ok) {
        throw new Error(`Google userinfo returned ${userInfoRes.status}`);
      }

      const calListData = (await calListRes.json()) as {
        items?: Array<{ id: string; summary: string }>;
      };
      const userInfo = (await userInfoRes.json()) as { sub?: unknown };
      if (typeof userInfo.sub !== "string" || userInfo.sub === "") {
        throw new Error("Google userinfo did not include a subject");
      }
      availableCalendars = (calListData.items ?? []).map((c) => ({
        id: c.id,
        summary: c.summary,
      }));
      identityId = await ctx.runQuery(googlyAuth.component.lib.resolve, {
        googleSubject: `https://accounts.google.com|${userInfo.sub}`,
      });
    } catch (error) {
      console.error("Unable to load Google calendar list:", error);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=calendar_list_failed&state=${encodeURIComponent(state)}`,
        },
      });
    }

    if (identityId === null) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=profile_not_found&state=${encodeURIComponent(state)}`,
        },
      });
    }

    await ctx.runMutation(internal.calendarSources.storeGoogleCalendarToken, {
      identityId,
      calendarRefreshToken: tokens.refresh_token,
      availableCalendars,
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${siteUrl}/auth/calendar-callback#success=true&state=${encodeURIComponent(state)}`,
      },
    });
  }),
});

// ---------------------------------------------------------------------------
// Discord interactions endpoint
//
// Discord sends interaction webhooks here (slash commands, message
// components, modals). The endpoint MUST:
//   1. Verify the Ed25519 signature using the app's public key
//   2. Respond to PING (type 1) with PONG (type 1) — required during
//      "interaction endpoint URL" setup
//   3. Respond within 3 seconds. For long work, use deferred response.
// ---------------------------------------------------------------------------

http.route({
  path: "/discord/interactions",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const signature = req.headers.get("X-Signature-Ed25519");
    const timestamp = req.headers.get("X-Signature-Timestamp");
    const body = await req.text();

    if (!signature || !timestamp) {
      return new Response("Missing signature", { status: 401 });
    }

    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      console.error("DISCORD_PUBLIC_KEY env var not set");
      return new Response("Server not configured", { status: 500 });
    }

    const ok = await verifyDiscordSignature(
      publicKey,
      signature,
      timestamp,
      body
    );
    if (!ok) {
      return new Response("Invalid signature", { status: 401 });
    }

    type DiscordInteraction = {
      id?: string;
      type: number;
      data?: {
        name?: string;
        custom_id?: string;
        values?: string[];
        component_type?: number;
      };
      member?: { user?: { id: string; username?: string } };
      user?: { id: string; username?: string };
      channel_id?: string;
      application_id?: string;
      token?: string;
    };
    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(body) as DiscordInteraction;
    } catch {
      return new Response("Malformed JSON", { status: 400 });
    }

    // PING — required during initial endpoint setup
    if (interaction.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const discordUserId =
      interaction.member?.user?.id ?? interaction.user?.id ?? "";
    const discordUsername =
      interaction.member?.user?.username ?? interaction.user?.username;

    // APPLICATION_COMMAND — /when
    if (interaction.type === 2 && interaction.data?.name === "when") {
      const scheduleResult = await ctx.runQuery(
        internal.discord.listSchedulesForDiscordUser,
        { discordUserId }
      );

      if (!scheduleResult.accountLinked) {
        const sessionToken = await ctx.runMutation(
          internal.discord.createDiscordUserLinkSession,
          { discordUserId, discordUsername },
        );
        const siteUrl = process.env.SITE_URL ?? "";
        const linkUrl = siteUrl
          ? new URL(
              `/discord/link-account?token=${encodeURIComponent(sessionToken)}`,
              siteUrl,
            ).toString()
          : null;
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              flags: 64,
              content:
                "Link your Discord account to your When? profile to choose schedules you have participated in.",
              components: linkUrl
                ? [
                    {
                      type: 1,
                      components: [
                        {
                          type: 2,
                          style: 5,
                          label: "Link When? account",
                          url: linkUrl,
                        },
                      ],
                    },
                  ]
                : undefined,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const schedules = scheduleResult.schedules;

      if (schedules.length === 0) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              flags: 64,
              content:
                "Your Discord account is linked, but this When? profile has not participated in any schedules yet. Participate in a schedule, then run /when again.",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const options = schedules.map((s) => ({
        label: s.title.slice(0, 100),
        value: s._id as string,
        description:
          s.type === "recurring"
            ? s.isLocked
              ? "Recurring · locked"
              : "Recurring"
            : s.isLocked
              ? "One-off · locked"
              : "One-off",
      }));

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            flags: 64, // ephemeral
            content: "Pick a schedule to share in this channel:",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 3,
                    custom_id: "when_pick_schedule",
                    placeholder: "Choose a schedule",
                    options,
                    min_values: 1,
                    max_values: 1,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // MESSAGE_COMPONENT — user picked a schedule from the select menu
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id === "when_pick_schedule" &&
      interaction.data.values?.[0]
    ) {
      const scheduleId = interaction.data.values[0] as unknown as
        | undefined
        | (string & { _brand?: never });
      if (!scheduleId) {
        return new Response(
          JSON.stringify({
            type: 7,
            data: { content: "No schedule selected.", components: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (
        !interaction.channel_id ||
        !interaction.application_id ||
        !interaction.token ||
        !interaction.id
      ) {
        return new Response(
          JSON.stringify({
            type: 7,
            data: {
              content: "When? could not determine which channel to share to.",
              components: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      await ctx.scheduler.runAfter(
        250,
        internal.discord.shareInteractionSummary,
        {
          scheduleId: scheduleId as unknown as never,
          discordUserId,
          channelId: interaction.channel_id,
          applicationId: interaction.application_id,
          interactionToken: interaction.token,
          messageNonce: interaction.id,
        },
      );

      // Acknowledge immediately, then the scheduled action posts the public
      // message and replaces the private picker with success/error text.
      return new Response(
        JSON.stringify({ type: 6 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Unknown interaction — politely ignore
    return new Response(
      JSON.stringify({
        type: 4,
        data: { flags: 64, content: "Sorry, I don't recognise that action." },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// ---------------------------------------------------------------------------
// Discord bot install callback
//
// The user clicks "Link to Discord" in the schedule view. That creates an
// install session and redirects them to Discord's OAuth dialog with the
// `bot` + `applications.commands` scopes. After they pick a guild and
// authorise, Discord redirects here with a code + guild_id + state.
//
// We don't actually need the user's access token (we use the bot token
// for posting). We just record the guild and fetch its channel list,
// then redirect the user to the channel picker page on the frontend.
// ---------------------------------------------------------------------------

http.route({
  path: "/discord/install-callback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code");
    const guildId = url.searchParams.get("guild_id");
    const permissions = url.searchParams.get("permissions");
    const error = url.searchParams.get("error");
    const siteUrl = process.env.SITE_URL!;

    if (error || !state || !guildId || !code) {
      const params = new URLSearchParams();
      params.set("error", error || "missing_params");
      params.set("session", state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
        },
      });
    }

    const redirectUri = new URL("/discord/install-callback", req.url).toString();
    const params = new URLSearchParams();
    params.set("session", state);

    const missingPermissions = getMissingDiscordPermissions(permissions);
    if (missingPermissions.length > 0) {
      params.set("error", "missing_permissions");
      params.set("missing", missingPermissions.join(","));
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
        },
      });
    }

    const missingConfiguration = getMissingDiscordInstallConfiguration();
    if (missingConfiguration.length > 0) {
      console.error(
        "Discord install callback is missing configuration",
        missingConfiguration,
      );
      params.set("error", "discord_not_configured");
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
        },
      });
    }

    try {
      const accessToken = await exchangeDiscordOAuthCode(code, redirectUri);
      if (!accessToken) {
        params.set("error", "oauth_exchange_failed");
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
          },
        });
      }

      const discordUser = await fetchDiscordCurrentUser(accessToken);
      await ctx.runMutation(internal.discord.linkDiscordUserForInstallSession, {
        sessionToken: state,
        discordUserId: discordUser.id,
        discordUsername: discordUser.username,
      });

      // Pull channel list using the bot token and persist on the session
      await ctx.runAction(internal.discord.completeInstallSession, {
        sessionToken: state,
        guildId,
      });
    } catch (err) {
      console.error("Discord install callback failed", err);
      params.set(
        "error",
        err instanceof DiscordApiError
          ? err.status === 401
            ? "discord_credentials_invalid"
            : err.status === 403 || err.code === 50001 || err.code === 50013
              ? "discord_server_access_failed"
              : "install_callback_failed"
          : "install_callback_failed",
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
        },
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${siteUrl}/discord/link-channel?${params.toString()}`,
      },
    });
  }),
});

export default http;
