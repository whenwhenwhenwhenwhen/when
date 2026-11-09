import { DateTime } from "luxon";
import {
  convertCellToTimezone,
  convertOneOffSlot,
  convertRecurringSlot,
  getCellKey,
  getWeekDates,
  type ScheduleType,
  type TimezoneCell,
} from "./timezone";

type Selection = TimezoneCell & {
  profileId: string;
  timezone: string;
  state: "can-do" | "cant-do" | "maybe";
};

type Participant = {
  _id: string;
  displayName: string;
  profileImageUrl?: string;
};

type Schedule = {
  type: ScheduleType;
  creatorTimezone: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  disallowedSlots?: TimezoneCell[];
  blockedProfileIds?: string[];
  selections: Selection[];
  profiles: Participant[];
};

type TimeWindow = {
  start: DateTime;
  end: DateTime;
};

type SummaryWindow = TimeWindow & {
  available: SummaryParticipant[];
  unavailable: SummaryParticipant[];
};

export type SummaryParticipant = {
  profile: Participant;
  state: Selection["state"] | "blank";
};

type Vote = { state: Selection["state"]; isException: boolean };
type VotedSlot = { start: DateTime; votes: Map<string, Vote> };

type LockedSchedule = Pick<Schedule, "type" | "creatorTimezone"> & {
  lockedSlots?: TimezoneCell[];
};

export function getLockedScheduleDays(
  { type, creatorTimezone, lockedSlots }: LockedSchedule,
  referenceDate: DateTime,
  weekStartDay: number,
) {
  const timezone = referenceDate.zoneName;
  if (!timezone || !lockedSlots?.length) return [];

  const weekStart = getWeekDates(referenceDate, weekStartDay)[0].startOf("day");
  const weekEnd = weekStart.plus({ weeks: 1 });
  const wrapIntoWeek = (date: DateTime) => {
    // The grid wraps projected weekdays at the edges of the viewed week.
    if (type === "one-off") return date;
    if (date < weekStart) return date.plus({ weeks: 1 });
    if (date >= weekEnd) return date.minus({ weeks: 1 });
    return date;
  };

  const slots: TimeWindow[] = [];
  for (const { dayKey, timeSlot } of lockedSlots) {
    const { dateTime } = type === "one-off"
      ? convertOneOffSlot(dayKey, timeSlot, creatorTimezone, timezone)
      : convertRecurringSlot(Number(dayKey), timeSlot, creatorTimezone, timezone, referenceDate, weekStartDay);
    if (!dateTime.isValid) continue;

    const start = wrapIntoWeek(dateTime);
    const end = start.plus({ minutes: 30 });
    const midnight = start.plus({ days: 1 }).startOf("day");
    slots.push({ start, end: DateTime.min(end, midnight) });
    if (end > midnight) {
      const nextDayStart = wrapIntoWeek(midnight);
      slots.push({ start: nextDayStart, end: nextDayStart.plus(end.diff(midnight)) });
    }
  }

  const days: { date: DateTime; windows: TimeWindow[] }[] = [];
  for (const slot of slots.sort((a, b) => a.start.toMillis() - b.start.toMillis())) {
    let day = days.at(-1);
    if (!day || !day.date.hasSame(slot.start, "day")) {
      day = { date: slot.start.startOf("day"), windows: [] };
      days.push(day);
    }
    const previous = day.windows.at(-1);
    if (previous && slot.start <= previous.end) {
      previous.end = DateTime.max(previous.end, slot.end);
    } else {
      day.windows.push(slot);
    }
  }
  return days;
}

