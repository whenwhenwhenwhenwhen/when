/**
 * Seed data for design mode.
 *
 * Populates the in-memory store with realistic sample data on import.
 * The anonymous identity matches the auth client mock.
 */

import { insert } from "./store";
import { identityIdForClaim, MOCK_ANONYMOUS_CLAIM } from "./identity";

// ---------------------------------------------------------------------------
// Anonymous profile — kept in sync with the auth client mock
// ---------------------------------------------------------------------------

const ANON_NAME_KEY = "when_anonymous_name";

// Set a display name if none exists so the user is "already onboarded"
if (!localStorage.getItem(ANON_NAME_KEY)) {
  localStorage.setItem(ANON_NAME_KEY, "Designer");
}

// ---------------------------------------------------------------------------
// Helper: compute ISO dates relative to today
// ---------------------------------------------------------------------------

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const designerProfileId = insert("userProfiles", {
  identityId: identityIdForClaim(MOCK_ANONYMOUS_CLAIM),
  displayName: localStorage.getItem(ANON_NAME_KEY) || "Designer",
  timezone: userTimezone,
  weekStartDay: 0,
  dstNotifications: true,
});

const aliceProfileId = insert("userProfiles", {
  identityId: "mock-google:alice",
  displayName: "Alice Chen",
  timezone: "America/New_York",
  weekStartDay: 1,
  dstNotifications: true,
});

const bobProfileId = insert("userProfiles", {
  identityId: "mock-google:bob",
  displayName: "Bob Martinez",
  timezone: "America/Los_Angeles",
  weekStartDay: 0,
  dstNotifications: false,
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const recurringScheduleId = insert("schedules", {
  title: "Friday Game Night",
  description: "Weekly board game session — mark when you can make it!",
  type: "recurring",
  creatorProfileId: designerProfileId,
  recurringStartDate: isoDate(-7),
  creatorTimezone: userTimezone,
  createdAt: Date.now() - 86400000 * 3,
  acceptParticipation: true,
});

const oneOffScheduleId = insert("schedules", {
  title: "Holiday Planning",
  description: "Finding the best day for our trip next week.",
  type: "one-off",
  creatorProfileId: aliceProfileId,
  dateRangeStart: isoDate(1),
  dateRangeEnd: isoDate(7),
  creatorTimezone: "America/New_York",
  createdAt: Date.now() - 86400000,
  acceptParticipation: true,
});

const unlistedScheduleId = insert("schedules", {
  title: "Campaign Planning",
  description: "An unlisted schedule visible because you nominated a time.",
  type: "recurring",
  creatorProfileId: aliceProfileId,
  recurringStartDate: isoDate(-14),
  creatorTimezone: "America/New_York",
  createdAt: Date.now() - 86400000 * 2,
  acceptParticipation: true,
});

const endedScheduleId = insert("schedules", {
  title: "Launch Retrospective",
  description: "A completed one-off schedule in the archive.",
  type: "one-off",
  creatorProfileId: bobProfileId,
  dateRangeStart: isoDate(-14),
  dateRangeEnd: isoDate(-7),
  creatorTimezone: "America/Los_Angeles",
  createdAt: Date.now() - 86400000 * 20,
  acceptParticipation: false,
});

// ---------------------------------------------------------------------------
// Selections — recurring schedule (dayKey = "0"-"6" for day-of-week)
// ---------------------------------------------------------------------------

const recurringSlots = [
  // Designer's availability (Fri/Sat evening slots)
  { profileId: designerProfileId, dayKey: "5", timeSlot: "18:00", state: "can-do" as const },
  { profileId: designerProfileId, dayKey: "5", timeSlot: "19:00", state: "can-do" as const },
  { profileId: designerProfileId, dayKey: "5", timeSlot: "20:00", state: "can-do" as const },
  { profileId: designerProfileId, dayKey: "6", timeSlot: "18:00", state: "maybe" as const },
  { profileId: designerProfileId, dayKey: "6", timeSlot: "19:00", state: "can-do" as const },

  // Alice's availability
  { profileId: aliceProfileId, dayKey: "5", timeSlot: "18:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayKey: "5", timeSlot: "19:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayKey: "5", timeSlot: "20:00", state: "maybe" as const },
  { profileId: aliceProfileId, dayKey: "4", timeSlot: "19:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayKey: "4", timeSlot: "20:00", state: "can-do" as const },

  // Bob's availability
  { profileId: bobProfileId, dayKey: "5", timeSlot: "19:00", state: "can-do" as const },
  { profileId: bobProfileId, dayKey: "5", timeSlot: "20:00", state: "can-do" as const },
  { profileId: bobProfileId, dayKey: "5", timeSlot: "21:00", state: "can-do" as const },
  { profileId: bobProfileId, dayKey: "6", timeSlot: "19:00", state: "cant-do" as const },
  { profileId: bobProfileId, dayKey: "6", timeSlot: "20:00", state: "maybe" as const },
];

for (const slot of recurringSlots) {
  insert("selections", {
    scheduleId: recurringScheduleId,
    profileId: slot.profileId,
    dayKey: slot.dayKey,
    timeSlot: slot.timeSlot,
    timezone: userTimezone,
    state: slot.state,
  });
}

// ---------------------------------------------------------------------------
// Selections — one-off schedule (dayKey = ISO date)
// ---------------------------------------------------------------------------

const oneOffSlots = [
  // Alice (creator)
  { profileId: aliceProfileId, dayOffset: 2, timeSlot: "10:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayOffset: 2, timeSlot: "11:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayOffset: 3, timeSlot: "14:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayOffset: 3, timeSlot: "15:00", state: "can-do" as const },
  { profileId: aliceProfileId, dayOffset: 5, timeSlot: "10:00", state: "maybe" as const },

  // Bob
  { profileId: bobProfileId, dayOffset: 2, timeSlot: "10:00", state: "can-do" as const },
  { profileId: bobProfileId, dayOffset: 2, timeSlot: "11:00", state: "maybe" as const },
  { profileId: bobProfileId, dayOffset: 3, timeSlot: "14:00", state: "cant-do" as const },
  { profileId: bobProfileId, dayOffset: 4, timeSlot: "10:00", state: "can-do" as const },
  { profileId: bobProfileId, dayOffset: 4, timeSlot: "11:00", state: "can-do" as const },
];

for (const slot of oneOffSlots) {
  insert("selections", {
    scheduleId: oneOffScheduleId,
    profileId: slot.profileId,
    dayKey: isoDate(slot.dayOffset),
    timeSlot: slot.timeSlot,
    timezone: "America/New_York",
    state: slot.state,
  });
}

insert("selections", {
  scheduleId: unlistedScheduleId,
  profileId: designerProfileId,
  dayKey: "3",
  timeSlot: "19:00",
  timezone: userTimezone,
  state: "can-do",
});

insert("selections", {
  scheduleId: endedScheduleId,
  profileId: designerProfileId,
  dayKey: isoDate(-10),
  timeSlot: "18:00",
  timezone: userTimezone,
  state: "can-do",
});
