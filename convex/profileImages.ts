import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const PROFILE_IMAGE_BACKFILL_BATCH_SIZE = 25;

// Internal mutation to update profile with the stored image's storage ID
export const updateProfileImage = internalMutation({
  args: {
    profileId: v.id("userProfiles"),
    storageId: v.id("_storage"),
    sourceUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) return;

    // Clean up the old stored image if it exists
    if (
      profile.profileImageStorageId &&
      profile.profileImageStorageId !== args.storageId
    ) {
      await ctx.storage.delete(profile.profileImageStorageId);
    }

    await ctx.db.patch(args.profileId, {
      profileImageStorageId: args.storageId,
      // Keep profileImageUrl in sync so we can detect changes on next sign-in
      profileImageUrl: args.sourceUrl,
      profileImageLastCheckedAt: Date.now(),
    });
  },
});

/**
 * Internal action to download a Google profile image and store it in Convex
 * file storage. This runs server-side (from Convex's infrastructure), so it
 * avoids the browser-side rate-limiting (429) that Google applies to
 * hotlinked lh3.googleusercontent.com URLs.
 *
 * Scheduled from ensureProfile after sign-in.
 */
export const downloadAndStoreProfileImage = internalAction({
  args: {
    profileId: v.id("userProfiles"),
    imageUrl: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const response = await fetch(args.imageUrl);
      if (!response.ok) {
        console.error(
          `Failed to fetch profile image for ${args.profileId}: HTTP ${response.status}`
        );
        return;
      }

      const blob = await response.blob();
      const storageId = await ctx.storage.store(blob);

      await ctx.runMutation(internal.profileImages.updateProfileImage, {
        profileId: args.profileId,
        storageId,
        sourceUrl: args.imageUrl,
      });
    } catch (error) {
      console.error(
        `Error downloading profile image for ${args.profileId}:`,
        error
      );
    }
  },
});

// --- One-time backfill for existing profiles ---

// Internal query to find profiles that have a Google image URL but no stored image
export const getProfilesNeedingImageBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_profileImageStorageId_and_profileImageUrl", (q) =>
        q.eq("profileImageStorageId", undefined).gt("profileImageUrl", "")
      )
      .take(PROFILE_IMAGE_BACKFILL_BATCH_SIZE);

    return profiles
      .map((p) => ({ profileId: p._id, imageUrl: p.profileImageUrl! }));
  },
});

/**
 * One-time backfill action: downloads and stores profile images for all
 * existing users who have a Google image URL but no cached copy in Convex storage.
 *
 * Run from the Convex dashboard:
 *   npx convex run profileImages:backfillAllProfileImages
 *
 * Safe to run multiple times — it skips profiles that already have a stored image.
 */
export const backfillAllProfileImages = internalAction({
  args: {},
  handler: async (ctx) => {
    const profiles: { profileId: Id<"userProfiles">; imageUrl: string }[] =
      await ctx.runQuery(
        internal.profileImages.getProfilesNeedingImageBackfill,
        {}
      );

    console.log(
      `Backfilling profile images for ${profiles.length} profiles...`
    );

    let success = 0;
    let failed = 0;
    for (const { profileId, imageUrl } of profiles) {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          console.error(
            `Failed to fetch image for ${profileId}: HTTP ${response.status}`
          );
          failed++;
          continue;
        }

        const blob = await response.blob();
        const storageId = await ctx.storage.store(blob);

        await ctx.runMutation(internal.profileImages.updateProfileImage, {
          profileId,
          storageId,
          sourceUrl: imageUrl,
        });
        success++;
      } catch (error) {
        console.error(`Error backfilling image for ${profileId}:`, error);
        failed++;
      }
    }

    console.log(
      `Backfill complete: ${success} succeeded, ${failed} failed out of ${profiles.length} total`
    );

    if (profiles.length === PROFILE_IMAGE_BACKFILL_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.profileImages.backfillAllProfileImages,
        {}
      );
    }
  },
});
