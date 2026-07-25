import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { hasScheduleParticipation } from "./scheduleMemberships";

const DEFAULT_DISCORD_DEBOUNCE_MS = 5 * 60 * 1000;
const SCHEDULE_LIST_LIMIT = 100;
const PROFILE_SELECTION_SCAN_LIMIT = 5000;
const PROFILE_AVAILABILITY_LINK_SCAN_LIMIT = 500;
const SCHEDULE_DETAIL_SELECTION_LIMIT = 5000;
const SCHEDULE_DETAIL_LINK_LIMIT = 500;
const SCHEDULE_DETAIL_BLOCKED_PROFILE_LIMIT = 1000;
const SCHEDULE_CLEANUP_BATCH_SIZE = 500;
const SCHEDULE_TYPE_CONVERSION_SELECTION_LIMIT = 5000;
const DISCORD_LINK_NOTIFY_BATCH_SIZE = 100;

function getDiscordDebounceMs(): number {
  const raw = process.env.DISCORD_DEBOUNCE_MS;
  if (!raw) return DEFAULT_DISCORD_DEBOUNCE_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DISCORD_DEBOUNCE_MS;
}

/** Force-queues a debounced Discord update — used when the lock state itself changes. */
async function notifyDiscordForceQueue(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">
) {
  return await processDiscordForceQueueBatch(ctx, scheduleId, null);
}

async function queueDiscordUpdatesForLinks(
  ctx: MutationCtx,
  links: Doc<"scheduleDiscordLinks">[]
) {
  const debounceMs = getDiscordDebounceMs();
  for (const link of links) {
    if (link.pendingScheduledId) {
      try {
        await ctx.scheduler.cancel(link.pendingScheduledId);
      } catch {
        // already fired
      }
    }
    const newId = await ctx.scheduler.runAfter(
      debounceMs,
      internal.discord.sendDebouncedUpdate,
      { linkId: link._id }
    );
    await ctx.db.patch(link._id, { pendingScheduledId: newId });
  }
}

async function processDiscordForceQueueBatch(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  cursor: string | null
) {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule) return { processed: 0, scheduled: false };

  const page = await ctx.db
    .query("scheduleDiscordLinks")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .paginate({ numItems: DISCORD_LINK_NOTIFY_BATCH_SIZE, cursor });

  await queueDiscordUpdatesForLinks(ctx, page.page);

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.schedules.continueDiscordForceQueue,
      {
        scheduleId,
        cursor: page.continueCursor,
      }
    );
  }

  return { processed: page.page.length, scheduled: !page.isDone };
}

async function invalidateSelectionBatchesForProfile(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">
) {
  await ctx.db.insert("selectionBatchInvalidations", {
    scheduleId,
    profileId,
    invalidatedAt: Date.now(),
  });
}

export const continueDiscordForceQueue = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    return await processDiscordForceQueueBatch(
      ctx,
      args.scheduleId,
      args.cursor
    );
  },
});

/**
 * Get the JS day-of-week (0=Sunday, 6=Saturday) from an ISO date string.
 * Uses UTC to avoid any local timezone influence — the ISO date string
 * already represents the correct local date for the user.
 */
function getDayOfWeekFromISODate(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDay();
}

async function getCallerProfile(
  ctx: MutationCtx | QueryCtx,
  anonymousId?: string
): Promise<Doc<"userProfiles"> | null> {
  const identity = await ctx.auth.getUserIdentity();

  if (identity) {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) =>
        q.eq("authUserId", identity.tokenIdentifier)
      )
      .unique();
    if (profile) return profile;
  }

  if (!anonymousId) return null;

  return await ctx.db
    .query("userProfiles")
    .withIndex("by_anonymousId", (q) => q.eq("anonymousId", anonymousId))
    .unique();
}

async function requireCallerProfile(
  ctx: MutationCtx | QueryCtx,
  anonymousId?: string
): Promise<Doc<"userProfiles">> {
  const profile = await getCallerProfile(ctx, anonymousId);
  if (!profile) throw new Error("Unauthorized");
  return profile;
}

async function requireScheduleCreator(
  ctx: MutationCtx | QueryCtx,
  schedule: Doc<"schedules">,
  anonymousId?: string
): Promise<Doc<"userProfiles">> {
  const caller = await requireCallerProfile(ctx, anonymousId);
  if (caller._id !== schedule.creatorProfileId) {
    throw new Error("Unauthorized");
  }
  return caller;
}

