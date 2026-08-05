import { DateTime } from "luxon";

/**
 * DST utility functions for client-side DST awareness.
 */

/**
 * Check if a DST transition occurs between two dates in a timezone.
 */
export function hasDstTransition(
  timezone: string,
  startDate: DateTime,
  endDate: DateTime
): { occurs: boolean; transitionDate?: DateTime; direction?: "forward" | "back" } {
  const startOffset = startDate.setZone(timezone).offset;
  const endOffset = endDate.setZone(timezone).offset;

  if (startOffset === endOffset) {
    return { occurs: false };
  }

  // Binary search for the exact transition date
  let low = startDate;
  let high = endDate;

  while (high.diff(low, "hours").hours > 24) {
    const mid = low.plus({ milliseconds: high.diff(low).milliseconds / 2 });
    const midOffset = mid.setZone(timezone).offset;

    if (midOffset === startOffset) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return {
    occurs: true,
    transitionDate: high.startOf("day"),
    direction: endOffset > startOffset ? "forward" : "back",
  };
}

/**
 * Get a human-readable DST notice for the current week view.
 */
export function getDstNotice(
  timezone: string,
  weekDates: DateTime[]
): string | null {
  if (weekDates.length < 2) return null;

  const firstDay = weekDates[0];
  const lastDay = weekDates[weekDates.length - 1];

  const transition = hasDstTransition(timezone, firstDay, lastDay);

  if (transition.occurs && transition.transitionDate) {
    const dir =
      transition.direction === "forward"
        ? "spring forward (clocks move ahead 1 hour)"
        : "fall back (clocks move back 1 hour)";
    return `DST change on ${transition.transitionDate.toFormat("MMMM d")}: ${dir}`;
  }

  return null;
}

