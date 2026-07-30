/**
 * Mock mutation handlers for design mode.
 *
 * Each handler modifies the in-memory store and calls notify() to trigger
 * reactive re-renders. Return values match the real Convex mutations.
 */

import * as store from "../store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: Args) => any;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function getOrCreateAnonymousProfile(args: Args) {
  const existing = store
    .query("userProfiles")
    .find((p) => p.anonymousId === args.anonymousId);
  if (existing) return existing._id;

  return store.insert("userProfiles", {
    anonymousId: args.anonymousId,
    displayName: args.displayName,
    timezone: args.timezone,
    weekStartDay: 0,
    dstNotifications: true,
  });
}

function updateProfile(args: Args) {
  const profile =
    (args.anonymousId
      ? store
          .query("userProfiles")
          .find((p) => p.anonymousId === args.anonymousId)
      : undefined) ?? store.query("userProfiles")[0];
  if (!profile) return;

  const clean: Record<string, unknown> = {};
  if (args.displayName !== undefined) clean.displayName = args.displayName;
  if (args.timezone !== undefined) clean.timezone = args.timezone;
  if (args.weekStartDay !== undefined) clean.weekStartDay = args.weekStartDay;
  if (args.dstNotifications !== undefined) clean.dstNotifications = args.dstNotifications;
  store.patch("userProfiles", profile._id, clean);
}

function ensureAuthProfile() {
  // No-op in design mode — no SSO
  return null;
}

function unlinkSso() {
  // No-op in design mode
  return { displayName: "Designer" };
}