async function canLockSchedule(
  ctx: MutationCtx,
  schedule: Doc<"schedules">,
  anonymousId?: string
): Promise<boolean> {
  if (schedule.anyoneCanLock) return true;

  const caller = await getCallerProfile(ctx, anonymousId);
  if (!caller) return false;

  return (
    caller._id === schedule.creatorProfileId ||
    (schedule.lockEditors ?? []).includes(caller._id)
  );
}

function isPastOneOffSchedule(
  schedule: Doc<"schedules">,
  currentDate: string
): boolean {
  return (
    schedule.type === "one-off" &&
    schedule.dateRangeEnd !== undefined &&
    schedule.dateRangeEnd < currentDate
  );
}

function sortSchedulesAlphabetically(
  schedules: Doc<"schedules">[]
): Doc<"schedules">[] {
  return schedules.sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      a.createdAt - b.createdAt
  );
}

async function enrichSchedule(
  ctx: QueryCtx,
  schedule: Doc<"schedules">,
  state: {
    isParticipated: boolean;
    isArchived: boolean;
    isExpired: boolean;
    isManuallyArchived: boolean;
  }
) {
  const creator = await ctx.db.get(schedule.creatorProfileId);
  const storedImageUrl = creator?.profileImageStorageId
    ? await ctx.storage.getUrl(creator.profileImageStorageId)
    : null;

  return {
    ...schedule,
    ...state,
    creatorName: creator?.displayName ?? "Unknown",
    creatorImage: storedImageUrl ?? creator?.profileImageUrl,
  };
}

