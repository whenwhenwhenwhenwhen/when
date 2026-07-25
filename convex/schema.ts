import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // User profiles (both anonymous and authenticated via Google)
  userProfiles: defineTable({
    // Google identity tokenIdentifier (set when authenticated via Google)
    authUserId: v.optional(v.string()),
    // Anonymous identifier stored in client localStorage
    anonymousId: v.optional(v.string()),
    displayName: v.string(),
    email: v.optional(v.string()),
    profileImageUrl: v.optional(v.string()),
    // Convex file storage ID for the cached profile image (downloaded from Google)
    profileImageStorageId: v.optional(v.id("_storage")),
    // When the profile image was last re-downloaded (ms since epoch)
    profileImageLastCheckedAt: v.optional(v.number()),
    timezone: v.string(),
    weekStartDay: v.number(), // 0=Sunday, 1=Monday, ..., 6=Saturday
    dstNotifications: v.boolean(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_anonymousId", ["anonymousId"])
    .index("by_profileImageStorageId_and_profileImageUrl", [
      "profileImageStorageId",
      "profileImageUrl",
    ]),

  schedules: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    type: v.union(v.literal("one-off"), v.literal("recurring")),
    creatorProfileId: v.id("userProfiles"),
    // For one-off: restrict the date range
    dateRangeStart: v.optional(v.string()), // ISO date
    dateRangeEnd: v.optional(v.string()), // ISO date
    // For recurring: optional start date
    recurringStartDate: v.optional(v.string()), // ISO date
    creatorTimezone: v.string(),
    // Disallowed time slots (for allow/disallow mode)
    disallowedSlots: v.optional(
      v.array(
        v.object({
          dayKey: v.string(),
          timeSlot: v.string(),
        })
      )
    ),
    // Locked-in time slots
    lockedSlots: v.optional(
      v.array(
        v.object({
          dayKey: v.string(),
          timeSlot: v.string(),
        })
      )
    ),
    isLocked: v.optional(v.boolean()),
    anyoneCanLock: v.optional(v.boolean()),
    lockEditors: v.optional(v.array(v.id("userProfiles"))),
    // Legacy field name: true means unlisted, not access-controlled.
    isPrivate: v.optional(v.boolean()),
    acceptParticipation: v.optional(v.boolean()), // undefined/true = open, false = closed
    createdAt: v.number(),
  })
    .index("by_creatorProfileId", ["creatorProfileId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_isPrivate_and_createdAt", ["isPrivate", "createdAt"])
    .index("by_type_and_createdAt", ["type", "createdAt"]),

  // Blocked profiles per schedule (creator can block users from participating)
  blockedProfiles: defineTable({
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    blockedAt: v.number(),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_profileId", ["profileId"])
    .index("by_schedule_profile", ["scheduleId", "profileId"]),

  // Per-user archive state. Archiving never changes the schedule for anyone
  // else and is independent of one-off schedules that archive automatically.
  scheduleArchives: defineTable({
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    archivedAt: v.number(),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_profileId", ["profileId"])
    .index("by_schedule_profile", ["scheduleId", "profileId"]),

  selectionBatchInvalidations: defineTable({
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    invalidatedAt: v.number(),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_schedule_profile_invalidatedAt", [
      "scheduleId",
      "profileId",
      "invalidatedAt",
    ]),

  selections: defineTable({
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    // For one-off: ISO date (e.g. "2026-04-24")
    // For recurring: day-of-week as string ("0"-"6")
    dayKey: v.string(),
    timeSlot: v.string(), // "HH:mm" in the user's timezone
    timezone: v.string(), // IANA timezone of the user at time of selection
    state: v.union(
      v.literal("can-do"),
      v.literal("cant-do"),
      v.literal("maybe")
    ),
    // For recurring schedule one-off exceptions
    isException: v.optional(v.boolean()),
    exceptionDate: v.optional(v.string()), // ISO date for the specific exception
    // Calendar sync metadata
    source: v.optional(v.union(v.literal("manual"), v.literal("calendar"))),
    externalEventId: v.optional(v.string()),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_profileId", ["profileId"])
    .index("by_schedule_profile", ["scheduleId", "profileId"])
    .index("by_schedule_profile_source", ["scheduleId", "profileId", "source"])
    .index("by_profileId_source", ["profileId", "source"])
    .index("by_profile_schedule_day_time", [
      "profileId",
      "scheduleId",
      "dayKey",
      "timeSlot",
    ])
    .index("by_profile_schedule_day_time_isException_exceptionDate", [
      "profileId",
      "scheduleId",
      "dayKey",
      "timeSlot",
      "isException",
      "exceptionDate",
    ])
    .index("by_schedule_day_time", ["scheduleId", "dayKey", "timeSlot"]),

  // Saved weekly availabilities (SSO users only)
  savedAvailabilities: defineTable({
    profileId: v.id("userProfiles"),
    name: v.string(),
    isDefault: v.optional(v.boolean()),
    timezone: v.string(),
    slots: v.array(
      v.object({
        dayKey: v.string(), // "0"-"6" day of week
        timeSlot: v.string(), // "HH:mm"
        state: v.union(
          v.literal("can-do"),
          v.literal("cant-do"),
          v.literal("maybe")
        ),
      })
    ),
  }).index("by_profileId", ["profileId"]),

  // Links a saved availability to a schedule for a user
  availabilityLinks: defineTable({
    savedAvailabilityId: v.id("savedAvailabilities"),
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
  })
    .index("by_schedule_profile", ["scheduleId", "profileId"])
    .index("by_scheduleId", ["scheduleId"])
    .index("by_savedAvailability", ["savedAvailabilityId"])
    .index("by_profileId", ["profileId"]),

  // Server-side auth sessions (stores Google refresh tokens for silent token renewal)
  authSessions: defineTable({
    sessionToken: v.string(),
    refreshToken: v.string(),
    googleUserId: v.string(),
    createdAt: v.number(),
  })
    .index("by_sessionToken", ["sessionToken"])
    .index("by_googleUserId", ["googleUserId"]),

  // External calendar sources (Google Calendar or ICS URLs)
  calendarSources: defineTable({
    profileId: v.id("userProfiles"),
    type: v.union(v.literal("google"), v.literal("ics")),
    // Google-specific
    calendarRefreshToken: v.optional(v.string()),
    googleUserId: v.optional(v.string()),
    availableCalendars: v.optional(
      v.array(
        v.object({
          id: v.string(),
          summary: v.string(),
        })
      )
    ),
    selectedCalendarIds: v.optional(v.array(v.string())),
    // ICS-specific
    icsUrl: v.optional(v.string()),
    // Sync state
    lastSyncAt: v.optional(v.number()),
    lastSyncStatus: v.optional(
      v.union(v.literal("success"), v.literal("error"))
    ),
    lastSyncError: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_profileId", ["profileId"])
    .index("by_profileId_and_enabled", ["profileId", "enabled"])
    .index("by_lastSyncAt", ["lastSyncAt"]),

  // User overrides for calendar-synced "can't do" cells
  calendarOverrides: defineTable({
    profileId: v.id("userProfiles"),
    scheduleId: v.id("schedules"),
    externalEventId: v.string(),
    dayKey: v.string(),
    timeSlot: v.string(),
  })
    .index("by_profile_schedule", ["profileId", "scheduleId"])
    .index("by_profile_event", ["profileId", "externalEventId"])
    .index("by_profile_schedule_dayKey_timeSlot", [
      "profileId",
      "scheduleId",
      "dayKey",
      "timeSlot",
    ])
    .index("by_profile_schedule_externalEventId_dayKey_timeSlot", [
      "profileId",
      "scheduleId",
      "externalEventId",
      "dayKey",
      "timeSlot",
    ]),

  // DST notification check log
  dstCheckLog: defineTable({
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    dstChangeDate: v.string(),
    notifiedAt: v.number(),
    impactDescription: v.string(),
  }).index("by_schedule_profile_date", [
    "scheduleId",
    "profileId",
    "dstChangeDate",
  ]),

  // Links a schedule to a Discord channel for notifications
  scheduleDiscordLinks: defineTable({
    scheduleId: v.id("schedules"),
    channelId: v.string(),
    channelName: v.optional(v.string()),
    guildId: v.string(),
    guildName: v.optional(v.string()),
    linkedByProfileId: v.id("userProfiles"),
    linkedAt: v.number(),
    // Discord message ID of the most recently sent summary (for edit/jump links)
    lastMessageId: v.optional(v.string()),
    // JSON-serialised locked-slot snapshot used to detect meaningful changes
    lastSnapshotJson: v.optional(v.string()),
    // Currently scheduled debounced send, if any (so we can cancel + reschedule)
    pendingScheduledId: v.optional(v.id("_scheduled_functions")),
    lastNotifiedAt: v.optional(v.number()),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_channel", ["channelId"]),

  // Maps a Discord user to a When profile (so /when can show "your" schedules)
  discordUserLinks: defineTable({
    profileId: v.id("userProfiles"),
    discordUserId: v.string(),
    discordUsername: v.optional(v.string()),
    linkedAt: v.number(),
  })
    .index("by_profileId", ["profileId"])
    .index("by_discordUserId", ["discordUserId"]),

  // Short-lived OAuth/install state for the schedule -> channel link flow
  discordInstallSessions: defineTable({
    sessionToken: v.string(),
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    guildId: v.optional(v.string()),
    guildName: v.optional(v.string()),
    channels: v.optional(
      v.array(
        v.object({
          id: v.string(),
          name: v.string(),
          type: v.number(),
        })
      )
    ),
    createdAt: v.number(),
  })
    .index("by_sessionToken", ["sessionToken"])
    .index("by_createdAt", ["createdAt"]),
});
