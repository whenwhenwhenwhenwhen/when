import { v } from "convex/values";
import { MutationCtx, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const PROFILE_MERGE_BATCH_SIZE = 100;

async function getAuthenticatedProfile(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  return await ctx.db
    .query("userProfiles")
    .withIndex("by_authUserId", (q) =>
      q.eq("authUserId", identity.tokenIdentifier)
    )
    .unique();
}

async function getProfileForSettings(
  ctx: MutationCtx,
  anonymousId: string | undefined
) {
  const authProfile = await getAuthenticatedProfile(ctx);
  if (authProfile) return authProfile;

  if (!anonymousId) throw new Error("Not authenticated");

  const anonymousProfile = await ctx.db
    .query("userProfiles")
    .withIndex("by_anonymousId", (q) => q.eq("anonymousId", anonymousId))
    .unique();

  if (!anonymousProfile || anonymousProfile.authUserId) {
    throw new Error("Profile not found");
  }

  return anonymousProfile;
}

async function moveProfileData(
  ctx: MutationCtx,
  fromProfileId: Id<"userProfiles">,
  toProfileId: Id<"userProfiles">
) {
  while (true) {
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(PROFILE_MERGE_BATCH_SIZE);

    if (selections.length === 0) break;

    for (const sel of selections) {
      const existingSel = await ctx.db
        .query("selections")
        .withIndex("by_profile_schedule_day_time", (q) =>
          q
            .eq("profileId", toProfileId)
            .eq("scheduleId", sel.scheduleId)
            .eq("dayKey", sel.dayKey)
            .eq("timeSlot", sel.timeSlot)
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
        });
      }
      await ctx.db.delete(sel._id);
    }
  }

  while (true) {
    const schedules = await ctx.db
      .query("schedules")
      .withIndex("by_creatorProfileId", (q) =>
        q.eq("creatorProfileId", fromProfileId)
      )
      .take(PROFILE_MERGE_BATCH_SIZE);

    if (schedules.length === 0) break;

    for (const sched of schedules) {
      await ctx.db.patch(sched._id, {
        creatorProfileId: toProfileId,
      });
    }
  }

  while (true) {
    const blockedProfiles = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(PROFILE_MERGE_BATCH_SIZE);

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
    }
  }

  while (true) {
    const archives = await ctx.db
      .query("scheduleArchives")
      .withIndex("by_profileId", (q) => q.eq("profileId", fromProfileId))
      .take(PROFILE_MERGE_BATCH_SIZE);

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
    }
  }

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
}

// Get or create an anonymous user profile
export const getOrCreateAnonymousProfile = mutation({
  args: {
    anonymousId: v.string(),
    displayName: v.string(),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_anonymousId", (q) => q.eq("anonymousId", args.anonymousId))
      .unique();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert("userProfiles", {
      anonymousId: args.anonymousId,
      displayName: args.displayName,
      timezone: args.timezone,
      weekStartDay: 0, // Sunday default
      dstNotifications: true,
    });
  },
});

// Get profile by anonymous ID
export const getProfileByAnonymousId = query({
  args: { anonymousId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userProfiles")
      .withIndex("by_anonymousId", (q) => q.eq("anonymousId", args.anonymousId))
      .unique();
  },
});

// Get profile by auth user ID (tokenIdentifier)
export const getProfileByAuthUserId = query({
  args: { authUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", args.authUserId))
      .unique();
  },
});