function refreshProfileImageIfNeeded() {
  // No-op
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

function schedulesCreate(args: Args) {
  return store.insert("schedules", {
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
}

function schedulesUpdate(args: Args) {
  const schedule = store.get("schedules", args.scheduleId);
  if (!schedule) return;

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.description !== undefined) updates.description = args.description;
  if (args.isPrivate !== undefined) updates.isPrivate = args.isPrivate || undefined;

  // Simplified type change — skip selection conversion for design mode
  if (args.type !== undefined) updates.type = args.type;
  if (args.dateRangeStart !== undefined) updates.dateRangeStart = args.dateRangeStart;
  if (args.dateRangeEnd !== undefined) updates.dateRangeEnd = args.dateRangeEnd;
  if (args.recurringStartDate !== undefined) updates.recurringStartDate = args.recurringStartDate;

  store.patch("schedules", args.scheduleId, updates);
}

function schedulesRemove(args: Args) {
  // Delete related data
  for (const sel of store.query("selections").filter((s) => s.scheduleId === args.scheduleId)) {
    store.remove("selections", sel._id);
  }
  for (const link of store.query("availabilityLinks").filter((l) => l.scheduleId === args.scheduleId)) {
    store.remove("availabilityLinks", link._id);
  }
  for (const b of store.query("blockedProfiles").filter((bp) => bp.scheduleId === args.scheduleId)) {
    store.remove("blockedProfiles", b._id);
  }
  for (const archive of store
    .query("scheduleArchives")
    .filter((item) => item.scheduleId === args.scheduleId)) {
    store.remove("scheduleArchives", archive._id);
  }
  store.remove("schedules", args.scheduleId);
}

function setArchived(args: Args) {
  const profile = args.anonymousId
    ? store
        .query("userProfiles")
        .find((item) => item.anonymousId === args.anonymousId)
    : undefined;
  const schedule = store.get("schedules", args.scheduleId);
  if (!profile || !schedule) return;

  const isCreator = schedule.creatorProfileId === profile._id;
  const hasNominations =
    store
      .query("selections")
      .some(
        (selection) =>
          selection.scheduleId === schedule._id &&
          selection.profileId === profile._id,
      ) ||
    store.query("availabilityLinks").some((link) => {
      if (
        link.scheduleId !== schedule._id ||
        link.profileId !== profile._id
      ) {
        return false;
      }
      const savedAvailability = store.get(
        "savedAvailabilities",
        link.savedAvailabilityId,
      );
      return (savedAvailability?.slots.length ?? 0) > 0;
    });
  const isBlocked = store
    .query("blockedProfiles")
    .some(
      (blocked) =>
        blocked.scheduleId === schedule._id &&
        blocked.profileId === profile._id,
    );
  if ((!isCreator && !hasNominations) || (!isCreator && isBlocked)) return;

  const existing = store
    .query("scheduleArchives")
    .find(
      (archive) =>
        archive.scheduleId === schedule._id &&
        archive.profileId === profile._id,
    );
  if (args.archived && !existing) {
    return store.insert("scheduleArchives", {
      scheduleId: schedule._id,
      profileId: profile._id,
      archivedAt: Date.now(),
    });
  }
  if (!args.archived && existing) {
    store.remove("scheduleArchives", existing._id);
  }
}

function setDisallowedSlots(args: Args) {
  const schedule = store.get("schedules", args.scheduleId);
  if (!schedule) return;

  let slots = args.slots;
  if (schedule.type === "one-off" && schedule.dateRangeStart && schedule.dateRangeEnd) {
    slots = args.slots.filter(
      (s: { dayKey: string }) => s.dayKey >= schedule.dateRangeStart && s.dayKey <= schedule.dateRangeEnd,
    );
  }

  // Remove locked slots that overlap with disallowed
  const disallowedKeys = new Set(
    slots.map((s: { dayKey: string; timeSlot: string }) => `${s.dayKey}|${s.timeSlot}`),
  );
  const filteredLocked = (schedule.lockedSlots || []).filter(
    (s: { dayKey: string; timeSlot: string }) => !disallowedKeys.has(`${s.dayKey}|${s.timeSlot}`),
  );

  store.patch("schedules", args.scheduleId, {
    disallowedSlots: slots,
    lockedSlots: filteredLocked,
  });
}

function setLockedSlots(args: Args) {
  const schedule = store.get("schedules", args.scheduleId);
  if (!schedule) return;

  const disallowedKeys = new Set(
    (schedule.disallowedSlots || []).map(
      (s: { dayKey: string; timeSlot: string }) => `${s.dayKey}|${s.timeSlot}`,
    ),
  );
  let slots = args.slots.filter(
    (s: { dayKey: string; timeSlot: string }) => !disallowedKeys.has(`${s.dayKey}|${s.timeSlot}`),
  );

  if (schedule.type === "one-off" && schedule.dateRangeStart && schedule.dateRangeEnd) {
    slots = slots.filter(
      (s: { dayKey: string }) => s.dayKey >= schedule.dateRangeStart && s.dayKey <= schedule.dateRangeEnd,
    );
  }

  store.patch("schedules", args.scheduleId, {
    lockedSlots: slots,
    isLocked: true,
  });
}

function clearDisallowedSlots(args: Args) {
  store.patch("schedules", args.scheduleId, { disallowedSlots: [] });
}

function clearLockedSlots(args: Args) {
  store.patch("schedules", args.scheduleId, { lockedSlots: [], isLocked: false });
}

function setAcceptParticipation(args: Args) {
  store.patch("schedules", args.scheduleId, {
    acceptParticipation: args.acceptParticipation,
  });
}

function removeParticipant(args: Args) {
  // Remove availability link
  for (const link of store
    .query("availabilityLinks")
    .filter((l) => l.scheduleId === args.scheduleId && l.profileId === args.profileId)) {
    store.remove("availabilityLinks", link._id);
  }
  // Remove selections
  for (const sel of store
    .query("selections")
    .filter((s) => s.scheduleId === args.scheduleId && s.profileId === args.profileId)) {
    store.remove("selections", sel._id);
  }
  for (const archive of store
    .query("scheduleArchives")
    .filter(
      (item) =>
        item.scheduleId === args.scheduleId &&
        item.profileId === args.profileId,
    )) {
    store.remove("scheduleArchives", archive._id);
  }
}

function blockParticipant(args: Args) {
  // Insert blocked record if not already blocked
  const existing = store
    .query("blockedProfiles")
    .find((b) => b.scheduleId === args.scheduleId && b.profileId === args.profileId);
  if (!existing) {
    store.insert("blockedProfiles", {
      scheduleId: args.scheduleId,
      profileId: args.profileId,
      blockedAt: Date.now(),
    });
  }
  // Remove their data
  removeParticipant(args);
}

function unblockParticipant(args: Args) {
  const blocked = store
    .query("blockedProfiles")
    .find((b) => b.scheduleId === args.scheduleId && b.profileId === args.profileId);
  if (blocked) {
    store.remove("blockedProfiles", blocked._id);
  }
}

// ---------------------------------------------------------------------------
// selections
// ---------------------------------------------------------------------------

function selectionsSet(args: Args) {
  // Find existing selection for this cell
  const existing = store.query("selections").find(
    (s) =>
      s.scheduleId === args.scheduleId &&
      s.profileId === args.profileId &&
      s.dayKey === args.dayKey &&
      s.timeSlot === args.timeSlot &&
      s.timezone === args.timezone &&
      (args.isException ? s.isException === true : s.isException !== true) &&
      (args.exceptionDate ? s.exceptionDate === args.exceptionDate : !s.exceptionDate),
  );

  if (existing) {
    store.patch("selections", existing._id, {
      state: args.state,
      timezone: args.timezone,
    });
    return existing._id;
  }

  return store.insert("selections", {
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

function selectionsRemove(args: Args) {
  const matches = store.query("selections").filter(
    (s) =>
      s.scheduleId === args.scheduleId &&
      s.profileId === args.profileId &&
      s.dayKey === args.dayKey &&
      s.timeSlot === args.timeSlot &&
      (args.timezone === undefined || s.timezone === args.timezone) &&
      (args.isException ? s.isException === true : s.isException !== true) &&
      (args.exceptionDate ? s.exceptionDate === args.exceptionDate : !s.exceptionDate),
  );

  for (const record of matches) {
    store.remove("selections", record._id);
  }
}

function selectionsBatchSet(args: Args) {
  for (const sel of args.selections) {
    if (sel.state === "blank") {
      selectionsRemove({
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        dayKey: sel.dayKey,
        timeSlot: sel.timeSlot,
        timezone: sel.timezone ?? args.timezone,
        isException: sel.isException,
        exceptionDate: sel.exceptionDate,
      });
    } else {
      selectionsSet({
        scheduleId: args.scheduleId,
        profileId: args.profileId,
        dayKey: sel.dayKey,
        timeSlot: sel.timeSlot,
        timezone: sel.timezone ?? args.timezone,
        state: sel.state,
        isException: sel.isException,
        exceptionDate: sel.exceptionDate,
      });
    }
  }
}

function selectionsClearForProfile(args: Args) {
  // Unlink saved availability
  for (const link of store
    .query("availabilityLinks")
    .filter((l) => l.scheduleId === args.scheduleId && l.profileId === args.profileId)) {
    store.remove("availabilityLinks", link._id);
  }

  // Delete all selections
  const matches = store
    .query("selections")
    .filter((s) => s.scheduleId === args.scheduleId && s.profileId === args.profileId);
  for (const record of matches) {
    store.remove("selections", record._id);
  }
  return matches.length;
}

// ---------------------------------------------------------------------------
// savedAvailabilities — stubs (designer is anonymous, UI guards behind isSsoUser)
// ---------------------------------------------------------------------------

function noop() {
  console.log("[mock] savedAvailabilities mutation — no-op in design mode");
}

// ---------------------------------------------------------------------------
// Export handler map
// ---------------------------------------------------------------------------

export const mutationHandlers: Record<string, Handler> = {
  // users
  "users:getOrCreateAnonymousProfile": getOrCreateAnonymousProfile,
  "users:updateProfile": updateProfile,
  "users:ensureAuthProfile": ensureAuthProfile,
  "users:unlinkSso": unlinkSso,
  "users:refreshProfileImageIfNeeded": refreshProfileImageIfNeeded,

  // schedules
  "schedules:create": schedulesCreate,
  "schedules:update": schedulesUpdate,
  "schedules:remove": schedulesRemove,
  "schedules:setArchived": setArchived,
  "schedules:setDisallowedSlots": setDisallowedSlots,
  "schedules:setLockedSlots": setLockedSlots,
  "schedules:clearDisallowedSlots": clearDisallowedSlots,
  "schedules:clearLockedSlots": clearLockedSlots,
  "schedules:setAcceptParticipation": setAcceptParticipation,
  "schedules:removeParticipant": removeParticipant,
  "schedules:blockParticipant": blockParticipant,
  "schedules:unblockParticipant": unblockParticipant,

  // selections
  "selections:set": selectionsSet,
  "selections:remove": selectionsRemove,
  "selections:batchSet": selectionsBatchSet,
  "selections:clearForProfile": selectionsClearForProfile,

  // savedAvailabilities
  "savedAvailabilities:applyToSchedule": noop,
  "savedAvailabilities:saveNewAndLink": noop,
  "savedAvailabilities:saveOverwriteDefaultAndLink": noop,
  "savedAvailabilities:unlinkFromSchedule": noop,
  "savedAvailabilities:renameSaved": noop,
  "savedAvailabilities:deleteSaved": noop,
};
