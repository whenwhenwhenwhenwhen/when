import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import type { PointerEvent } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { CalendarDays } from "lucide-react";
import { Id } from "../../convex/_generated/dataModel";
import { DEFAULT_NOMINATION_HOVER_DISTANCE_PX } from "../../shared/nominationHover";
import {
  generateTimeSlots,
  formatTimeSlot,
  getDayNames,
  getWeekDates,
  convertCellToTimezone,
  getCellKey as getTimezoneCellKey,
  TimezoneCell,
} from "../lib/timezone";
import { getDstNotice } from "../lib/dst";
import { useToast } from "../hooks/useToast";
import { cx } from "../lib/classes";
import { ParticipantIcon } from "./ParticipantIcon";
import { AvailabilitySelectionToolbar, availabilityActions, type AvailabilityState } from "./AvailabilitySelectionToolbar";
import { NominationDetails, nominationLabels, nominationOrder, type NominationState } from "./NominationDetails";
import styles from "../styles/app.module.css";

type CellState = AvailabilityState;
export type SelectMode = "auto" | "select" | CellState;
type AllowMode = "auto" | "allow" | "dont-allow";
type CreatorMode = "limit" | "nominate" | "lock" | null;

interface Selection {
  _id: string;
  scheduleId: string;
  profileId: string;
  dayKey: string;
  timeSlot: string;
  timezone: string;
  state: "can-do" | "cant-do" | "maybe";
  isException?: boolean;
  exceptionDate?: string;
  source?: "manual" | "calendar";
  externalEventId?: string;
}

interface Profile {
  _id: string;
  displayName: string;
  profileImageUrl?: string;
  timezone: string;
}

interface Schedule {
  _id: Id<"schedules">;
  title: string;
  type: "one-off" | "recurring";
  dateRangeStart?: string;
  dateRangeEnd?: string;
  creatorTimezone: string;
  creatorProfileId: Id<"userProfiles">;
  selections: Selection[];
  profiles: Profile[];
  blockedProfileIds?: string[];
  disallowCantDo?: boolean;
  disallowedSlots?: { dayKey: string; timeSlot: string }[];
  lockedSlots?: { dayKey: string; timeSlot: string }[];
  isLocked?: boolean;
  anyoneCanLock?: boolean;
  lockEditors?: Id<"userProfiles">[];
}

interface Props {
  schedule: Schedule;
  profileId: Id<"userProfiles"> | null;
  userTimezone: string;
  selectionTimezone: string;
  weekStartDay: number;
  nominationHoverEnabled?: boolean;
  nominationHoverDistancePx?: number;
  selectMode: SelectMode;
  allowMode: AllowMode;
  weekOffset: number;
  canInteract: boolean;
  isCreator: boolean;
  canLock: boolean;
  creatorMode: CreatorMode;
  onCellChange: (
    dayKey: string,
    timeSlot: string,
    state: CellState,
    isException?: boolean,
    exceptionDate?: string,
    storageTimezone?: string,
    scheduleDayKey?: string,
    scheduleTimeSlot?: string
  ) => Promise<void>;
  onBatchChange: (
    cells: {
      dayKey: string;
      timeSlot: string;
      state: CellState;
      isException?: boolean;
      exceptionDate?: string;
      timezone?: string;
      scheduleDayKey?: string;
      scheduleTimeSlot?: string;
    }[]
  ) => Promise<void>;
  onCreatorSlotChange: (
    slots: { dayKey: string; timeSlot: string }[]
  ) => Promise<void>;
}

const DEAD_ZONE_PX = 8;
const TIME_SLOTS = generateTimeSlots();
const CELL_ERROR = "Couldn't save your availability. Please try again.";
const SLOT_ERROR = "Couldn't update the schedule. Please try again.";

interface CellParticipant {
  profileId: string;
  state: NominationState;
}

interface NominationHover {
  anchor: HTMLTableCellElement;
  dayIndex: number;
  timeIndex: number;
  profileId?: string;
}

interface GridCell {
  dayIndex: number;
  timeIndex: number;
}

interface CellRange {
  start: GridCell;
  end: GridCell;
}

type GridAction =
  | { kind: "availability"; state: CellState }
  | { kind: "slots"; field: "disallowedSlots" | "lockedSlots"; add: boolean }
  | { kind: "select" };

interface DragGesture {
  x: number;
  y: number;
  range: CellRange;
  action: GridAction;
  moved: boolean;
}

function getRangeCells({ start, end }: CellRange): GridCell[] {
  const cells: GridCell[] = [];
  const firstDay = Math.min(start.dayIndex, end.dayIndex);
  const lastDay = Math.max(start.dayIndex, end.dayIndex);
  const firstTime = Math.min(start.timeIndex, end.timeIndex);
  const lastTime = Math.max(start.timeIndex, end.timeIndex);
  for (let timeIndex = firstTime; timeIndex <= lastTime; timeIndex++) {
    for (let dayIndex = firstDay; dayIndex <= lastDay; dayIndex++) {
      cells.push({ dayIndex, timeIndex });
    }
  }
  return cells;
}

