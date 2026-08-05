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
import { isSessionExpired } from "./authSessions";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Session token security helpers
//
// Session tokens sent to the client are HMAC-signed: "uuid.signature".
// The DB stores only the raw UUID. On refresh the server:
//   1. Splits the client token into uuid + signature
//   2. Looks up the session by uuid
//   3. Verifies HMAC(uuid|googleUserId) matches the signature
//      (timing-safe via crypto.subtle.verify)
//
// The signing key is derived from AUTH_GOOGLE_SECRET via HMAC with a
// fixed context string (domain separation).
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function getSigningKey(): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env.AUTH_GOOGLE_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    baseKey,
    enc.encode("whengames-session-signing-v1"),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function signSessionToken(
  uuid: string,
  googleUserId: string,
): Promise<string> {
  const key = await getSigningKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${uuid}|${googleUserId}`),
  );
  return `${uuid}.${base64UrlEncode(sig)}`;
}

async function verifyAndParseSessionToken(
  signedToken: string,
  googleUserId: string,
): Promise<string | null> {
  const dotIdx = signedToken.indexOf(".");
  if (dotIdx < 0) return null;

  const uuid = signedToken.substring(0, dotIdx);
  const sig = base64UrlDecode(signedToken.substring(dotIdx + 1));

  const key = await getSigningKey();
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer as ArrayBuffer,
    enc.encode(`${uuid}|${googleUserId}`),
  );
  return valid ? uuid : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
}

// ---------------------------------------------------------------------------
// Google OAuth callback
// ---------------------------------------------------------------------------

http.route({
  path: "/auth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "/";
    const error = url.searchParams.get("error");
    const siteUrl = process.env.SITE_URL!;

    if (error) {
      const redirectUrl = `${siteUrl}/auth/callback#redirect=${encodeURIComponent(state)}`;
      return new Response(null, {
        status: 302,
        headers: { Location: redirectUrl },
      });
    }

    if (!code) {
      return new Response("Missing authorization code", { status: 400 });
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        redirect_uri: `${process.env.CONVEX_SITE_URL}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      console.error("Token exchange failed:", await tokenResponse.text());
      return new Response("Authentication failed", { status: 500 });
    }

    const tokens = (await tokenResponse.json()) as {
      id_token?: string;
      refresh_token?: string;
    };
    const idToken = tokens.id_token;

    if (!idToken) {
      return new Response("No ID token received from Google", { status: 500 });
    }

    const payload = decodeJwtPayload(idToken);
    const googleUserId = payload.sub as string;

    // Use Google's new refresh token, or reuse one stored from a prior login
    let refreshToken = tokens.refresh_token ?? null;
    if (!refreshToken) {
      const existing = await ctx.runQuery(
        internal.authSessions.getRefreshTokenByGoogleUser,
        { googleUserId },
      );
      refreshToken = existing?.refreshToken ?? null;
    }

    // Create a server-side session. The client receives an HMAC-signed
    // session token; the refresh token never leaves the backend.
    let signedSessionToken: string | undefined;
    if (refreshToken) {
      const uuid = crypto.randomUUID();

      await ctx.runMutation(internal.authSessions.createSession, {
        sessionToken: uuid,
        refreshToken,
        googleUserId,
      });

      signedSessionToken = await signSessionToken(uuid, googleUserId);
    }

    let fragment = `token=${encodeURIComponent(idToken)}&redirect=${encodeURIComponent(state)}`;
    if (signedSessionToken) {
      fragment += `&session=${encodeURIComponent(signedSessionToken)}`;
    }

    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/auth/callback#${fragment}` },
    });
  }),
});

// ---------------------------------------------------------------------------
// Token refresh
//
// Accepts the HMAC-signed session token, verifies the HMAC signature
// (proves the token wasn't forged), then uses the server-side refresh
// token to get a fresh ID token from Google. The refresh token is never
// included in any response.
// ---------------------------------------------------------------------------

