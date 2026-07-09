import { useState } from "react";
import { Id } from "../../convex/_generated/dataModel";
import styles from "../styles/app.module.css";

interface SavedAvailability {
  _id: Id<"savedAvailabilities">;
  name: string;
  isDefault?: boolean;
}

interface Props {
  savedAvailabilities: SavedAvailability[];
  onApply: (savedAvailabilityId: Id<"savedAvailabilities">) => Promise<void>;
  onManage: () => void;
  onClose: () => void;
}

export function ApplyAvailabilityModal({
  savedAvailabilities,
  onApply,
  onManage,
  onClose,
}: Props) {
  const [selectedId, setSelectedId] = useState<Id<"savedAvailabilities"> | "">(
    savedAvailabilities.length > 0 ? savedAvailabilities[0]._id : ""
  );
  const [applying, setApplying] = useState(false);

  const handleApply = async () => {
    if (!selectedId) return;
    setApplying(true);
    try {
      await onApply(selectedId as Id<"savedAvailabilities">);
      onClose();
    } catch (err) {
      console.error("Failed to apply availability:", err);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className={styles.modalBackdrop}
      onClick={onClose}
    >
      <div
        className={styles.modalPanelSm}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>
            Apply Saved Availability
          </h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <p className={styles.bodyText}>
          Choose which saved availability to apply to this schedule. Your
          current nominations will be replaced.
        </p>

        <select
          value={selectedId}
          onChange={(e) =>
            setSelectedId(e.target.value as Id<"savedAvailabilities">)
          }
          className={styles.control}
        >
          {savedAvailabilities.map((sa) => (
            <option key={sa._id} value={sa._id}>
              {sa.name}
              {sa.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>

        <div className={styles.modalActionsSplit}>
          <button
            onClick={() => {
              onClose();
              onManage();
            }}
            className={styles.linkButton}
          >
            Manage saved availabilities
          </button>

          <div className={styles.modalActions}>
            <button
              onClick={onClose}
              className={styles.buttonPlain}
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={applying || !selectedId}
              className={styles.buttonPrimary}
            >
              {applying ? "Applying..." : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
