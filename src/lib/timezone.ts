import { DateTime } from "luxon";

export type ScheduleType = "one-off" | "recurring";

export interface TimezoneCell {
  dayKey: string;
  timeSlot: string;
  isException?: boolean;
  exceptionDate?: string;
}

/**
 * Get the user's timezone from browser.
 * Uses Intl API which considers client hints.
 */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Convert a weekday + time in one timezone to another timezone for a specific date.
 * Used for recurring schedules where the selection is stored as wall-clock time.
 *
 * @param dayOfWeek 0-6 (0=Sunday in JS convention)
 * @param time "HH:mm" format
 * @param fromTimezone IANA timezone of the selection
 * @param toTimezone IANA timezone of the viewer
 * @param referenceDate A date in the week being viewed (to get correct DST offset)
 * @param weekStartDay 0-6 weekday used as the displayed week's first day
 * @returns { dayOfWeek, time, dateTime } in the target timezone
 */
export function convertRecurringSlot(
  dayOfWeek: number,
  time: string,
  fromTimezone: string,
  toTimezone: string,
  referenceDate: DateTime,
  weekStartDay: number = 1
): { dayOfWeek: number; time: string; dateTime: DateTime } {
  const referenceDayOfWeek =
    referenceDate.weekday === 7 ? 0 : referenceDate.weekday;
  const daysBack = (referenceDayOfWeek - weekStartDay + 7) % 7;
  const weekStart = referenceDate.minus({ days: daysBack });
  const dayOffset = (dayOfWeek - weekStartDay + 7) % 7;
  const targetDate = weekStart.plus({ days: dayOffset });

  const [hours, minutes] = time.split(":").map(Number);

  // Create datetime in the source timezone
  const sourceDateTime = targetDate.set({
    hour: hours,
    minute: minutes,
    second: 0,
    millisecond: 0,
  }).setZone(fromTimezone, { keepLocalTime: true });

  // Convert to target timezone
  const targetDateTime = sourceDateTime.setZone(toTimezone);

  // Get the JS day of week (0=Sunday)
  const resultDow = targetDateTime.weekday === 7 ? 0 : targetDateTime.weekday;
  const resultTime = targetDateTime.toFormat("HH:mm");

  return {
    dayOfWeek: resultDow,
    time: resultTime,
    dateTime: targetDateTime,
  };
}

/**
 * Convert a one-off date + time selection between timezones.
 * For one-off schedules, times are absolute (UTC-convertible).
 */
export function convertOneOffSlot(
  dateStr: string,
  time: string,
  fromTimezone: string,
  toTimezone: string
): { date: string; time: string; dateTime: DateTime } {
  const [hours, minutes] = time.split(":").map(Number);

  const sourceDateTime = DateTime.fromISO(dateStr, {
    zone: fromTimezone,
  }).set({
    hour: hours,
    minute: minutes,
    second: 0,
    millisecond: 0,
  });

  const targetDateTime = sourceDateTime.setZone(toTimezone);

  return {
    date: targetDateTime.toISODate()!,
    time: targetDateTime.toFormat("HH:mm"),
    dateTime: targetDateTime,
  };
}

/**
 * Convert a stored grid cell between timezones without losing its coordinate
 * domain. Recurring base cells remain weekday based, while one-off cells and
 * recurring exceptions remain tied to an exact date.
 */
export function convertCellToTimezone(
  scheduleType: ScheduleType,
  cell: TimezoneCell,
  fromTimezone: string,
  toTimezone: string,
  referenceDate: DateTime,
  weekStartDay: number = 1
): TimezoneCell {
  if (scheduleType === "one-off") {
    const converted = convertOneOffSlot(
      cell.dayKey,
      cell.timeSlot,
      fromTimezone,
      toTimezone
    );
    return { dayKey: converted.date, timeSlot: converted.time };
  }

  if (cell.isException && cell.exceptionDate) {
    const converted = convertOneOffSlot(
      cell.exceptionDate,
      cell.timeSlot,
      fromTimezone,
      toTimezone
    );
    const dayOfWeek =
      converted.dateTime.weekday === 7 ? 0 : converted.dateTime.weekday;
    return {
      dayKey: String(dayOfWeek),
      timeSlot: converted.time,
      isException: true,
      exceptionDate: converted.date,
    };
  }

  const converted = convertRecurringSlot(
    Number(cell.dayKey),
    cell.timeSlot,
    fromTimezone,
    toTimezone,
    referenceDate,
    weekStartDay
  );
  return {
    dayKey: String(converted.dayOfWeek),
    timeSlot: converted.time,
  };
}