// Get the currently authenticated user's profile
export const currentUserProfile = query({
  args: { anonymousId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity) {
      const tokenIdentifier = identity.tokenIdentifier;

      // Authenticated user - find their profile
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_authUserId", (q) => q.eq("authUserId", tokenIdentifier))
        .unique();
      if (profile) {
        // Prefer Convex-stored image over hotlinked Google URL
        const storedImageUrl = profile.profileImageStorageId
          ? await ctx.storage.getUrl(profile.profileImageStorageId)
          : null;
        const resolvedImage = storedImageUrl ?? identity.pictureUrl;
        return {
          ...profile,
          isAuthenticated: true as const,
          authType: "sso" as const,
          ssoName: identity.name,
          ssoEmail: identity.email,
          ssoImage: resolvedImage,
        };
      }

      // Auth user exists but profile hasn't been linked yet (merge in progress).
      // Check if the anonymous profile exists and return it with SSO info.
      if (args.anonymousId) {
        const anonProfile = await ctx.db
          .query("userProfiles")
          .withIndex("by_anonymousId", (q) =>
            q.eq("anonymousId", args.anonymousId)
          )
          .unique();
        if (anonProfile) {
          const storedImageUrl = anonProfile.profileImageStorageId
            ? await ctx.storage.getUrl(anonProfile.profileImageStorageId)
            : null;
          const resolvedImage = storedImageUrl ?? identity.pictureUrl;
          return {
            ...anonProfile,
            isAuthenticated: true as const,
            authType: "sso" as const,
            ssoName: identity.name,
            ssoEmail: identity.email,
            ssoImage: resolvedImage,
          };
        }
      }

      // No profile at all yet — return SSO info so the UI can render
      return {
        _id: undefined as unknown as Id<"userProfiles">,
        displayName: identity.name ?? identity.email ?? "User",
        email: identity.email,
        profileImageUrl: identity.pictureUrl,
        timezone: "UTC",
        weekStartDay: 0,
        dstNotifications: true,
        isAuthenticated: true as const,
        authType: "sso" as const,
        ssoName: identity.name,
        ssoEmail: identity.email,
        ssoImage: identity.pictureUrl,
      };
    }

    // Fall back to anonymous profile
    if (args.anonymousId) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_anonymousId", (q) =>
          q.eq("anonymousId", args.anonymousId)
        )
        .unique();
      if (profile) {
        return {
          ...profile,
          isAuthenticated: false as const,
          authType: "anonymous" as const,
          ssoName: undefined as string | undefined,
          ssoEmail: undefined as string | undefined,
          ssoImage: undefined as string | undefined,
        };
      }
    }

    return null;
  },
});

// Update user profile
export const updateProfile = mutation({
  args: {
    anonymousId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    timezone: v.optional(v.string()),
    weekStartDay: v.optional(v.number()),
    dstNotifications: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const profile = await getProfileForSettings(ctx, args.anonymousId);
    const cleanUpdates: Record<string, unknown> = {};
    if (args.displayName !== undefined) cleanUpdates.displayName = args.displayName;
    if (args.timezone !== undefined) cleanUpdates.timezone = args.timezone;
    if (args.weekStartDay !== undefined)
      cleanUpdates.weekStartDay = args.weekStartDay;
    if (args.dstNotifications !== undefined)
      cleanUpdates.dstNotifications = args.dstNotifications;

    await ctx.db.patch(profile._id, cleanUpdates);
  },
});

// Merge anonymous user into authenticated user
export const mergeAnonymousToAuth = mutation({
  args: {
    anonymousId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const tokenIdentifier = identity.tokenIdentifier;
    const email = identity.email;
    const profileImageUrl = identity.pictureUrl;
    const displayName = identity.name;

    // Check if auth user already has a profile
    const existingAuthProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", tokenIdentifier))
      .unique();

    // Find anonymous profile
    const anonProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_anonymousId", (q) =>
        q.eq("anonymousId", args.anonymousId)
      )
      .unique();

    if (existingAuthProfile && anonProfile) {
      // Both exist - merge anon selections into auth profile
      await moveProfileData(ctx, anonProfile._id, existingAuthProfile._id);

      // Inherit anon display name if auth profile has no custom one
      if (anonProfile.displayName && !existingAuthProfile.displayName) {
        await ctx.db.patch(existingAuthProfile._id, {
          displayName: anonProfile.displayName,
          email,
          profileImageUrl,
        });
      } else {
        await ctx.db.patch(existingAuthProfile._id, {
          email,
          profileImageUrl,
        });
      }

      // Delete anonymous profile
      await ctx.db.delete(anonProfile._id);

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: existingAuthProfile._id, imageUrl: profileImageUrl }
        );
      }

      return existingAuthProfile._id;
    } else if (anonProfile) {
      // Only anon exists - upgrade it to authenticated
      await ctx.db.patch(anonProfile._id, {
        authUserId: tokenIdentifier,
        email,
        profileImageUrl,
        displayName: anonProfile.displayName || displayName || "User",
      });

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: anonProfile._id, imageUrl: profileImageUrl }
        );
      }
      return anonProfile._id;
    } else {
      // No anon profile - create new auth profile
      const newProfileId = await ctx.db.insert("userProfiles", {
        authUserId: tokenIdentifier,
        displayName: displayName || "User",
        email,
        profileImageUrl,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        weekStartDay: 0,
        dstNotifications: true,
      });

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: newProfileId, imageUrl: profileImageUrl }
        );
      }
      return newProfileId;
    }
  },
});