// List current public schedules plus schedules associated with the viewer.
export const list = query({
  args: {
    anonymousId: v.optional(v.string()),
    currentDate: v.string(),
  },
  handler: async (ctx, args) => {
    const explicitlyPublicSchedules = await ctx.db
      .query("schedules")
      .withIndex("by_isPrivate_and_createdAt", (q) =>
        q.eq("isPrivate", false)
      )
      .order("desc")
      .take(SCHEDULE_LIST_LIMIT);

    const legacyPublicSchedules = await ctx.db
      .query("schedules")
      .withIndex("by_isPrivate_and_createdAt", (q) =>
        q.eq("isPrivate", undefined)
      )
      .order("desc")
      .take(SCHEDULE_LIST_LIMIT);

    const listedSchedules = [
      ...explicitlyPublicSchedules,
      ...legacyPublicSchedules,
    ]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SCHEDULE_LIST_LIMIT);

    const viewer = await getCallerProfile(ctx, args.anonymousId);
    if (!viewer) {
      const publicSchedules = sortSchedulesAlphabetically(
        listedSchedules.filter(
          (schedule) => !isPastOneOffSchedule(schedule, args.currentDate)
        )
      );

      return {
        participated: [],
        publicSchedules: await Promise.all(
          publicSchedules.map((schedule) =>
            enrichSchedule(ctx, schedule, {
              isParticipated: false,
              isArchived: false,
              isExpired: false,
              isManuallyArchived: false,
            })
          )
        ),
        archived: [],
        hasArchived: false,
      };
    }

    const [
      createdSchedules,
      archiveRecords,
      selections,
      availabilityLinks,
    ] = await Promise.all([
      ctx.db
        .query("schedules")
        .withIndex("by_creatorProfileId", (q) =>
          q.eq("creatorProfileId", viewer._id)
        )
        .order("desc")
        .take(SCHEDULE_LIST_LIMIT),
      ctx.db
        .query("scheduleArchives")
        .withIndex("by_profileId", (q) => q.eq("profileId", viewer._id))
        .order("desc")
        .take(SCHEDULE_LIST_LIMIT),
      ctx.db
        .query("selections")
        .withIndex("by_profileId", (q) => q.eq("profileId", viewer._id))
        .take(PROFILE_SELECTION_SCAN_LIMIT),
      ctx.db
        .query("availabilityLinks")
        .withIndex("by_profileId", (q) => q.eq("profileId", viewer._id))
        .take(PROFILE_AVAILABILITY_LINK_SCAN_LIMIT),
    ]);

    const associatedScheduleIds = new Set<string>();
    for (const schedule of createdSchedules) {
      associatedScheduleIds.add(schedule._id);
    }
    for (const selection of selections) {
      associatedScheduleIds.add(selection.scheduleId);
    }
    const availabilityLinksWithNominations = await Promise.all(
      availabilityLinks.map(async (link) => ({
        link,
        savedAvailability: await ctx.db.get(link.savedAvailabilityId),
      }))
    );
    for (const { link, savedAvailability } of availabilityLinksWithNominations) {
      if ((savedAvailability?.slots.length ?? 0) > 0) {
        associatedScheduleIds.add(link.scheduleId);
      }
    }

    const listedScheduleIds = new Set(
      listedSchedules.map((schedule) => schedule._id as string)
    );
    const associatedSchedules = await Promise.all(
      [...associatedScheduleIds]
        .filter((scheduleId) => !listedScheduleIds.has(scheduleId))
        .map((scheduleId) =>
          ctx.db.get(scheduleId as Id<"schedules">)
        )
    );

    const candidateSchedules = new Map<string, Doc<"schedules">>();
    for (const schedule of listedSchedules) {
      candidateSchedules.set(schedule._id, schedule);
    }
    for (const schedule of associatedSchedules) {
      if (schedule) candidateSchedules.set(schedule._id, schedule);
    }

    const archiveByScheduleId = new Set(
      archiveRecords.map((record) => record.scheduleId as string)
    );
    const blockedScheduleIds = new Set<string>();
    await Promise.all(
      [...candidateSchedules.values()].map(async (schedule) => {
        if (schedule.creatorProfileId === viewer._id) return;
        const blocked = await ctx.db
          .query("blockedProfiles")
          .withIndex("by_schedule_profile", (q) =>
            q.eq("scheduleId", schedule._id).eq("profileId", viewer._id)
          )
          .unique();
        if (blocked) blockedScheduleIds.add(schedule._id);
      })
    );

    const participated: Doc<"schedules">[] = [];
    const publicSchedules: Doc<"schedules">[] = [];
    const archived: Doc<"schedules">[] = [];

    for (const schedule of candidateSchedules.values()) {
      if (blockedScheduleIds.has(schedule._id)) continue;

      const isParticipated = associatedScheduleIds.has(schedule._id);
      const isExpired = isPastOneOffSchedule(schedule, args.currentDate);
      const isManuallyArchived =
        isParticipated && archiveByScheduleId.has(schedule._id);
      const isArchived = isExpired || isManuallyArchived;

      if (isArchived) {
        if (isParticipated) archived.push(schedule);
      } else if (isParticipated) {
        participated.push(schedule);
      } else if (schedule.isPrivate !== true) {
        publicSchedules.push(schedule);
      }
    }

    const enrich = (
      schedule: Doc<"schedules">,
      isParticipated: boolean
    ) => {
      const isExpired = isPastOneOffSchedule(schedule, args.currentDate);
      const isManuallyArchived =
        isParticipated && archiveByScheduleId.has(schedule._id);
      return enrichSchedule(ctx, schedule, {
        isParticipated,
        isArchived: isExpired || isManuallyArchived,
        isExpired,
        isManuallyArchived,
      });
    };

    const [enrichedParticipated, enrichedPublic, enrichedArchived] =
      await Promise.all([
        Promise.all(
          sortSchedulesAlphabetically(participated)
            .slice(0, SCHEDULE_LIST_LIMIT)
            .map((schedule) => enrich(schedule, true))
        ),
        Promise.all(
          sortSchedulesAlphabetically(publicSchedules)
            .slice(0, SCHEDULE_LIST_LIMIT)
            .map((schedule) => enrich(schedule, false))
        ),
        Promise.all(
          sortSchedulesAlphabetically(archived)
            .slice(0, SCHEDULE_LIST_LIMIT)
            .map((schedule) => enrich(schedule, true))
        ),
      ]);

    return {
      participated: enrichedParticipated,
      publicSchedules: enrichedPublic,
      archived: enrichedArchived,
      hasArchived: enrichedArchived.length > 0,
    };
  },
});

export const getViewerScheduleState = query({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    currentDate: v.string(),
  },
  handler: async (ctx, args) => {
    const [schedule, viewer] = await Promise.all([
      ctx.db.get(args.scheduleId),
      getCallerProfile(ctx, args.anonymousId),
    ]);
    if (!schedule || !viewer) {
      return {
        canArchive: false,
        isArchived: false,
        isExpired: false,
        isManuallyArchived: false,
      };
    }

    const isCreator = schedule.creatorProfileId === viewer._id;
    const [isParticipant, blocked, archiveRecord] = await Promise.all([
      isCreator
        ? Promise.resolve(false)
        : hasScheduleParticipation(ctx, schedule._id, viewer._id),
      isCreator
        ? Promise.resolve(null)
        : ctx.db
            .query("blockedProfiles")
            .withIndex("by_schedule_profile", (q) =>
              q.eq("scheduleId", schedule._id).eq("profileId", viewer._id)
            )
            .unique(),
      ctx.db
        .query("scheduleArchives")
        .withIndex("by_schedule_profile", (q) =>
          q.eq("scheduleId", schedule._id).eq("profileId", viewer._id)
        )
        .unique(),
    ]);

    const canArchive = blocked === null && (isCreator || isParticipant);
    const isExpired = isPastOneOffSchedule(schedule, args.currentDate);
    const isManuallyArchived = canArchive && archiveRecord !== null;

    return {
      canArchive,
      isArchived: canArchive && (isExpired || isManuallyArchived),
      isExpired,
      isManuallyArchived,
    };
  },
});

