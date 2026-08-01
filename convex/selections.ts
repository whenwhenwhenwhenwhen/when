import { v } from "convex/values";
import { internalMutation, mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

const DEFAULT_DISCORD_DEBOUNCE_MS = 5 * 60 * 1000;
const BATCH_SET_SELECTION_LIMIT = 500;
const SELECTION_DELETE_BATCH_SIZE = 500;
const SELECTIONS_BY_SCHEDULE_LIMIT = 5000;
const DISCORD_LINK_NOTIFY_BATCH_SIZE = 100;

const batchSelectionValidator = v.object({
  dayKey: v.string(),
  timeSlot: v.string(),
  state: v.union(
    v.literal("can-do"),
    v.literal("cant-do"),
    v.literal("maybe"),
    v.literal("blank")
  ),
  isException: v.optional(v.boolean()),
  exceptionDate: v.optional(v.string()),
  timezone: v.optional(v.string()),
  scheduleDayKey: v.optional(v.string()),
  scheduleTimeSlot: v.optional(v.string()),
});

type BatchSelection = {
  dayKey: string;
  timeSlot: string;
  state: "can-do" | "cant-do" | "maybe" | "blank";
  isException?: boolean;
  exceptionDate?: string;
  timezone?: string;
  scheduleDayKey?: string;
  scheduleTimeSlot?: string;
};

function getDiscordDebounceMs(): number {
  const raw = process.env.DISCORD_DEBOUNCE_MS;
  if (!raw) return DEFAULT_DISCORD_DEBOUNCE_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DISCORD_DEBOUNCE_MS;
}

/**
 * Inline change-detection: if this schedule has any linked Discord
 * channels AND the affected cells overlap with locked slots, queue
 * (or re-queue) a debounced update. Cheap when there are no links.
 */
async function notifyDiscordIfLockedImpacted(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  affectedCells: { dayKey: string; timeSlot: string }[]
) {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule) return;
  const locked = schedule.lockedSlots ?? [];
  if (locked.length === 0) return;

  const lockedSet = new Set(locked.map((s) => `${s.dayKey}|${s.timeSlot}`));
  const anyOverlap = affectedCells.some((c) =>
    lockedSet.has(`${c.dayKey}|${c.timeSlot}`)
  );
  if (!anyOverlap) return;

  return await processDiscordLockedImpactBatch(ctx, scheduleId, null);
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
    await ctx.db.patch(link._id, {
      pendingScheduledId: newId,
      pendingUpdateAt: Date.now() + debounceMs,
      lastUpdateError: undefined,
    });
  }
}

async function processDiscordLockedImpactBatch(
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
      internal.selections.continueDiscordLockedImpactNotify,
      {
        scheduleId,
        cursor: page.continueCursor,
      }
    );
  }

  return { processed: page.page.length, scheduled: !page.isDone };
}

// Helper: check if a profile is blocked from a schedule
async function isProfileBlocked(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">
): Promise<boolean> {
  const blocked = await ctx.db
    .query("blockedProfiles")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .unique();
  return blocked !== null;
}

type SelectionAccess = {
  schedule: Doc<"schedules">;
  actorProfileId: Id<"userProfiles">;
  targetProfileId: Id<"userProfiles">;
  actorIsCreator: boolean;
};

async function getActorProfileId(
  ctx: MutationCtx,
  anonymousId: string | undefined
): Promise<Id<"userProfiles"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const authProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) =>
        q.eq("authUserId", identity.tokenIdentifier)
      )
      .unique();
    return authProfile?._id ?? null;
  }

  if (!anonymousId) return null;
  const anonymousProfile = await ctx.db
    .query("userProfiles")
    .withIndex("by_anonymousId", (q) => q.eq("anonymousId", anonymousId))
    .unique();
  if (!anonymousProfile || anonymousProfile.authUserId) return null;
  return anonymousProfile._id;
}

