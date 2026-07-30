import { v } from "convex/values";
import { DateTime } from "luxon";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { cellKey, convertCellToTimezone } from "./timezone";

type SavedAvailabilitySlot = {
  dayKey: string;
  timeSlot: string;
  state: "can-do" | "cant-do" | "maybe";
};

async function requireAuthenticatedProfile(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"userProfiles">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_authUserId", (q) =>
      q.eq("authUserId", identity.tokenIdentifier)
    )
    .unique();

  if (!profile) throw new Error("Authenticated profile not found");
  return profile;
}

async function requireOwnedSavedAvailability(
  ctx: QueryCtx | MutationCtx,
  savedAvailabilityId: Id<"savedAvailabilities">,
  profileId: Id<"userProfiles">
): Promise<Doc<"savedAvailabilities">> {
  const savedAvail = await ctx.db.get(savedAvailabilityId);
  if (!savedAvail) throw new Error("Saved availability not found");
  if (savedAvail.profileId !== profileId) throw new Error("Not authorized");
  return savedAvail;
}

function sameProfile(
  left: Id<"userProfiles">,
  right: Id<"userProfiles">
): boolean {
  return left === right;
}

// List saved availabilities for the authenticated profile
export const listForProfile = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireAuthenticatedProfile(ctx);

    return await ctx.db
      .query("savedAvailabilities")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .collect();
  },
});

// Get availability link for a schedule and the authenticated profile
export const getLinkForSchedule = query({
  args: {
    scheduleId: v.id("schedules"),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);

    const link = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .unique();

    if (!link) return null;

    const savedAvail = await requireOwnedSavedAvailability(
      ctx,
      link.savedAvailabilityId,
      profile._id
    );

    return {
      linkId: link._id,
      savedAvailabilityId: link.savedAvailabilityId,
      savedAvailabilityName: savedAvail.name,
    };
  },
});

// Helper: get effective current recurring slots for a profile on a schedule
async function getEffectiveSlots(
  ctx: { db: MutationCtx["db"] },
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  targetTimezone: string
): Promise<SavedAvailabilitySlot[]> {
  const referenceDate = DateTime.now().setZone(targetTimezone);
  const normalizeSlots = (
    entries: { slot: SavedAvailabilitySlot; timezone: string }[]
  ) => {
    const normalized = new Map<string, SavedAvailabilitySlot>();
    for (const { slot, timezone } of entries) {
      const converted = convertCellToTimezone(
        "recurring",
        slot,
        timezone,
        targetTimezone,
        referenceDate
      );
      normalized.set(cellKey(converted), {
        dayKey: converted.dayKey,
        timeSlot: converted.timeSlot,
        state: slot.state,
      });
    }
    return [...normalized.values()];
  };

  // Check if linked to a saved availability
  const existingLink = await ctx.db
    .query("availabilityLinks")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .unique();

  if (existingLink) {
    const linkedAvail = await ctx.db.get(existingLink.savedAvailabilityId);
    if (linkedAvail && sameProfile(linkedAvail.profileId, profileId)) {
      return normalizeSlots(
        linkedAvail.slots.map((slot) => ({
          slot,
          timezone: linkedAvail.timezone,
        }))
      );
    }
    return [];
  }

  // Not linked - get from selections
  const selections = await ctx.db
    .query("selections")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .collect();

  const recurringSelections = selections.filter((s) => !s.isException);
  return normalizeSlots(
    recurringSelections.map((selection) => ({
      slot: {
        dayKey: selection.dayKey,
        timeSlot: selection.timeSlot,
        state: selection.state,
      },
      timezone: selection.timezone,
    }))
  );
}

// Save current schedule selections as a new saved availability and link it
export const saveNewAndLink = mutation({
  args: {
    scheduleId: v.id("schedules"),
    name: v.string(),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);

    // Get effective current slots
    const slots = await getEffectiveSlots(
      ctx,
      args.scheduleId,
      profile._id,
      args.timezone
    );

    // Remove existing link if any (without copying back)
    const existingLink = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .unique();
    if (existingLink) {
      await ctx.db.delete(existingLink._id);
    }

    // Delete non-exception selections (they'll be served by the saved availability)
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .collect();
    for (const sel of selections) {
      if (!sel.isException) {
        await ctx.db.delete(sel._id);
      }
    }

    // Create saved availability
    const savedAvailId = await ctx.db.insert("savedAvailabilities", {
      profileId: profile._id,
      name: args.name,
      timezone: args.timezone,
      slots,
    });

    // Create link
    await ctx.db.insert("availabilityLinks", {
      savedAvailabilityId: savedAvailId,
      scheduleId: args.scheduleId,
      profileId: profile._id,
    });

    return savedAvailId;
  },
});