export const setArchived = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    const [schedule, viewer] = await Promise.all([
      ctx.db.get(args.scheduleId),
      requireCallerProfile(ctx, args.anonymousId),
    ]);
    if (!schedule) throw new Error("Schedule not found");

    const isCreator = schedule.creatorProfileId === viewer._id;
    if (!isCreator) {
      const [isParticipant, blocked] = await Promise.all([
        hasScheduleParticipation(ctx, schedule._id, viewer._id),
        ctx.db
          .query("blockedProfiles")
          .withIndex("by_schedule_profile", (q) =>
            q.eq("scheduleId", schedule._id).eq("profileId", viewer._id)
          )
          .unique(),
      ]);
      if (!isParticipant || blocked) throw new Error("Unauthorized");
    }

    const existing = await ctx.db
      .query("scheduleArchives")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", schedule._id).eq("profileId", viewer._id)
      )
      .unique();

    if (args.archived) {
      if (existing) {
        await ctx.db.patch(existing._id, { archivedAt: Date.now() });
        return existing._id;
      }
      return await ctx.db.insert("scheduleArchives", {
        scheduleId: schedule._id,
        profileId: viewer._id,
        archivedAt: Date.now(),
      });
    }

    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

// Get a single schedule with all its selections (including virtual ones from linked availabilities)
export const get = query({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return null;

    const creator = await ctx.db.get(schedule.creatorProfileId);

    // Get all selections for this schedule
    let selections = await ctx.db
      .query("selections")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .take(SCHEDULE_DETAIL_SELECTION_LIMIT);

    // Get availability links for this schedule
    const links = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .take(SCHEDULE_DETAIL_LINK_LIMIT);

    const linkedProfileIds = new Set(links.map((l) => l.profileId.toString()));

    // Filter out non-exception selections for linked profiles
    // (their recurring data comes from the saved availability)
    if (links.length > 0) {
      selections = selections.filter((sel) => {
        if (linkedProfileIds.has(sel.profileId.toString())) {
          return sel.isException === true;
        }
        return true;
      });
    }

    // Build virtual selections from linked saved availabilities
    type VirtualSelection = {
      _id: string;
      scheduleId: typeof args.scheduleId;
      profileId: typeof schedule.creatorProfileId;
      dayKey: string;
      timeSlot: string;
      timezone: string;
      state: "can-do" | "cant-do" | "maybe";
      isException?: boolean;
      exceptionDate?: string;
    };
    const virtualSelections: VirtualSelection[] = [];

    // Collect link info for the frontend
    const availabilityLinkInfo: {
      profileId: string;
      savedAvailabilityId: string;
      savedAvailabilityName: string;
    }[] = [];

    for (const link of links) {
      const savedAvail = await ctx.db.get(link.savedAvailabilityId);
      if (!savedAvail) continue;

      availabilityLinkInfo.push({
        profileId: link.profileId,
        savedAvailabilityId: link.savedAvailabilityId,
        savedAvailabilityName: savedAvail.name,
      });

      for (const slot of savedAvail.slots) {
        virtualSelections.push({
          _id: `virtual_${link._id}_${slot.dayKey}_${slot.timeSlot}`,
          scheduleId: args.scheduleId,
          profileId: link.profileId,
          dayKey: slot.dayKey,
          timeSlot: slot.timeSlot,
          timezone: savedAvail.timezone,
          state: slot.state,
        });
      }
    }

    // Normalize selections to a common shape for the frontend
    const normalizedSelections = selections.map((s) => ({
      _id: s._id as string,
      scheduleId: s.scheduleId as string,
      profileId: s.profileId as string,
      dayKey: s.dayKey,
      timeSlot: s.timeSlot,
      timezone: s.timezone,
      state: s.state,
      isException: s.isException,
      exceptionDate: s.exceptionDate,
      source: s.source,
      externalEventId: s.externalEventId,
    }));

    const allSelections = [
      ...normalizedSelections,
      ...virtualSelections.map((v) => ({
        _id: v._id,
        scheduleId: v.scheduleId as string,
        profileId: v.profileId as string,
        dayKey: v.dayKey,
        timeSlot: v.timeSlot,
        timezone: v.timezone,
        state: v.state,
        isException: v.isException,
        exceptionDate: v.exceptionDate,
      })),
    ];

    // Get all unique profile IDs from all selections + linked profiles
    const profileIdSet = new Set<string>();
    for (const sel of allSelections) {
      profileIdSet.add(sel.profileId);
    }
    for (const link of links) {
      profileIdSet.add(link.profileId);
    }

    const profilesRaw = await Promise.all(
      [...profileIdSet].map(async (id) => {
        const profile = await ctx.db.get(id as Id<"userProfiles">);
        if (!profile) return null;
        // Prefer Convex-stored image over hotlinked Google URL
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
    const profiles = profilesRaw.filter((p) => p !== null);

    // Get blocked profiles for this schedule
    const blockedProfiles = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .take(SCHEDULE_DETAIL_BLOCKED_PROFILE_LIMIT);
    const blockedProfileIds = blockedProfiles.map((b) => b.profileId as string);

    // Prefer Convex-stored image over hotlinked Google URL for creator
    const creatorStoredImageUrl = creator?.profileImageStorageId
      ? await ctx.storage.getUrl(creator.profileImageStorageId)
      : null;

    return {
      ...schedule,
      creatorName: creator?.displayName ?? "Unknown",
      creatorImage: creatorStoredImageUrl ?? creator?.profileImageUrl,
      creatorTimezoneStored: creator?.timezone ?? schedule.creatorTimezone,
      selections: allSelections,
      profiles,
      availabilityLinks: availabilityLinkInfo,
      blockedProfileIds,
    };
  },
});

// Create a new schedule
export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    type: v.union(v.literal("one-off"), v.literal("recurring")),
    creatorProfileId: v.id("userProfiles"),
    anonymousId: v.optional(v.string()),
    dateRangeStart: v.optional(v.string()),
    dateRangeEnd: v.optional(v.string()),
    recurringStartDate: v.optional(v.string()),
    creatorTimezone: v.string(),
    isPrivate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const caller = await requireCallerProfile(ctx, args.anonymousId);
    if (caller._id !== args.creatorProfileId) {
      throw new Error("Unauthorized");
    }

    return await ctx.db.insert("schedules", {
      title: args.title,
      description: args.description,
      type: args.type,
      creatorProfileId: args.creatorProfileId,
      dateRangeStart: args.dateRangeStart,
      dateRangeEnd: args.dateRangeEnd,
      recurringStartDate: args.recurringStartDate,
      creatorTimezone: args.creatorTimezone,
      isPrivate: args.isPrivate,
      createdAt: Date.now(),
    });
  },
});

