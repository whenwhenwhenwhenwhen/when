import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { convertCellToTimezone as convertBackendCellToTimezone } from "../../convex/timezone";
import {
  convertCellToTimezone,
  getCellKey,
} from "./timezone";

describe("grid cell timezone conversion", () => {
  const referenceDate = DateTime.fromISO("2026-07-29T12:00:00", {
    zone: "Australia/Melbourne",
  });

  it("round-trips recurring schedule cells across a day boundary", () => {
    const newYorkCell = { dayKey: "1", timeSlot: "09:00" };
    const melbourneCell = convertCellToTimezone(
      "recurring",
      newYorkCell,
      "America/New_York",
      "Australia/Melbourne",
      referenceDate
    );

    expect(melbourneCell).toEqual({
      dayKey: "1",
      timeSlot: "23:00",
    });
    expect(
      convertCellToTimezone(
        "recurring",
        melbourneCell,
        "Australia/Melbourne",
        "America/New_York",
        referenceDate
      )
    ).toEqual(newYorkCell);
  });

  it("keeps one-off and exception dates attached to the same instant", () => {
    expect(
      convertCellToTimezone(
        "one-off",
        { dayKey: "2026-07-27", timeSlot: "23:30" },
        "America/New_York",
        "Australia/Melbourne",
        referenceDate
      )
    ).toEqual({
      dayKey: "2026-07-28",
      timeSlot: "13:30",
    });

    const exception = convertCellToTimezone(
      "recurring",
      {
        dayKey: "1",
        timeSlot: "23:30",
        isException: true,
        exceptionDate: "2026-07-27",
      },
      "America/New_York",
      "Australia/Melbourne",
      referenceDate
    );
    expect(exception).toEqual({
      dayKey: "2",
      timeSlot: "13:30",
      isException: true,
      exceptionDate: "2026-07-28",
    });
    expect(getCellKey("recurring", exception)).toBe(
      "exc:2026-07-28|13:30"
    );
  });

  it("uses the configured week boundary when DST changes on Sunday", () => {
    const dstReference = DateTime.fromISO("2026-09-30T12:00:00", {
      zone: "Australia/Melbourne",
    });
    const cell = { dayKey: "0", timeSlot: "01:30" };
    const converted = convertCellToTimezone(
      "recurring",
      cell,
      "America/New_York",
      "Australia/Melbourne",
      dstReference,
      0
    );

    expect(converted).toEqual({
      dayKey: "0",
      timeSlot: "15:30",
    });

    expect(
      convertBackendCellToTimezone(
        "recurring",
        cell,
        "America/New_York",
        "Australia/Melbourne",
        dstReference,
        0
      )
    ).toEqual(converted);
  });
});
