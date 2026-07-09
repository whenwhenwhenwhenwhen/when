import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { useTimezone } from "../hooks/useTimezone";
import { useNavigate } from "react-router";
import { detectTimezone } from "../lib/timezone";
import styles from "../styles/app.module.css";

interface Props {
  onClose: () => void;
}

export function CreateScheduleModal({ onClose }: Props) {
  const navigate = useNavigate();
  const { anonymousId, displayName, setDisplayName } = useAnonymousUser();
  const { timezone } = useTimezone();

  const profile = useQuery(api.users.currentUserProfile, {
    anonymousId: anonymousId || undefined,
  });

  const createSchedule = useMutation(api.schedules.create);
  const getOrCreateProfile = useMutation(api.users.getOrCreateAnonymousProfile);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"one-off" | "recurring">("recurring");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [recurringStartDate, setRecurringStartDate] = useState("");
  const [creatorName, setCreatorName] = useState(displayName || "");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (type === "one-off" && (!dateStart || !dateEnd)) return;

    setIsSubmitting(true);

    try {
      // Ensure we have a profile
      let profileId = profile?._id;
      if (!profileId) {
        const name = creatorName.trim() || "Anonymous";
        profileId = await getOrCreateProfile({
          anonymousId,
          displayName: name,
          timezone: timezone || detectTimezone(),
        });
        if (name !== displayName) {
          setDisplayName(name);
        }
      }

      const scheduleId = await createSchedule({
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        creatorProfileId: profileId,
        anonymousId: anonymousId || undefined,
        dateRangeStart: type === "one-off" ? dateStart : undefined,
        dateRangeEnd: type === "one-off" ? dateEnd : undefined,
        recurringStartDate: type === "recurring" && recurringStartDate ? recurringStartDate : undefined,
        creatorTimezone: timezone || detectTimezone(),
        isPrivate: isPrivate || undefined,
      });

      navigate(`/schedule/${scheduleId}`);
    } catch (err) {
      console.error("Failed to create schedule:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop}>
      <div className={styles.modalPanelMd}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Create Schedule</h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className={styles.formStack}>
          {/* Display name for anonymous users */}
          {!profile && (
            <div>
              <label className={styles.fieldLabel}>
                Your Display Name
              </label>
              <input
                type="text"
                value={creatorName}
                onChange={(e) => setCreatorName(e.target.value)}
                placeholder="Enter your name"
                className={styles.control}
                required
              />
            </div>
          )}

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
              <label className={styles.radioOption}>
                <input
                  type="radio"
                  name="type"
                  value="one-off"
                  checked={type === "one-off"}
                  onChange={() => setType("one-off")}
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
          </div>

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
                id="is-private"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className={styles.checkbox}
              />
              <label htmlFor="is-private" className={styles.checkboxOption}>
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

          <div className={styles.faintText}>
            My timezone: {timezone}. Others will see schedules in their own timezone.
          </div>

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
              disabled={isSubmitting}
              className={styles.buttonPrimary}
            >
              {isSubmitting ? "Creating..." : "Create Schedule"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
