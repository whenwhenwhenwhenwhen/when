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
import { useToast } from "../hooks/useToast";
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
const CELL_ERROR = "Couldn't save your availability. Please try again.";
const SLOT_ERROR = "Couldn't update the schedule. Please try again.";

interface CellParticipant {
  profileId: string;
  state: "can-do" | "cant-do" | "maybe";
}

interface SelectionBox {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

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
  const { showToast } = useToast();

  // Drag state. The document listeners are registered once per drag, so the
  // commit path must read the live box from refs rather than from the state
  // captured when the listeners were attached.
  const [isDragging, setIsDragging] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const dragActiveRef = useRef(false);
  const selectionBoxRef = useRef<SelectionBox | null>(null);
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

  const setDragActiveState = useCallback((active: boolean) => {
    dragActiveRef.current = active;
    setDragActive(active);
  }, []);

  const setSelectionBoxState = useCallback((box: SelectionBox | null) => {
    selectionBoxRef.current = box;
    setSelectionBox(box);
  }, []);

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
            commitChange(
              onCreatorSlotChange(
                currentSlots.filter(
                  (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
                )
              ),
              SLOT_ERROR
            );
          } else {
            commitChange(
              onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]),
              SLOT_ERROR
            );
          }
        } else if (allowMode === "allow" && cellIsDisallowed) {
          commitChange(
            onCreatorSlotChange(
              currentSlots.filter(
                (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
              )
            ),
            SLOT_ERROR
          );
        } else if (allowMode === "dont-allow" && !cellIsDisallowed) {
          commitChange(
            onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]),
            SLOT_ERROR
          );
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
          commitChange(
            onCreatorSlotChange(
              currentSlots.filter(
                (s) => !(s.dayKey === dayKey && s.timeSlot === timeSlot)
              )
            ),
            SLOT_ERROR
          );
        } else {
          commitChange(
            onCreatorSlotChange([...currentSlots, { dayKey, timeSlot }]),
            SLOT_ERROR
          );
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
      commitChange(
        onCellChange(
          dayKey,
          timeSlot,
          newState,
          isException,
          exceptionDate,
          storageTimezone,
          scheduleCell.dayKey,
          scheduleCell.timeSlot
        ),
        CELL_ERROR
      );
    },
    [
      canInteract,
      commitChange,
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
      setDragActiveState(false);

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

      setSelectionBoxState({
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
      setDragActiveState,
      setSelectionBoxState,
    ]
  );

  // Get cells that overlap with the selection box
  const getSelectedCells = useCallback((): {
    dayIndex: number;
    timeIndex: number;
  }[] => {
    const box = selectionBoxRef.current;
    if (!box || !dragActiveRef.current) return [];

    const rect = {
      left: Math.min(box.startX, box.currentX),
      top: Math.min(box.startY, box.currentY),
      right: Math.max(box.startX, box.currentX),
      bottom: Math.max(box.startY, box.currentY),
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
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;

      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > DEAD_ZONE_PX) {
        setDragActiveState(true);
      }

      const box = selectionBoxRef.current;
      if (box) {
        setSelectionBoxState({
          ...box,
          currentX: e.clientX,
          currentY: e.clientY,
        });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        // Right click cancels
        setIsDragging(false);
        setSelectionBoxState(null);
        setDragActiveState(false);
        dragStartRef.current = null;
        return;
      }

      if (!dragActiveRef.current && dragStartRef.current) {
        // Single click
        handleSingleCellToggle(
          dragStartRef.current.dayIndex,
          dragStartRef.current.timeIndex
        );
      } else if (dragActiveRef.current) {
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
            commitChange(onCreatorSlotChange(currentSlots), SLOT_ERROR);
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
            commitChange(onCreatorSlotChange(currentSlots), SLOT_ERROR);
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
              commitChange(onBatchChange(batchSelections), CELL_ERROR);
            }
          }
        }
      }

      setIsDragging(false);
      setSelectionBoxState(null);
      setDragActiveState(false);
      dragStartRef.current = null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsDragging(false);
        setSelectionBoxState(null);
        setDragActiveState(false);
        dragStartRef.current = null;
      }
    };

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
      setIsDragging(false);
      setSelectionBoxState(null);
      setDragActiveState(false);
      dragStartRef.current = null;
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
    commitChange,
    getSelectedCells,
    handleSingleCellToggle,
    setDragActiveState,
    setSelectionBoxState,
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
                  const cellParticipants = getCellParticipants(
                    dayIndex,
                    timeIndex
                  );
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

                      {/* Profile icons for every participant in this cell */}
                      {cellParticipants.length > 0 && (
                        <div className={styles.profileCellContent}>
                          {(
                            ["can-do", "cant-do", "maybe"] as const
                          ).map((state) => {
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