// Update schedule metadata (creator only)
export const update = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    type: v.optional(v.union(v.literal("one-off"), v.literal("recurring"))),
    dateRangeStart: v.optional(v.string()),
    dateRangeEnd: v.optional(v.string()),
    recurringStartDate: v.optional(v.string()),
    isPrivate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    const cleanUpdates: Record<string, unknown> = {};
    if (args.title !== undefined) cleanUpdates.title = args.title;
    if (args.description !== undefined) cleanUpdates.description = args.description;
    if (args.isPrivate !== undefined) cleanUpdates.isPrivate = args.isPrivate || undefined;

    // Type change: only one-off -> recurring is allowed
    if (args.type !== undefined && args.type !== schedule.type) {
      if (schedule.type === "recurring") {
        // Disallow recurring -> one-off
        return;
      }

      cleanUpdates.type = args.type;
      // Clear one-off specific fields
      cleanUpdates.dateRangeStart = undefined;
      cleanUpdates.dateRangeEnd = undefined;
      // Set recurring fields
      if (args.recurringStartDate !== undefined) {
        cleanUpdates.recurringStartDate = args.recurringStartDate;
      }

      // ── Convert selections from date-keyed to day-of-week-keyed ──
      //
      // One-off selections store dayKey as an ISO date ("2026-04-24")
      // with the timeSlot and timezone representing wall-clock time in
      // the user's timezone. Recurring selections store dayKey as a
      // day-of-week ("0"-"6"). The timeSlot and timezone are identical
      // in both formats, so we only need to convert the dayKey.
      //
      // When multiple dates map to the same (profileId, dow, timeSlot),
      // the most recent date's state wins since it best reflects the
      // user's current availability.
      const selections = await ctx.db
        .query("selections")
        .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
        .take(SCHEDULE_TYPE_CONVERSION_SELECTION_LIMIT + 1);

      if (selections.length > SCHEDULE_TYPE_CONVERSION_SELECTION_LIMIT) {
        throw new Error(
          "This schedule has too many selections to convert from one-off to recurring in one edit."
        );
      }

      // Group by (profileId, dow, timeSlot) to resolve conflicts
      const selectionMap = new Map<
        string,
        {
          profileId: Id<"userProfiles">;
          dow: number;
          timeSlot: string;
          timezone: string;
          state: "can-do" | "cant-do" | "maybe";
          sourceDate: string; // for conflict resolution
        }
      >();

      for (const sel of selections) {
        const dow = getDayOfWeekFromISODate(sel.dayKey);
        const key = `${sel.profileId}|${dow}|${sel.timeSlot}`;
        const existing = selectionMap.get(key);

        // Most recent date wins
        if (!existing || sel.dayKey > existing.sourceDate) {
          selectionMap.set(key, {
            profileId: sel.profileId,
            dow,
            timeSlot: sel.timeSlot,
            timezone: sel.timezone,
            state: sel.state,
            sourceDate: sel.dayKey,
          });
        }
      }

      // Delete all old selections
      for (const sel of selections) {
        await ctx.db.delete(sel._id);
      }

      // Insert converted recurring selections
      for (const [, converted] of selectionMap) {
        await ctx.db.insert("selections", {
          scheduleId: args.scheduleId,
          profileId: converted.profileId,
          dayKey: String(converted.dow),
          timeSlot: converted.timeSlot,
          timezone: converted.timezone,
          state: converted.state,
        });
      }

      // ── Convert disallowed slots ──
      // Union: if a (dow, timeSlot) was disallowed on any date, keep it.
      const currentDisallowed = schedule.disallowedSlots || [];
      const disallowedMap = new Map<
        string,
        { dayKey: string; timeSlot: string }
      >();
      for (const slot of currentDisallowed) {
        const dow = getDayOfWeekFromISODate(slot.dayKey);
        const key = `${dow}|${slot.timeSlot}`;
        disallowedMap.set(key, {
          dayKey: String(dow),
          timeSlot: slot.timeSlot,
        });
      }
      cleanUpdates.disallowedSlots = [...disallowedMap.values()];

      // ── Convert locked slots ──
      // Union: if a (dow, timeSlot) was locked on any date, keep it.
      // Also filter out any that are now disallowed.
      const currentLocked = schedule.lockedSlots || [];
      const lockedMap = new Map<
        string,
        { dayKey: string; timeSlot: string }
      >();
      for (const slot of currentLocked) {
        const dow = getDayOfWeekFromISODate(slot.dayKey);
        const key = `${dow}|${slot.timeSlot}`;
        if (!disallowedMap.has(key)) {
          lockedMap.set(key, {
            dayKey: String(dow),
            timeSlot: slot.timeSlot,
          });
        }
      }
      cleanUpdates.lockedSlots = [...lockedMap.values()];
      cleanUpdates.isLocked = lockedMap.size > 0;

      // Availability links are kept — saved availabilities already use
      // day-of-week keys, so they work correctly with recurring schedules.
    } else {
      // Same type — update date fields
      if (args.type === "one-off" || schedule.type === "one-off") {
        if (args.dateRangeStart !== undefined)
          cleanUpdates.dateRangeStart = args.dateRangeStart;
        if (args.dateRangeEnd !== undefined)
          cleanUpdates.dateRangeEnd = args.dateRangeEnd;
      }
      if (args.type === "recurring" || schedule.type === "recurring") {
        if (args.recurringStartDate !== undefined)
          cleanUpdates.recurringStartDate = args.recurringStartDate;
      }
    }

    await ctx.db.patch(args.scheduleId, cleanUpdates);
  },
});