function getSelectionViewerCell(
  scheduleType: Schedule["type"],
  selection: Selection,
  userTimezone: string,
  referenceDate: DateTime,
  weekStartDay: number
): { key: string; cell: TimezoneCell } {
  const cell = convertCellToTimezone(
    scheduleType,
    selection,
    selection.timezone,
    userTimezone,
    referenceDate,
    weekStartDay
  );
  return {
    key: getTimezoneCellKey(scheduleType, cell),
    cell,
  };
}

export function WeeklyGrid({
  schedule,
  profileId,
  userTimezone,
  selectionTimezone,
  weekStartDay,
  nominationHoverEnabled = true,
  nominationHoverDistancePx = DEFAULT_NOMINATION_HOVER_DISTANCE_PX,
  selectMode,
  allowMode,
  weekOffset,
  canInteract,
  isCreator,
  canLock,
  creatorMode,
  onCellChange,
  onBatchChange,
  onCreatorSlotChange,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const cursorRef = useRef({ x: 0, y: 0 });
  const [nominationHover, setNominationHover] = useState<NominationHover | null>(null);
  const nominationAnchor = nominationHover?.anchor;
  const { showToast } = useToast();

  useEffect(() => {
    setNominationHover(null);
  }, [schedule._id, userTimezone, weekStartDay, weekOffset]);

  useEffect(() => {
    if (!nominationHoverEnabled) {
      setNominationHover(null);
      return;
    }
    if (!nominationAnchor) return;

    const close = () => setNominationHover(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [nominationAnchor, nominationHoverEnabled]);

  // One cell range serves clicks, drags, and the retained Select-mode region.
  // The live gesture ref also keeps document listeners current between renders.
  const [isDragging, setIsDragging] = useState(false);
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  const gestureRef = useRef<DragGesture | null>(null);
  const lastShortcutRef = useRef<CellState | null>(null);
  const isLimitMode = isCreator && creatorMode === "limit";
  const isLockMode = canLock && creatorMode === "lock";
  const isSelectMode = selectMode === "select" && !isLimitMode && !isLockMode;

  const clearSelection = useCallback(() => {
    gestureRef.current = null;
    lastShortcutRef.current = null;
    setIsDragging(false);
    setSelectedRange(null);
  }, []);

  useEffect(clearSelection, [
    clearSelection, schedule._id, profileId, userTimezone, selectionTimezone,
    weekStartDay, weekOffset, selectMode, allowMode, creatorMode, canInteract, isCreator, canLock,
  ]);

  // The grid renders straight from the server's selections, so a rejected
  // change reverts on its own and only needs reporting.
  const commitChange = useCallback(
    (change: Promise<void>, message: string) => {
      void change.catch((err) => {
        console.error(message, err);
        showToast(message, "error");
      });
    },
    [showToast]
  );

  // Current time for the indicator
  const [now, setNow] = useState(DateTime.now().setZone(userTimezone));

  useEffect(() => {
    setNow(DateTime.now().setZone(userTimezone));
    const interval = setInterval(() => {
      setNow(DateTime.now().setZone(userTimezone));
    }, 30000);
    return () => clearInterval(interval);
  }, [userTimezone]);

  // Calculate week dates. The reference date keeps a stable identity for as
  // long as it addresses the same day: every map below converts timezones per
  // selection and must stay off the drag render path.
  const referenceDate = useMemo(
    () => DateTime.now().setZone(userTimezone).plus({ weeks: weekOffset }),
    [userTimezone, weekOffset, now.toISODate()]
  );
  const weekDates = useMemo(
    () => getWeekDates(referenceDate, weekStartDay),
    [referenceDate, weekStartDay]
  );
  const dayNames = getDayNames(weekStartDay);

  // DST notice
  const dstNotice = getDstNotice(userTimezone, weekDates);

  // Build display-state and exact storage-address maps for the edited profile.
  // Keeping the original address matters after a user changes timezone:
  // existing records must continue to be edited in the timezone they were
  // created in rather than being reinterpreted in the new profile timezone.
  const { myCellStates, myCellSelections } = useMemo(() => {
    const states = new Map<string, CellState>();
    const selections = new Map<string, Selection>();
    if (!profileId) {
      return { myCellStates: states, myCellSelections: selections };
    }

    for (const sel of schedule.selections) {
      if (sel.profileId !== profileId) continue;
      const { key } = getSelectionViewerCell(
        schedule.type,
        sel,
        userTimezone,
        referenceDate,
        weekStartDay
      );
      states.set(key, sel.state);
      selections.set(key, sel);
    }
    return { myCellStates: states, myCellSelections: selections };
  }, [
    schedule.selections,
    profileId,
    userTimezone,
    schedule.type,
    referenceDate,
    weekStartDay,
  ]);

  // Build a set of cell keys that are calendar-synced for the current user
  const calendarSyncedCells = useMemo(() => {
    const set = new Set<string>();
    if (!profileId || schedule.disallowCantDo) return set;
    for (const sel of schedule.selections) {
      if (sel.profileId !== profileId) continue;
      if (sel.source !== "calendar") continue;
      const { key } = getSelectionViewerCell(
        schedule.type,
        sel,
        userTimezone,
        referenceDate,
        weekStartDay
      );
      set.add(key);
    }
    return set;
  }, [
    schedule.selections,
    schedule.disallowCantDo,
    profileId,
    userTimezone,
    schedule.type,
    referenceDate,
    weekStartDay,
  ]);

  // Build maps of every participant's selections for each cell (for profile
  // icons). Base and exception rows are kept apart because an exception only
  // overrides the participant who owns it — merging them into one map would
  // apply one participant's exception to everybody in the cell.
  const { baseCellSelections, exceptionCellSelections } = useMemo(() => {
    const base = new Map<string, CellParticipant[]>();
    const exceptions = new Map<string, CellParticipant[]>();

    for (const sel of schedule.selections) {
      const { key: cellKey, cell } = getSelectionViewerCell(
        schedule.type,
        sel,
        userTimezone,
        referenceDate,
        weekStartDay
      );
      const map = cell.isException ? exceptions : base;

      const existing = map.get(cellKey) || [];
      existing.push({ profileId: sel.profileId, state: sel.state });
      map.set(cellKey, existing);
    }

    for (const map of [base, exceptions]) {
      for (const selections of map.values()) {
        selections.sort((a, b) => a.profileId.localeCompare(b.profileId));
      }
    }

    return { baseCellSelections: base, exceptionCellSelections: exceptions };
  }, [
    schedule.selections,
    userTimezone,
    schedule.type,
    referenceDate,
    weekStartDay,
  ]);

  // Schedule-level limits and locks are anchored to the timezone in which the
  // schedule was created, then projected into the viewer's current timezone.
  const disallowedSet = useMemo(() => {
    const set = new Set<string>();
    if (!schedule.disallowedSlots) return set;
    for (const slot of schedule.disallowedSlots) {
      const converted = convertCellToTimezone(
        schedule.type,
        slot,
        schedule.creatorTimezone,
        userTimezone,
        referenceDate,
        weekStartDay
      );
      set.add(getTimezoneCellKey(schedule.type, converted));
    }
    return set;
  }, [
    schedule.disallowedSlots,
    schedule.type,
    schedule.creatorTimezone,
    userTimezone,
    referenceDate,
    weekStartDay,
  ]);

  const lockedSet = useMemo(() => {
    const set = new Set<string>();
    if (!schedule.lockedSlots) return set;
    for (const slot of schedule.lockedSlots) {
      const converted = convertCellToTimezone(
        schedule.type,
        slot,
        schedule.creatorTimezone,
        userTimezone,
        referenceDate,
        weekStartDay
      );
      set.add(getTimezoneCellKey(schedule.type, converted));
    }
    return set;
  }, [
    schedule.lockedSlots,
    schedule.type,
    schedule.creatorTimezone,
    userTimezone,
    referenceDate,
    weekStartDay,
  ]);

  // Key of the recurring weekday (or one-off date) row behind a grid cell
  const getBaseCellKey = useCallback(
    (dayIndex: number, timeIndex: number): string => {
      if (schedule.type === "one-off") {
        return `${weekDates[dayIndex].toISODate()}|${TIME_SLOTS[timeIndex]}`;
      }
      const dow = (weekStartDay + dayIndex) % 7;
      return `${dow}|${TIME_SLOTS[timeIndex]}`;
    },
    [schedule.type, weekDates, weekStartDay]
  );

  // Key of the exception row that would override the base row on this date
  const getExceptionCellKey = useCallback(
    (dayIndex: number, timeIndex: number): string =>
      `exc:${weekDates[dayIndex].toISODate()}|${TIME_SLOTS[timeIndex]}`,
    [weekDates]
  );

  // Get the cell key the edited profile's own selection lives at
  const getCellKey = useCallback(
    (dayIndex: number, timeIndex: number): string => {
      if (schedule.type === "recurring") {
        const excKey = getExceptionCellKey(dayIndex, timeIndex);
        if (myCellStates.has(excKey)) {
          return excKey;
        }
      }
      return getBaseCellKey(dayIndex, timeIndex);
    },
    [schedule.type, getBaseCellKey, getExceptionCellKey, myCellStates]
  );

  // Resolve every participant's effective state for a cell: their exception on
  // this date if they have one, otherwise their recurring selection.
  const getCellParticipants = useCallback(
    (dayIndex: number, timeIndex: number): CellParticipant[] => {
      const base =
        baseCellSelections.get(getBaseCellKey(dayIndex, timeIndex)) || [];
      if (schedule.type === "one-off") return base;

      const exceptions =
        exceptionCellSelections.get(
          getExceptionCellKey(dayIndex, timeIndex)
        ) || [];
      if (exceptions.length === 0) return base;

      const overridden = new Set(exceptions.map((s) => s.profileId));
      return [...base.filter((s) => !overridden.has(s.profileId)), ...exceptions]
        .sort((a, b) => a.profileId.localeCompare(b.profileId));
    },
    [
      schedule.type,
      baseCellSelections,
      exceptionCellSelections,
      getBaseCellKey,
      getExceptionCellKey,
    ]
  );

  // Get cell state for a given day/time index
  const getCellState = useCallback(
    (dayIndex: number, timeIndex: number): CellState => {
      const key = getCellKey(dayIndex, timeIndex);
      return myCellStates.get(key) || "blank";
    },
    [getCellKey, myCellStates]
  );

  const getNextAutoState = useCallback(
    (current: CellState, hasCalendarBaseline: boolean): CellState => {
      switch (current) {
        case "blank":
          return "can-do";
        case "can-do":
          return hasCalendarBaseline || schedule.disallowCantDo
            ? "maybe"
            : "cant-do";
        case "cant-do":
          return hasCalendarBaseline ? "can-do" : "maybe";
        case "maybe":
          return "blank";
      }
    },
    [schedule.disallowCantDo]
  );

  // Convert a cell from the viewer's grid timezone to the timezone of the
  // profile whose availability is being edited.
  const toStorageKeys = useCallback(
    (
      dayIndex: number,
      timeIndex: number
    ): {
      dayKey: string;
      timeSlot: string;
      isException?: boolean;
      exceptionDate?: string;
      timezone: string;
    } => {
      const displayedTime = TIME_SLOTS[timeIndex];
      const displayedDate = weekDates[dayIndex];
      const viewerKey = getCellKey(dayIndex, timeIndex);
      const displayedException =
        schedule.type === "recurring" &&
        (weekOffset !== 0 || viewerKey.startsWith("exc:"));
      const existingSelection =
        schedule.type === "one-off" ||
        weekOffset === 0 ||
        viewerKey.startsWith("exc:")
          ? myCellSelections.get(viewerKey)
          : undefined;

      if (existingSelection) {
        return {
          dayKey: existingSelection.dayKey,
          timeSlot: existingSelection.timeSlot,
          isException: existingSelection.isException,
          exceptionDate: existingSelection.exceptionDate,
          timezone: existingSelection.timezone,
        };
      }

      const displayedCell: TimezoneCell =
        schedule.type === "one-off"
          ? {
              dayKey: displayedDate.toISODate()!,
              timeSlot: displayedTime,
            }
          : {
              dayKey: String((weekStartDay + dayIndex) % 7),
              timeSlot: displayedTime,
              ...(displayedException
                ? {
                    isException: true,
                    exceptionDate: displayedDate.toISODate()!,
                  }
                : {}),
            };
      return {
        ...convertCellToTimezone(
          schedule.type,
          displayedCell,
          userTimezone,
          selectionTimezone,
          referenceDate,
          weekStartDay
        ),
        timezone: selectionTimezone,
      };
    },
    [
      schedule.type,
      weekDates,
      weekStartDay,
      weekOffset,
      getCellKey,
      myCellSelections,
      userTimezone,
      selectionTimezone,
      referenceDate,
    ]
  );

  const getDisplayedScheduleCell = useCallback(
    (dayIndex: number, timeIndex: number): TimezoneCell => ({
      dayKey:
        schedule.type === "one-off"
          ? weekDates[dayIndex].toISODate()!
          : String((weekStartDay + dayIndex) % 7),
      timeSlot: TIME_SLOTS[timeIndex],
    }),
    [schedule.type, weekDates, weekStartDay]
  );

  // Convert a displayed grid cell back to the schedule's immutable timezone
  // anchor for limit and lock storage.
  const toScheduleKeys = useCallback(
    (dayIndex: number, timeIndex: number): TimezoneCell =>
      convertCellToTimezone(
        schedule.type,
        getDisplayedScheduleCell(dayIndex, timeIndex),
        userTimezone,
        schedule.creatorTimezone,
        referenceDate,
        weekStartDay
      ),
    [
      schedule.type,
      schedule.creatorTimezone,
      getDisplayedScheduleCell,
      userTimezone,
      referenceDate,
      weekStartDay,
    ]
  );

  // Check if a cell is disallowed
  const isCellDisallowed = useCallback(
    (dayIndex: number, timeIndex: number): boolean => {
      const key = getTimezoneCellKey(
        schedule.type,
        getDisplayedScheduleCell(dayIndex, timeIndex)
      );
      return disallowedSet.has(key);
    },
    [schedule.type, getDisplayedScheduleCell, disallowedSet]
  );

  // Check if a cell is locked
  const isCellLocked = useCallback(
    (dayIndex: number, timeIndex: number): boolean => {
      const key = getTimezoneCellKey(
        schedule.type,
        getDisplayedScheduleCell(dayIndex, timeIndex)
      );
      return lockedSet.has(key);
    },
    [schedule.type, getDisplayedScheduleCell, lockedSet]
  );

  const isCellInDateRange = useCallback(
    (dayIndex: number, timeIndex: number): boolean => {
      if (
        schedule.type !== "one-off" ||
        !schedule.dateRangeStart ||
        !schedule.dateRangeEnd
      ) {
        return true;
      }
      const { dayKey } = toScheduleKeys(dayIndex, timeIndex);
      return (
        dayKey >= schedule.dateRangeStart && dayKey <= schedule.dateRangeEnd
      );
    },
    [
      schedule.type,
      schedule.dateRangeStart,
      schedule.dateRangeEnd,
      toScheduleKeys,
    ]
  );

  // Limits, locks, and availability all use the same range and commit path.
  const getEditableCells = useCallback(
    (range: CellRange): GridCell[] => getRangeCells(range).filter(({ dayIndex, timeIndex }) =>
      isCellInDateRange(dayIndex, timeIndex) &&
      (isLimitMode || (isCreator && creatorMode === "nominate") || !isCellDisallowed(dayIndex, timeIndex))
    ),
    [isCellInDateRange, isLimitMode, isCreator, creatorMode, isCellDisallowed]
  );

  const applyCells = useCallback(
    (cells: GridCell[], action: GridAction) => {
      if (!canInteract || cells.length === 0 || action.kind === "select") return;

      if (action.kind === "slots") {
        const currentSlots = schedule[action.field] ?? [];
        const slots = new Map(currentSlots.map((slot) => [`${slot.dayKey}|${slot.timeSlot}`, slot]));
        for (const cell of cells) {
          const slot = toScheduleKeys(cell.dayIndex, cell.timeIndex);
          const key = `${slot.dayKey}|${slot.timeSlot}`;
          if (action.add) slots.set(key, slot);
          else slots.delete(key);
        }
        if (slots.size !== currentSlots.length) {
          commitChange(onCreatorSlotChange([...slots.values()]), SLOT_ERROR);
        }
        return;
      }

      if (action.state === "cant-do" && schedule.disallowCantDo) return;
      const changes = cells.map(({ dayIndex, timeIndex }) => {
        const storage = toStorageKeys(dayIndex, timeIndex);
        const scheduleCell = toScheduleKeys(dayIndex, timeIndex);
        return {
          ...storage,
          state: action.state,
          scheduleDayKey: scheduleCell.dayKey,
          scheduleTimeSlot: scheduleCell.timeSlot,
        };
      });
      if (changes.length === 1) {
        const cell = changes[0];
        commitChange(
          onCellChange(
            cell.dayKey, cell.timeSlot, cell.state, cell.isException, cell.exceptionDate,
            cell.timezone, cell.scheduleDayKey, cell.scheduleTimeSlot
          ),
          CELL_ERROR
        );
      } else {
        commitChange(onBatchChange(changes), CELL_ERROR);
      }
    },
    [canInteract, schedule.disallowedSlots, schedule.lockedSlots, schedule.disallowCantDo,
      toScheduleKeys, toStorageKeys, commitChange, onCreatorSlotChange, onCellChange, onBatchChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, dayIndex: number, timeIndex: number) => {
      if (e.button !== 0 || !canInteract) return;
      e.preventDefault();
      gridRef.current?.focus({ preventScroll: true });
      setNominationHover(null);
      lastShortcutRef.current = null;

      let action: GridAction;
      if (isLimitMode) {
        action = {
          kind: "slots",
          field: "disallowedSlots",
          add: allowMode === "auto"
            ? !isCellDisallowed(dayIndex, timeIndex)
            : allowMode === "dont-allow",
        };
      } else if (isLockMode) {
        action = { kind: "slots", field: "lockedSlots", add: !isCellLocked(dayIndex, timeIndex) };
      } else if (selectMode === "select") {
        action = { kind: "select" };
      } else {
        action = {
          kind: "availability",
          state: selectMode === "auto"
            ? getNextAutoState(
                getCellState(dayIndex, timeIndex),
                calendarSyncedCells.has(getCellKey(dayIndex, timeIndex))
              )
            : selectMode,
        };
      }
      const cell = { dayIndex, timeIndex };
      const range = { start: cell, end: cell };
      gestureRef.current = { x: e.clientX, y: e.clientY, range, action, moved: false };
      setSelectedRange(range);
      setIsDragging(true);
    },
    [canInteract, isLimitMode, isLockMode, allowMode, selectMode, isCellDisallowed,
      isCellLocked, getNextAutoState, getCellState, calendarSyncedCells, getCellKey]
  );

  // Snap to whole cells, including the starting cell and horizontal/vertical
  // drags. The nearest cell also clamps a drag that leaves the grid's edges.
  const updateGesture = useCallback((x: number, y: number) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) <= DEAD_ZONE_PX) return;
    gesture.moved = true;

    let nearest = gesture.range.end;
    let nearestDistance = Infinity;
    for (const [key, element] of cellRefs.current) {
      const rect = element.getBoundingClientRect();
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        const [dayIndex, timeIndex] = key.split(",").map(Number);
        nearest = { dayIndex, timeIndex };
        nearestDistance = distance;
        if (distance === 0) break;
      }
    }
    if (nearest.dayIndex !== gesture.range.end.dayIndex || nearest.timeIndex !== gesture.range.end.timeIndex) {
      gesture.range = { start: gesture.range.start, end: nearest };
      setSelectedRange(gesture.range);
    }
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (event: MouseEvent) => updateGesture(event.clientX, event.clientY);
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button === 2) {
        clearSelection();
        return;
      }
      if (event.button !== 0) return;
      updateGesture(event.clientX, event.clientY);
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.action.kind !== "select") {
        applyCells(getEditableCells(gesture.range), gesture.action);
        setSelectedRange(null);
      }
      gestureRef.current = null;
      setIsDragging(false);
    };
    const handleContextMenu = (event: Event) => {
      event.preventDefault();
      clearSelection();
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("blur", clearSelection);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("blur", clearSelection);
    };
  }, [isDragging, updateGesture, applyCells, getEditableCells, clearSelection]);

  const selectedCells = useMemo(() => selectedRange ? getEditableCells(selectedRange) : [],
    [selectedRange, getEditableCells]);
  const selectedCellKeys = useMemo(() => new Set(selectedCells.map(({ dayIndex, timeIndex }) => `${dayIndex},${timeIndex}`)),
    [selectedCells]);
  // Include the lock-mode preview so its outline joins existing locked slots.
  // Only vertical neighbors belong to the same group, within the visible day.
  const isCellLockOutlined = (dayIndex: number, timeIndex: number): boolean =>
    timeIndex >= 0 && timeIndex < TIME_SLOTS.length && (
      isCellLocked(dayIndex, timeIndex) ||
      (isLockMode && selectedCellKeys.has(`${dayIndex},${timeIndex}`))
    );
  const applySelectedState = useCallback((state: CellState) => {
    lastShortcutRef.current = null;
    applyCells(selectedCells, { kind: "availability", state });
  }, [applyCells, selectedCells]);

  useEffect(() => {
    if (!selectedRange) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (!isSelectMode || isDragging || !canInteract || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const state = availabilityActions.find(({ key }) => key.toLowerCase() === event.key.toLowerCase())?.state;
      if (!state || (state === "cant-do" && schedule.disallowCantDo)) return;
      event.preventDefault();
      if (lastShortcutRef.current === state) {
        clearSelection();
      } else {
        applyCells(selectedCells, { kind: "availability", state });
        lastShortcutRef.current = state;
      }
    };
    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Element && !gridRef.current?.contains(event.target) &&
        !event.target.closest("[data-availability-selection-toolbar]")) clearSelection();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleOutsideMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleOutsideMouseDown);
    };
  }, [selectedRange, selectedCells, isSelectMode, isDragging, canInteract, schedule.disallowCantDo, clearSelection, applyCells]);

  // Profile map for quick lookup
  const profileMap = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const p of schedule.profiles) {
      map.set(p._id, p);
    }
    return map;
  }, [schedule.profiles]);

  const participantProfiles = useMemo(() => {
    const participantIds = new Set(schedule.selections.map((selection) => selection.profileId));
    const blockedIds = new Set(schedule.blockedProfileIds);
    return schedule.profiles.filter((profile) => participantIds.has(profile._id) && !blockedIds.has(profile._id));
  }, [schedule.selections, schedule.profiles, schedule.blockedProfileIds]);

  const hoveredNominations = useMemo(() => {
    if (!nominationHoverEnabled || !nominationHover) return [];
    const states = new Map(getCellParticipants(nominationHover.dayIndex, nominationHover.timeIndex)
      .map(({ profileId, state }) => [profileId, state]));
    return participantProfiles.map((profile) => ({
      profile,
      state: states.get(profile._id) ?? "cant-do" as const,
    })).sort((a, b) =>
      nominationOrder.indexOf(a.state) - nominationOrder.indexOf(b.state) ||
      a.profile.displayName.localeCompare(b.profile.displayName)
    );
  }, [nominationHoverEnabled, nominationHover, getCellParticipants, participantProfiles]);
  const inspectedSlotLocked = !!nominationHover && isCellLocked(nominationHover.dayIndex, nominationHover.timeIndex);
  const inspectedSlot = nominationHover && (hoveredNominations.length > 0 || inspectedSlotLocked)
    ? `${weekDates[nominationHover.dayIndex].toFormat("ccc, MMM d")} · ${formatTimeSlot(TIME_SLOTS[nominationHover.timeIndex])}`
    : undefined;

  // A pointer can enter the cell under the popup when Escape dismisses it.
  // Wait for actual pointer movement before opening another popup.
  function handleNominationMove(
    event: PointerEvent<HTMLTableCellElement>,
    dayIndex: number,
    timeIndex: number
  ) {
    if (isDragging || (isSelectMode && selectedRange) || event.buttons !== 0 || event.pointerType === "touch") return;

    cursorRef.current = { x: event.clientX, y: event.clientY };

    const anchor = event.currentTarget;
    const profileId = (event.target as HTMLElement).dataset.nominationProfile;
    setNominationHover((current) => {
      if (current?.anchor !== anchor) return { anchor, dayIndex, timeIndex, profileId };
      return current.profileId === profileId ? current : { ...current, profileId };
    });
  }

  // Current day and time for indicators
  const currentDayIndex = useMemo(() => {
    const todayStr = now.toISODate();
    return weekDates.findIndex((d) => d.toISODate() === todayStr);
  }, [now, weekDates]);

  const currentTimePosition = useMemo(() => {
    const totalMinutes = now.hour * 60 + now.minute;
    const slotIndex = totalMinutes / 30;
    return slotIndex;
  }, [now]);

  // Date labels for columns
  const columnDates = weekDates.map((d) => d.toFormat("MMM d"));

  return (
    <div className={styles.gridRoot}>
      {/* DST Notice */}
      {dstNotice && (
        <div className={styles.gridNotice}>
          {dstNotice}
        </div>
      )}

      {/* Grid Container */}
      <div
        ref={gridRef}
        tabIndex={-1}
        className={styles.gridContainer}
        onScroll={() => setNominationHover(null)}
      >
        <table
          className={cx(
            styles.scheduleTable,
            !canInteract && styles.noInteract,
          )}
        >
          <thead className={styles.tableHead}>
            <tr>
              <th className={styles.timeHeader}>
                Time
              </th>
              {dayNames.map((day, i) => {
                const inRange = TIME_SLOTS.some((_, timeIndex) =>
                  isCellInDateRange(i, timeIndex)
                );
                const isToday = i === currentDayIndex;

                return (
                  <th
                    key={i}
                    className={cx(
                      styles.dayHeader,
                      isToday && styles.currentDayHeader,
                      !inRange && styles.dayHeaderMuted,
                    )}
                  >
                    <div className={styles.dayHeadingLabel}>
                      <div>{day}</div>
                      <div className={styles.dayDate}>
                        {columnDates[i]}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {TIME_SLOTS.map((slot, timeIndex) => (
              <tr key={slot}>
                <td className={styles.timeCell}>
                  {timeIndex % 2 === 0 ? formatTimeSlot(slot) : ""}
                </td>
                {dayNames.map((_, dayIndex) => {
                  const inRange = isCellInDateRange(dayIndex, timeIndex);
                  const myState = getCellState(dayIndex, timeIndex);
                  const cellKey = getCellKey(dayIndex, timeIndex);
                  const cellParticipants = getCellParticipants(
                    dayIndex,
                    timeIndex
                  );
                  const hasNominations = cellParticipants.length > 0;
                  const canShowNominations = nominationHoverEnabled && inRange &&
                    (participantProfiles.length > 0 || isCellLocked(dayIndex, timeIndex));
                  const isNominationAnchor =
                    nominationHover?.dayIndex === dayIndex &&
                    nominationHover.timeIndex === timeIndex;
                  const cellDisallowed = isCellDisallowed(dayIndex, timeIndex);
                  const cellLockOutlined = isCellLockOutlined(dayIndex, timeIndex);
                  const cellCalendarSynced = calendarSyncedCells.has(cellKey);
                  const isToday = dayIndex === currentDayIndex;
                  const cellSelected = selectedCellKeys.has(`${dayIndex},${timeIndex}`);
                  const dragSelectionClass = cellSelected && !isLockMode
                    ? isLimitMode
                      ? styles.dragSelectLimit
                      : styles.dragSelectNominate
                    : "";

                  // Current time line
                  const showTimeLine =
                    isToday &&
                    Math.floor(currentTimePosition) === timeIndex;
                  const timeLineOffset =
                    (currentTimePosition - timeIndex) * 100;

                  // In limit/nominate mode, disallowed cells are still interactive for creators
                  const inLimitMode = isCreator && creatorMode === "limit";
                  const inCreatorNominateMode = isCreator && creatorMode === "nominate";
                  const cellDisabledForInteraction =
                    cellDisallowed && !inLimitMode && !inCreatorNominateMode;

                  // Build className
                  const stateClass =
                    myState === "can-do"
                      ? styles.stateCanDo
                      : myState === "cant-do"
                        ? styles.stateCantDo
                        : myState === "maybe"
                          ? styles.stateMaybe
                          : "";
                  const cellClasses = cx(
                    styles.gridCell,
                    stateClass,
                    cellDisallowed && styles.disallowed,
                    cellDisallowed &&
                      (inLimitMode || inCreatorNominateMode) &&
                      styles.limitInteractive,
                    cellLockOutlined && styles.locked,
                    cellLockOutlined && !isCellLockOutlined(dayIndex, timeIndex - 1) && styles.lockedStart,
                    cellLockOutlined && !isCellLockOutlined(dayIndex, timeIndex + 1) && styles.lockedEnd,
                    isToday && styles.currentDayCol,
                    isToday && timeIndex === TIME_SLOTS.length - 1
                      ? styles.currentDayColLast
                      : "",
                    dragSelectionClass,
                    !inRange && styles.cellOutOfRange,
                    canShowNominations && styles.cellHasNominations,
                  );

                  return (
                    <td
                      key={dayIndex}
                      ref={(el) => {
                        if (el) {
                          cellRefs.current.set(
                            `${dayIndex},${timeIndex}`,
                            el
                          );
                        }
                      }}
                      className={cellClasses}
                      data-selected={cellSelected || undefined}
                      data-inspected={isNominationAnchor && inspectedSlot ? true : undefined}
                      title={
                        cellCalendarSynced
                          ? myState === "cant-do"
                            ? "Unavailable due to a synced calendar entry. Click to override."
                            : "Overrides a synced calendar entry. Clear to restore Can't Do."
                          : undefined
                      }
                      onMouseDown={(e) =>
                        inRange && !cellDisabledForInteraction
                          ? handleMouseDown(e, dayIndex, timeIndex)
                          : undefined
                      }
                      onPointerMove={canShowNominations
                        ? (event) => handleNominationMove(event, dayIndex, timeIndex)
                        : undefined}
                      onPointerLeave={canShowNominations || isNominationAnchor ? (event) => {
                        const anchor = event.currentTarget;
                        setNominationHover((current) => current?.anchor === anchor ? null : current);
                      } : undefined}
                      style={{ height: 24, padding: "1px" }}
                    >
                      {/* Current time line */}
                      {showTimeLine && (
                        <div
                          className={styles.currentTimeLine}
                          style={{ top: `${timeLineOffset}%` }}
                        />
                      )}

                      {cellCalendarSynced && (
                        <CalendarDays
                          className={styles.calendarSyncedIcon}
                          aria-hidden="true"
                        />
                      )}

                      {/* Profile icons for every participant in this cell */}
                      {hasNominations && (
                        <div className={styles.profileCellContent}>
                          {nominationOrder.map((state) => {
                            const stateSelections = cellParticipants.filter(
                              (s) => s.state === state
                            );
                            if (stateSelections.length === 0) return null;

                            const bgClass =
                              state === "can-do"
                                ? styles.profileGroupCanDo
                                : state === "cant-do"
                                  ? styles.profileGroupCantDo
                                  : styles.profileGroupMaybe;

                            return (
                              <div
                                key={state}
                                className={cx(styles.profileGroup, bgClass)}
                              >
                                {stateSelections.map((s) => {
                                  const prof = profileMap.get(s.profileId);
                                  if (!prof) return null;

                                  return (
                                    <ParticipantIcon
                                      key={s.profileId}
                                      profile={prof}
                                      nomination={nominationLabels[state]}
                                    />
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inspectedSlot && nominationHover && createPortal(
        <NominationDetails
          nominations={hoveredNominations}
          slotLabel={inspectedSlot}
          isLocked={inspectedSlotLocked}
          highlightedId={nominationHover.profileId}
          cursorRef={cursorRef}
          distance={nominationHoverDistancePx}
          onPointerLeave={() => setNominationHover(null)}
        />,
        document.body
      )}

      {isSelectMode && !isDragging && selectedCells.length > 0 && selectedRange && (
        <AvailabilitySelectionToolbar
          startCell={cellRefs.current.get(`${Math.min(selectedRange.start.dayIndex, selectedRange.end.dayIndex)},${Math.min(selectedRange.start.timeIndex, selectedRange.end.timeIndex)}`)!}
          endCell={cellRefs.current.get(`${Math.max(selectedRange.start.dayIndex, selectedRange.end.dayIndex)},${Math.max(selectedRange.start.timeIndex, selectedRange.end.timeIndex)}`)!}
          container={gridRef.current!}
          count={selectedCells.length}
          disallowCantDo={schedule.disallowCantDo}
          onApply={applySelectedState}
          onDismiss={clearSelection}
        />
      )}
    </div>
  );
}
