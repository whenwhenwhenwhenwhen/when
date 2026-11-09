import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { getLockedScheduleDays, getTopScheduleWindows } from "./scheduleSummary";

type Schedule = Parameters<typeof getTopScheduleWindows>[0];
type Selection = Schedule["selections"][number];

const profiles = [
  { _id: "a", displayName: "Alex" },
  { _id: "b", displayName: "Sam" },
  { _id: "c", displayName: "Sam" },
];

function vote(profileId: string, dayKey: string, timeSlot: string, state: Selection["state"] = "can-do"): Selection {
  return { profileId, dayKey, timeSlot, state, timezone: "UTC" };
}

describe("getLockedScheduleDays", () => {
  it("merges adjacent locks by local date while keeping gaps and dates beyond the viewed week", () => {
    const days = getLockedScheduleDays({
      type: "one-off",
      creatorTimezone: "UTC",
      lockedSlots: [
        { dayKey: "2026-08-04", timeSlot: "16:00" },
        { dayKey: "2026-07-27", timeSlot: "13:30" },
        { dayKey: "2026-07-27", timeSlot: "14:30" },
        { dayKey: "2026-07-27", timeSlot: "13:00" },
        { dayKey: "2026-07-27", timeSlot: "14:00" },
        { dayKey: "2026-07-27", timeSlot: "16:30" },
      ],
    }, DateTime.fromISO("2026-07-27", { zone: "Australia/Melbourne" }), 1);

    expect(days.map(({ date, windows }) => [date.toISODate(), windows.map(({ start, end }) => [
      start.toFormat("HH:mm"), end.toFormat("HH:mm"),
    ])])).toEqual([
      ["2026-07-27", [["23:00", "00:00"]]],
      ["2026-07-28", [["00:00", "01:00"], ["02:30", "03:00"]]],
      ["2026-08-05", [["02:00", "02:30"]]],
    ]);
  });

  it("combines recurring locks projected onto the same weekday across the week boundary", () => {
    const days = getLockedScheduleDays({
      type: "recurring",
      creatorTimezone: "Australia/Melbourne",
      lockedSlots: [
        { dayKey: "0", timeSlot: "23:30" },
        { dayKey: "1", timeSlot: "00:00" },
        { dayKey: "1", timeSlot: "10:00" },
      ],
    }, DateTime.fromISO("2026-07-27", { zone: "UTC" }), 1);

    expect(days.map(({ date, windows }) => [date.toISODate(), windows.map(({ start, end }) => [
      start.toFormat("HH:mm"), end.toFormat("HH:mm"),
    ])])).toEqual([
      ["2026-07-27", [["00:00", "00:30"]]],
      ["2026-08-02", [["13:30", "14:30"]]],
    ]);
  });
});