http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const origin = process.env.SITE_URL!;
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    const body = (await req.json()) as { sessionToken?: string };
    const signedToken = body.sessionToken;

    if (!signedToken || typeof signedToken !== "string") {
      return new Response(JSON.stringify({ error: "Missing session token" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Extract the raw UUID (before HMAC verification — we need the DB
    // record to get the googleUserId for signature verification)
    const dotIdx = signedToken.indexOf(".");
    if (dotIdx < 0) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const uuid = signedToken.substring(0, dotIdx);

    const session = await ctx.runQuery(
      internal.authSessions.getBySessionToken,
      { sessionToken: uuid },
    );

    if (!session) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Verify HMAC signature (timing-safe)
    const verifiedUuid = await verifyAndParseSessionToken(
      signedToken,
      session.googleUserId,
    );
    if (!verifiedUuid) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Expiry is enforced only after the signature check, so an unauthenticated
    // caller learns nothing about whether a given uuid exists or is still live.
    if (isSessionExpired(session, Date.now())) {
      await ctx.runMutation(internal.authSessions.deleteBySessionToken, {
        sessionToken: uuid,
      });
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // HMAC verified — use the stored refresh token to get a new ID token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenResponse.ok) {
      console.error("Token refresh failed:", await tokenResponse.text());
      await ctx.runMutation(internal.authSessions.deleteBySessionToken, {
        sessionToken: uuid,
      });
      return new Response(JSON.stringify({ error: "Refresh failed" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const newTokens = (await tokenResponse.json()) as { id_token?: string };

    if (!newTokens.id_token) {
      return new Response(
        JSON.stringify({ error: "No ID token returned" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    await ctx.runMutation(internal.authSessions.touchSession, {
      sessionToken: uuid,
    });

    return new Response(JSON.stringify({ idToken: newTokens.id_token }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }),
});

// ---------------------------------------------------------------------------
// Sign-out
//
// Clearing client storage alone leaves the server-side session — and the Google
// refresh token it unlocks — usable by anyone who captured the token. This
// destroys the session row and asks Google to drop the grant as well.
// ---------------------------------------------------------------------------

http.route({
  path: "/auth/signout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const origin = process.env.SITE_URL!;
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    const body = (await req.json().catch(() => ({}))) as {
      sessionToken?: unknown;
    };
    const signedToken = body.sessionToken;

    // Sign-out answers identically whether or not the token was real, so it
    // cannot be used to probe which session tokens exist.
    const ok = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

    if (typeof signedToken !== "string" || signedToken.length === 0) return ok;

    const dotIdx = signedToken.indexOf(".");
    if (dotIdx < 0) return ok;
    const uuid = signedToken.substring(0, dotIdx);

    const session = await ctx.runQuery(
      internal.authSessions.getBySessionToken,
      { sessionToken: uuid },
    );
    if (!session) return ok;

    // Requiring a valid signature stops an attacker who has only guessed or
    // scraped a bare uuid from logging other people out.
    const verifiedUuid = await verifyAndParseSessionToken(
      signedToken,
      session.googleUserId,
    );
    if (!verifiedUuid) return ok;

    const revoked = await ctx.runMutation(internal.authSessions.revokeSession, {
      sessionToken: uuid,
    });

    if (revoked) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: revoked.refreshToken }),
        });
      } catch {
        // The local session is already gone, which is what actually gates
        // access here; Google expires the orphaned grant on its own.
      }
    }

    return ok;
  }),
});

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
      id_token?: string;
    };

    if (!tokens.refresh_token || !tokens.access_token) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=no_refresh_token&state=${encodeURIComponent(state)}`,
        },
      });
    }

    let googleUserId = "";
    if (tokens.id_token) {
      const payload = decodeJwtPayload(tokens.id_token);
      googleUserId = payload.sub as string;
    }

    // Fetch the user's calendar list using the access token. A successful
    // connection must include this list; otherwise the UI cannot select which
    // calendars to sync.
    let availableCalendars: { id: string; summary: string }[];
    try {
      const calListRes = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      if (!calListRes.ok) {
        console.error(
          "Google calendar list fetch failed:",
          calListRes.status,
          await calListRes.text(),
        );
        throw new Error(`Google calendar list returned ${calListRes.status}`);
      }

      const calListData = (await calListRes.json()) as {
        items?: Array<{ id: string; summary: string }>;
      };
      availableCalendars = (calListData.items ?? []).map((c) => ({
        id: c.id,
        summary: c.summary,
      }));
    } catch (error) {
      console.error("Unable to load Google calendar list:", error);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${siteUrl}/auth/calendar-callback#error=calendar_list_failed&state=${encodeURIComponent(state)}`,
        },
      });
    }

    await ctx.runMutation(internal.calendarSources.storeGoogleCalendarToken, {
      googleUserId,
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

// CORS preflight for the refresh endpoint
http.route({
  path: "/auth/refresh",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": process.env.SITE_URL!,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

http.route({
  path: "/auth/signout",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": process.env.SITE_URL!,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
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