// Save/overwrite the default availability from current schedule and link it
export const saveOverwriteDefaultAndLink = mutation({
  args: {
    scheduleId: v.id("schedules"),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);

    // Get effective current slots
    const slots = await getEffectiveSlots(
      ctx,
      args.scheduleId,
      profile._id,
      args.timezone
    );

    // Remove existing link if any (without copying back)
    const existingLink = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .unique();
    if (existingLink) {
      await ctx.db.delete(existingLink._id);
    }

    // Delete non-exception selections
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .collect();
    for (const sel of selections) {
      if (!sel.isException) {
        await ctx.db.delete(sel._id);
      }
    }

    // Find or create default availability
    const allSaved = await ctx.db
      .query("savedAvailabilities")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .collect();
    const existingDefault = allSaved.find((s) => s.isDefault === true);

    let savedAvailId: Id<"savedAvailabilities">;
    if (existingDefault) {
      await ctx.db.patch(existingDefault._id, {
        slots,
        timezone: args.timezone,
      });
      savedAvailId = existingDefault._id;
    } else {
      savedAvailId = await ctx.db.insert("savedAvailabilities", {
        profileId: profile._id,
        name: "Default",
        isDefault: true,
        timezone: args.timezone,
        slots,
      });
    }

    // Create link
    await ctx.db.insert("availabilityLinks", {
      savedAvailabilityId: savedAvailId,
      scheduleId: args.scheduleId,
      profileId: profile._id,
    });

    return savedAvailId;
  },
});

// Apply (link) an existing saved availability to a schedule
export const applyToSchedule = mutation({
  args: {
    savedAvailabilityId: v.id("savedAvailabilities"),
    scheduleId: v.id("schedules"),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);
    await requireOwnedSavedAvailability(
      ctx,
      args.savedAvailabilityId,
      profile._id
    );

    // Remove existing link if any
    const existingLink = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .unique();
    if (existingLink) {
      await ctx.db.delete(existingLink._id);
    }

    // Delete non-exception selections (replaced by saved availability)
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .collect();
    for (const sel of selections) {
      if (!sel.isException) {
        await ctx.db.delete(sel._id);
      }
    }

    // Create link
    await ctx.db.insert("availabilityLinks", {
      savedAvailabilityId: args.savedAvailabilityId,
      scheduleId: args.scheduleId,
      profileId: profile._id,
    });
  },
});

// Unlink a saved availability from a schedule (copies slots back to selections)
export const unlinkFromSchedule = mutation({
  args: {
    scheduleId: v.id("schedules"),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);

    const link = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", profile._id)
      )
      .unique();

    if (!link) return;

    // Get the saved availability to copy slots back
    const savedAvail = await requireOwnedSavedAvailability(
      ctx,
      link.savedAvailabilityId,
      profile._id
    );

    for (const slot of savedAvail.slots) {
      await ctx.db.insert("selections", {
        scheduleId: args.scheduleId,
        profileId: profile._id,
        dayKey: slot.dayKey,
        timeSlot: slot.timeSlot,
        timezone: savedAvail.timezone,
        state: slot.state,
      });
    }

    // Delete the link
    await ctx.db.delete(link._id);
  },
});

// Delete a saved availability (unlinks from all schedules, copying slots back)
export const deleteSaved = mutation({
  args: {
    savedAvailabilityId: v.id("savedAvailabilities"),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);
    const savedAvail = await requireOwnedSavedAvailability(
      ctx,
      args.savedAvailabilityId,
      profile._id
    );

    // Unlink from all schedules, copying slots back
    const links = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_savedAvailability", (q) =>
        q.eq("savedAvailabilityId", args.savedAvailabilityId)
      )
      .collect();

    for (const link of links) {
      if (sameProfile(link.profileId, profile._id)) {
        for (const slot of savedAvail.slots) {
          await ctx.db.insert("selections", {
            scheduleId: link.scheduleId,
            profileId: profile._id,
            dayKey: slot.dayKey,
            timeSlot: slot.timeSlot,
            timezone: savedAvail.timezone,
            state: slot.state,
          });
        }
      }
      await ctx.db.delete(link._id);
    }

    // Delete the saved availability
    await ctx.db.delete(args.savedAvailabilityId);
  },
});

// Rename a saved availability
export const renameSaved = mutation({
  args: {
    savedAvailabilityId: v.id("savedAvailabilities"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);
    await requireOwnedSavedAvailability(
      ctx,
      args.savedAvailabilityId,
      profile._id
    );

    await ctx.db.patch(args.savedAvailabilityId, { name: args.name });
  },
});

// Get linked schedule count for a saved availability
export const getLinkedScheduleCount = query({
  args: { savedAvailabilityId: v.id("savedAvailabilities") },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);
    await requireOwnedSavedAvailability(
      ctx,
      args.savedAvailabilityId,
      profile._id
    );

    const links = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_savedAvailability", (q) =>
        q.eq("savedAvailabilityId", args.savedAvailabilityId)
      )
      .collect();
    return links.length;
  },
});