describe("getTopScheduleWindows", () => {
  it("compares the full one-off date range and merges only adjacent slots with the same voters", () => {
    const first = "2026-07-27";
    const second = "2026-08-04";
    const schedule: Schedule = {
      type: "one-off",
      creatorTimezone: "UTC",
      dateRangeStart: first,
      dateRangeEnd: second,
      disallowedSlots: [{ dayKey: first, timeSlot: "22:30" }],
      profiles,
      selections: [
        ...["a", "b", "c"].flatMap((id) => [
          vote(id, first, "22:30"), // Disallowed.
          vote(id, "2026-08-05", "09:00"), // Outside the schedule's date range.
        ]),
        vote("a", first, "23:00"), vote("b", first, "23:00"),
        vote("a", first, "23:00"), // A duplicate vote must not increase the count.
        vote("a", first, "23:30"), vote("b", first, "23:30"),
        vote("a", "2026-07-28", "00:00"), vote("c", "2026-07-28", "00:00"),
        vote("a", second, "23:30"), vote("b", second, "23:30"),
      ],
    };

    const windows = getTopScheduleWindows(schedule, DateTime.fromISO(first, { zone: "Australia/Melbourne" }), 0);

    expect(windows.map(({ start, end, available }) => [
      start.toFormat("yyyy-MM-dd HH:mm"),
      end.toFormat("HH:mm"),
      available.map(({ profile }) => profile._id),
    ])).toEqual([
      ["2026-07-28 09:00", "10:00", ["a", "b"]],
      ["2026-07-28 10:00", "10:30", ["a", "c"]],
      ["2026-08-05 09:30", "10:00", ["a", "b"]],
    ]);
  });

  it("applies recurring exceptions only to their participant and displayed week", () => {
    const schedule: Schedule = {
      type: "recurring",
      creatorTimezone: "UTC",
      profiles,
      selections: [
        { ...vote("a", "1", "23:00", "cant-do"), isException: true, exceptionDate: "2026-07-27" },
        { ...vote("c", "1", "23:00"), isException: true, exceptionDate: "2026-08-10" },
        vote("a", "1", "23:00"),
        vote("b", "1", "23:00"),
        vote("c", "1", "23:00", "maybe"),
      ],
    };
    const firstWeek = DateTime.fromISO("2026-07-28", { zone: "Australia/Melbourne" });
    const [first] = getTopScheduleWindows(schedule, firstWeek, 2, false);
    const [next] = getTopScheduleWindows(schedule, firstWeek.plus({ weeks: 1 }), 2, false);

    expect(first.start.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-28 09:00");
    expect(first.available.map(({ profile }) => profile)).toEqual([profiles[1]]);
    expect(next.available.map(({ profile }) => profile)).toEqual(profiles.slice(0, 2));
  });

  it("counts Maybe by default, keeps all ties, and lists only schedule participants as unavailable or blank", () => {
    const schedule: Schedule = {
      type: "recurring",
      creatorTimezone: "UTC",
      profiles: [...profiles,
        { _id: "d", displayName: "Tess" },
        { _id: "e", displayName: "Una" },
        { _id: "f", displayName: "Viewer" },
        { _id: "g", displayName: "Blocked" },
      ],
      blockedProfileIds: ["g"],
      selections: [
        ...["09:00", "09:30"].flatMap((time) => [
          vote("a", "1", time), vote("b", "1", time, "maybe"), vote("c", "1", time, "maybe"),
        ]),
        vote("d", "1", "09:00", "cant-do"),
        vote("a", "1", "10:00"), vote("b", "1", "10:00"), vote("c", "1", "10:00", "maybe"),
        { ...vote("e", "1", "09:00"), isException: true, exceptionDate: "2026-08-03" },
        vote("g", "1", "10:00"),
      ],
    };
    const week = DateTime.fromISO("2026-07-27", { zone: "UTC" });
    const withMaybe = getTopScheduleWindows(schedule, week, 0);
    expect(withMaybe.map(({ start, end }) => [start.toFormat("HH:mm"), end.toFormat("HH:mm")])).toEqual([
      ["09:00", "09:30"], ["09:30", "10:30"],
    ]);
    expect(withMaybe[0].available.map(({ profile, state }) => [profile._id, state])).toEqual([
      ["a", "can-do"], ["b", "maybe"], ["c", "maybe"],
    ]);
    expect(withMaybe[0].unavailable.map(({ profile, state }) => [profile._id, state])).toEqual([
      ["d", "cant-do"], ["e", "blank"],
    ]);

    const withoutMaybe = getTopScheduleWindows(schedule, week, 0, false);
    expect(withoutMaybe.map(({ start }) => start.toFormat("HH:mm"))).toEqual(["10:00", "09:00", "09:30"]);
    expect(withoutMaybe[0].available.map(({ profile }) => profile._id)).toEqual(["a", "b"]);
    expect(withoutMaybe[0].unavailable.map(({ profile }) => profile._id)).toEqual(["d", "e"]);
  });

  it("keeps a Maybe inside a window tentative without splitting it when Maybe is included", () => {
    const date = "2026-07-27";
    const schedule: Schedule = {
      type: "one-off",
      creatorTimezone: "UTC",
      profiles,
      selections: [
        vote("a", date, "09:00"), vote("b", date, "09:00"),
        vote("a", date, "09:30", "maybe"), vote("b", date, "09:30"),
        vote("a", date, "10:00"), vote("b", date, "10:00"),
      ],
    };
    const referenceDate = DateTime.fromISO(date, { zone: "UTC" });
    const windows = getTopScheduleWindows(schedule, referenceDate, 0);
    expect(windows).toHaveLength(1);
    expect(windows[0].start.toFormat("HH:mm")).toBe("09:00");
    expect(windows[0].end.toFormat("HH:mm")).toBe("10:30");
    expect(windows[0].available.map(({ profile, state }) => [profile._id, state])).toEqual([
      ["a", "maybe"], ["b", "can-do"],
    ]);

    const withoutMaybe = getTopScheduleWindows(schedule, referenceDate, 0, false);
    expect(withoutMaybe.map(({ start, end, available }) => [
      start.toFormat("HH:mm"), end.toFormat("HH:mm"), available.length,
    ])).toEqual([
      ["09:00", "09:30", 2], ["10:00", "10:30", 2], ["09:30", "10:00", 1],
    ]);
  });

  it("returns both highest distinct vote totals with all ties in rank order", () => {
    const date = "2026-07-27";
    const slots = [
      ["09:00", ["a", "b"]],
      ["09:30", ["a", "b", "c"]],
      ["10:00", ["a"]],
      ["10:30", ["a", "b", "c"]],
      ["11:00", ["b", "c"]],
    ] as const;
    const windows = getTopScheduleWindows({
      type: "one-off",
      creatorTimezone: "UTC",
      profiles,
      selections: slots.flatMap(([time, voters]) => voters.map((id) => vote(id, date, time))),
    }, DateTime.fromISO(date, { zone: "UTC" }), 0);

    expect(windows.map(({ start, available }) => [start.toFormat("HH:mm"), available.length])).toEqual([
      ["09:30", 3], ["10:30", 3], ["09:00", 2], ["11:00", 2],
    ]);
  });

  it("keeps one-off votes at different instants separate when clocks go back", () => {
    const date = "2026-11-01";
    const windows = getTopScheduleWindows({
      type: "one-off",
      creatorTimezone: "UTC",
      profiles,
      selections: [vote("a", date, "05:00"), vote("b", date, "06:00")],
    }, DateTime.fromISO(date, { zone: "America/New_York" }), 0);

    expect(windows.map(({ start, available }) => [start.toFormat("HH:mm ZZZ"), available.map(({ profile }) => profile)])).toEqual([
      ["01:00 -0400", [profiles[0]]],
      ["01:00 -0500", [profiles[1]]],
    ]);
  });
});