async function cleanupRemovedScheduleBatch(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">
) {
  const selections = await ctx.db
    .query("selections")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const sel of selections) {
    await ctx.db.delete(sel._id);
  }

  const links = await ctx.db
    .query("availabilityLinks")
    .withIndex("by_scheduleId", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const link of links) {
    await ctx.db.delete(link._id);
  }

  const blocked = await ctx.db
    .query("blockedProfiles")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const record of blocked) {
    await ctx.db.delete(record._id);
  }

  const archives = await ctx.db
    .query("scheduleArchives")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const archive of archives) {
    await ctx.db.delete(archive._id);
  }

  const dstLogs = await ctx.db
    .query("dstCheckLog")
    .withIndex("by_schedule_profile_date", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const log of dstLogs) {
    await ctx.db.delete(log._id);
  }

  const discordLinks = await ctx.db
    .query("scheduleDiscordLinks")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const link of discordLinks) {
    if (link.pendingScheduledId) {
      try {
        await ctx.scheduler.cancel(link.pendingScheduledId);
      } catch {
        // already fired
      }
    }
    await ctx.db.delete(link._id);
  }

  const invalidations = await ctx.db
    .query("selectionBatchInvalidations")
    .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
    .take(SCHEDULE_CLEANUP_BATCH_SIZE);
  for (const invalidation of invalidations) {
    await ctx.db.delete(invalidation._id);
  }

  const shouldContinue =
    selections.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    links.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    blocked.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    archives.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    dstLogs.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    discordLinks.length === SCHEDULE_CLEANUP_BATCH_SIZE ||
    invalidations.length === SCHEDULE_CLEANUP_BATCH_SIZE;

  if (shouldContinue) {
    await ctx.scheduler.runAfter(0, internal.schedules.cleanupRemovedSchedule, {
      scheduleId,
    });
  }

  return {
    deleted:
      selections.length +
      links.length +
      blocked.length +
      archives.length +
      dstLogs.length +
      discordLinks.length +
      invalidations.length,
    scheduled: shouldContinue,
  };
}