async function getSelectionAccess(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  targetProfileId: Id<"userProfiles">,
  anonymousId: string | undefined
): Promise<SelectionAccess | null> {
  const [schedule, targetProfile, actorProfileId] = await Promise.all([
    ctx.db.get(scheduleId),
    ctx.db.get(targetProfileId),
    getActorProfileId(ctx, anonymousId),
  ]);
  if (!schedule || !targetProfile || !actorProfileId) return null;

  const actorIsCreator = schedule.creatorProfileId === actorProfileId;
  if (actorProfileId !== targetProfileId && !actorIsCreator) return null;

  return {
    schedule,
    actorProfileId,
    targetProfileId,
    actorIsCreator,
  };
}

// Helper: check if participation is closed and actor is not creator
async function isParticipationDenied(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  actorIsCreator: boolean
): Promise<boolean> {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule) return true;

  // Creator is always allowed (either as themselves or acting on behalf).
  if (schedule.creatorProfileId === profileId || actorIsCreator) return false;

  // Check if participation is closed
  if (schedule.acceptParticipation === false) return true;

  // Check if profile is blocked
  return await isProfileBlocked(ctx, scheduleId, profileId);
}

async function hasBatchInvalidationSince(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  batchStartedAt: number
): Promise<boolean> {
  const invalidation = await ctx.db
    .query("selectionBatchInvalidations")
    .withIndex("by_schedule_profile_invalidatedAt", (q) =>
      q
        .eq("scheduleId", scheduleId)
        .eq("profileId", profileId)
        .gte("invalidatedAt", batchStartedAt)
    )
    .first();
  return invalidation !== null;
}

// Helper: check if a slot is in the schedule's disallowed list
function isSlotDisallowed(
  disallowedSlots: { dayKey: string; timeSlot: string }[] | undefined,
  dayKey: string,
  timeSlot: string
): boolean {
  if (!disallowedSlots) return false;
  return disallowedSlots.some(
    (s) => s.dayKey === dayKey && s.timeSlot === timeSlot
  );
}

async function getExistingSelectionsForCell(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  dayKey: string,
  timeSlot: string,
  isException: boolean | undefined,
  exceptionDate: string | undefined,
  timezone: string | undefined
) {
  const queryCell = (exceptionValue: true | false | undefined) =>
    ctx.db.query("selections").withIndex(
      "by_profile_schedule_day_time_isException_exceptionDate",
      (q) =>
        q
          .eq("profileId", profileId)
          .eq("scheduleId", scheduleId)
          .eq("dayKey", dayKey)
          .eq("timeSlot", timeSlot)
          .eq("isException", exceptionValue)
          .eq("exceptionDate", exceptionDate)
    );

  if (isException) {
    const selections = await queryCell(true).take(20);
    return timezone
      ? selections.filter((selection) => selection.timezone === timezone)
      : selections;
  }

  const [missingExceptionFlag, falseExceptionFlag] = await Promise.all([
    queryCell(undefined).take(20),
    queryCell(false).take(20),
  ]);

  const selections = [...missingExceptionFlag, ...falseExceptionFlag];
  return timezone
    ? selections.filter((selection) => selection.timezone === timezone)
    : selections;
}

async function getCalendarOverridesForCell(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  dayKey: string,
  timeSlot: string,
  timezone: string | undefined
) {
  const overrides = await ctx.db
    .query("calendarOverrides")
    .withIndex("by_profile_schedule_dayKey_timeSlot", (q) =>
      q
        .eq("profileId", profileId)
        .eq("scheduleId", scheduleId)
        .eq("dayKey", dayKey)
        .eq("timeSlot", timeSlot)
    )
    .take(20);
  return timezone
    ? overrides.filter(
        (override) =>
          override.timezone === undefined || override.timezone === timezone
      )
    : overrides;
}

async function createCalendarOverrides(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">,
  dayKey: string,
  timeSlot: string,
  calendarSelections: Doc<"selections">[]
) {
  for (const selection of calendarSelections) {
    if (!selection.externalEventId) continue;

    const overrideCandidates = await ctx.db
      .query("calendarOverrides")
      .withIndex("by_profile_schedule_externalEventId_dayKey_timeSlot", (q) =>
        q
          .eq("profileId", profileId)
          .eq("scheduleId", scheduleId)
          .eq("externalEventId", selection.externalEventId!)
          .eq("dayKey", dayKey)
          .eq("timeSlot", timeSlot)
      )
      .take(20);
    const overrideExists = overrideCandidates.some(
      (override) =>
        override.timezone === undefined ||
        override.timezone === selection.timezone
    );

    if (!overrideExists) {
      await ctx.db.insert("calendarOverrides", {
        profileId,
        scheduleId,
        externalEventId: selection.externalEventId,
        dayKey,
        timeSlot,
        timezone: selection.timezone,
        isException: selection.isException,
        exceptionDate: selection.exceptionDate,
      });
    }
  }
}

