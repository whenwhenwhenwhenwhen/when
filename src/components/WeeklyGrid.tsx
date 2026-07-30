import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { DateTime } from "luxon";
import { CalendarDays } from "lucide-react";
import { Id } from "../../convex/_generated/dataModel";
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
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

type CellState = "can-do" | "cant-do" | "maybe" | "blank";
type SelectMode = "auto" | "can-do" | "cant-do" | "maybe" | "blank";
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

// Generate a consistent color for a user based on their ID
function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
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

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    dayIndex: number;
    timeIndex: number;
  } | null>(null);
  // For regular/nominate mode: stores the CellState to apply
  // For limit mode: stores "allow" or "dont-allow"
  // For lock mode: stores "lock" or "unlock"
  const dragActionRef = useRef<string>("can-do");

  // Current time for the indicator
  const [now, setNow] = useState(DateTime.now().setZone(userTimezone));

  useEffect(() => {
    setNow(DateTime.now().setZone(userTimezone));
    const interval = setInterval(() => {
      setNow(DateTime.now().setZone(userTimezone));
    }, 30000);
    return () => clearInterval(interval);
  }, [userTimezone]);

  // Calculate week dates
  const referenceDate = DateTime.now()
    .setZone(userTimezone)
    .plus({ weeks: weekOffset });
  const weekDates = useMemo(
    () => getWeekDates(referenceDate, weekStartDay),
    [referenceDate.toISODate(), weekStartDay]
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
    if (!profileId) return set;
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
    profileId,
    userTimezone,
    schedule.type,
    referenceDate,
    weekStartDay,
  ]);

  // Build a map of all users' selections for each cell (for profile icons)
  const allCellSelections = useMemo(() => {
    const map = new Map<
      string,
      { profileId: string; state: "can-do" | "cant-do" | "maybe" }[]
    >();

    for (const sel of schedule.selections) {
      const { key: cellKey } = getSelectionViewerCell(
        schedule.type,
        sel,
        userTimezone,
        referenceDate,
        weekStartDay
      );

      const existing = map.get(cellKey) || [];
      existing.push({ profileId: sel.profileId, state: sel.state });
      map.set(cellKey, existing);
    }

    return map;
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

  // Get the cell key for a given day/time index
  const getCellKey = useCallback(
    (dayIndex: number, timeIndex: number): string => {
      if (schedule.type === "one-off") {
        const date = weekDates[dayIndex];
        return `${date.toISODate()}|${TIME_SLOTS[timeIndex]}`;
      } else {
        const date = weekDates[dayIndex];
        const dow = (weekStartDay + dayIndex) % 7;
        const excKey = `exc:${date.toISODate()}|${TIME_SLOTS[timeIndex]}`;
        if (myCellStates.has(excKey)) {
          return excKey;
        }
        return `${dow}|${TIME_SLOTS[timeIndex]}`;
      }
    },
    [schedule.type, weekDates, weekStartDay, myCellStates]
  );

  // Get cell state for a given day/time index
  const getCellState = useCallback(
    (dayIndex: number, timeIndex: number): CellState => {
      const key = getCellKey(dayIndex, timeIndex);
      return myCellStates.get(key) || "blank";
    },
    [getCellKey, myCellStates]
  );

  // Get the next state in auto mode cycle
  const getNextAutoState = (
    current: CellState,
    hasCalendarBaseline: boolean
  ): CellState => {
    if (hasCalendarBaseline) {
      switch (current) {
        case "blank":
        case "cant-do":
          return "can-do";
        case "can-do":
          return "maybe";
        case "maybe":
          return "blank";
      }
    }

    switch (current) {
      case "blank":
        return "can-do";
      case "can-do":
        return "cant-do";
      case "cant-do":
        return "maybe";
      case "maybe":
        return "blank";
    }
  };

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

  // Handle single cell click (toggle)
  const handleSingleCellToggle = useCallback(
    (dayIndex: number, timeIndex: number) => {
      if (!canInteract) return;

      if (!isCellInDateRange(dayIndex, timeIndex)) return;

      // Creator: Allow/Disallow mode
      if (isCreator && creatorMode === "limit") {
        const { dayKey, timeSlot } = toScheduleKeys(dayIndex, timeIndex);
        const currentSlots = schedule.disallowedSlots || [];
        const cellIsDisallowed = isCellDisallowed(dayIndex, timeIndex);

        if (allowMode === "auto") {
          // Toggle
          if (cellIsDisallowed) {
            onCreatorSlotChange(
              currentSlots.filter(
                (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
              )
            );
          } else {
            onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]);
          }
        } else if (allowMode === "allow" && cellIsDisallowed) {
          onCreatorSlotChange(
            currentSlots.filter(
              (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
            )
          );
        } else if (allowMode === "dont-allow" && !cellIsDisallowed) {
          onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]);
        }
        return;
      }

      // Creator: Lock mode
      if (canLock && creatorMode === "lock") {
        const { dayKey, timeSlot } = toScheduleKeys(dayIndex, timeIndex);
        const currentSlots = schedule.lockedSlots || [];
        const cellIsLocked = isCellLocked(dayIndex, timeIndex);

        // Toggle lock state
        if (cellIsLocked) {
          onCreatorSlotChange(
            currentSlots.filter(
              (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
            )
          );
        } else {
          onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]);
        }
        return;
      }

      // Regular mode or creator nominate mode — standard selection behavior
      const currentState = getCellState(dayIndex, timeIndex);
      const hasCalendarBaseline = calendarSyncedCells.has(
        getCellKey(dayIndex, timeIndex)
      );
      let newState: CellState;

      if (selectMode === "auto") {
        newState = getNextAutoState(currentState, hasCalendarBaseline);
      } else {
        newState = currentState === selectMode ? "blank" : selectMode;
      }

      const {
        dayKey,
        timeSlot,
        isException,
        exceptionDate,
        timezone: storageTimezone,
      } =
        toStorageKeys(dayIndex, timeIndex);
      const scheduleCell = toScheduleKeys(dayIndex, timeIndex);
      onCellChange(
        dayKey,
        timeSlot,
        newState,
        isException,
        exceptionDate,
        storageTimezone,
        scheduleCell.dayKey,
        scheduleCell.timeSlot
      );
    },
    [
      canInteract,
      isCreator,
      canLock,
      creatorMode,
      selectMode,
      allowMode,
      getCellState,
      getCellKey,
      calendarSyncedCells,
      isCellInDateRange,
      isCellDisallowed,
      isCellLocked,
      toStorageKeys,
      toScheduleKeys,
      onCellChange,
      onCreatorSlotChange,
      schedule.disallowedSlots,
      schedule.lockedSlots,
    ]
  );

  // Mouse handlers for drag selection
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, dayIndex: number, timeIndex: number) => {
      if (e.button !== 0) return;
      if (!canInteract) return;

      e.preventDefault();
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        dayIndex,
        timeIndex,
      };
      setIsDragging(true);
      setDragActive(false);

      // Determine drag action based on mode
      if (isCreator && creatorMode === "limit") {
        const cellIsDisallowed = isCellDisallowed(dayIndex, timeIndex);
        if (allowMode === "auto") {
          dragActionRef.current = cellIsDisallowed ? "allow" : "dont-allow";
        } else {
          dragActionRef.current = allowMode;
        }
      } else if (canLock && creatorMode === "lock") {
        const cellIsLocked = isCellLocked(dayIndex, timeIndex);
        dragActionRef.current = cellIsLocked ? "unlock" : "lock";
      } else {
        // Regular / nominate mode
        const currentState = getCellState(dayIndex, timeIndex);
        if (selectMode === "auto") {
          const hasCalendarBaseline = calendarSyncedCells.has(
            getCellKey(dayIndex, timeIndex)
          );
          dragActionRef.current = hasCalendarBaseline
            ? getNextAutoState(currentState, true)
            : currentState === "blank"
              ? "can-do"
              : currentState;
        } else {
          dragActionRef.current = selectMode;
        }
      }

      setSelectionBox({
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
      });
    },
    [
      canInteract,
      getCellState,
      getCellKey,
      calendarSyncedCells,
      selectMode,
      isCreator,
      canLock,
      creatorMode,
      allowMode,
      isCellDisallowed,
      isCellLocked,
    ]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;

      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > DEAD_ZONE_PX) {
        setDragActive(true);
      }

      setSelectionBox((prev) =>
        prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null
      );
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        // Right click cancels
        setIsDragging(false);
        setSelectionBox(null);
        setDragActive(false);
        dragStartRef.current = null;
        return;
      }

      if (!dragActive && dragStartRef.current) {
        // Single click
        handleSingleCellToggle(
          dragStartRef.current.dayIndex,
          dragStartRef.current.timeIndex
        );
      } else if (dragActive) {
        // Drag complete — collect selected cells, filtering in the schedule's
        // timezone so boundary days work correctly for remote viewers.
        const selectedCells = getSelectedCells().filter((cell) =>
          isCellInDateRange(cell.dayIndex, cell.timeIndex)
        );
        if (selectedCells.length > 0) {
          if (isCreator && creatorMode === "limit") {
            // Allow/Disallow mode: update disallowedSlots
            const action = dragActionRef.current; // "allow" or "dont-allow"
            const currentSlots = [...(schedule.disallowedSlots || [])];

            for (const cell of selectedCells) {
              const { dayKey, timeSlot } = toScheduleKeys(
                cell.dayIndex,
                cell.timeIndex
              );
              const isInSet = isCellDisallowed(
                cell.dayIndex,
                cell.timeIndex
              );

              if (action === "dont-allow" && !isInSet) {
                currentSlots.push({ dayKey, timeSlot });
              } else if (action === "allow" && isInSet) {
                const idx = currentSlots.findIndex(
                  (s) => s.dayKey === dayKey && s.timeSlot === timeSlot
                );
                if (idx !== -1) currentSlots.splice(idx, 1);
              }
            }
            onCreatorSlotChange(currentSlots);
          } else if (canLock && creatorMode === "lock") {
            // Lock mode: filter out disallowed cells first
            const allowedCells = selectedCells.filter(
              (cell) => !isCellDisallowed(cell.dayIndex, cell.timeIndex)
            );
            const action = dragActionRef.current; // "lock" or "unlock"
            const currentSlots = [...(schedule.lockedSlots || [])];

            for (const cell of allowedCells) {
              const { dayKey, timeSlot } = toScheduleKeys(
                cell.dayIndex,
                cell.timeIndex
              );
              const isInSet = isCellLocked(cell.dayIndex, cell.timeIndex);

              if (action === "lock" && !isInSet) {
                currentSlots.push({ dayKey, timeSlot });
              } else if (action === "unlock" && isInSet) {
                const idx = currentSlots.findIndex(
                  (s) => s.dayKey === dayKey && s.timeSlot === timeSlot
                );
                if (idx !== -1) currentSlots.splice(idx, 1);
              }
            }
            onCreatorSlotChange(currentSlots);
          } else {
            // Regular / nominate mode: filter out disallowed cells (creators in nominate mode can override)
            const allowedCells = (isCreator && creatorMode === "nominate")
              ? selectedCells
              : selectedCells.filter(
                  (cell) => !isCellDisallowed(cell.dayIndex, cell.timeIndex)
                );
            const state = dragActionRef.current as CellState;
            const batchSelections = allowedCells.map((cell) => {
              const {
                dayKey,
                timeSlot,
                isException,
                exceptionDate,
                timezone,
              } =
                toStorageKeys(cell.dayIndex, cell.timeIndex);
              const scheduleCell = toScheduleKeys(
                cell.dayIndex,
                cell.timeIndex
              );
              return {
                dayKey,
                timeSlot,
                state,
                isException,
                exceptionDate,
                timezone,
                scheduleDayKey: scheduleCell.dayKey,
                scheduleTimeSlot: scheduleCell.timeSlot,
              };
            });
            if (batchSelections.length > 0) {
              onBatchChange(batchSelections);
            }
          }
        }
      }

      setIsDragging(false);
      setSelectionBox(null);
      setDragActive(false);
      dragStartRef.current = null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsDragging(false);
        setSelectionBox(null);
        setDragActive(false);
        dragStartRef.current = null;
      }
    };

    const handleContextMenu = (e: Event) => {
      if (isDragging) {
        e.preventDefault();
        setIsDragging(false);
        setSelectionBox(null);
        setDragActive(false);
        dragStartRef.current = null;
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("contextmenu", handleContextMenu);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [
    isDragging,
    dragActive,
    handleSingleCellToggle,
    toStorageKeys,
    toScheduleKeys,
    onBatchChange,
    isCreator,
    canLock,
    creatorMode,
    onCreatorSlotChange,
    isCellDisallowed,
    isCellLocked,
    isCellInDateRange,
    schedule.disallowedSlots,
    schedule.lockedSlots,
  ]);

  // Get cells that overlap with the selection box
  const getSelectedCells = useCallback((): {
    dayIndex: number;
    timeIndex: number;
  }[] => {
    if (!selectionBox || !dragActive) return [];

    const rect = {
      left: Math.min(selectionBox.startX, selectionBox.currentX),
      top: Math.min(selectionBox.startY, selectionBox.currentY),
      right: Math.max(selectionBox.startX, selectionBox.currentX),
      bottom: Math.max(selectionBox.startY, selectionBox.currentY),
    };

    const cells: { dayIndex: number; timeIndex: number }[] = [];

    cellRefs.current.forEach((el, key) => {
      const cellRect = el.getBoundingClientRect();
      const overlapX =
        Math.min(rect.right, cellRect.right) -
        Math.max(rect.left, cellRect.left);
      const overlapY =
        Math.min(rect.bottom, cellRect.bottom) -
        Math.max(rect.top, cellRect.top);

      if (overlapX > DEAD_ZONE_PX && overlapY > DEAD_ZONE_PX) {
        const [d, t] = key.split(",").map(Number);
        cells.push({ dayIndex: d, timeIndex: t });
      }
    });

    return cells;
  }, [selectionBox, dragActive]);

  // Check if a cell is within the active selection box
  const isCellInDragSelection = useCallback(
    (dayIndex: number, timeIndex: number): boolean => {
      if (!selectionBox || !dragActive) return false;

      const el = cellRefs.current.get(`${dayIndex},${timeIndex}`);
      if (!el) return false;

      const rect = {
        left: Math.min(selectionBox.startX, selectionBox.currentX),
        top: Math.min(selectionBox.startY, selectionBox.currentY),
        right: Math.max(selectionBox.startX, selectionBox.currentX),
        bottom: Math.max(selectionBox.startY, selectionBox.currentY),
      };

      const cellRect = el.getBoundingClientRect();
      const overlapX =
        Math.min(rect.right, cellRect.right) -
        Math.max(rect.left, cellRect.left);
      const overlapY =
        Math.min(rect.bottom, cellRect.bottom) -
        Math.max(rect.top, cellRect.top);

      return overlapX > DEAD_ZONE_PX && overlapY > DEAD_ZONE_PX;
    },
    [selectionBox, dragActive]
  );

  // Get drag selection styling based on creator mode
  const getDragSelectionClass = useCallback(
    (dayIndex: number, timeIndex: number): string => {
      if (!isCellInDragSelection(dayIndex, timeIndex)) return "";

      if (isCreator && creatorMode === "limit") return styles.dragSelectLimit;
      if (canLock && creatorMode === "lock") return styles.dragSelectLock;
      // nominate mode or non-creator
      return styles.dragSelectNominate;
    },
    [isCellInDragSelection, isCreator, canLock, creatorMode]
  );

  // Profile map for quick lookup
  const profileMap = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const p of schedule.profiles) {
      map.set(p._id, p);
    }
    return map;
  }, [schedule.profiles]);

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

  // Selection box rect for rendering
  const selectionRect = useMemo(() => {
    if (!selectionBox || !dragActive) return null;
    return {
      left: Math.min(selectionBox.startX, selectionBox.currentX),
      top: Math.min(selectionBox.startY, selectionBox.currentY),
      width: Math.abs(selectionBox.currentX - selectionBox.startX),
      height: Math.abs(selectionBox.currentY - selectionBox.startY),
    };
  }, [selectionBox, dragActive]);

  // Determine the CSS class for the selection box overlay
  const selectionBoxClass = useMemo(() => {
    if (isCreator && creatorMode === "limit") {
      return cx(styles.selectionBox, styles.selectionBoxLimit);
    }
    if (canLock && creatorMode === "lock") {
      return cx(styles.selectionBox, styles.selectionBoxLock);
    }
    return styles.selectionBox;
  }, [isCreator, canLock, creatorMode]);

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
        className={styles.gridContainer}
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
                    <div>{day}</div>
                    <div className={styles.dayDate}>
                      {columnDates[i]}
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
                  const otherSelections = allCellSelections.get(cellKey) || [];
                  const cellDisallowed = isCellDisallowed(dayIndex, timeIndex);
                  const cellLocked = isCellLocked(dayIndex, timeIndex);
                  const cellCalendarSynced = calendarSyncedCells.has(cellKey);
                  const isToday = dayIndex === currentDayIndex;
                  const dragSelectionClass = getDragSelectionClass(
                    dayIndex,
                    timeIndex
                  );

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
                    cellLocked && styles.locked,
                    isToday && styles.currentDayCol,
                    isToday && timeIndex === TIME_SLOTS.length - 1
                      ? styles.currentDayColLast
                      : "",
                    dragSelectionClass,
                    !inRange && styles.cellOutOfRange,
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

                      {/* Profile icons for other users */}
                      {otherSelections.length > 0 && (
                        <div className={styles.profileCellContent}>
                          {(
                            ["can-do", "cant-do", "maybe"] as const
                          ).map((state) => {
                            const stateSelections = otherSelections.filter(
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

                                  return prof.profileImageUrl ? (
                                    <img
                                      key={s.profileId}
                                      src={prof.profileImageUrl}
                                      alt={prof.displayName}
                                      title={`${prof.displayName} (${state})`}
                                      className={styles.profileIcon}
                                    />
                                  ) : (
                                    <span
                                      key={s.profileId}
                                      className={styles.profileIcon}
                                      style={{
                                        backgroundColor: getUserColor(
                                          s.profileId
                                        ),
                                      }}
                                      title={`${prof.displayName} (${state})`}
                                    >
                                      {getInitials(prof.displayName)}
                                    </span>
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

      {/* Selection box overlay */}
      {selectionRect && (
        <div
          className={selectionBoxClass}
          style={{
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        />
      )}
    </div>
  );
}
