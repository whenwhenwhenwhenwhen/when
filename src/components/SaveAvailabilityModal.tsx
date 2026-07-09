import { useState } from "react";
import styles from "../styles/app.module.css";

interface Props {
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

export function SaveAvailabilityModal({ onSave, onClose }: Props) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      console.error("Failed to save availability:", err);
    } finally {
      setSaving(false);
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
            Save New Availability
          </h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <p className={styles.bodyText}>
          Give your saved availability a name. Your current nominations will be
          saved and linked to this schedule.
        </p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekday evenings, Weekend mornings..."
          className={styles.control}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
        />

        <div className={styles.modalFooter}>
          <button
            onClick={onClose}
            className={styles.buttonPlain}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className={styles.buttonPrimary}
          >
            {saving ? "Saving..." : "Save & Link"}
          </button>
        </div>
      </div>
    </div>
  );
}