async function restoreCalendarBaseline(
  ctx: MutationCtx,
  args: {
    scheduleId: Id<"schedules">;
    profileId: Id<"userProfiles">;
    dayKey: string;
    timeSlot: string;
    timezone?: string;
    existing: Doc<"selections">[];
  }
): Promise<boolean> {
  const overrides = await getCalendarOverridesForCell(
    ctx,
    args.scheduleId,
    args.profileId,
    args.dayKey,
    args.timeSlot,
    args.timezone
  );
  const calendarSelection = args.existing.find(
    (selection) =>
      selection.source === "calendar" && selection.externalEventId !== undefined
  );
  const externalEventId =
    calendarSelection?.externalEventId ?? overrides[0]?.externalEventId;

  if (!externalEventId) return false;

  for (const override of overrides) {
    await ctx.db.delete(override._id);
  }

  const primary = calendarSelection ?? args.existing[0];
  if (primary) {
    await ctx.db.patch(primary._id, {
      state: "cant-do",
      source: "calendar",
      externalEventId,
      ...(args.timezone ? { timezone: args.timezone } : {}),
    });
    for (const selection of args.existing) {
      if (selection._id !== primary._id) {
        await ctx.db.delete(selection._id);
      }
    }
  } else if (args.timezone) {
    await ctx.db.insert("selections", {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      dayKey: args.dayKey,
      timeSlot: args.timeSlot,
      timezone: args.timezone,
      state: "cant-do",
      source: "calendar",
      externalEventId,
    });
  }

  return true;
}

function compactSelections(selections: BatchSelection[]): BatchSelection[] {
  const byCell = new Map<string, BatchSelection>();
  for (const selection of selections) {
    const key = [
      selection.dayKey,
      selection.timeSlot,
      selection.isException === true ? "exception" : "base",
      selection.exceptionDate ?? "",
      selection.timezone ?? "",
      selection.scheduleDayKey ?? "",
      selection.scheduleTimeSlot ?? "",
    ].join("|");
    byCell.set(key, selection);
  }
  return [...byCell.values()];
}

// Helper: check if this profile has a linked availability for this schedule
async function getAvailabilityLink(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">
) {
  return await ctx.db
    .query("availabilityLinks")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .unique();
}

