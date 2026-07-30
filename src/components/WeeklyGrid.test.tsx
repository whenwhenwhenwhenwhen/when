// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Settings } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Id } from "../../convex/_generated/dataModel";
import { WeeklyGrid } from "./WeeklyGrid";

describe("WeeklyGrid participant timezone editing", () => {
  beforeEach(() => {
    Settings.now = () => Date.parse("2026-07-29T12:00:00+10:00");
  });

  afterEach(() => {
    Settings.now = () => Date.now();
  });

  it("submits clicked cells in the edited participant's timezone", async () => {
    const onCellChange = vi.fn(() => Promise.resolve());
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Timezone test",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [
            {
              _id: "selection",
              scheduleId: "schedule",
              profileId: participantId,
              dayKey: "1",
              timeSlot: "09:00",
              timezone: "America/New_York",
              state: "can-do",
            },
          ],
          profiles: [
            {
              _id: participantId,
              displayName: "Participant",
              timezone: "America/New_York",
            },
          ],
        }}
        profileId={participantId}
        userTimezone="Australia/Melbourne"
        selectionTimezone="America/New_York"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract
        isCreator
        canLock
        creatorMode="nominate"
        onCellChange={onCellChange}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    const rows = container.querySelectorAll("tbody tr");

    // Monday 09:00 Melbourne is Sunday 19:00 New York. It is blank even
    // though the participant also has a raw Monday 09:00 selection.
    const blankMondayNine = rows[18].querySelectorAll("td")[2];
    fireEvent.mouseDown(blankMondayNine, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCellChange).toHaveBeenCalledWith(
        "0",
        "19:00",
        "can-do",
        undefined,
        undefined,
        "America/New_York",
        "1",
        "09:00"
      );
    });

    // The participant's Monday 09:00 selection appears at Monday 23:00
    // Melbourne and must still target the original storage key.
    const populatedMondayElevenPm = rows[46].querySelectorAll("td")[2];
    fireEvent.mouseDown(populatedMondayElevenPm, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCellChange).toHaveBeenLastCalledWith(
        "1",
        "09:00",
        "cant-do",
        undefined,
        undefined,
        "America/New_York",
        "1",
        "23:00"
      );
    });
  });

  it("moves schedule limits with the viewer timezone and edits their original key", async () => {
    const onCreatorSlotChange = vi.fn(() => Promise.resolve());
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Timezone limits",
          type: "recurring",
          creatorTimezone: "America/New_York",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [],
          profiles: [],
          disallowedSlots: [{ dayKey: "1", timeSlot: "09:00" }],
        }}
        profileId={participantId}
        userTimezone="Australia/Melbourne"
        selectionTimezone="Australia/Melbourne"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract
        isCreator
        canLock
        creatorMode="limit"
        onCellChange={vi.fn(() => Promise.resolve())}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={onCreatorSlotChange}
      />
    );

    const rows = container.querySelectorAll("tbody tr");

    // The stored Monday 09:00 New York limit appears at Monday 23:00
    // Melbourne and toggling it removes the original stored key.
    const mondayElevenPm = rows[46].querySelectorAll("td")[2];
    fireEvent.mouseDown(mondayElevenPm, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCreatorSlotChange).toHaveBeenCalledWith([]);
    });

    // Monday 09:00 Melbourne maps back to Sunday 19:00 New York rather
    // than colliding with the raw Monday 09:00 schedule key.
    const mondayNineAm = rows[18].querySelectorAll("td")[2];
    fireEvent.mouseDown(mondayNineAm, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCreatorSlotChange).toHaveBeenLastCalledWith([
        { dayKey: "1", timeSlot: "09:00" },
        { dayKey: "0", timeSlot: "19:00" },
      ]);
    });
  });

  it("keeps an existing selection's storage timezone after a settings change", async () => {
    const onCellChange = vi.fn(() => Promise.resolve());
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Changed profile timezone",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [
            {
              _id: "old-selection",
              scheduleId: "schedule",
              profileId: participantId,
              dayKey: "1",
              timeSlot: "09:00",
              timezone: "America/New_York",
              state: "can-do",
            },
          ],
          profiles: [
            {
              _id: participantId,
              displayName: "Participant",
              timezone: "Europe/London",
            },
          ],
        }}
        profileId={participantId}
        userTimezone="Australia/Melbourne"
        selectionTimezone="Europe/London"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract
        isCreator
        canLock
        creatorMode="nominate"
        onCellChange={onCellChange}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    const mondayElevenPm =
      container.querySelectorAll("tbody tr")[46].querySelectorAll("td")[2];
    fireEvent.mouseDown(mondayElevenPm, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCellChange).toHaveBeenCalledWith(
        "1",
        "09:00",
        "cant-do",
        undefined,
        undefined,
        "America/New_York",
        "1",
        "23:00"
      );
    });
  });

  it("checks one-off range boundaries in the schedule timezone", async () => {
    const onCellChange = vi.fn(() => Promise.resolve());
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "One-off boundary",
          type: "one-off",
          dateRangeStart: "2026-07-27",
          dateRangeEnd: "2026-07-27",
          creatorTimezone: "America/New_York",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [],
          profiles: [],
        }}
        profileId={participantId}
        userTimezone="Australia/Melbourne"
        selectionTimezone="Australia/Melbourne"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract
        isCreator={false}
        canLock={false}
        creatorMode={null}
        onCellChange={onCellChange}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    const rows = container.querySelectorAll("tbody tr");

    // Monday 09:00 Melbourne is still Sunday in New York, before the poll.
    const beforeRange = rows[18].querySelectorAll("td")[2];
    fireEvent.mouseDown(beforeRange, { button: 0 });
    fireEvent.mouseUp(document, { button: 0 });
    expect(onCellChange).not.toHaveBeenCalled();

    // Tuesday 09:00 Melbourne is Monday 19:00 New York and is valid.
    const insideRange = rows[18].querySelectorAll("td")[3];
    fireEvent.mouseDown(insideRange, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(onCellChange).toHaveBeenCalledWith(
        "2026-07-28",
        "09:00",
        "can-do",
        undefined,
        undefined,
        "Australia/Melbourne",
        "2026-07-27",
        "19:00"
      );
    });
  });
});
