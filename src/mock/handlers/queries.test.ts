import { beforeAll, describe, expect, it } from "vitest";
import * as store from "../store";
import { identityIdForClaim } from "../identity";
import { queryHandlers } from "./queries";

let schedulesList: (args: Record<string, unknown>) => Record<string, unknown>;
const anonymousClaim = "schedule-list-viewer";

beforeAll(() => {
  schedulesList = queryHandlers["schedules:list"];

  const viewerProfileId = store.insert("userProfiles", {
    identityId: identityIdForClaim(anonymousClaim),
    displayName: "Viewer",
    timezone: "Australia/Melbourne",
  });
  const otherProfileId = store.insert("userProfiles", {
    identityId: identityIdForClaim("schedule-list-other"),
    displayName: "Other",
    timezone: "Australia/Melbourne",
  });

  store.insert("schedules", {
    title: "Friday Game Night",
    type: "recurring",
    creatorProfileId: viewerProfileId,
    creatorTimezone: "Australia/Melbourne",
    createdAt: 1,
  });
  const participatedScheduleId = store.insert("schedules", {
    title: "Campaign Planning",
    type: "recurring",
    creatorProfileId: otherProfileId,
    creatorTimezone: "Australia/Melbourne",
    createdAt: 2,
  });
  store.insert("selections", {
    scheduleId: participatedScheduleId,
    profileId: viewerProfileId,
    dayKey: "3",
    timeSlot: "19:00",
    timezone: "Australia/Melbourne",
    state: "can-do",
  });
  store.insert("schedules", {
    title: "Unrelated Schedule",
    type: "recurring",
    creatorProfileId: otherProfileId,
    creatorTimezone: "Australia/Melbourne",
    createdAt: 3,
  });
  const endedScheduleId = store.insert("schedules", {
    title: "Launch Retrospective",
    type: "one-off",
    creatorProfileId: otherProfileId,
    creatorTimezone: "Australia/Melbourne",
    dateRangeStart: "2025-01-01",
    dateRangeEnd: "2025-01-02",
    createdAt: 4,
  });
  store.insert("selections", {
    scheduleId: endedScheduleId,
    profileId: viewerProfileId,
    dayKey: "2025-01-01",
    timeSlot: "18:00",
    timezone: "Australia/Melbourne",
    state: "can-do",
  });
});

describe("schedules:list design-mode handler", () => {
  it("separates owned and participated schedules without unrelated ones", () => {
    const result = schedulesList({
      anonymousClaim,
      currentDate: "2026-08-02",
    }) as {
      mySchedules: { title: string }[];
      participatedIn: { title: string }[];
      archived: { title: string }[];
    };

    expect(result.mySchedules.map((schedule) => schedule.title)).toEqual([
      "Friday Game Night",
    ]);
    expect(result.participatedIn.map((schedule) => schedule.title)).toEqual([
      "Campaign Planning",
    ]);
    expect(result.archived.map((schedule) => schedule.title)).toEqual([
      "Launch Retrospective",
    ]);
  });

  it("does not list schedules for a viewer without a profile", () => {
    const result = schedulesList({
      currentDate: "2026-08-02",
    });

    expect(result).toMatchObject({
      mySchedules: [],
      participatedIn: [],
      archived: [],
      hasArchived: false,
    });
  });
});