export function getCellKey(
  scheduleType: ScheduleType,
  cell: TimezoneCell
): string {
  if (scheduleType === "one-off") {
    return `${cell.dayKey}|${cell.timeSlot}`;
  }
  if (cell.isException && cell.exceptionDate) {
    return `exc:${cell.exceptionDate}|${cell.timeSlot}`;
  }
  return `${cell.dayKey}|${cell.timeSlot}`;
}

/**
 * Generate time slot labels for the grid (48 half-hour slots).
 */
export function generateTimeSlots(): string[] {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(
        `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`
      );
    }
  }
  return slots;
}

/**
 * Format a time slot for display (e.g., "14:00" -> "2:00 PM").
 */
export function formatTimeSlot(slot: string): string {
  const [h, m] = slot.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayHour}:${m.toString().padStart(2, "0")} ${period}`;
}

/**
 * Get day names starting from the configured start day.
 */
export function getDayNames(startDay: number = 0): string[] {
  const allDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const result: string[] = [];
  for (let i = 0; i < 7; i++) {
    result.push(allDays[(startDay + i) % 7]);
  }
  return result;
}

/**
 * Get the dates for a week starting from a reference date and start day.
 */
export function getWeekDates(
  referenceDate: DateTime,
  startDay: number = 0
): DateTime[] {
  // Find the most recent startDay on or before referenceDate
  const refDow = referenceDate.weekday === 7 ? 0 : referenceDate.weekday; // Convert to JS convention
  let daysBack = (refDow - startDay + 7) % 7;
  const weekStart = referenceDate.minus({ days: daysBack });

  const dates: DateTime[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(weekStart.plus({ days: i }));
  }
  return dates;
}

/**
 * Get a list of common timezones for the settings dropdown.
 */
export function getCommonTimezones(): string[] {
  return [
    // North America
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "America/Toronto",
    "America/Vancouver",
    "America/Winnipeg",
    "America/Edmonton",
    "America/Halifax",
    "America/St_Johns",
    "America/Phoenix",
    // Central & South America
    "America/Mexico_City",
    "America/Bogota",
    "America/Lima",
    "America/Santiago",
    "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires",
    // Europe
    "Europe/London",
    "Europe/Dublin",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Amsterdam",
    "Europe/Brussels",
    "Europe/Zurich",
    "Europe/Vienna",
    "Europe/Stockholm",
    "Europe/Oslo",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Warsaw",
    "Europe/Prague",
    "Europe/Budapest",
    "Europe/Bucharest",
    "Europe/Athens",
    "Europe/Moscow",
    "Europe/Istanbul",
    "Europe/Lisbon",
    "Europe/Kiev",
    // Middle East & Africa
    "Asia/Dubai",
    "Asia/Riyadh",
    "Asia/Tehran",
    "Asia/Jerusalem",
    "Africa/Cairo",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Africa/Johannesburg",
    "Africa/Casablanca",
    // South Asia
    "Asia/Kolkata",
    "Asia/Karachi",
    "Asia/Dhaka",
    "Asia/Colombo",
    // Southeast Asia
    "Asia/Bangkok",
    "Asia/Singapore",
    "Asia/Jakarta",
    "Asia/Ho_Chi_Minh",
    "Asia/Manila",
    "Asia/Kuala_Lumpur",
    // East Asia
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Taipei",
    "Asia/Tokyo",
    "Asia/Seoul",
    // Oceania
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Hobart",
    "Pacific/Auckland",
    "Pacific/Fiji",
    "Pacific/Guam",
    // UTC
    "UTC",
  ];
}
