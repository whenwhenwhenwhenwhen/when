/**
 * Mock query handlers for design mode.
 *
 * Each handler mirrors the return shape of its real Convex query function.
 */

import * as store from "../store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: Args) => any;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function currentUserProfile(args: Args) {
  const profiles = store.query("userProfiles");

  // Anonymous path (no auth in design mode)
  if (args.anonymousId) {
    const profile = profiles.find((p) => p.anonymousId === args.anonymousId);
    if (profile) {
      return {
        ...profile,
        isAuthenticated: false,
        authType: "anonymous",
        ssoName: undefined,
        ssoEmail: undefined,
        ssoImage: undefined,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

function getViewerProfile(args: Args) {
  if (!args.anonymousId) return null;
  return (
    store
      .query("userProfiles")
      .find((profile) => profile.anonymousId === args.anonymousId) ?? null
  );
}

function hasNominations(scheduleId: string, profileId: string) {
  return (
    store
      .query("selections")
      .some(
        (selection) =>
          selection.scheduleId === scheduleId &&
          selection.profileId === profileId,
      ) ||
    store.query("availabilityLinks").some((link) => {
      if (link.scheduleId !== scheduleId || link.profileId !== profileId) {
        return false;
      }
      const savedAvailability = store.get(
        "savedAvailabilities",
        link.savedAvailabilityId,
      );
      return (savedAvailability?.slots.length ?? 0) > 0;
    })
  );
}

function isBlocked(scheduleId: string, profileId: string) {
  return store
    .query("blockedProfiles")
    .some(
      (blocked) =>
        blocked.scheduleId === scheduleId &&
        blocked.profileId === profileId,
    );
}

function isPastOneOff(schedule: Args, currentDate: string) {
  return (
    schedule.type === "one-off" &&
    !!schedule.dateRangeEnd &&
    schedule.dateRangeEnd < currentDate
  );
}

function enrichListedSchedule(
  schedule: Args,
  state: {
    isParticipated: boolean;
    isArchived: boolean;
    isExpired: boolean;
    isManuallyArchived: boolean;
  },
) {
  const creator = store.get("userProfiles", schedule.creatorProfileId);
  return {
    ...schedule,
    ...state,
    creatorName: creator?.displayName ?? "Unknown",
    creatorImage: creator?.profileImageUrl,
  };
}

function schedulesList(args: Args) {
  const viewer = getViewerProfile(args);
  const publicSchedules = store
    .query("schedules")
    .filter((schedule) => !schedule.isPrivate);

  if (!viewer) {
    return {
      participated: [],
      publicSchedules: publicSchedules
        .filter((schedule) => !isPastOneOff(schedule, args.currentDate))
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((schedule) =>
          enrichListedSchedule(schedule, {
            isParticipated: false,
            isArchived: false,
            isExpired: false,
            isManuallyArchived: false,
          }),
        ),
      archived: [],
      hasArchived: false,
    };
  }

  const candidates = new Map(
    publicSchedules.map((schedule) => [schedule._id, schedule]),
  );
  for (const schedule of store.query("schedules")) {
    if (
      schedule.creatorProfileId === viewer._id ||
      hasNominations(schedule._id, viewer._id)
    ) {
      candidates.set(schedule._id, schedule);
    }
  }

  const archives = store
    .query("scheduleArchives")
    .filter((archive) => archive.profileId === viewer._id);
  const archivedIds = new Set(archives.map((archive) => archive.scheduleId));

  const participated: Args[] = [];
  const remainingPublic: Args[] = [];
  const archived: Args[] = [];

  for (const schedule of candidates.values()) {
    const isCreator = schedule.creatorProfileId === viewer._id;
    const isParticipated =
      isCreator || hasNominations(schedule._id, viewer._id);
    if (!isCreator && isBlocked(schedule._id, viewer._id)) continue;

    const isExpired = isPastOneOff(schedule, args.currentDate);
    const isManuallyArchived =
      isParticipated && archivedIds.has(schedule._id);
    if (isExpired || isManuallyArchived) {
      if (isParticipated) archived.push(schedule);
    } else if (isParticipated) {
      participated.push(schedule);
    } else if (!schedule.isPrivate) {
      remainingPublic.push(schedule);
    }
  }

  const enrich = (schedule: Args, isParticipated: boolean) => {
    const isExpired = isPastOneOff(schedule, args.currentDate);
    const isManuallyArchived =
      isParticipated && archivedIds.has(schedule._id);
    return enrichListedSchedule(schedule, {
      isParticipated,
      isArchived: isExpired || isManuallyArchived,
      isExpired,
      isManuallyArchived,
    });
  };
  const byTitle = (a: Args, b: Args) => a.title.localeCompare(b.title);
  const enrichedArchived = archived
    .sort(byTitle)
    .map((schedule) => enrich(schedule, true));

  return {
    participated: participated
      .sort(byTitle)
      .map((schedule) => enrich(schedule, true)),
    publicSchedules: remainingPublic
      .sort(byTitle)
      .map((schedule) => enrich(schedule, false)),
    archived: enrichedArchived,
    hasArchived: enrichedArchived.length > 0,
  };
}

function getViewerScheduleState(args: Args) {
  const viewer = getViewerProfile(args);
  const schedule = store.get("schedules", args.scheduleId);
  if (!viewer || !schedule) {
    return {
      canArchive: false,
      isArchived: false,
      isExpired: false,
      isManuallyArchived: false,
    };
  }

  const isCreator = schedule.creatorProfileId === viewer._id;
  const canArchive =
    (isCreator || hasNominations(schedule._id, viewer._id)) &&
    (isCreator || !isBlocked(schedule._id, viewer._id));
  const isExpired = isPastOneOff(schedule, args.currentDate);
  const isManuallyArchived =
    canArchive &&
    store
      .query("scheduleArchives")
      .some(
        (archive) =>
          archive.scheduleId === schedule._id &&
          archive.profileId === viewer._id,
      );

  return {
    canArchive,
    isArchived: canArchive && (isExpired || isManuallyArchived),
    isExpired,
    isManuallyArchived,
  };
}

function schedulesGet(args: Args) {
  const schedule = store.get("schedules", args.scheduleId);
  if (!schedule) return null;

  const creator = store.get("userProfiles", schedule.creatorProfileId);

  // Get selections for this schedule
  const allSelections = store
    .query("selections")
    .filter((s) => s.scheduleId === args.scheduleId);

  // Get availability links for this schedule
  const links = store
    .query("availabilityLinks")
    .filter((l) => l.scheduleId === args.scheduleId);

  const linkedProfileIds = new Set(links.map((l) => l.profileId));

  // Filter out non-exception selections for linked profiles
  let filteredSelections = allSelections;
  if (links.length > 0) {
    filteredSelections = allSelections.filter((sel) => {
      if (linkedProfileIds.has(sel.profileId)) {
        return sel.isException === true;
      }
      return true;
    });
  }

  // Build virtual selections from linked saved availabilities
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const virtualSelections: any[] = [];
  const availabilityLinkInfo: {
    profileId: string;
    savedAvailabilityId: string;
    savedAvailabilityName: string;
  }[] = [];

  for (const link of links) {
    const savedAvail = store.get("savedAvailabilities", link.savedAvailabilityId);
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

  // Normalize selections
  const normalizedSelections = filteredSelections.map((s) => ({
    _id: s._id,
    scheduleId: s.scheduleId,
    profileId: s.profileId,
    dayKey: s.dayKey,
    timeSlot: s.timeSlot,
    timezone: s.timezone,
    state: s.state,
    isException: s.isException,
    exceptionDate: s.exceptionDate,
  }));

  const selections = [...normalizedSelections, ...virtualSelections];

  // Collect unique profile IDs from selections + links
  const profileIdSet = new Set<string>();
  for (const sel of selections) profileIdSet.add(sel.profileId);
  for (const link of links) profileIdSet.add(link.profileId);

  const profiles = [...profileIdSet]
    .map((id) => {
      const profile = store.get("userProfiles", id);
      if (!profile) return null;
      return {
        _id: profile._id,
        displayName: profile.displayName,
        profileImageUrl: profile.profileImageUrl,
        timezone: profile.timezone,
      };
    })
    .filter(Boolean);

  // Blocked profiles
  const blockedProfiles = store
    .query("blockedProfiles")
    .filter((b) => b.scheduleId === args.scheduleId);
  const blockedProfileIds = blockedProfiles.map((b) => b.profileId);

  return {
    ...schedule,
    creatorName: creator?.displayName ?? "Unknown",
    creatorImage: creator?.profileImageUrl,
    creatorTimezoneStored: creator?.timezone ?? schedule.creatorTimezone,
    selections,
    profiles,
    availabilityLinks: availabilityLinkInfo,
    blockedProfileIds,
  };
}

function getBlockedProfiles(args: Args) {
  const blocked = store
    .query("blockedProfiles")
    .filter((b) => b.scheduleId === args.scheduleId);

  return blocked.map((b) => {
    const profile = store.get("userProfiles", b.profileId);
    return {
      ...b,
      displayName: profile?.displayName ?? "Unknown",
      profileImageUrl: profile?.profileImageUrl,
    };
  });
}

// ---------------------------------------------------------------------------
// savedAvailabilities
// ---------------------------------------------------------------------------

function listForProfile(args: Args) {
  if (!args.profileId) {
    return store.query("savedAvailabilities");
  }

  return store
    .query("savedAvailabilities")
    .filter((s) => s.profileId === args.profileId);
}

// ---------------------------------------------------------------------------
// Export handler map
// ---------------------------------------------------------------------------

export const queryHandlers: Record<string, Handler> = {
  "users:currentUserProfile": currentUserProfile,
  "schedules:list": schedulesList,
  "schedules:get": schedulesGet,
  "schedules:getViewerScheduleState": getViewerScheduleState,
  "schedules:getBlockedProfiles": getBlockedProfiles,
  "savedAvailabilities:listForProfile": listForProfile,
};