// Helper: update a slot in a saved availability
async function updateSavedAvailabilitySlot(
  ctx: MutationCtx,
  savedAvailabilityId: Id<"savedAvailabilities">,
  dayKey: string,
  timeSlot: string,
  state: "can-do" | "cant-do" | "maybe",
  timezone: string
) {
  const savedAvail = await ctx.db.get(savedAvailabilityId);
  if (!savedAvail) return;

  const newSlots = savedAvail.slots.filter(
    (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
  );
  newSlots.push({ dayKey, timeSlot, state });
  await ctx.db.patch(savedAvailabilityId, { slots: newSlots, timezone });
}

// Helper: remove a slot from a saved availability
async function removeSavedAvailabilitySlot(
  ctx: MutationCtx,
  savedAvailabilityId: Id<"savedAvailabilities">,
  dayKey: string,
  timeSlot: string
) {
  const savedAvail = await ctx.db.get(savedAvailabilityId);
  if (!savedAvail) return;

  const newSlots = savedAvail.slots.filter(
    (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
  );
  await ctx.db.patch(savedAvailabilityId, { slots: newSlots });
}

// Set a single cell selection
export const set = mutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    dayKey: v.string(),
    timeSlot: v.string(),
    timezone: v.string(),
    state: v.union(
      v.literal("can-do"),
      v.literal("cant-do"),
      v.literal("maybe")
    ),
    isException: v.optional(v.boolean()),
    exceptionDate: v.optional(v.string()),
    scheduleDayKey: v.optional(v.string()),
    scheduleTimeSlot: v.optional(v.string()),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await getSelectionAccess(
      ctx,
      args.scheduleId,
      args.profileId,
      args.anonymousId
    );
    if (!access) return null;

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, args.scheduleId, args.profileId, access.actorIsCreator)) {
      return null;
    }

    // Guard: reject nominations on disallowed cells (creator auto-allows)
    const schedule = access.schedule;
    const scheduleDayKey = args.scheduleDayKey ?? args.dayKey;
    const scheduleTimeSlot = args.scheduleTimeSlot ?? args.timeSlot;
    if (
      schedule &&
      isSlotDisallowed(
        schedule.disallowedSlots,
        scheduleDayKey,
        scheduleTimeSlot
      )
    ) {
      if (access.actorIsCreator) {
        await ctx.db.patch(args.scheduleId, {
          disallowedSlots: (schedule.disallowedSlots || []).filter(
            (s) =>
              !(
                s.dayKey === scheduleDayKey &&
                s.timeSlot === scheduleTimeSlot
              )
          ),
        });
      } else {
        return null;
      }
    }

    // Guard: reject changes outside one-off schedule date range
    if (schedule && schedule.type === "one-off") {
      if (
        schedule.dateRangeStart &&
        schedule.dateRangeEnd &&
        (scheduleDayKey < schedule.dateRangeStart ||
          scheduleDayKey > schedule.dateRangeEnd)
      ) {
        return null;
      }
    }

    // Check for linked availability (only for non-exception changes)
    if (!args.isException) {
      const link = await getAvailabilityLink(
        ctx,
        args.scheduleId,
        args.profileId
      );
      if (link) {
        await updateSavedAvailabilitySlot(
          ctx,
          link.savedAvailabilityId,
          args.dayKey,
          args.timeSlot,
          args.state,
          args.timezone
        );
        await notifyDiscordIfLockedImpacted(ctx, args.scheduleId, [
          { dayKey: scheduleDayKey, timeSlot: scheduleTimeSlot },
        ]);
        return null;
      }
    }

    // Find existing selection(s) for this cell
    const existing = await getExistingSelectionsForCell(
      ctx,
      args.scheduleId,
      args.profileId,
      args.dayKey,
      args.timeSlot,
      args.isException,
      args.exceptionDate,
      args.timezone
    );

    const calendarSelections = existing.filter(
      (selection) =>
        selection.source === "calendar" &&
        selection.externalEventId !== undefined
    );
    await createCalendarOverrides(
      ctx,
      args.scheduleId,
      args.profileId,
      args.dayKey,
      args.timeSlot,
      calendarSelections
    );

    let resultId: Id<"selections">;
    if (existing.length > 0) {
      const primary = calendarSelections[0] ?? existing[0];
      await ctx.db.patch(primary._id, {
        state: args.state,
        timezone: args.timezone,
        ...(calendarSelections.length === 0 ? { source: "manual" as const } : {}),
      });
      for (const selection of existing) {
        if (selection._id !== primary._id) {
          await ctx.db.delete(selection._id);
        }
      }
      resultId = primary._id;
    } else {
      resultId = await ctx.db.insert("selections", {
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        dayKey: args.dayKey,
        timeSlot: args.timeSlot,
        timezone: args.timezone,
        state: args.state,
        isException: args.isException,
        exceptionDate: args.exceptionDate,
      });
    }

    await notifyDiscordIfLockedImpacted(ctx, args.scheduleId, [
      { dayKey: scheduleDayKey, timeSlot: scheduleTimeSlot },
    ]);
    return resultId;
  },
});

