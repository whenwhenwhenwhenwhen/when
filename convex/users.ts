import { v } from "convex/values";
import {
  MutationCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  getCurrentProfile,
  googlyAuth,
  requireCurrentProfile,
  requireGoogleProfile,
} from "./lib/auth";

const PROFILE_MERGE_BATCH_SIZE = 100;
// Documents relocated per transaction. A merge larger than this continues in a
// scheduled follow-up, so a user with a long history cannot blow the Convex
// per-transaction limit and permanently fail their own sign-in.
const PROFILE_MERGE_DOC_BUDGET = 512;

// Relocates one profile's data onto another. Returns false when the work
// budget ran out before the profile was drained, in which case the caller must
// schedule `continueProfileMerge` and must not delete the source profile yet.
async function moveProfileData(
  ctx: MutationCtx,
  fromProfileId: Id<"userProfiles">,
  toProfileId: Id<"userProfiles">
): Promise<boolean> {
  let budget = PROFILE_MERGE_DOC_BUDGET;
  const nextBatchSize = () => Math.min(PROFILE_MERGE_BATCH_SIZE, budget);

  while (budget > 0) {
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(nextBatchSize());

    if (selections.length === 0) break;

    for (const sel of selections) {
      // Matching on the exception fields too: a base recurring selection and a
      // dated exception occupy the same day/slot but are distinct rows, so the
      // coarser index would treat one as a duplicate of the other and drop it.
      const existingSel = await ctx.db
        .query("selections")
        .withIndex(
          "by_profile_schedule_day_time_isException_exceptionDate",
          (q) =>
            q
              .eq("profileId", toProfileId)
              .eq("scheduleId", sel.scheduleId)
              .eq("dayKey", sel.dayKey)
              .eq("timeSlot", sel.timeSlot)
              .eq("isException", sel.isException)
              .eq("exceptionDate", sel.exceptionDate)
        )
        .first();

      if (!existingSel) {
        await ctx.db.insert("selections", {
          scheduleId: sel.scheduleId,
          profileId: toProfileId,
          dayKey: sel.dayKey,
          timeSlot: sel.timeSlot,
          timezone: sel.timezone,
          state: sel.state,
          isException: sel.isException,
          exceptionDate: sel.exceptionDate,
          source: sel.source,
          externalEventId: sel.externalEventId,
          calendarSourceId: sel.calendarSourceId,
        });
      }
      await ctx.db.delete(sel._id);
      budget--;
    }
  }
  if (budget <= 0) return false;

  while (budget > 0) {
    const schedules = await ctx.db
      .query("schedules")
      .withIndex("by_creatorProfileId", (q) =>
        q.eq("creatorProfileId", fromProfileId)
      )
      .take(nextBatchSize());

    if (schedules.length === 0) break;

    for (const sched of schedules) {
      await ctx.db.patch(sched._id, {
        creatorProfileId: toProfileId,
      });
      budget--;
    }
  }
  if (budget <= 0) return false;

  while (budget > 0) {
    const blockedProfiles = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(nextBatchSize());

    if (blockedProfiles.length === 0) break;

    for (const blocked of blockedProfiles) {
      const existing = await ctx.db
        .query("blockedProfiles")
        .withIndex("by_schedule_profile", (q) =>
          q
            .eq("scheduleId", blocked.scheduleId)
            .eq("profileId", toProfileId)
        )
        .unique();
      if (existing) {
        await ctx.db.delete(blocked._id);
      } else {
        await ctx.db.patch(blocked._id, { profileId: toProfileId });
      }
      budget--;
    }
  }
  if (budget <= 0) return false;

  while (budget > 0) {
    const archives = await ctx.db
      .query("scheduleArchives")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(nextBatchSize());

    if (archives.length === 0) break;

    for (const archive of archives) {
      const existing = await ctx.db
        .query("scheduleArchives")
        .withIndex("by_schedule_profile", (q) =>
          q
            .eq("scheduleId", archive.scheduleId)
            .eq("profileId", toProfileId)
        )
        .unique();
      if (existing) {
        if (archive.archivedAt > existing.archivedAt) {
          await ctx.db.patch(existing._id, {
            archivedAt: archive.archivedAt,
          });
        }
        await ctx.db.delete(archive._id);
      } else {
        await ctx.db.patch(archive._id, { profileId: toProfileId });
      }
      budget--;
    }
  }
  if (budget <= 0) return false;

  while (budget > 0) {
    const links = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(nextBatchSize());

    if (links.length === 0) break;

    for (const link of links) {
      const existing = await ctx.db
        .query("availabilityLinks")
        .withIndex("by_schedule_profile", (q) =>
          q.eq("scheduleId", link.scheduleId).eq("profileId", toProfileId)
        )
        .unique();
      if (existing) {
        await ctx.db.delete(link._id);
      } else {
        await ctx.db.patch(link._id, { profileId: toProfileId });
      }
      budget--;
    }
  }
  if (budget <= 0) return false;

  for (const table of [
    "savedAvailabilities",
    "calendarSources",
    "selectionBatchInvalidations",
    "calendarOverrides",
    "discordInstallSessions",
  ] as const) {
    while (budget > 0) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
        .take(nextBatchSize());

      if (rows.length === 0) break;

      for (const row of rows) {
        await ctx.db.patch(row._id, { profileId: toProfileId });
        budget--;
      }
    }
    if (budget <= 0) return false;
  }

  while (budget > 0) {
    const logs = await ctx.db
      .query("dstCheckLog")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(nextBatchSize());

    if (logs.length === 0) break;

    for (const log of logs) {
      const existing = await ctx.db
        .query("dstCheckLog")
        .withIndex("by_schedule_profile_date", (q) =>
          q
            .eq("scheduleId", log.scheduleId)
            .eq("profileId", toProfileId)
            .eq("dstChangeDate", log.dstChangeDate),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(log._id);
      } else {
        await ctx.db.patch(log._id, { profileId: toProfileId });
      }
      budget--;
    }
  }
  if (budget <= 0) return false;

  while (budget > 0) {
    const links = await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_linkedByProfileId", (q) =>
        q.eq("linkedByProfileId", fromProfileId),
      )
      .take(nextBatchSize());

    if (links.length === 0) break;

    for (const link of links) {
      await ctx.db.patch(link._id, { linkedByProfileId: toProfileId });
      budget--;
    }
  }
  if (budget <= 0) return false;

  const [fromDiscordLink, toDiscordLink] = await Promise.all([
    ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .unique(),
    ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", toProfileId))
      .unique(),
  ]);
  if (fromDiscordLink) {
    if (toDiscordLink) {
      await ctx.db.delete(fromDiscordLink._id);
    } else {
      await ctx.db.patch(fromDiscordLink._id, { profileId: toProfileId });
    }
  }

  return true;
}

