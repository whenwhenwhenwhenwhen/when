import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useNavigate } from "react-router";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Schedule {
  _id: Id<"schedules">;
  title: string;
  description?: string;
  type: "one-off" | "recurring";
  dateRangeStart?: string;
  dateRangeEnd?: string;
  recurringStartDate?: string;
  isPrivate?: boolean;
}

interface Props {
  schedule: Schedule;
  anonymousId?: string;
  onClose: () => void;
}

export function EditScheduleModal({ schedule, anonymousId, onClose }: Props) {
  const navigate = useNavigate();
  const updateSchedule = useMutation(api.schedules.update);
  const removeSchedule = useMutation(api.schedules.remove);
  const unblockParticipant = useMutation(api.schedules.unblockParticipant);

  // Load blocked profiles
  const blockedProfiles = useQuery(api.schedules.getBlockedProfiles, {
    scheduleId: schedule._id,
    anonymousId,
  });

  const [title, setTitle] = useState(schedule.title);
  const [description, setDescription] = useState(schedule.description || "");
  const [type, setType] = useState<"one-off" | "recurring">(schedule.type);
  const [dateStart, setDateStart] = useState(schedule.dateRangeStart || "");
  const [dateEnd, setDateEnd] = useState(schedule.dateRangeEnd || "");
  const [recurringStartDate, setRecurringStartDate] = useState(
    schedule.recurringStartDate || ""
  );
  const [isPrivate, setIsPrivate] = useState(schedule.isPrivate || false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isRecurringOriginal = schedule.type === "recurring";
  const isTypeChanged = type !== schedule.type;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (type === "one-off" && (!dateStart || !dateEnd)) return;

    setIsSubmitting(true);
    try {
      await updateSchedule({
        scheduleId: schedule._id,
        anonymousId,
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        dateRangeStart: type === "one-off" ? dateStart : undefined,
        dateRangeEnd: type === "one-off" ? dateEnd : undefined,
        recurringStartDate:
          type === "recurring" && recurringStartDate
            ? recurringStartDate
            : undefined,
        isPrivate,
      });
      onClose();
    } catch (err) {
      console.error("Failed to update schedule:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setIsSubmitting(true);
    try {
      await removeSchedule({ scheduleId: schedule._id, anonymousId });
      navigate("/");
    } catch (err) {
      console.error("Failed to delete schedule:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={styles.modalBackdrop}
      onClick={onClose}
    >
      <div
        className={styles.modalPanelMd}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>
            Edit Schedule
          </h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className={styles.formStack}>
          <div>
            <label className={styles.fieldLabel}>
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Friday Game Night"
              className={styles.control}
              required
            />
          </div>

          <div>
            <label className={styles.fieldLabel}>
              Description{" "}
              <span className={styles.optionalText}>(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this schedule for?"
              rows={2}
              className={styles.textarea}
            />
          </div>

          <div>
            <label className={styles.fieldLabel}>
              Type
            </label>
            <div className={styles.radioGroup}>
              <label
                className={cx(
                  styles.radioOption,
                  isRecurringOriginal && styles.disabledOption,
                )}
              >
                <input
                  type="radio"
                  name="type"
                  value="one-off"
                  checked={type === "one-off"}
                  onChange={() => setType("one-off")}
                  disabled={isRecurringOriginal}
                  className={styles.radio}
                />
                <span>One-off</span>
              </label>
              <label className={styles.radioOption}>
                <input
                  type="radio"
                  name="type"
                  value="recurring"
                  checked={type === "recurring"}
                  onChange={() => setType("recurring")}
                  className={styles.radio}
                />
                <span>Recurring (weekly)</span>
              </label>
            </div>
            {isRecurringOriginal && (
              <p className={styles.faintText}>
                Recurring schedules cannot be changed to one-off.
              </p>
            )}
          </div>

          {/* Type change warning */}
          {isTypeChanged && !isRecurringOriginal && (
            <div className={cx(styles.panel, styles.panelWarning)}>
              <p className={styles.warningText}>
                Converting to recurring will:
              </p>
              <ul className={styles.faintText}>
                <li>
                  Convert all nominations from date-specific to weekly
                  day-of-week (e.g. &ldquo;April 24&rdquo; becomes
                  &ldquo;every Friday&rdquo;)
                </li>
                <li>
                  If multiple weeks had different nominations for the same
                  day/time, the most recent week&apos;s choice is kept
                </li>
                <li>
                  Convert allow/disallow and locked time settings the same way
                </li>
                <li>Remove the date range restriction</li>
              </ul>
              <p className={styles.faintText}>
                This cannot be undone, but all existing data will be preserved
                in the new recurring format.
              </p>
            </div>
          )}

          {type === "one-off" && (
            <div className={styles.gridTwo}>
              <div>
                <label className={styles.fieldLabel}>
                  Start Date
                </label>
                <input
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  className={styles.control}
                  required
                />
              </div>
              <div>
                <label className={styles.fieldLabel}>
                  End Date
                </label>
                <input
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  min={dateStart}
                  className={styles.control}
                  required
                />
              </div>
            </div>
          )}

          {type === "recurring" && (
            <div>
              <label className={styles.fieldLabel}>
                Start Date{" "}
                <span className={styles.optionalText}>(optional)</span>
              </label>
              <input
                type="date"
                value={recurringStartDate}
                onChange={(e) => setRecurringStartDate(e.target.value)}
                className={styles.control}
              />
            </div>
          )}

          <div>
            <div className={styles.checkboxRow}>
              <input
                type="checkbox"
                id="edit-is-private"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className={styles.checkbox}
              />
              <label
                htmlFor="edit-is-private"
                className={styles.checkboxOption}
              >
                Unlisted schedule
              </label>
            </div>
            {isPrivate && (
              <p className={styles.helperText}>
                Unlisted schedules are hidden from the public list but can still
                be viewed by anyone with the link.
              </p>
            )}
          </div>

          {/* Blocked users section */}
          {blockedProfiles && blockedProfiles.length > 0 && (
            <div className={styles.dividerTop}>
              <h3 className={styles.sectionTitle}>
                Blocked Users
              </h3>
              <p className={styles.smallText}>
                Blocked users cannot enter availability for this schedule. Unblock to allow them to participate again.
              </p>
              <div className={styles.listStack}>
                {blockedProfiles.map((blocked) => (
                  <div
                    key={blocked._id}
                    className={cx(styles.panel, styles.panelMuted, styles.itemHeader)}
                  >
                    <div className={styles.inlineClusterTight}>
                      {blocked.profileImageUrl ? (
                        <img
                          src={blocked.profileImageUrl}
                          alt=""
                          className={styles.avatarXs}
                        />
                      ) : (
                        <div className={styles.avatarFallback}>
                          {blocked.displayName.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className={styles.smallText}>
                        {blocked.displayName}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await unblockParticipant({
                          scheduleId: schedule._id,
                          anonymousId,
                          profileId: blocked.profileId,
                        });
                      }}
                      className={styles.buttonSecondarySmall}
                    >
                      Unblock
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Delete section */}
          <div className={styles.dividerTop}>
            {!showDeleteConfirm ? (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className={styles.buttonDangerSmall}
              >
                Delete Schedule
              </button>
            ) : (
              <div className={cx(styles.panel, styles.panelDanger)}>
                <p className={styles.errorText}>
                  Are you sure? This will permanently delete &ldquo;
                  {schedule.title}&rdquo; and all nominations, settings, and
                  linked availabilities. This cannot be undone.
                </p>
                <div className={styles.fieldRow}>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className={cx(styles.buttonSecondary, styles.flexGrow)}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isSubmitting}
                    className={cx(styles.buttonDanger, styles.flexGrow)}
                  >
                    {isSubmitting ? "Deleting..." : "Delete Forever"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer buttons */}
          <div className={styles.modalFooter}>
            <button
              type="button"
              onClick={onClose}
              className={styles.buttonPlain}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim()}
              className={styles.buttonPrimary}
            >
              {isSubmitting ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
