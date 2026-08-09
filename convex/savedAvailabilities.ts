import { v } from "convex/values";
import { DateTime } from "luxon";
import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { cellKey, convertCellToTimezone } from "./timezone";
import { requireGoogleProfile } from "./lib/auth";

const SELECTION_DELETE_BATCH_SIZE = 500;
const EFFECTIVE_SELECTION_LIMIT = 2000;
const AVAILABILITY_LINK_BATCH_SIZE = 10;

type SavedAvailabilitySlot = {
  dayKey: string;
  timeSlot: string;
  state: "can-do" | "cant-do" | "maybe";
};

async function requireAuthenticatedProfile(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"userProfiles">> {
  return await requireGoogleProfile(ctx);
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

// Same participation gate as selections.ts. Every mutation in this file acts on
// the authenticated profile itself, so the actor is the creator exactly when the
// target profile is, and the creator is never denied their own schedule.
async function isParticipationDenied(
  ctx: MutationCtx,
  schedule: Doc<"schedules">,
  profileId: Id<"userProfiles">
): Promise<boolean> {
  if (sameProfile(schedule.creatorProfileId, profileId)) return false;

  if (schedule.acceptParticipation === false) return true;

  const blocked = await ctx.db
    .query("blockedProfiles")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", schedule._id).eq("profileId", profileId)
    )
    .unique();
  return blocked !== null;
}

// Disallowed slots and one-off date ranges are expressed in the schedule's
// immutable creatorTimezone, so saved slots must be converted into those
// coordinates before they can be compared.
function allowedSlotsForSchedule(
  schedule: Doc<"schedules">,
  slots: SavedAvailabilitySlot[],
  slotsTimezone: string
): SavedAvailabilitySlot[] {
  const referenceDate = DateTime.now().setZone(schedule.creatorTimezone);
  const disallowed = schedule.disallowedSlots;

  return slots.filter((slot) => {
    const scheduleCell = convertCellToTimezone(
      schedule.type,
      slot,
      slotsTimezone,
      schedule.creatorTimezone,
      referenceDate
    );

    if (
      disallowed?.some(
        (s) =>
          s.dayKey === scheduleCell.dayKey &&
          s.timeSlot === scheduleCell.timeSlot
      )
    ) {
      return false;
    }

    if (
      schedule.type === "one-off" &&
      schedule.dateRangeStart &&
      schedule.dateRangeEnd &&
      (scheduleCell.dayKey < schedule.dateRangeStart ||
        scheduleCell.dayKey > schedule.dateRangeEnd)
    ) {
      return false;
    }

    return true;
  });
}

// Copy a saved availability's slots back into the schedule's selections,
// dropping anything the schedule does not accept from this profile.
async function copySlotsToSelections(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  savedAvail: Doc<"savedAvailabilities">
) {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule) return;
  if (await isParticipationDenied(ctx, schedule, profileId)) return;

  const slots = allowedSlotsForSchedule(
    schedule,
    savedAvail.slots,
    savedAvail.timezone
  );

  for (const slot of slots) {
    await ctx.db.insert("selections", {
      scheduleId,
      profileId,
      dayKey: slot.dayKey,
      timeSlot: slot.timeSlot,
      timezone: savedAvail.timezone,
      state: slot.state,
    });
  }
}

// Delete the profile's recurring selections one page at a time; exceptions are
// kept because they are not served by the saved availability.
async function deleteRecurringSelectionsBatch(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  cursor: string | null
) {
  const page = await ctx.db
    .query("selections")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .paginate({ numItems: SELECTION_DELETE_BATCH_SIZE, cursor });

  for (const sel of page.page) {
    if (!sel.isException) {
      await ctx.db.delete(sel._id);
    }
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.savedAvailabilities.continueDeleteRecurringSelections,
      { scheduleId, profileId, cursor: page.continueCursor }
    );
  }
}

export const continueDeleteRecurringSelections = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await deleteRecurringSelectionsBatch(
      ctx,
      args.scheduleId,
      args.profileId,
      args.cursor
    );
  },
});

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
    .take(EFFECTIVE_SELECTION_LIMIT);

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

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) throw new Error("Schedule not found");

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, schedule, profile._id)) {
      return null;
    }

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
    await deleteRecurringSelectionsBatch(
      ctx,
      args.scheduleId,
      profile._id,
      null
    );

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

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) throw new Error("Schedule not found");

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, schedule, profile._id)) {
      return null;
    }

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
    await deleteRecurringSelectionsBatch(
      ctx,
      args.scheduleId,
      profile._id,
      null
    );

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

    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) throw new Error("Schedule not found");

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, schedule, profile._id)) {
      return;
    }

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
    await deleteRecurringSelectionsBatch(
      ctx,
      args.scheduleId,
      profile._id,
      null
    );

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

    await copySlotsToSelections(ctx, args.scheduleId, profile._id, savedAvail);

    // Delete the link
    await ctx.db.delete(link._id);
  },
});

// Unlink from all schedules a page at a time, copying slots back. The saved
// availability is only removed once every link has been processed, so the
// continuation can still read its slots.
async function processDeleteSavedBatch(
  ctx: MutationCtx,
  savedAvailabilityId: Id<"savedAvailabilities">,
  profileId: Id<"userProfiles">,
  cursor: string | null
) {
  const savedAvail = await ctx.db.get(savedAvailabilityId);
  if (!savedAvail || !sameProfile(savedAvail.profileId, profileId)) return;

  const page = await ctx.db
    .query("availabilityLinks")
    .withIndex("by_savedAvailability", (q) =>
      q.eq("savedAvailabilityId", savedAvailabilityId)
    )
    .paginate({ numItems: AVAILABILITY_LINK_BATCH_SIZE, cursor });

  for (const link of page.page) {
    if (sameProfile(link.profileId, profileId)) {
      await copySlotsToSelections(ctx, link.scheduleId, profileId, savedAvail);
    }
    await ctx.db.delete(link._id);
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.savedAvailabilities.continueDeleteSaved,
      { savedAvailabilityId, profileId, cursor: page.continueCursor }
    );
    return;
  }

  await ctx.db.delete(savedAvailabilityId);
}

export const continueDeleteSaved = internalMutation({
  args: {
    savedAvailabilityId: v.id("savedAvailabilities"),
    profileId: v.id("userProfiles"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await processDeleteSavedBatch(
      ctx,
      args.savedAvailabilityId,
      args.profileId,
      args.cursor
    );
  },
});

// Delete a saved availability (unlinks from all schedules, copying slots back)
export const deleteSaved = mutation({
  args: {
    savedAvailabilityId: v.id("savedAvailabilities"),
  },
  handler: async (ctx, args) => {
    const profile = await requireAuthenticatedProfile(ctx);
    await requireOwnedSavedAvailability(
      ctx,
      args.savedAvailabilityId,
      profile._id
    );

    await processDeleteSavedBatch(
      ctx,
      args.savedAvailabilityId,
      profile._id,
      null
    );
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
