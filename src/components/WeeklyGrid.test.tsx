// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Settings } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Id } from "../../convex/_generated/dataModel";
import styles from "../styles/app.module.css";
import { WeeklyGrid } from "./WeeklyGrid";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function makeRect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

const iconTitles = (cell: Element) =>
  Array.from(cell.querySelectorAll("img")).map((img) => img.title);

describe("WeeklyGrid participant timezone editing", () => {
  beforeEach(() => {
    Settings.now = () => Date.parse("2026-07-29T12:00:00+10:00");
    // jsdom has no layout, so drag hit-testing needs a synthetic grid:
    // 100x24 cells laid out from the cell's row and column position.
    Element.prototype.getBoundingClientRect = function () {
      const cell = this as HTMLTableCellElement;
      const row = cell.parentElement as HTMLTableRowElement | null;
      if (cell.tagName !== "TD" || !row?.parentElement) {
        return makeRect(0, 0, 0, 0);
      }
      const rowIndex = Array.from(row.parentElement.children).indexOf(row);
      return makeRect(cell.cellIndex * 100, rowIndex * 24, 100, 24);
    };
  });

  afterEach(() => {
    Settings.now = () => Date.now();
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
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

  it("keeps the grid viewport scrollable while anonymous interactions are disabled", () => {
    const onCellChange = vi.fn(() => Promise.resolve());
    const onBatchChange = vi.fn(() => Promise.resolve());
    const onCreatorSlotChange = vi.fn(() => Promise.resolve());
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Read-only schedule",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [],
          profiles: [],
        }}
        profileId={null}
        userTimezone="Australia/Melbourne"
        selectionTimezone="Australia/Melbourne"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract={false}
        isCreator={false}
        canLock={false}
        creatorMode={null}
        onCellChange={onCellChange}
        onBatchChange={onBatchChange}
        onCreatorSlotChange={onCreatorSlotChange}
      />,
    );

    const table = container.querySelector("table");
    const scrollContainer = table?.parentElement;
    expect(table?.classList.contains(styles.noInteract)).toBe(true);
    expect(scrollContainer?.classList.contains(styles.noInteract)).toBe(false);

    const firstCell = container.querySelector("tbody td:nth-child(2)");
    fireEvent.mouseDown(firstCell!, { button: 0 });
    fireEvent.mouseUp(document, { button: 0 });

    expect(onCellChange).not.toHaveBeenCalled();
    expect(onBatchChange).not.toHaveBeenCalled();
    expect(onCreatorSlotChange).not.toHaveBeenCalled();
  });

  it("shows another participant's exception instead of their recurring selection", () => {
    const viewerId = "aaa-viewer" as Id<"userProfiles">;
    const otherId = "bbb-other" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Exception visibility",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [
            {
              _id: "other-base",
              scheduleId: "schedule",
              profileId: otherId,
              dayKey: "2",
              timeSlot: "09:00",
              timezone: "Australia/Melbourne",
              state: "can-do",
            },
            {
              _id: "other-exception",
              scheduleId: "schedule",
              profileId: otherId,
              dayKey: "2",
              timeSlot: "09:00",
              timezone: "Australia/Melbourne",
              state: "cant-do",
              isException: true,
              exceptionDate: "2026-07-28",
            },
          ],
          profiles: [
            {
              _id: viewerId,
              displayName: "Viewer",
              profileImageUrl: "https://example.com/viewer.png",
              timezone: "Australia/Melbourne",
            },
            {
              _id: otherId,
              displayName: "Other",
              profileImageUrl: "https://example.com/other.png",
              timezone: "Australia/Melbourne",
            },
          ],
        }}
        profileId={viewerId}
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
        onCellChange={vi.fn(() => Promise.resolve())}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    // Tuesday 2026-07-28 at 09:00 — the exception's date.
    const rows = container.querySelectorAll("tbody tr");
    const tuesdayNine = rows[18].querySelectorAll("td")[3];
    expect(iconTitles(tuesdayNine)).toEqual(["Other (cant-do)"]);

    // The following Tuesday still shows the recurring selection.
    const wednesdayNine = rows[18].querySelectorAll("td")[4];
    expect(iconTitles(wednesdayNine)).toEqual([]);
  });

  it("keeps other participants' selections visible on a cell the viewer excepts", () => {
    const viewerId = "aaa-viewer" as Id<"userProfiles">;
    const otherId = "bbb-other" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Viewer exception",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [
            {
              _id: "other-base",
              scheduleId: "schedule",
              profileId: otherId,
              dayKey: "2",
              timeSlot: "09:00",
              timezone: "Australia/Melbourne",
              state: "can-do",
            },
            {
              _id: "viewer-exception",
              scheduleId: "schedule",
              profileId: viewerId,
              dayKey: "2",
              timeSlot: "09:00",
              timezone: "Australia/Melbourne",
              state: "maybe",
              isException: true,
              exceptionDate: "2026-07-28",
            },
          ],
          profiles: [
            {
              _id: viewerId,
              displayName: "Viewer",
              profileImageUrl: "https://example.com/viewer.png",
              timezone: "Australia/Melbourne",
            },
            {
              _id: otherId,
              displayName: "Other",
              profileImageUrl: "https://example.com/other.png",
              timezone: "Australia/Melbourne",
            },
          ],
        }}
        profileId={viewerId}
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
        onCellChange={vi.fn(() => Promise.resolve())}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    const tuesdayNine = container
      .querySelectorAll("tbody tr")[18]
      .querySelectorAll("td")[3];
    // Icons are grouped by state, can-do first.
    expect(iconTitles(tuesdayNine)).toEqual([
      "Other (can-do)",
      "Viewer (maybe)",
    ]);
    // The viewer's own state still resolves to their exception.
    expect(tuesdayNine.classList.contains(styles.stateMaybe)).toBe(true);
  });

  it("commits the full dragged range on mouse up", async () => {
    const onBatchChange = vi.fn(
      (_cells: { dayKey: string; timeSlot: string; state: string }[]) =>
        Promise.resolve()
    );
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Drag range",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
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
        onCellChange={vi.fn(() => Promise.resolve())}
        onBatchChange={onBatchChange}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );

    const start = container
      .querySelectorAll("tbody tr")[18]
      .querySelectorAll("td")[2];
    fireEvent.mouseDown(start, { button: 0, clientX: 210, clientY: 440 });
    // First move crosses the dead zone; the box only reaches its final size
    // on the second, so a stale commit would apply the start cell alone.
    fireEvent.mouseMove(document, { clientX: 230, clientY: 450 });
    fireEvent.mouseMove(document, { clientX: 450, clientY: 500 });
    fireEvent.mouseUp(document, { button: 0, clientX: 450, clientY: 500 });

    await waitFor(() => {
      expect(onBatchChange).toHaveBeenCalledTimes(1);
    });

    const cells = onBatchChange.mock.calls[0][0] as {
      dayKey: string;
      timeSlot: string;
      state: string;
    }[];
    expect(cells.every((cell) => cell.state === "can-do")).toBe(true);
    expect(cells.map((cell) => `${cell.dayKey}|${cell.timeSlot}`).sort()).toEqual(
      [
        "1|09:00",
        "1|09:30",
        "1|10:00",
        "2|09:00",
        "2|09:30",
        "2|10:00",
        "3|09:00",
        "3|09:30",
        "3|10:00",
      ]
    );
  });

  it("keeps profile icons ordered by profile ID when selection order changes", () => {
    const alphaId = "profile-alpha" as Id<"userProfiles">;
    const zuluId = "profile-zulu" as Id<"userProfiles">;
    const profiles = [
      {
        _id: zuluId,
        displayName: "Zulu",
        profileImageUrl: "https://example.com/zulu.png",
        timezone: "Australia/Melbourne",
      },
      {
        _id: alphaId,
        displayName: "Alpha",
        profileImageUrl: "https://example.com/alpha.png",
        timezone: "Australia/Melbourne",
      },
    ];
    const makeSelection = (profileId: Id<"userProfiles">) => ({
      _id: `selection-${profileId}`,
      scheduleId: "schedule",
      profileId,
      dayKey: "1",
      timeSlot: "09:00",
      timezone: "Australia/Melbourne",
      state: "can-do" as const,
    });
    const renderGrid = (selectionOrder: Id<"userProfiles">[]) => (
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Stable participant order",
          type: "recurring",
          creatorTimezone: "Australia/Melbourne",
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: selectionOrder.map(makeSelection),
          profiles,
        }}
        profileId={null}
        userTimezone="Australia/Melbourne"
        selectionTimezone="Australia/Melbourne"
        weekStartDay={0}
        selectMode="auto"
        allowMode="auto"
        weekOffset={0}
        canInteract={false}
        isCreator={false}
        canLock={false}
        creatorMode={null}
        onCellChange={vi.fn(() => Promise.resolve())}
        onBatchChange={vi.fn(() => Promise.resolve())}
        onCreatorSlotChange={vi.fn(() => Promise.resolve())}
      />
    );
    const getIconNames = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("img")).map((img) => img.alt);

    const { container, rerender } = render(renderGrid([zuluId, alphaId]));
    expect(getIconNames(container)).toEqual(["Alpha", "Zulu"]);

    rerender(renderGrid([alphaId, zuluId]));
    expect(getIconNames(container)).toEqual(["Alpha", "Zulu"]);
  });
});