// The component retires the source credential before returning mergedFromId.
// This helper only needs to finish relocating app-owned data.
async function finishOrContinueMerge(
  ctx: MutationCtx,
  merged: boolean,
  fromProfileId: Id<"userProfiles">,
  toProfileId: Id<"userProfiles">
) {
  if (merged) {
    await ctx.db.delete(fromProfileId);
    return;
  }

  await ctx.scheduler.runAfter(0, internal.users.continueProfileMerge, {
    fromProfileId,
    toProfileId,
  });
}

// Hands the source profile to `moveProfileData` until it drains, then removes
// it. Its component identity has already been absorbed and is unreachable.
export const continueProfileMerge = internalMutation({
  args: {
    fromProfileId: v.id("userProfiles"),
    toProfileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    const [from, to] = await Promise.all([
      ctx.db.get(args.fromProfileId),
      ctx.db.get(args.toProfileId),
    ]);
    if (!from || !to) return;

    if (await moveProfileData(ctx, args.fromProfileId, args.toProfileId)) {
      await ctx.db.delete(args.fromProfileId);
      return;
    }

    await ctx.scheduler.runAfter(0, internal.users.continueProfileMerge, args);
  },
});

// Find or create the app profile for the component-owned identity. This is the
// only profile bootstrap path for both anonymous and Google callers.
export const ensureProfile = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    displayName: v.optional(v.string()),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await googlyAuth.ensureIdentity(ctx, {
      anonymousClaim: args.anonymousClaim,
    });

    let profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_identityId", (q) =>
        q.eq("identityId", result.identityId),
      )
      .unique();

    if (result.mergedFromId !== null) {
      const source = await ctx.db
        .query("userProfiles")
        .withIndex("by_identityId", (q) =>
          q.eq("identityId", result.mergedFromId!),
        )
        .unique();

      if (source !== null && profile !== null && source._id !== profile._id) {
        const merged = await moveProfileData(ctx, source._id, profile._id);
        if (source.displayName.trim() !== "") {
          await ctx.db.patch(profile._id, {
            displayName: source.displayName,
          });
          profile = { ...profile, displayName: source.displayName };
        }
        await finishOrContinueMerge(ctx, merged, source._id, profile._id);
      } else if (source !== null && profile === null) {
        await ctx.db.patch(source._id, { identityId: result.identityId });
        profile = { ...source, identityId: result.identityId };
      }
    }

    if (profile === null) {
      const profileId = await ctx.db.insert("userProfiles", {
        identityId: result.identityId,
        displayName:
          args.displayName?.trim() || result.identity?.name || "Anonymous",
        profileImageUrl: result.identity?.pictureUrl,
        timezone: args.timezone,
        weekStartDay: 0,
        dstNotifications: true,
      });
      profile = (await ctx.db.get(profileId))!;
    } else if (result.identity !== null) {
      const updates: {
        displayName?: string;
        profileImageUrl?: string;
      } = {};
      if (profile.displayName.trim() === "" && result.identity.name) {
        updates.displayName = result.identity.name;
      }
      if (result.identity.pictureUrl) {
        updates.profileImageUrl = result.identity.pictureUrl;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(profile._id, updates);
        profile = { ...profile, ...updates };
      }
    }

    if (result.identity?.pictureUrl) {
      await ctx.scheduler.runAfter(
        0,
        internal.profileImages.downloadAndStoreProfileImage,
        { profileId: profile._id, imageUrl: result.identity.pictureUrl },
      );
    }

    return profile._id;
  },
});

