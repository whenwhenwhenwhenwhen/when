import { useState, useRef, useEffect } from "react";
import { Id } from "../../convex/_generated/dataModel";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface SavedAvailability {
  _id: Id<"savedAvailabilities">;
  name: string;
  isDefault?: boolean;
}

interface AvailabilityLink {
  profileId: string;
  savedAvailabilityId: string;
  savedAvailabilityName: string;
}

interface Props {
  scheduleType: "one-off" | "recurring";
  weekOffset: number;
  isSsoUser: boolean;
  profileId: Id<"userProfiles"> | null;
  savedAvailabilities: SavedAvailability[];
  currentLink: AvailabilityLink | null;
  onApply: (savedAvailabilityId: Id<"savedAvailabilities">) => void;
  onSaveOverwriteDefault: () => void;
  onSaveNew: () => void;
  onUnlink: () => void;
  onManage: () => void;
}

export function AvailabilitiesMenu({
  scheduleType,
  weekOffset,
  isSsoUser,
  profileId,
  savedAvailabilities,
  currentLink,
  onApply,
  onSaveOverwriteDefault,
  onSaveNew,
  onUnlink,
  onManage,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  if (!isSsoUser || !profileId) return null;

  const isLinked = !!currentLink;
  const isOneOff = scheduleType === "one-off";
  const isNonCurrentWeek = scheduleType === "recurring" && weekOffset !== 0;
  const hasNoSavedAvailabilities = savedAvailabilities.length === 0;

  let buttonLabel = "Availabilities";
  let buttonTitle = "Manage saved availabilities";
  let buttonStateClass = "";

  if (isNonCurrentWeek) {
    buttonStateClass = styles.menuButtonDisabled;
    buttonTitle =
      "Making one-off nominations to a reoccurring schedule are not saved to your saved availability.";
    buttonLabel = isLinked ? currentLink.savedAvailabilityName : "Availabilities";
  } else if (isLinked) {
    buttonStateClass = styles.menuButtonActive;
    buttonLabel = currentLink.savedAvailabilityName;
    buttonTitle = `Current availability is linked to ${currentLink.savedAvailabilityName}. Any changes made will be automatically applied to your saved availability.`;
  }

  // Determine disabled states and hover text for each option
  const applyDisabled = hasNoSavedAvailabilities;
  const applyTitle = hasNoSavedAvailabilities
    ? "No saved availabilities."
    : "Apply a saved availability to this schedule";

  const saveDisabled = isOneOff;
  const saveTitle = isOneOff
    ? "Cannot save availability for one-off event"
    : "Save current nominations as your default availability";

  const saveNewDisabled = isOneOff;
  const saveNewTitle = isOneOff
    ? "Cannot save availability for one-off event"
    : "Save current nominations as a new named availability";

  const unlinkDisabled = !isLinked;
  const unlinkTitle = !isLinked
    ? "No saved availability applied. Nothing to unlink."
    : "Unlinking means any changes you make in this schedule will not be saved to the saved availability anymore.";

  const handleApplyClick = () => {
    if (applyDisabled) return;
    if (savedAvailabilities.length === 1) {
      // Apply directly
      onApply(savedAvailabilities[0]._id);
      setIsOpen(false);
    } else {
      // Open modal for selection
      onApply(null as any); // Signal to parent to open modal
      setIsOpen(false);
    }
  };

  return (
    <div className={styles.menuWrapper} ref={menuRef}>
      <button
        onClick={() => !isNonCurrentWeek && setIsOpen(!isOpen)}
        className={cx(styles.menuButton, buttonStateClass)}
        title={buttonTitle}
      >
        {buttonLabel}
        {!isNonCurrentWeek && (
          <svg
            className={styles.iconXs}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        )}
      </button>

      {isOpen && !isNonCurrentWeek && (
        <div className={styles.menuDropdown}>
          {/* Apply */}
          <button
            onClick={handleApplyClick}
            disabled={applyDisabled}
            className={applyDisabled ? styles.menuItemDisabled : styles.menuItem}
            title={applyTitle}
          >
            Apply saved availability...
          </button>

          <div className={styles.menuDivider} />

          {/* Save/overwrite default */}
          <button
            onClick={() => {
              if (!saveDisabled) {
                onSaveOverwriteDefault();
                setIsOpen(false);
              }
            }}
            disabled={saveDisabled}
            className={saveDisabled ? styles.menuItemDisabled : styles.menuItem}
            title={saveTitle}
          >
            Save/overwrite and link default availability
          </button>

          {/* Save new */}
          <button
            onClick={() => {
              if (!saveNewDisabled) {
                onSaveNew();
                setIsOpen(false);
              }
            }}
            disabled={saveNewDisabled}
            className={saveNewDisabled ? styles.menuItemDisabled : styles.menuItem}
            title={saveNewTitle}
          >
            Save and link new availability...
          </button>

          <div className={styles.menuDivider} />

          {/* Unlink */}
          <button
            onClick={() => {
              if (!unlinkDisabled) {
                onUnlink();
                setIsOpen(false);
              }
            }}
            disabled={unlinkDisabled}
            className={unlinkDisabled ? styles.menuItemDisabled : styles.menuItem}
            title={unlinkTitle}
          >
            Unlink from saved
          </button>

          {/* Manage link */}
          {savedAvailabilities.length > 0 && (
            <>
              <div className={styles.menuDivider} />
              <button
                onClick={() => {
                  onManage();
                  setIsOpen(false);
                }}
                className={cx(styles.menuItem, styles.accentText)}
              >
                Manage saved availabilities
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
