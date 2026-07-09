import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { useGoogleAuth } from "../lib/googleAuth";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Header } from "./Header";
import { WeeklyGrid } from "./WeeklyGrid";
import { DisplayNamePrompt } from "./DisplayNamePrompt";
import { ClearConfirmModal } from "./ClearConfirmModal";
import { AvailabilitiesMenu } from "./AvailabilitiesMenu";
import { ApplyAvailabilityModal } from "./ApplyAvailabilityModal";
import { SaveAvailabilityModal } from "./SaveAvailabilityModal";
import { ManageSavedAvailabilitiesModal } from "./ManageSavedAvailabilitiesModal";
import { EditScheduleModal } from "./EditScheduleModal";
import { ParticipantsMenu } from "./ParticipantsMenu";
import { DiscordLinkButton } from "./DiscordLinkButton";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { useTimezone } from "../hooks/useTimezone";
import { detectTimezone, getWeekDates, generateTimeSlots } from "../lib/timezone";
import { DateTime } from "luxon";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

type SelectMode = "auto" | "can-do" | "cant-do" | "maybe" | "blank";
type AllowMode = "auto" | "allow" | "dont-allow";
type CreatorMode = "limit" | "nominate" | "lock" | null;

export function ScheduleView() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = useGoogleAuth();
  const { anonymousId, displayName, setDisplayName, hasInteracted } =
    useAnonymousUser();

  const profile = useQuery(api.users.currentUserProfile, {
    anonymousId: isAuthenticated ? undefined : anonymousId || undefined,
  });
  const callerAnonymousId = isAuthenticated ? undefined : anonymousId || undefined;

  const schedule = useQuery(api.schedules.get, {
    scheduleId: id as Id<"schedules">,
  });

  const { timezone } = useTimezone(profile?.timezone);

  const getOrCreateProfile = useMutation(api.users.getOrCreateAnonymousProfile);
  const setSelectionMut = useMutation(api.selections.set);
  const removeSelectionMut = useMutation(api.selections.remove);
  const batchSetMut = useMutation(api.selections.batchSet);
  const setDisallowedSlots = useMutation(api.schedules.setDisallowedSlots);
  const setLockedSlots = useMutation(api.schedules.setLockedSlots);
  const clearDisallowedSlots = useMutation(api.schedules.clearDisallowedSlots);
  const clearLockedSlots = useMutation(api.schedules.clearLockedSlots);
  const clearSelections = useMutation(api.selections.clearForProfile);
  const setAcceptParticipation = useMutation(api.schedules.setAcceptParticipation);
  const setAnyoneCanLock = useMutation(api.schedules.setAnyoneCanLock);
  const addLockEditor = useMutation(api.schedules.addLockEditor);
  const removeLockEditor = useMutation(api.schedules.removeLockEditor);
  const removeParticipant = useMutation(api.schedules.removeParticipant);
  const blockParticipant = useMutation(api.schedules.blockParticipant);

  const [selectMode, setSelectMode] = useState<SelectMode>("auto");
  const [allowMode, setAllowMode] = useState<AllowMode>("auto");
  const [creatorMode, setCreatorMode] = useState<CreatorMode>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [hasName, setHasName] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [showSaveNewModal, setShowSaveNewModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<Id<"userProfiles"> | null>(null);

  // Saved availabilities (only for SSO users)
  const isSsoUser = profile?.authType === "sso";
  const savedAvailabilities = useQuery(
    api.savedAvailabilities.listForProfile,
    isSsoUser && profile?._id ? {} : "skip"
  );

  // Availability link mutations
  const applyToScheduleMut = useMutation(api.savedAvailabilities.applyToSchedule);
  const saveNewAndLinkMut = useMutation(api.savedAvailabilities.saveNewAndLink);
  const saveOverwriteDefaultMut = useMutation(api.savedAvailabilities.saveOverwriteDefaultAndLink);
  const unlinkFromScheduleMut = useMutation(api.savedAvailabilities.unlinkFromSchedule);

  // Derive current link from schedule data
  const profileIdStr = profile?._id ? String(profile._id) : null;
  const currentLink = schedule?.availabilityLinks?.find(
    (l: any) => String(l.profileId) === profileIdStr
  ) ?? null;

  // Check if current user is the creator
  const isCreator = profile && schedule
    ? schedule.creatorProfileId === profile._id
    : false;

  // Check if user can lock (creator, promoted lock editor, or anyone if toggle is on)
  const canLock = profile && schedule
    ? isCreator
      || !!schedule.anyoneCanLock
      || !!(schedule.lockEditors as string[] | undefined)?.includes(profile._id as string)
    : false;

  // Default to "nominate" mode for creators
  useEffect(() => {
    if (isCreator && creatorMode === null) {
      setCreatorMode("nominate");
    }
  }, [isCreator, creatorMode]);

  // Check if user is blocked from this schedule
  const isBlocked = !isCreator && profile && schedule?.blockedProfileIds?.includes(profile._id as string);

  // Check if participation is closed for non-creators
  const isParticipationClosed = !isCreator && schedule?.acceptParticipation === false;

  // Determine if user can interact with the grid
  const canInteract =
    ((isAuthenticated && !!profile) || (hasInteracted && !!profile) || hasName)
    && !isBlocked
    && !isParticipationClosed;

  // The reference date for the current week view
  const referenceDate = DateTime.now()
    .setZone(timezone)
    .plus({ weeks: weekOffset });

  useEffect(() => {
    if (hasInteracted || isAuthenticated) {
      setHasName(true);
    } else {
      // Reset when user logs out (isAuthenticated becomes false and
      // anonymous identity was already cleared during the auth flow)
      setHasName(false);
    }
  }, [hasInteracted, isAuthenticated]);

  const handleDisplayNameSubmit = useCallback(
    async (name: string) => {
      setDisplayName(name);
      setHasName(true);

      // Create anonymous profile in Convex
      if (!profile) {
        await getOrCreateProfile({
          anonymousId,
          displayName: name,
          timezone: timezone || detectTimezone(),
        });
      }
    },
    [anonymousId, getOrCreateProfile, profile, setDisplayName, timezone]
  );

  // The effective profile for selections: either the user being edited or the current user
  const effectiveProfileId = editingProfileId ?? profile?._id ?? null;

  const handleCellChange = useCallback(
    async (
      dayKey: string,
      timeSlot: string,
      state: "can-do" | "cant-do" | "maybe" | "blank",
      isException?: boolean,
      exceptionDate?: string
    ) => {
      if (!effectiveProfileId) return;

      if (state === "blank") {
        await removeSelectionMut({
          scheduleId: id as Id<"schedules">,
          profileId: effectiveProfileId,
          dayKey,
          timeSlot,
          isException,
          exceptionDate,
          timezone,
          anonymousId: callerAnonymousId,
        });
      } else {
        await setSelectionMut({
          scheduleId: id as Id<"schedules">,
          profileId: effectiveProfileId,
          dayKey,
          timeSlot,
          timezone,
          state,
          isException,
          exceptionDate,
          anonymousId: callerAnonymousId,
        });
      }
    },
    [id, effectiveProfileId, callerAnonymousId, timezone, setSelectionMut, removeSelectionMut]
  );

  const handleBatchChange = useCallback(
    async (
      cells: {
        dayKey: string;
        timeSlot: string;
        state: "can-do" | "cant-do" | "maybe" | "blank";
        isException?: boolean;
        exceptionDate?: string;
      }[]
    ) => {
      if (!effectiveProfileId) return;

      await batchSetMut({
        scheduleId: id as Id<"schedules">,
        profileId: effectiveProfileId,
        timezone,
        selections: cells,
        anonymousId: callerAnonymousId,
      });
    },
    [id, effectiveProfileId, callerAnonymousId, timezone, batchSetMut]
  );

  const handleCreatorSlotChange = useCallback(
    async (slots: { dayKey: string; timeSlot: string }[]) => {
      if (!schedule) return;

      if (isCreator && creatorMode === "limit") {
        await setDisallowedSlots({
          scheduleId: schedule._id,
          anonymousId: callerAnonymousId,
          slots,
        });
      } else if (canLock && creatorMode === "lock") {
        await setLockedSlots({
          scheduleId: schedule._id,
          anonymousId: callerAnonymousId,
          slots,
        });
      }
    },
    [isCreator, canLock, schedule, callerAnonymousId, creatorMode, setDisallowedSlots, setLockedSlots]
  );

  // Availability handlers
  const handleApply = useCallback(
    async (savedAvailabilityId: Id<"savedAvailabilities">) => {
      if (!savedAvailabilityId) {
        // Signal to open the modal (multiple availabilities)
        setShowApplyModal(true);
        return;
      }
      if (!profile || !schedule) return;
      await applyToScheduleMut({
        savedAvailabilityId,
        scheduleId: schedule._id,
      });
    },
    [profile, schedule, applyToScheduleMut]
  );

  const handleApplyFromModal = useCallback(
    async (savedAvailabilityId: Id<"savedAvailabilities">) => {
      if (!profile || !schedule) return;
      await applyToScheduleMut({
        savedAvailabilityId,
        scheduleId: schedule._id,
      });
    },
    [profile, schedule, applyToScheduleMut]
  );

  const handleSaveOverwriteDefault = useCallback(async () => {
    if (!profile || !schedule) return;
    await saveOverwriteDefaultMut({
      scheduleId: schedule._id,
      timezone,
    });
  }, [profile, schedule, timezone, saveOverwriteDefaultMut]);

  const handleSaveNew = useCallback(
    async (name: string) => {
      if (!profile || !schedule) return;
      await saveNewAndLinkMut({
        scheduleId: schedule._id,
        name,
        timezone,
      });
    },
    [profile, schedule, timezone, saveNewAndLinkMut]
  );

  const handleUnlink = useCallback(async () => {
    if (!profile || !schedule) return;
    await unlinkFromScheduleMut({
      scheduleId: schedule._id,
    });
  }, [profile, schedule, unlinkFromScheduleMut]);

  // Participant management handlers (creator only)
  const handleToggleAcceptParticipation = useCallback(
    async (accept: boolean) => {
      if (!schedule) return;
      await setAcceptParticipation({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        acceptParticipation: accept,
      });
    },
    [schedule, callerAnonymousId, setAcceptParticipation]
  );

  const handleToggleAnyoneCanLock = useCallback(
    async (enabled: boolean) => {
      if (!schedule) return;
      await setAnyoneCanLock({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        anyoneCanLock: enabled,
      });
    },
    [schedule, callerAnonymousId, setAnyoneCanLock]
  );

  const handlePromoteLockEditor = useCallback(
    async (profileId: Id<"userProfiles">) => {
      if (!schedule) return;
      await addLockEditor({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        profileId,
      });
    },
    [schedule, callerAnonymousId, addLockEditor]
  );

  const handleDemoteLockEditor = useCallback(
    async (profileId: Id<"userProfiles">) => {
      if (!schedule) return;
      await removeLockEditor({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        profileId,
      });
    },
    [schedule, callerAnonymousId, removeLockEditor]
  );

  const handleDeleteParticipant = useCallback(
    async (profileId: Id<"userProfiles">) => {
      if (!schedule) return;
      // If we're currently editing this user, stop
      if (editingProfileId === profileId) {
        setEditingProfileId(null);
      }
      await removeParticipant({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        profileId,
      });
    },
    [schedule, callerAnonymousId, editingProfileId, removeParticipant]
  );

  const handleBlockParticipant = useCallback(
    async (profileId: Id<"userProfiles">) => {
      if (!schedule) return;
      // If we're currently editing this user, stop
      if (editingProfileId === profileId) {
        setEditingProfileId(null);
      }
      await blockParticipant({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
        profileId,
      });
    },
    [schedule, callerAnonymousId, editingProfileId, blockParticipant]
  );

  const handleEditParticipant = useCallback(
    (profileId: Id<"userProfiles">) => {
      setEditingProfileId(profileId);
      // Switch to nominate mode so the creator can make selections
      setCreatorMode("nominate");
    },
    []
  );

  const handleStopEditingParticipant = useCallback(() => {
    setEditingProfileId(null);
  }, []);

  // Clear modal content based on role and creator mode
  const getClearModalContent = () => {
    if (canLock && creatorMode === "lock") {
      return {
        title: "Clear Locked Times",
        message:
          "Are you sure you want to clear all locked-in times? The schedule will be unlocked.",
      };
    }
    if (!isCreator) {
      return {
        title: "Clear Nominations",
        message:
          "Are you sure you want to clear all your nominations for this schedule? This cannot be undone.",
      };
    }
    switch (creatorMode) {
      case "limit":
        return {
          title: "Clear Allow/Disallow Settings",
          message:
            "Are you sure you want to clear all allow/disallow time settings? All time slots will become allowed again.",
        };
      case "nominate":
        return {
          title: "Clear Nominations",
          message:
            "Are you sure you want to clear all your nominations for this schedule? This cannot be undone.",
        };
      default:
        return {
          title: "Clear",
          message: "Are you sure you want to clear?",
        };
    }
  };

  const handleClear = useCallback(async () => {
    if (!profile || !schedule) return;

    if (canLock && creatorMode === "lock") {
      await clearLockedSlots({
        scheduleId: schedule._id,
        anonymousId: callerAnonymousId,
      });
    } else if (!isCreator) {
      await clearSelections({
        scheduleId: schedule._id,
        profileId: profile._id,
        anonymousId: callerAnonymousId,
      });
    } else {
      switch (creatorMode) {
        case "limit":
          await clearDisallowedSlots({
            scheduleId: schedule._id,
            anonymousId: callerAnonymousId,
          });
          break;
        case "nominate":
          await clearSelections({
            scheduleId: schedule._id,
            profileId: profile._id,
            anonymousId: callerAnonymousId,
          });
          break;
      }
    }
  }, [
    profile,
    schedule,
    isCreator,
    canLock,
    creatorMode,
    clearSelections,
    clearDisallowedSlots,
    clearLockedSlots,
    callerAnonymousId,
  ]);

  const handleDisallowOutsideNominations = useCallback(async () => {
    if (!schedule || !profile) return;

    const timeSlots = generateTimeSlots();

    // Build set of creator's "can-do" and "maybe" nomination keys
    const nominatedSet = new Set<string>();
    for (const sel of schedule.selections) {
      if (sel.profileId !== (profile._id as string)) continue;
      if (sel.state !== "can-do" && sel.state !== "maybe") continue;
      if (schedule.type === "recurring" && sel.isException) continue;
      nominatedSet.add(`${sel.dayKey}|${sel.timeSlot}`);
    }

    const disallowedSlots: { dayKey: string; timeSlot: string }[] = [];

    if (schedule.type === "recurring") {
      for (let dow = 0; dow < 7; dow++) {
        for (const ts of timeSlots) {
          if (!nominatedSet.has(`${dow}|${ts}`)) {
            disallowedSlots.push({ dayKey: String(dow), timeSlot: ts });
          }
        }
      }
    } else if (schedule.dateRangeStart && schedule.dateRangeEnd) {
      let current = DateTime.fromISO(schedule.dateRangeStart);
      const end = DateTime.fromISO(schedule.dateRangeEnd);
      while (current <= end) {
        const dateStr = current.toISODate()!;
        for (const ts of timeSlots) {
          if (!nominatedSet.has(`${dateStr}|${ts}`)) {
            disallowedSlots.push({ dayKey: dateStr, timeSlot: ts });
          }
        }
        current = current.plus({ days: 1 });
      }
    }

    await setDisallowedSlots({
      scheduleId: schedule._id,
      anonymousId: callerAnonymousId,
      slots: disallowedSlots,
    });
  }, [schedule, profile, callerAnonymousId, setDisallowedSlots]);

  if (!schedule) {
    return (
      <div className={styles.appShell}>
        <Header />
        <div className={styles.emptyState}>
          {schedule === null ? "Schedule not found." : "Loading..."}
        </div>
      </div>
    );
  }

  const weekStartDay = profile?.weekStartDay ?? 0;

  // Determine navigation boundaries based on schedule type
  const getNavigationBoundaries = () => {
    if (schedule.type === "one-off") {
      const startDate = schedule.dateRangeStart
        ? DateTime.fromISO(schedule.dateRangeStart)
        : null;
      const endDate = schedule.dateRangeEnd
        ? DateTime.fromISO(schedule.dateRangeEnd)
        : null;
      return { minDate: startDate, maxDate: endDate };
    } else {
      const startDate = schedule.recurringStartDate
        ? DateTime.fromISO(schedule.recurringStartDate)
        : null;
      return { minDate: startDate, maxDate: null };
    }
  };

  const boundaries = getNavigationBoundaries();

  // Check if we can navigate backward (prev week has any overlap with date range)
  const canGoBack = () => {
    if (!boundaries.minDate) return true;
    const prevWeekDates = getWeekDates(referenceDate.minus({ weeks: 1 }), weekStartDay);
    const prevWeekEnd = prevWeekDates[6]; // Last day of previous week
    return prevWeekEnd.toISODate()! >= boundaries.minDate.toISODate()!;
  };

  // Check if we can navigate forward (next week has any overlap with date range)
  const canGoForward = () => {
    if (!boundaries.maxDate) return true;
    const nextWeekDates = getWeekDates(referenceDate.plus({ weeks: 1 }), weekStartDay);
    const nextWeekStart = nextWeekDates[0]; // First day of next week
    return nextWeekStart.toISODate()! <= boundaries.maxDate.toISODate()!;
  };

  const handleWeekBack = () => {
    if (canGoBack()) {
      setWeekOffset((w) => w - 1);
    }
  };

  const handleWeekForward = () => {
    if (canGoForward()) {
      setWeekOffset((w) => w + 1);
    }
  };

  return (
    <div className={styles.appShell}>
      <Header />
      <main className={styles.mainWide}>
        {/* Schedule Header */}
        <div className={styles.scheduleHeader}>
          <div className={styles.scheduleHeaderRow}>
            <div>
              <h1 className={styles.scheduleTitle}>
                {schedule.title}
              </h1>
              {schedule.description && (
                <p className={styles.subtleText}>
                  {schedule.description}
                </p>
              )}
              <div className={styles.scheduleMeta}>
                <span
                  className={cx(
                    styles.badge,
                    schedule.type === "one-off"
                      ? styles.badgeOneOff
                      : styles.badgeRecurring,
                  )}
                >
                  {schedule.type === "one-off" ? "One-off" : "Recurring"}
                </span>
                <span className={styles.faintText}>
                  by {schedule.creatorName}
                </span>
              </div>
            </div>
            <div className={styles.creatorActions}>
              <span className={styles.faintText}>
                My timezone: {timezone}
              </span>
              <DiscordLinkButton
                scheduleId={schedule._id}
                profileId={profile?._id ?? null}
                anonymousId={isAuthenticated ? undefined : anonymousId || undefined}
                isCreator={!!isCreator}
              />
              {isCreator && (
                <button
                  onClick={() => setShowEditModal(true)}
                  className={styles.buttonSecondarySmall}
                >
                  Edit Schedule
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Editing another user banner */}
        {editingProfileId && (() => {
          const editingUser = (schedule.profiles || []).find(
            (p: any) => p._id === editingProfileId
          );
          return editingUser ? (
            <div className={cx(styles.panel, styles.panelWarning, styles.spaceBottomMedium)}>
              <p className={styles.warningText}>
                You are editing <strong>{editingUser.displayName}</strong>&apos;s availability.{" "}
                <button
                  onClick={handleStopEditingParticipant}
                  className={styles.warningTextButton}
                >
                  Stop editing
                </button>
              </p>
            </div>
          ) : null;
        })()}

        {/* Participation closed banner (non-creators) */}
        {!isCreator && schedule.acceptParticipation === false && (
          <div className={cx(styles.panel, styles.panelDanger, styles.spaceBottomMedium)}>
            <p className={styles.errorText}>
              The creator has closed participation for this schedule. You cannot make changes to your availability.
            </p>
          </div>
        )}

        {/* Blocked user banner */}
        {!isCreator && profile && schedule.blockedProfileIds?.includes(profile._id as string) && (
          <div className={cx(styles.panel, styles.panelDanger, styles.spaceBottomMedium)}>
            <p className={styles.errorText}>
              You have been blocked from participating in this schedule.
            </p>
          </div>
        )}

        {/* Non-current week banner for recurring schedules */}
        {schedule.type === "recurring" && weekOffset !== 0 && (
          <div className={cx(styles.panel, styles.panelWarning, styles.spaceBottomMedium)}>
            <p className={styles.warningText}>
              Nomination changes made on non-current weeks are one-off exceptions.{" "}
              <button
                onClick={() => setWeekOffset(0)}
                className={styles.warningTextButton}
              >
                Click 'Today'
              </button>{" "}
              to update nominations for recurring weeks.
            </p>
          </div>
        )}

        {/* Anonymous user prompt */}
        {!canInteract && !isAuthenticated && !isBlocked && !isParticipationClosed && (
          <DisplayNamePrompt
            currentName={displayName}
            onSubmit={handleDisplayNameSubmit}
          />
        )}

        {/* Controls bar */}
        <div className={styles.toolbar}>
          {/* Apply mode / Select mode */}
          <div className={styles.inlineClusterTight}>
            <label className={styles.calendarLabel}>Apply:</label>
            {isCreator && creatorMode === "limit" ? (
              <select
                value={allowMode}
                onChange={(e) => setAllowMode(e.target.value as AllowMode)}
                className={styles.selectControl}
              >
                <option value="auto">Auto</option>
                <option value="allow">Allow</option>
                <option value="dont-allow">Don&apos;t Allow</option>
              </select>
            ) : (
              <select
                value={selectMode}
                onChange={(e) => setSelectMode(e.target.value as SelectMode)}
                className={styles.selectControl}
              >
                <option value="auto">Auto</option>
                <option value="can-do">Can Do</option>
                <option value="cant-do">Can&apos;t Do</option>
                <option value="maybe">Maybe</option>
                <option value="blank">Clear</option>
              </select>
            )}
          </div>

          {/* Legend */}
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={cx(styles.legendSwatch, styles.canDoSwatch)}></span>
              Can Do
            </span>
            <span className={styles.legendItem}>
              <span className={cx(styles.legendSwatch, styles.cantDoSwatch)}></span>
              Can&apos;t Do
            </span>
            <span className={styles.legendItem}>
              <span className={cx(styles.legendSwatch, styles.maybeSwatch)}></span>
              Maybe
            </span>
          </div>

          {/* Creator mode buttons (radio-style) */}
          {isCreator && (
            <div className={cx(styles.inlineClusterTight, styles.toolbarSpacer)}>
              <button
                onClick={() => setCreatorMode("limit")}
                className={cx(
                  styles.modeButton,
                  creatorMode === "limit"
                    ? cx(styles.modeButtonActive, styles.modeLimitActive)
                    : undefined,
                )}
              >
                Allow/Disallow Time
              </button>
              <button
                onClick={() => setCreatorMode("nominate")}
                className={cx(
                  styles.modeButton,
                  creatorMode === "nominate"
                    ? cx(styles.modeButtonActive, styles.modeNominateActive)
                    : undefined,
                )}
              >
                Nominate Time
              </button>
              <button
                onClick={() => setCreatorMode("lock")}
                className={cx(
                  styles.modeButton,
                  creatorMode === "lock"
                    ? cx(styles.modeButtonActive, styles.modeLockActive)
                    : undefined,
                )}
              >
                Lock In Time
              </button>
              {creatorMode === "nominate" && (
                <button
                  onClick={handleDisallowOutsideNominations}
                  className={styles.modeButtonWarning}
                  title="Mark all times without 'Can Do' or 'Maybe' nominations as disallowed"
                >
                  Disallow Outside Nominations
                </button>
              )}
            </div>
          )}

          {/* Lock In Time toggle for non-creator lock editors */}
          {!isCreator && canLock && (
            <button
              onClick={() => setCreatorMode(creatorMode === "lock" ? null : "lock")}
              className={cx(
                styles.modeButton,
                styles.toolbarSpacer,
                creatorMode === "lock"
                  ? cx(styles.modeButtonActive, styles.modeLockActive)
                  : undefined,
              )}
            >
              Lock In Time
            </button>
          )}

          {/* Accept Participation toggle (creator only) */}
          {isCreator && schedule && (
            <div className={styles.toggleRow}>
              <label className={styles.calendarLabel}>
                Accept Participation:
              </label>
              <button
                onClick={() =>
                  handleToggleAcceptParticipation(
                    schedule.acceptParticipation === false
                  )
                }
                className={cx(
                  styles.toggle,
                  schedule.acceptParticipation !== false && styles.toggleOn,
                )}
                title={
                  schedule.acceptParticipation !== false
                    ? "Participation is open. Click to close."
                    : "Participation is closed. Click to open."
                }
              >
                <span
                  className={cx(
                    styles.toggleKnob,
                    schedule.acceptParticipation !== false && styles.toggleKnobOn,
                  )}
                />
              </button>
            </div>
          )}

          {/* Anyone Can Lock toggle (creator only) */}
          {isCreator && schedule && (
            <div className={styles.toggleRow}>
              <label className={styles.calendarLabel}>
                Anyone Can Lock:
              </label>
              <button
                onClick={() =>
                  handleToggleAnyoneCanLock(!schedule.anyoneCanLock)
                }
                className={cx(
                  styles.toggle,
                  schedule.anyoneCanLock && styles.togglePurpleOn,
                )}
                title={
                  schedule.anyoneCanLock
                    ? "Anyone can lock in times. Click to restrict."
                    : "Only the creator and promoted users can lock in times. Click to allow anyone."
                }
              >
                <span
                  className={cx(
                    styles.toggleKnob,
                    schedule.anyoneCanLock && styles.toggleKnobOn,
                  )}
                />
              </button>
            </div>
          )}

          {/* Participants menu (creator only) */}
          {isCreator && schedule && (() => {
            // Get participants (profiles that have selections, excluding creator)
            const participantProfiles = (schedule.profiles || []).filter(
              (p: any) => p._id !== schedule.creatorProfileId
            );
            return participantProfiles.length > 0 ? (
              <ParticipantsMenu
                participants={participantProfiles}
                availabilityLinks={schedule.availabilityLinks || []}
                lockEditors={(schedule.lockEditors as string[] | undefined) || []}
                editingProfileId={editingProfileId}
                onEditUser={handleEditParticipant}
                onStopEditing={handleStopEditingParticipant}
                onDeleteUser={handleDeleteParticipant}
                onBlockUser={handleBlockParticipant}
                onPromoteLockEditor={handlePromoteLockEditor}
                onDemoteLockEditor={handleDemoteLockEditor}
              />
            ) : null;
          })()}

          {/* Availabilities menu (SSO users only) */}
          {isSsoUser && profile && canInteract && (
            <AvailabilitiesMenu
              scheduleType={schedule.type}
              weekOffset={weekOffset}
              isSsoUser={!!isSsoUser}
              profileId={profile._id}
              savedAvailabilities={savedAvailabilities ?? []}
              currentLink={currentLink}
              onApply={handleApply}
              onSaveOverwriteDefault={handleSaveOverwriteDefault}
              onSaveNew={() => setShowSaveNewModal(true)}
              onUnlink={handleUnlink}
              onManage={() => setShowManageModal(true)}
            />
          )}

          {/* Clear button */}
          {canInteract && (
            <button
              onClick={() => setShowClearModal(true)}
              className={styles.modeButtonDanger}
            >
              Clear
            </button>
          )}

          {/* Week navigation */}
          <div className={cx(styles.inlineClusterTight, styles.toolbarSpacer)}>
            <button
              onClick={handleWeekBack}
              disabled={!canGoBack()}
              className={styles.navButton}
              title="Previous week"
            >
              &larr;
            </button>
            <span className={styles.weekRange}>
              {(() => {
                const weekDates = getWeekDates(referenceDate, weekStartDay);
                return `${weekDates[0].toFormat("MMM d")} – ${weekDates[6].toFormat("MMM d, yyyy")}`;
              })()}
            </span>
            <button
              onClick={handleWeekForward}
              disabled={!canGoForward()}
              className={styles.navButton}
              title="Next week"
            >
              &rarr;
            </button>
            {weekOffset !== 0 && (
              <button
                onClick={() => setWeekOffset(0)}
                className={styles.linkButton}
              >
                Today
              </button>
            )}
          </div>
        </div>

        {/* The Grid */}
        <WeeklyGrid
          schedule={schedule}
          profileId={effectiveProfileId}
          userTimezone={timezone}
          weekStartDay={weekStartDay}
          selectMode={selectMode}
          allowMode={allowMode}
          weekOffset={weekOffset}
          canInteract={canInteract || !!editingProfileId}
          isCreator={!!isCreator}
          canLock={!!canLock}
          creatorMode={editingProfileId ? "nominate" : creatorMode}
          onCellChange={handleCellChange}
          onBatchChange={handleBatchChange}
          onCreatorSlotChange={handleCreatorSlotChange}
        />
      </main>

      {/* Clear confirmation modal */}
      {showClearModal && (() => {
        const { title, message } = getClearModalContent();
        return (
          <ClearConfirmModal
            title={title}
            message={message}
            onConfirm={handleClear}
            onClose={() => setShowClearModal(false)}
          />
        );
      })()}

      {/* Apply availability modal */}
      {showApplyModal && savedAvailabilities && (
        <ApplyAvailabilityModal
          savedAvailabilities={savedAvailabilities}
          onApply={handleApplyFromModal}
          onManage={() => {
            setShowApplyModal(false);
            setShowManageModal(true);
          }}
          onClose={() => setShowApplyModal(false)}
        />
      )}

      {/* Save new availability modal */}
      {showSaveNewModal && (
        <SaveAvailabilityModal
          onSave={handleSaveNew}
          onClose={() => setShowSaveNewModal(false)}
        />
      )}

      {/* Manage saved availabilities modal */}
      {showManageModal && savedAvailabilities && (
        <ManageSavedAvailabilitiesModal
          savedAvailabilities={savedAvailabilities}
          onClose={() => setShowManageModal(false)}
        />
      )}

      {/* Edit schedule modal (creator only) */}
      {showEditModal && schedule && (
        <EditScheduleModal
          schedule={schedule}
          anonymousId={callerAnonymousId}
          onClose={() => setShowEditModal(false)}
        />
      )}
    </div>
  );
}