// Delete a schedule and all related data (creator only)
export const remove = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    await ctx.db.delete(args.scheduleId);
    await ctx.scheduler.runAfter(0, internal.schedules.cleanupRemovedSchedule, {
      scheduleId: args.scheduleId,
    });
    return { scheduled: true };
  },
});

export const cleanupRemovedSchedule = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
  },
  handler: async (ctx, args) => {
    return await cleanupRemovedScheduleBatch(ctx, args.scheduleId);
  },
});

// Set disallowed time slots (creator allow/disallow mode)
// Also strips any locked slots that overlap with the newly disallowed set.
export const setDisallowedSlots = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    slots: v.array(
      v.object({
        dayKey: v.string(),
        timeSlot: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    // For one-off schedules, filter out slots outside date range
    let filteredSlots = args.slots;
    if (schedule.type === "one-off" && schedule.dateRangeStart && schedule.dateRangeEnd) {
      filteredSlots = args.slots.filter(
        (s) => s.dayKey >= schedule.dateRangeStart! && s.dayKey <= schedule.dateRangeEnd!
      );
    }

    // Build a set of the new disallowed keys for fast lookup
    const disallowedKeys = new Set(
      filteredSlots.map((s) => `${s.dayKey}|${s.timeSlot}`)
    );

    // Remove any locked slots that are now disallowed
    const currentLocked = schedule.lockedSlots || [];
    const filteredLocked = currentLocked.filter(
      (s) => !disallowedKeys.has(`${s.dayKey}|${s.timeSlot}`)
    );

    await ctx.db.patch(args.scheduleId, {
      disallowedSlots: filteredSlots,
      lockedSlots: filteredLocked,
    });

    // If we just stripped some locked slots, that's a notify-worthy change.
    if (filteredLocked.length !== (schedule.lockedSlots?.length ?? 0)) {
      await notifyDiscordForceQueue(ctx, args.scheduleId);
    }
  },
});

// Lock in time slots (creator, lock editors, or anyone if anyoneCanLock)
// Filters out any slots that are currently disallowed.
export const setLockedSlots = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    slots: v.array(
      v.object({
        dayKey: v.string(),
        timeSlot: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;

    if (!(await canLockSchedule(ctx, schedule, args.anonymousId))) {
      throw new Error("Unauthorized");
    }

    // Strip any disallowed slots from the lock request
    const disallowedKeys = new Set(
      (schedule.disallowedSlots || []).map(
        (s) => `${s.dayKey}|${s.timeSlot}`
      )
    );
    let filteredSlots = args.slots.filter(
      (s) => !disallowedKeys.has(`${s.dayKey}|${s.timeSlot}`)
    );

    // For one-off schedules, also filter out slots outside date range
    if (schedule.type === "one-off" && schedule.dateRangeStart && schedule.dateRangeEnd) {
      filteredSlots = filteredSlots.filter(
        (s) => s.dayKey >= schedule.dateRangeStart! && s.dayKey <= schedule.dateRangeEnd!
      );
    }

    await ctx.db.patch(args.scheduleId, {
      lockedSlots: filteredSlots,
      isLocked: true,
    });

    await notifyDiscordForceQueue(ctx, args.scheduleId);
  },
});

// Clear disallowed time slots (creator allow/disallow mode)
export const clearDisallowedSlots = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    await ctx.db.patch(args.scheduleId, {
      disallowedSlots: [],
    });
  },
});