export function getTopScheduleWindows(
  schedule: Schedule,
  referenceDate: DateTime,
  weekStartDay: number,
  includeMaybe = true,
): SummaryWindow[] {
  const { type, creatorTimezone, dateRangeStart, dateRangeEnd } = schedule;
  const timezone = referenceDate.zoneName;
  if (!timezone) return [];

  const weekDays = getWeekDates(referenceDate, weekStartDay).map((day) => day.toISODate());
  const project = (cell: TimezoneCell, fromZone: string) =>
    convertCellToTimezone(type, cell, fromZone, timezone, referenceDate, weekStartDay);
  const disallowed = new Set((schedule.disallowedSlots ?? []).map((slot) =>
    getCellKey(type, project(slot, creatorTimezone))
  ));
  const blocked = new Set(schedule.blockedProfileIds);
  // Collect participants across the schedule before filtering votes to this period.
  const voterIds = new Set(schedule.selections.map((selection) => selection.profileId));
  const participants = schedule.profiles
    .filter(({ _id }) => voterIds.has(_id) && !blocked.has(_id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a._id.localeCompare(b._id));
  const participantIds = new Set(participants.map(({ _id }) => _id));
  const cells = new Map<string | number, VotedSlot>();

  for (const selection of schedule.selections) {
    const { profileId } = selection;
    if (!participantIds.has(profileId)) continue;

    // One-off votes identify an instant, even when the local clock repeats an hour.
    const oneOff = type === "one-off"
      ? convertOneOffSlot(selection.dayKey, selection.timeSlot, selection.timezone, timezone)
      : undefined;
    const { dayKey, timeSlot, exceptionDate } = oneOff
      ? { dayKey: oneOff.date, timeSlot: oneOff.time, exceptionDate: undefined }
      : project(selection, selection.timezone);
    if (disallowed.has(getCellKey(type, { dayKey, timeSlot }))) continue;

    const date = type === "one-off"
      ? dayKey
      : exceptionDate ?? weekDays[(Number(dayKey) - weekStartDay + 7) % 7];
    if (!date || (exceptionDate && !weekDays.includes(exceptionDate))) continue;

    const key = oneOff?.dateTime.toMillis() ?? `${date}|${timeSlot}`;
    let cell = cells.get(key);
    if (!cell) {
      const start = oneOff?.dateTime ?? DateTime.fromISO(`${date}T${timeSlot}`, { zone: timezone });
      if (!start.isValid) continue;
      if (type === "one-off") {
        const scheduleDate = start.setZone(creatorTimezone).toISODate();
        if (!scheduleDate || (dateRangeStart && scheduleDate < dateRangeStart)
          || (dateRangeEnd && scheduleDate > dateRangeEnd)) continue;
      }
      cell = { start, votes: new Map() };
      cells.set(key, cell);
    }

    // A dated override replaces only this participant's recurring vote.
    if (exceptionDate || !cell.votes.get(profileId)?.isException) {
      cell.votes.set(profileId, { state: selection.state, isException: !!exceptionDate });
    }
  }

  const isAvailable = (state: SummaryParticipant["state"]) =>
    state === "can-do" || (includeMaybe && state === "maybe");
  const ranked = [...cells.values()]
    .map((cell) => ({
      ...cell,
      count: [...cell.votes.values()].filter(({ state }) => isAvailable(state)).length,
    }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.start.toMillis() - b.start.toMillis());
  const topCounts = [...new Set(ranked.map(({ count }) => count))].slice(0, 2);

  const windows: (VotedSlot & { end: DateTime })[] = [];
  for (const { start, votes, count } of ranked) {
    if (!topCounts.includes(count)) break;

    const end = start.plus({ minutes: 30 });
    const previous = windows.at(-1);
    if (
      previous && previous.end.toMillis() === start.toMillis() && votes.size === previous.votes.size &&
      [...votes].every(([id, { state }]) => {
        const previousState = previous.votes.get(id)?.state;
        return previousState !== undefined &&
          (state === previousState || (isAvailable(state) && isAvailable(previousState)));
      })
    ) {
      previous.end = end;
      // A participant is tentative for the window if any part is a Maybe.
      for (const [id, vote] of votes) {
        if (vote.state === "maybe") previous.votes.set(id, vote);
      }
    } else {
      windows.push({ start, end, votes: new Map(votes) });
    }
  }

  return windows.map(({ start, end, votes }) => {
    const available: SummaryParticipant[] = [];
    const unavailable: SummaryParticipant[] = [];
    for (const profile of participants) {
      const state = votes.get(profile._id)?.state ?? "blank";
      if (isAvailable(state)) {
        available.push({ profile, state });
      } else if (state !== "maybe") {
        unavailable.push({ profile, state });
      }
    }
    return { start, end, available, unavailable };
  });
}
