// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const iconLabels = (cell: Element) =>
  Array.from(cell.querySelectorAll("img")).map((img) => img.getAttribute("aria-label"));

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
    cleanup();
    Settings.now = () => Date.now();
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it.each([
    { disallowCantDo: undefined, nextState: "cant-do" },
    { disallowCantDo: true, nextState: "maybe" },
  ])("submits clicked cells in the edited participant's timezone with next state $nextState", async ({
    disallowCantDo,
    nextState,
  }) => {
    const onCellChange = vi.fn(() => Promise.resolve());
    const participantId = "participant" as Id<"userProfiles">;
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Timezone test",
          type: "recurring",
          disallowCantDo,
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
        nextState,
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
    expect(iconLabels(tuesdayNine)).toEqual(["Other (Can't Do)"]);

    // The following Tuesday still shows the recurring selection.
    const wednesdayNine = rows[18].querySelectorAll("td")[4];
    expect(iconLabels(wednesdayNine)).toEqual([]);
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
    expect(iconLabels(tuesdayNine)).toEqual([
      "Other (Can Do)",
      "Viewer (Maybe)",
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

  it.each(["recurring", "one-off"] as const)("counts blank slots for schedule participants in the %s status popover", (scheduleType) => {
    const nominations = [
      { profileId: "a", displayName: "Ari", state: "maybe" },
      { profileId: "b", displayName: "Zoe", state: "can-do" },
      { profileId: "c", displayName: "Bea", state: "cant-do" },
      { profileId: "d", displayName: "Cam", state: "can-do" },
    ] as const;
    const timezone = "Australia/Melbourne";
    const { container } = render(
      <WeeklyGrid
        schedule={{
          _id: "schedule" as Id<"schedules">,
          title: "Hover order",
          type: scheduleType,
          creatorTimezone: timezone,
          creatorProfileId: "creator" as Id<"userProfiles">,
          selections: [...nominations.map(({ profileId, state }) => ({
            _id: `selection-${profileId}`,
            scheduleId: "schedule",
            profileId,
            state,
            isException: scheduleType === "recurring" && profileId === "a",
            exceptionDate: scheduleType === "recurring" && profileId === "a" ? "2026-07-27" : undefined,
            dayKey: scheduleType === "recurring" ? "1" : "2026-07-27",
            timeSlot: "09:00",
            timezone,
          })), ...(scheduleType === "recurring" ? [{
            _id: "ari-base",
            scheduleId: "schedule",
            profileId: "a",
            state: "can-do" as const,
            dayKey: "1",
            timeSlot: "09:00",
            timezone,
          }] : []), {
            _id: "selection-blank",
            scheduleId: "schedule",
            profileId: "blank",
            state: "can-do",
            dayKey: scheduleType === "recurring" ? "1" : "2026-08-03",
            timeSlot: "10:00",
            timezone,
            isException: scheduleType === "recurring",
            exceptionDate: scheduleType === "recurring" ? "2026-08-03" : undefined,
          }],
          profiles: [...nominations.map(({ profileId, displayName }) => ({
            _id: profileId,
            displayName,
            timezone,
          })),
            { _id: "blank", displayName: "Dee", timezone },
            { _id: "creator", displayName: "Creator without selections", timezone },
          ],
        }}
        profileId={null}
        userTimezone={timezone}
        selectionTimezone={timezone}
        weekStartDay={0}
        nominationHoverDistancePx={75}
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
    const viewportWidth = vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(800);
    try {
      fireEvent.pointerMove(screen.getByRole("img", { name: "Zoe (Can Do)" }), {
        clientX: 250, clientY: 440,
      });
      const popover = screen.getByRole("region", { name: "Cell availability" });
      const names = (label: string) => within(popover).getAllByRole("list", { name: label })
        .flatMap((list) => within(list).queryAllByRole("listitem").map((row) => row.lastElementChild?.textContent));
      expect(names("Can Do")).toEqual(["Cam", "Zoe"]);
      expect(names("Can't Do")).toEqual(["Bea", "Dee"]);
      expect(names("Maybe")).toEqual(["Ari"]);
      expect(within(popover).queryByText("Creator without selections")).toBeNull();
      const counts = Array.from(popover.querySelectorAll(`.${styles.nominationCount} strong`));
      expect(counts.map((count) => count.textContent)).toEqual(["2", "1", "2"]);
      expect(popover.style.bottom).toBe(`${window.innerHeight - 440 + 75}px`);
      fireEvent.pointerMove(screen.getByRole("img", { name: "Zoe (Can Do)" }), {
        clientX: 260, clientY: 450,
      });
      expect(popover.style.bottom).toBe(`${window.innerHeight - 450 + 75}px`);

      // Empty cells still show every participant as unavailable, without adding
      // synthetic selections or profile icons to the grid.
      fireEvent.pointerOut(screen.getByRole("img", { name: "Zoe (Can Do)" }).closest("td")!, { relatedTarget: document.body });
      const blankCell = container.querySelectorAll("tbody tr")[19].querySelectorAll("td")[2];
      fireEvent.pointerMove(blankCell, { clientX: 250, clientY: 465 });
      const blankPopover = screen.getByRole("region", { name: "Cell availability" });
      expect(within(blankPopover).getAllByRole("listitem").map((row) => row.lastElementChild?.textContent))
        .toEqual(["Ari", "Bea", "Cam", "Dee", "Zoe"]);
      expect(blankCell.querySelectorAll("img")).toHaveLength(0);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("region", { name: "Cell availability" })).toBeNull();

      fireEvent.pointerMove(blankCell, { clientX: 251, clientY: 465 });
      expect(screen.getByRole("region", { name: "Cell availability" })).toBeTruthy();
      fireEvent.pointerOut(blankCell, { relatedTarget: document.body });
      expect(screen.queryByRole("region", { name: "Cell availability" })).toBeNull();
    } finally {
      viewportWidth.mockRestore();
    }
  });
});