// Toggle accept participation (creator only)
export const setAcceptParticipation = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    acceptParticipation: v.boolean(),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    await ctx.db.patch(args.scheduleId, {
      acceptParticipation: args.acceptParticipation,
    });
  },
});

// Remove a participant's selections from a schedule (creator only)
export const removeParticipant = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    // Remove from lock editors if present
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    if (schedule?.lockEditors?.includes(args.profileId)) {
      await ctx.db.patch(args.scheduleId, {
        lockEditors: schedule.lockEditors.filter((id) => id !== args.profileId),
      });
    }

    // Unlink any saved availability
    const link = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();
    if (link) {
      await ctx.db.delete(link._id);
    }

    const archive = await ctx.db
      .query("scheduleArchives")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();
    if (archive) await ctx.db.delete(archive._id);

    await invalidateSelectionBatchesForProfile(
      ctx,
      args.scheduleId,
      args.profileId
    );

    await ctx.scheduler.runAfter(0, internal.selections.continueClearForProfile, {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
    });

    // Participant removal can impact locked-slot outcomes.
    if ((schedule?.lockedSlots ?? []).length > 0) {
      await notifyDiscordForceQueue(ctx, args.scheduleId);
    }
  },
});

// Block a profile from participating in a schedule (creator only)
// Also removes their existing selections
export const blockParticipant = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    // Remove from lock editors if present
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    if (schedule?.lockEditors?.includes(args.profileId)) {
      await ctx.db.patch(args.scheduleId, {
        lockEditors: schedule.lockEditors.filter((id) => id !== args.profileId),
      });
    }

    // Check if already blocked
    const existing = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();

    if (!existing) {
      await ctx.db.insert("blockedProfiles", {
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        blockedAt: Date.now(),
      });
    }

    // Unlink any saved availability
    const link = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();
    if (link) {
      await ctx.db.delete(link._id);
    }

    const archive = await ctx.db
      .query("scheduleArchives")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();
    if (archive) await ctx.db.delete(archive._id);

    await invalidateSelectionBatchesForProfile(
      ctx,
      args.scheduleId,
      args.profileId
    );

    await ctx.scheduler.runAfter(0, internal.selections.continueClearForProfile, {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
    });

    if ((schedule?.lockedSlots ?? []).length > 0) {
      await notifyDiscordForceQueue(ctx, args.scheduleId);
    }
  },
});

// Unblock a profile from a schedule
export const unblockParticipant = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    const blocked = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", args.scheduleId).eq("profileId", args.profileId)
      )
      .unique();

    if (blocked) {
      await ctx.db.delete(blocked._id);
    }
  },
});

// Get blocked profiles for a schedule
export const getBlockedProfiles = query({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return [];
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    const blocked = await ctx.db
      .query("blockedProfiles")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .take(SCHEDULE_DETAIL_BLOCKED_PROFILE_LIMIT);

    // Enrich with profile info
    const enriched = await Promise.all(
      blocked.map(async (b) => {
        const profile = await ctx.db.get(b.profileId);
        // Prefer Convex-stored image over hotlinked Google URL
        const storedImageUrl = profile?.profileImageStorageId
          ? await ctx.storage.getUrl(profile.profileImageStorageId)
          : null;
        return {
          ...b,
          displayName: profile?.displayName ?? "Unknown",
          profileImageUrl: storedImageUrl ?? profile?.profileImageUrl,
        };
      })
    );

    return enriched;
  },
});

// Clear locked time slots (creator, lock editors, or anyone if anyoneCanLock)
export const clearLockedSlots = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;

    if (!(await canLockSchedule(ctx, schedule, args.anonymousId))) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.scheduleId, {
      lockedSlots: [],
      isLocked: false,
    });

    await notifyDiscordForceQueue(ctx, args.scheduleId);
  },
});

// Toggle "anyone can lock" setting (creator only)
export const setAnyoneCanLock = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    anyoneCanLock: v.boolean(),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    await ctx.db.patch(args.scheduleId, {
      anyoneCanLock: args.anyoneCanLock || undefined,
    });
  },
});

// Promote a participant to lock editor (creator only)
export const addLockEditor = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    const editors = schedule.lockEditors || [];
    if (editors.includes(args.profileId)) return;

    await ctx.db.patch(args.scheduleId, {
      lockEditors: [...editors, args.profileId],
    });
  },
});

// Demote a participant from lock editor (creator only)
export const removeLockEditor = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return;
    await requireScheduleCreator(ctx, schedule, args.anonymousId);

    const editors = schedule.lockEditors || [];
    await ctx.db.patch(args.scheduleId, {
      lockEditors: editors.filter((id) => id !== args.profileId),
    });
  },
});