// Remove a selection (set to blank)
export const remove = mutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    dayKey: v.string(),
    timeSlot: v.string(),
    isException: v.optional(v.boolean()),
    exceptionDate: v.optional(v.string()),
    timezone: v.optional(v.string()),
    scheduleDayKey: v.optional(v.string()),
    scheduleTimeSlot: v.optional(v.string()),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await getSelectionAccess(
      ctx,
      args.scheduleId,
      args.profileId,
      args.anonymousId
    );
    if (!access) return;

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, args.scheduleId, args.profileId, access.actorIsCreator)) {
      return;
    }

    // Guard: reject changes on disallowed cells (skip for creator)
    const schedule = access.schedule;
    const scheduleDayKey = args.scheduleDayKey ?? args.dayKey;
    const scheduleTimeSlot = args.scheduleTimeSlot ?? args.timeSlot;
    if (
      schedule &&
      isSlotDisallowed(
        schedule.disallowedSlots,
        scheduleDayKey,
        scheduleTimeSlot
      )
    ) {
      if (!access.actorIsCreator) {
        return;
      }
    }

    // Guard: reject changes outside one-off schedule date range
    if (schedule && schedule.type === "one-off") {
      if (
        schedule.dateRangeStart &&
        schedule.dateRangeEnd &&
        (scheduleDayKey < schedule.dateRangeStart ||
          scheduleDayKey > schedule.dateRangeEnd)
      ) {
        return;
      }
    }

    // Check for linked availability (only for non-exception changes)
    if (!args.isException) {
      const link = await getAvailabilityLink(
        ctx,
        args.scheduleId,
        args.profileId
      );
      if (link) {
        await removeSavedAvailabilitySlot(
          ctx,
          link.savedAvailabilityId,
          args.dayKey,
          args.timeSlot
        );
        await notifyDiscordIfLockedImpacted(ctx, args.scheduleId, [
          { dayKey: scheduleDayKey, timeSlot: scheduleTimeSlot },
        ]);
        return;
      }
    }

    const existing = await getExistingSelectionsForCell(
      ctx,
      args.scheduleId,
      args.profileId,
      args.dayKey,
      args.timeSlot,
      args.isException,
      args.exceptionDate,
      args.timezone
    );

    if (
      await restoreCalendarBaseline(ctx, {
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        dayKey: args.dayKey,
        timeSlot: args.timeSlot,
        timezone: args.timezone,
        existing,
      })
    ) {
      await notifyDiscordIfLockedImpacted(ctx, args.scheduleId, [
        { dayKey: scheduleDayKey, timeSlot: scheduleTimeSlot },
      ]);
      return;
    }

    for (const record of existing) {
      await ctx.db.delete(record._id);
    }

    await notifyDiscordIfLockedImpacted(ctx, args.scheduleId, [
      { dayKey: scheduleDayKey, timeSlot: scheduleTimeSlot },
    ]);
  },
});

async function applySelectionCell(
  ctx: MutationCtx,
  args: {
    scheduleId: Id<"schedules">;
    profileId: Id<"userProfiles">;
    timezone: string;
    selection: BatchSelection;
  }
) {
  const sel = args.selection;
  const timezone = sel.timezone ?? args.timezone;
  const existing = await getExistingSelectionsForCell(
    ctx,
    args.scheduleId,
    args.profileId,
    sel.dayKey,
    sel.timeSlot,
    sel.isException,
    sel.exceptionDate,
    timezone
  );

  if (sel.state === "blank") {
    const restoredCalendarBaseline = await restoreCalendarBaseline(ctx, {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      dayKey: sel.dayKey,
      timeSlot: sel.timeSlot,
      timezone,
      existing,
    });
    if (!restoredCalendarBaseline) {
      for (const record of existing) {
        await ctx.db.delete(record._id);
      }
    }
  } else if (existing.length > 0) {
    const calendarSelections = existing.filter(
      (selection) =>
        selection.source === "calendar" &&
        selection.externalEventId !== undefined
    );
    await createCalendarOverrides(
      ctx,
      args.scheduleId,
      args.profileId,
      sel.dayKey,
      sel.timeSlot,
      calendarSelections
    );
    const primary = calendarSelections[0] ?? existing[0];
    await ctx.db.patch(primary._id, {
      state: sel.state,
      timezone,
      ...(calendarSelections.length === 0 ? { source: "manual" as const } : {}),
    });
    for (const selection of existing) {
      if (selection._id !== primary._id) {
        await ctx.db.delete(selection._id);
      }
    }
  } else {
    await ctx.db.insert("selections", {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      dayKey: sel.dayKey,
      timeSlot: sel.timeSlot,
      timezone,
      state: sel.state,
      isException: sel.isException,
      exceptionDate: sel.exceptionDate,
    });
  }
}

