import { DateTime } from "luxon";

export type ScheduleType = "one-off" | "recurring";

export type TimezoneCell = {
  dayKey: string;
  timeSlot: string;
  isException?: boolean;
  exceptionDate?: string;
};

function jsDayOfWeek(dateTime: DateTime): number {
  return dateTime.weekday === 7 ? 0 : dateTime.weekday;
}

export function convertCellToTimezone(
  scheduleType: ScheduleType,
  cell: TimezoneCell,
  fromTimezone: string,
  toTimezone: string,
  referenceDate: DateTime,
  weekStartDay: number = 1
): TimezoneCell {
  const [hour, minute] = cell.timeSlot.split(":").map(Number);

  if (scheduleType === "one-off" || (cell.isException && cell.exceptionDate)) {
    const sourceDate =
      scheduleType === "one-off" ? cell.dayKey : cell.exceptionDate!;
    const converted = DateTime.fromISO(sourceDate, { zone: fromTimezone })
      .set({ hour, minute, second: 0, millisecond: 0 })
      .setZone(toTimezone);

    if (scheduleType === "one-off") {
      return {
        dayKey: converted.toISODate()!,
        timeSlot: converted.toFormat("HH:mm"),
      };
    }

    return {
      dayKey: String(jsDayOfWeek(converted)),
      timeSlot: converted.toFormat("HH:mm"),
      isException: true,
      exceptionDate: converted.toISODate()!,
    };
  }

  const referenceDayOfWeek =
    referenceDate.weekday === 7 ? 0 : referenceDate.weekday;
  const daysBack = (referenceDayOfWeek - weekStartDay + 7) % 7;
  const weekStart = referenceDate.minus({ days: daysBack });
  const dayOffset = (Number(cell.dayKey) - weekStartDay + 7) % 7;
  const sourceDateTime = weekStart
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .setZone(fromTimezone, { keepLocalTime: true });
  const converted = sourceDateTime.setZone(toTimezone);
  return {
    dayKey: String(jsDayOfWeek(converted)),
    timeSlot: converted.toFormat("HH:mm"),
  };
}

export function cellKey(cell: TimezoneCell): string {
  return `${cell.dayKey}|${cell.timeSlot}`;
}