// Return only UI-safe app profile fields; the opaque identity id stays private.
export const currentUserProfile = query({
  args: { anonymousClaim: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const profile = await getCurrentProfile(ctx, args.anonymousClaim);
    if (profile === null) return null;

    const storedImageUrl = profile.profileImageStorageId
      ? await ctx.storage.getUrl(profile.profileImageStorageId)
      : null;
    const profileImageUrl =
      storedImageUrl ?? identity?.pictureUrl ?? profile.profileImageUrl;

    return {
      _id: profile._id,
      _creationTime: profile._creationTime,
      displayName: profile.displayName,
      profileImageUrl,
      timezone: profile.timezone,
      weekStartDay: profile.weekStartDay,
      dstNotifications: profile.dstNotifications,
      isAuthenticated: identity !== null,
      authType: identity !== null ? ("sso" as const) : ("anonymous" as const),
      ssoName: identity?.name,
      ssoEmail: identity?.email,
      ssoImage: identity === null ? undefined : profileImageUrl,
    };
  },
});

// Update user profile
export const updateProfile = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    displayName: v.optional(v.string()),
    timezone: v.optional(v.string()),
    weekStartDay: v.optional(v.number()),
    dstNotifications: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const cleanUpdates: Record<string, unknown> = {};
    if (args.displayName !== undefined) cleanUpdates.displayName = args.displayName;
    if (args.timezone !== undefined) cleanUpdates.timezone = args.timezone;
    if (args.weekStartDay !== undefined) {
      if (!Number.isInteger(args.weekStartDay) || args.weekStartDay < 0 || args.weekStartDay > 6) {
        throw new Error("weekStartDay must be an integer from 0 to 6");
      }
      cleanUpdates.weekStartDay = args.weekStartDay;
    }
    if (args.dstNotifications !== undefined)
      cleanUpdates.dstNotifications = args.dstNotifications;

    await ctx.db.patch(profile._id, cleanUpdates);
  },
});

// Refresh the authenticated user's cached profile image if stale (>24 hours).
// Called by the frontend on each app access; the backend throttles to avoid
// redundant downloads. This catches profile-picture changes between sign-ins.
const PROFILE_IMAGE_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export const refreshProfileImageIfNeeded = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const profile = await requireGoogleProfile(ctx);

    // Throttle: skip if checked recently
    const now = Date.now();
    if (
      profile.profileImageLastCheckedAt &&
      now - profile.profileImageLastCheckedAt < PROFILE_IMAGE_REFRESH_INTERVAL
    ) {
      return;
    }

    // Use the current Google picture URL from the identity
    const imageUrl = identity.pictureUrl ?? profile.profileImageUrl;
    if (!imageUrl) return;

    // Stamp the throttle first so concurrent calls don't duplicate
    await ctx.db.patch(profile._id, {
      profileImageLastCheckedAt: now,
    });

    // Schedule the download
    await ctx.scheduler.runAfter(
      0,
      internal.profileImages.downloadAndStoreProfileImage,
      { profileId: profile._id, imageUrl }
    );
  },
});

// Public profile lookup by ID. Raw profile documents include the app's opaque
// identity key, so callers get this reduced shape.
export const getPublicProfiles = query({
  args: { profileIds: v.array(v.id("userProfiles")) },
  handler: async (ctx, args) => {
    const profiles = await Promise.all(
      args.profileIds.map(async (id) => {
        const profile = await ctx.db.get(id);
        if (!profile) return null;
        const storedImageUrl = profile.profileImageStorageId
          ? await ctx.storage.getUrl(profile.profileImageStorageId)
          : null;
        return {
          _id: profile._id,
          displayName: profile.displayName,
          profileImageUrl: storedImageUrl ?? profile.profileImageUrl,
          timezone: profile.timezone,
        };
      })
    );
    return profiles.filter((p) => p !== null);
  },
});
