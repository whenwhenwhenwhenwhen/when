import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { DateTime } from "luxon";
import { X } from "lucide-react";
import { cx } from "../lib/classes";
import { getTopScheduleWindows, type SummaryParticipant } from "../lib/scheduleSummary";
import { getWeekDates } from "../lib/timezone";
import { ParticipantIcon } from "./ParticipantIcon";
import styles from "../styles/app.module.css";

interface Props {
  schedule: Parameters<typeof getTopScheduleWindows>[0];
  referenceDate: DateTime;
  weekStartDay: number;
  onClose: () => void;
}

function formatWindowTime(start: DateTime, end: DateTime) {
  const timeFormat = start.offset !== end.offset ||
    start.getPossibleOffsets().length > 1 || end.getPossibleOffsets().length > 1
    ? DateTime.TIME_WITH_SHORT_OFFSET
    : DateTime.TIME_SIMPLE;
  const endTime = end.toLocaleString(timeFormat);
  const endLabel = start.hasSame(end, "day")
    ? endTime
    : `${end.toLocaleString(DateTime.DATE_MED_WITH_WEEKDAY)}, ${endTime}`;
  return `${start.toLocaleString(timeFormat)} – ${endLabel}`;
}

const responseLabels = { "cant-do": "Can’t Do", maybe: "Maybe", blank: "Blank" };

function ParticipantRow({ participant }: { participant: SummaryParticipant }) {
  const { profile, state } = participant;
  return (
    <li className={styles.inlineClusterTight}>
      <ParticipantIcon profile={profile} />
      <span>
        {profile.displayName}
        {state !== "can-do" && <small className={styles.smallText}> ({responseLabels[state]})</small>}
      </span>
    </li>
  );
}

function UnavailableCount({ participants }: { participants: SummaryParticipant[] }) {
  const id = useId();
  const anchorName = `--summary-${id.replace(/:/g, "")}`;
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  function cancelClose() {
    window.clearTimeout(closeTimer.current);
  }

  function closeAfterPointerLeaves(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    // Give the pointer time to cross the gap between the count and the list.
    closeTimer.current = window.setTimeout(() => {
      const popover = popoverRef.current;
      if (popover && !popover.contains(document.activeElement)) popover.hidePopover?.();
    }, 200);
  }

  return (
    <>
      <button
        type="button"
        className={styles.scheduleSummaryCount}
        style={{ anchorName }}
        popoverTarget={id}
        popoverTargetAction="show"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          cancelClose();
          popoverRef.current?.showPopover?.();
        }}
        onPointerLeave={closeAfterPointerLeaves}
      >
        {participants.length} {participants.length === 1 ? "person" : "people"} cannot/blank
      </button>
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        role="region"
        aria-label="Cannot or blank"
        tabIndex={0}
        className={styles.scheduleSummaryPopover}
        style={{ positionAnchor: anchorName }}
        onToggle={(event) => setOpen(event.newState === "open")}
        onPointerEnter={cancelClose}
        onPointerLeave={closeAfterPointerLeaves}
      >
        {open && (
          <ul className={cx(styles.bodyText, styles.scheduleSummaryParticipants)}>
            {participants.map((participant) => (
              <ParticipantRow key={participant.profile._id} participant={participant} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function ScheduleSummaryModal({ schedule, referenceDate, weekStartDay, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [includeMaybe, setIncludeMaybe] = useState(true);
  const windows = getTopScheduleWindows(schedule, referenceDate, weekStartDay, includeMaybe);
  const windowsByDay = new Map<string, typeof windows>();
  for (const window of windows.sort((a, b) => a.start.toMillis() - b.start.toMillis())) {
    const day = window.start.toISODate();
    if (!day) continue;
    const dayWindows = windowsByDay.get(day);
    if (dayWindows) dayWindows.push(window);
    else windowsByDay.set(day, [window]);
  }
  const countedVotes = includeMaybe ? "“Can Do” or “Maybe”" : "“Can Do”";
  const scope = schedule.type === "one-off"
    ? "All schedule dates"
    : `Week of ${getWeekDates(referenceDate, weekStartDay)[0].toLocaleString(DateTime.DATE_MED)}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  function dismiss() {
    dialogRef.current?.close();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className={cx(styles.modalPanelMd, styles.scheduleSummaryDialog)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
          dismiss();
        }
      }}
    >
      <div className={styles.modalHeader}>
        <h2 id={titleId} className={styles.modalTitle}>Schedule summary</h2>
        <button type="button" onClick={dismiss} className={styles.closeButton} aria-label="Close">
          <X className={styles.iconMd} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.stack}>
        <div className={styles.stackTight}>
          <p className={styles.mutedText}>{scope} · {referenceDate.zoneName}</p>
          <label className={styles.checkboxOption}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={includeMaybe}
              onChange={(event) => setIncludeMaybe(event.target.checked)}
            />
            Include Maybe
          </label>
          <p className={styles.bodyText}>
            {windows.length
              ? `Top two totals for ${countedVotes} votes, including ties.`
              : `No ${countedVotes} votes for this period yet.`}
          </p>
        </div>
        {windowsByDay.size > 0 && (
          <ul className={cx(styles.listStack, styles.scheduleSummaryList)}>
            {[...windowsByDay].map(([day, dayWindows]) => (
              <li key={day} className={styles.scheduleSummaryDay}>
                <h3 className={styles.sectionTitle}>
                  {dayWindows[0].start.toLocaleString(DateTime.DATE_MED_WITH_WEEKDAY)}
                </h3>
                <ul className={styles.scheduleSummaryList}>
                  {dayWindows.map(({ start, end, available, unavailable }) => (
                    <li key={start.toMillis()} className={cx(styles.scheduleSummaryWindow, styles.stackTight)}>
                      <h4 className={cx(styles.sectionTitle, styles.scheduleSummaryTime)}>{formatWindowTime(start, end)}</h4>
                      <div className={styles.bodyText}>
                        <strong>{available.length} {available.length === 1 ? "person" : "people"} {includeMaybe ? "can/maybe" : "can"}</strong>
                        {" ("}{unavailable.length > 0 ? <UnavailableCount participants={unavailable} /> : "0 people cannot/blank"}{")"}
                      </div>
                      <ul aria-label={includeMaybe ? "Can Do or Maybe" : "Can Do"} className={cx(styles.bodyText, styles.scheduleSummaryParticipants)}>
                        {available.map((participant) => (
                          <ParticipantRow key={participant.profile._id} participant={participant} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