async function processBatchSetSelections(
  ctx: MutationCtx,
  args: {
    scheduleId: Id<"schedules">;
    profileId: Id<"userProfiles">;
    timezone: string;
    selections: BatchSelection[];
    actorIsCreator: boolean;
    batchStartedAt: number;
  }
) {
  const selections = compactSelections(args.selections);
  const chunk = selections.slice(0, BATCH_SET_SELECTION_LIMIT);
  const remaining = selections.slice(BATCH_SET_SELECTION_LIMIT);
  if (chunk.length === 0) return { processed: 0, scheduled: 0 };

  const [schedule, targetProfile, invalidated] = await Promise.all([
    ctx.db.get(args.scheduleId),
    ctx.db.get(args.profileId),
    hasBatchInvalidationSince(
      ctx,
      args.scheduleId,
      args.profileId,
      args.batchStartedAt
    ),
  ]);
  if (!schedule || !targetProfile || invalidated) {
    return { processed: 0, scheduled: 0 };
  }

  if (
    await isParticipationDenied(
      ctx,
      args.scheduleId,
      args.profileId,
      args.actorIsCreator
    )
  ) {
    return { processed: 0, scheduled: 0 };
  }

  let disallowed = schedule.disallowedSlots;
  const getScheduleCell = (selection: BatchSelection) => ({
    dayKey: selection.scheduleDayKey ?? selection.dayKey,
    timeSlot: selection.scheduleTimeSlot ?? selection.timeSlot,
  });

  // Creator bypass: auto-allow nominated disallowed cells across the full request.
  if (args.actorIsCreator && disallowed && disallowed.length > 0) {
    const slotsToAllow = selections
      .filter((selection) => {
        const scheduleCell = getScheduleCell(selection);
        return (
          selection.state !== "blank" &&
          isSlotDisallowed(
            disallowed,
            scheduleCell.dayKey,
            scheduleCell.timeSlot
          )
        );
      })
      .map(getScheduleCell);
    if (slotsToAllow.length > 0) {
      const allowSet = new Set(
        slotsToAllow.map((slot) => `${slot.dayKey}|${slot.timeSlot}`)
      );
      disallowed = disallowed.filter(
        (s) => !allowSet.has(`${s.dayKey}|${s.timeSlot}`)
      );
      await ctx.db.patch(args.scheduleId, { disallowedSlots: disallowed });
    }
    disallowed = undefined;
  }

  const isInDateRange = (selection: BatchSelection): boolean => {
    if (schedule.type !== "one-off") return true;
    if (!schedule.dateRangeStart || !schedule.dateRangeEnd) return true;
    const { dayKey } = getScheduleCell(selection);
    return dayKey >= schedule.dateRangeStart && dayKey <= schedule.dateRangeEnd;
  };

  const isSelectionDisallowed = (selection: BatchSelection): boolean => {
    const scheduleCell = getScheduleCell(selection);
    return isSlotDisallowed(
      disallowed,
      scheduleCell.dayKey,
      scheduleCell.timeSlot
    );
  };

  const link = await getAvailabilityLink(
    ctx,
    args.scheduleId,
    args.profileId
  );

  if (link) {
    const savedAvail = await ctx.db.get(link.savedAvailabilityId);
    if (savedAvail) {
      let slots = [...savedAvail.slots];
      const nonExceptionSels = chunk.filter(
        (s) =>
          !s.isException &&
          !isSelectionDisallowed(s) &&
          isInDateRange(s)
      );

      for (const sel of nonExceptionSels) {
        slots = slots.filter(
          (s) => !(s.dayKey === sel.dayKey && s.timeSlot === sel.timeSlot)
        );
        if (sel.state !== "blank") {
          slots.push({
            dayKey: sel.dayKey,
            timeSlot: sel.timeSlot,
            state: sel.state,
          });
        }
      }

      if (nonExceptionSels.length > 0) {
        await ctx.db.patch(link.savedAvailabilityId, {
          slots,
          timezone: args.timezone,
        });
      }
    }

    for (const sel of chunk.filter((s) => s.isException)) {
      if (isSelectionDisallowed(sel)) continue;
      if (!isInDateRange(sel)) continue;
      await applySelectionCell(ctx, {
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        timezone: args.timezone,
        selection: sel,
      });
    }
  } else {
    for (const sel of chunk) {
      if (isSelectionDisallowed(sel)) continue;
      if (!isInDateRange(sel)) continue;
      await applySelectionCell(ctx, {
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        timezone: args.timezone,
        selection: sel,
      });
    }
  }

  if (remaining.length > 0) {
    await ctx.scheduler.runAfter(0, internal.selections.continueBatchSet, {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      timezone: args.timezone,
      selections: remaining,
      actorIsCreator: args.actorIsCreator,
      batchStartedAt: args.batchStartedAt,
    });
  }

  await notifyDiscordIfLockedImpacted(
    ctx,
    args.scheduleId,
    chunk.map(getScheduleCell)
  );

  return { processed: chunk.length, scheduled: remaining.length };
}