// Create or get authenticated profile (called after Google sign-in)
export const ensureAuthProfile = mutation({
  args: {
    anonymousId: v.optional(v.string()),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const tokenIdentifier = identity.tokenIdentifier;
    const email = identity.email;
    const profileImageUrl = identity.pictureUrl;
    const displayName = identity.name;

    // Check if auth user already has a profile
    let authProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", tokenIdentifier))
      .unique();

    // Find anonymous profile if anonymousId provided
    let anonProfile = args.anonymousId
      ? await ctx.db
          .query("userProfiles")
          .withIndex("by_anonymousId", (q) =>
            q.eq("anonymousId", args.anonymousId)
          )
          .unique()
      : null;

    if (authProfile && anonProfile && authProfile._id !== anonProfile._id) {
      // Merge: move all anon data to auth profile
      await moveProfileData(ctx, anonProfile._id, authProfile._id);

      // Inherit display name from anon if it was set
      if (anonProfile.displayName) {
        await ctx.db.patch(authProfile._id, {
          displayName: anonProfile.displayName,
          email,
          profileImageUrl,
        });
      } else {
        await ctx.db.patch(authProfile._id, {
          email,
          profileImageUrl,
        });
      }

      await ctx.db.delete(anonProfile._id);

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: authProfile._id, imageUrl: profileImageUrl }
        );
      }
      return authProfile._id;
    } else if (anonProfile && !authProfile) {
      // Upgrade anon to auth
      await ctx.db.patch(anonProfile._id, {
        authUserId: tokenIdentifier,
        email,
        profileImageUrl,
      });

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: anonProfile._id, imageUrl: profileImageUrl }
        );
      }
      return anonProfile._id;
    } else if (authProfile) {
      // Already have auth profile, update email/image
      await ctx.db.patch(authProfile._id, {
        email: email ?? authProfile.email,
        profileImageUrl: profileImageUrl ?? authProfile.profileImageUrl,
      });

      // Always re-download on sign-in to pick up any profile picture changes
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: authProfile._id, imageUrl: profileImageUrl }
        );
      }
      return authProfile._id;
    } else {
      // Create new
      const newProfileId = await ctx.db.insert("userProfiles", {
        authUserId: tokenIdentifier,
        displayName: displayName || "User",
        email,
        profileImageUrl,
        timezone: args.timezone,
        weekStartDay: 0,
        dstNotifications: true,
      });

      // Schedule background download of Google profile image into Convex storage
      if (profileImageUrl) {
        await ctx.scheduler.runAfter(
          0,
          internal.profileImages.downloadAndStoreProfileImage,
          { profileId: newProfileId, imageUrl: profileImageUrl }
        );
      }
      return newProfileId;
    }
  },
});

// Unlink SSO and convert back to anonymous/cookie-based account
export const unlinkSso = mutation({
  args: {
    newAnonymousId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) =>
        q.eq("authUserId", identity.tokenIdentifier)
      )
      .unique();

    if (!profile) throw new Error("Profile not found");
    if (!profile.authUserId) throw new Error("Profile is not linked to SSO");

    const ssoName = identity.name;

    // Clean up stored profile image from Convex storage
    if (profile.profileImageStorageId) {
      await ctx.storage.delete(profile.profileImageStorageId);
    }

    const updates: Record<string, unknown> = {
      authUserId: undefined,
      anonymousId: args.newAnonymousId,
      email: undefined,
      profileImageUrl: undefined,
      profileImageStorageId: undefined,
    };

    // If display name was cleared (to use SSO name), restore the SSO name
    if (!profile.displayName || profile.displayName.trim() === "") {
      updates.displayName = ssoName || "Anonymous";
    }

    await ctx.db.patch(profile._id, updates);

    return { displayName: (updates.displayName as string) || profile.displayName };
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

    const tokenIdentifier = identity.tokenIdentifier;

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", tokenIdentifier))
      .unique();
    if (!profile) return;

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

// Get a profile by ID
export const getProfile = query({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.profileId);
  },
});

// Get multiple profiles by IDs
export const getProfiles = query({
  args: { profileIds: v.array(v.id("userProfiles")) },
  handler: async (ctx, args) => {
    const profiles = await Promise.all(
      args.profileIds.map((id) => ctx.db.get(id))
    );
    return profiles.filter(Boolean);
  },
});
