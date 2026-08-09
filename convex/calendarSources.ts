import { v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalMutation,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeIcsUrl } from "./calendarSync";
import { googlyAuth, requireGoogleProfile } from "./lib/auth";

async function getAuthenticatedProfile(
  ctx: QueryCtx | MutationCtx,
  profileId: Id<"userProfiles">,
) {
  const profile = await requireGoogleProfile(ctx);
  if (profile._id !== profileId) {
    throw new Error("Not authorized");
  }
  return profile;
}

function redactedCalendarSource(source: Doc<"calendarSources">) {
  return {
    _id: source._id,
    type: source.type,
    availableCalendars: source.availableCalendars,
    selectedCalendarIds: source.selectedCalendarIds,
    hasIcsUrl: source.type === "ics" && !!source.icsUrl,
    lastSyncAt: source.lastSyncAt,
    lastSyncStatus: source.lastSyncStatus,
    // Provider messages can leak feed URLs or tokens, so errors are generic.
    // Notes recorded alongside a successful sync are ours and safe to show.
    lastSyncError:
      source.lastSyncStatus === "error"
        ? "Calendar sync failed"
        : source.lastSyncError,
    enabled: source.enabled,
  };
}

export const getForProfile = query({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const profile = await getAuthenticatedProfile(ctx, args.profileId);

    const sources = await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(10);
    return sources.map(redactedCalendarSource);
  },
});

export const getOwnedGoogleSource = internalQuery({
  args: {
    profileId: v.id("userProfiles"),
    identityId: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_identityId", (q) => q.eq("identityId", args.identityId))
      .unique();
    if (!profile || profile._id !== args.profileId) {
      throw new Error("Not authorized");
    }

    const sources = await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(10);
    return sources.find((s) => s.type === "google") ?? null;
  },
});

export const storeGoogleCalendarToken = internalMutation({
  args: {
    identityId: v.string(),
    calendarRefreshToken: v.string(),
    availableCalendars: v.array(
      v.object({ id: v.string(), summary: v.string() })
    ),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_identityId", (q) => q.eq("identityId", args.identityId))
      .unique();
    if (!profile) throw new Error("No user profile found for this identity");

    const existingSources = await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(10);
    const googleSource = existingSources.find((s) => s.type === "google");

    let calendarSourceId: Id<"calendarSources">;

    if (googleSource) {
      await ctx.db.patch(googleSource._id, {
        calendarRefreshToken: args.calendarRefreshToken,
        availableCalendars: args.availableCalendars,
        enabled: true,
      });
      calendarSourceId = googleSource._id;
    } else {
      calendarSourceId = await ctx.db.insert("calendarSources", {
        profileId: profile._id,
        type: "google",
        calendarRefreshToken: args.calendarRefreshToken,
        availableCalendars: args.availableCalendars,
        selectedCalendarIds: [],
        enabled: true,
        createdAt: Date.now(),
      });
    }

    await ctx.scheduler.runAfter(0, internal.calendarSync.syncForSource, {
      calendarSourceId,
    });
  },
});

export const updateSelectedCalendars = mutation({
  args: {
    profileId: v.id("userProfiles"),
    selectedCalendarIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await getAuthenticatedProfile(ctx, args.profileId);

    const sources = await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId", (q) => q.eq("profileId", args.profileId))
      .take(10);
    const googleSource = sources.find((s) => s.type === "google");
    if (!googleSource) throw new Error("No Google calendar source found");

    await ctx.db.patch(googleSource._id, {
      selectedCalendarIds: args.selectedCalendarIds,
    });
  },
});

export const saveIcsUrl = mutation({
  args: {
    profileId: v.id("userProfiles"),
    icsUrl: v.string(),
  },
  handler: async (ctx, args) => {
    await getAuthenticatedProfile(ctx, args.profileId);

    const icsUrl = normalizeIcsUrl(args.icsUrl);

    const sources = await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId", (q) => q.eq("profileId", args.profileId))
      .take(10);
    const icsSource = sources.find((s) => s.type === "ics");

    if (icsSource) {
      await ctx.db.patch(icsSource._id, {
        icsUrl,
        enabled: true,
      });
    } else {
      await ctx.db.insert("calendarSources", {
        profileId: args.profileId,
        type: "ics",
        icsUrl,
        enabled: true,
        createdAt: Date.now(),
      });
    }
  },
});

export const removeSource = mutation({
  args: { sourceId: v.id("calendarSources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("Calendar source not found");

    await getAuthenticatedProfile(ctx, source.profileId);

    const overrides = await ctx.db
      .query("calendarOverrides")
      .withIndex("by_profile_event", (q) =>
        q.eq("profileId", source.profileId)
      )
      .collect();
    for (const override of overrides) {
      await ctx.db.delete(override._id);
    }

    await ctx.db.delete(args.sourceId);

    await ctx.scheduler.runAfter(
      0,
      internal.calendarSync.cleanupSelectionsForProfile,
      { profileId: source.profileId }
    );
  },
});

export const fetchGoogleCalendars = action({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not authenticated");
    }
    const identityId = await ctx.runQuery(googlyAuth.component.lib.resolve, {
      googleSubject: identity.tokenIdentifier,
    });
    if (identityId === null) throw new Error("Not authenticated");

    const googleSource: Doc<"calendarSources"> | null = await ctx.runQuery(
      internal.calendarSources.getOwnedGoogleSource,
      {
        profileId: args.profileId,
        identityId,
      }
    );
    if (!googleSource || !googleSource.calendarRefreshToken) {
      throw new Error("No Google calendar source with refresh token found");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        refresh_token: googleSource.calendarRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Failed to refresh Google token: ${tokenResponse.status}`);
    }
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token as string;

    const calendarListResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!calendarListResponse.ok) {
      throw new Error(
        `Failed to fetch Google calendars: ${calendarListResponse.status}`
      );
    }
    const calendarListData = await calendarListResponse.json();
    const calendars: { id: string; summary: string }[] = (
      calendarListData.items as Array<{ id: string; summary: string }>
    ).map((item) => ({ id: item.id, summary: item.summary }));

    await ctx.runMutation(
      internal.calendarSources.updateAvailableCalendars,
      {
        sourceId: googleSource._id,
        availableCalendars: calendars,
      }
    );

    return calendars;
  },
});

export const updateAvailableCalendars = internalMutation({
  args: {
    sourceId: v.id("calendarSources"),
    availableCalendars: v.array(
      v.object({ id: v.string(), summary: v.string() })
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sourceId, {
      availableCalendars: args.availableCalendars,
    });
  },
});