// Batch set selections (for drag operations)
export const batchSet = mutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    timezone: v.string(),
    selections: v.array(batchSelectionValidator),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchStartedAt = Date.now();
    const access = await getSelectionAccess(
      ctx,
      args.scheduleId,
      args.profileId,
      args.anonymousId
    );
    if (!access) return { processed: 0, scheduled: 0 };

    // Guard: reject if participation denied (closed or blocked)
    if (await isParticipationDenied(ctx, args.scheduleId, args.profileId, access.actorIsCreator)) {
      return { processed: 0, scheduled: 0 };
    }

    return await processBatchSetSelections(ctx, {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      timezone: args.timezone,
      selections: args.selections,
      actorIsCreator: access.actorIsCreator,
      batchStartedAt,
    });
  },
});

export const continueDiscordLockedImpactNotify = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    return await processDiscordLockedImpactBatch(
      ctx,
      args.scheduleId,
      args.cursor
    );
  },
});

export const continueBatchSet = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    timezone: v.string(),
    selections: v.array(batchSelectionValidator),
    actorIsCreator: v.boolean(),
    batchStartedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await processBatchSetSelections(ctx, args);
  },
});

async function deleteSelectionsForProfileBatch(
  ctx: MutationCtx,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">
) {
  const batch = await ctx.db
    .query("selections")
    .withIndex("by_schedule_profile", (q) =>
      q.eq("scheduleId", scheduleId).eq("profileId", profileId)
    )
    .take(SELECTION_DELETE_BATCH_SIZE);

  for (const record of batch) {
    await ctx.db.delete(record._id);
  }

  if (batch.length === SELECTION_DELETE_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.selections.continueClearForProfile, {
      scheduleId,
      profileId,
    });
  }

  return {
    deleted: batch.length,
    scheduled: batch.length === SELECTION_DELETE_BATCH_SIZE,
  };
}

// Clear all selections for a profile on a schedule
// Also unlinks any saved availability (without copying back)
export const clearForProfile = mutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await getSelectionAccess(
      ctx,
      args.scheduleId,
      args.profileId,
      args.anonymousId
    );
    if (!access) return { deleted: 0, scheduled: false };

    // If linked to a saved availability, unlink without copying back
    const link = await getAvailabilityLink(
      ctx,
      args.scheduleId,
      args.profileId
    );
    if (link) {
      await ctx.db.delete(link._id);
    }

    return await deleteSelectionsForProfileBatch(
      ctx,
      args.scheduleId,
      args.profileId
    );
  },
});

export const continueClearForProfile = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
  },
  handler: async (ctx, args) => {
    return await deleteSelectionsForProfileBatch(
      ctx,
      args.scheduleId,
      args.profileId
    );
  },
});

// Get all selections for a schedule
export const getBySchedule = query({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("selections")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .take(SELECTIONS_BY_SCHEDULE_LIMIT);
  },
});
