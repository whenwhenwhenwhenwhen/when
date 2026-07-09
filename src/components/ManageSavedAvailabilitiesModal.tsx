import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface SavedAvailability {
  _id: Id<"savedAvailabilities">;
  name: string;
  isDefault?: boolean;
  slots: { dayKey: string; timeSlot: string; state: string }[];
}

interface Props {
  savedAvailabilities: SavedAvailability[];
  onClose: () => void;
}

export function ManageSavedAvailabilitiesModal({
  savedAvailabilities,
  onClose,
}: Props) {
  const renameMut = useMutation(api.savedAvailabilities.renameSaved);
  const deleteMut = useMutation(api.savedAvailabilities.deleteSaved);

  const [editingId, setEditingId] = useState<Id<"savedAvailabilities"> | null>(
    null
  );
  const [editName, setEditName] = useState("");
  const [deletingId, setDeletingId] = useState<Id<"savedAvailabilities"> | null>(
    null
  );

  const handleRename = async (id: Id<"savedAvailabilities">) => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    try {
      await renameMut({ savedAvailabilityId: id, name: trimmed });
      setEditingId(null);
    } catch (err) {
      console.error("Failed to rename:", err);
    }
  };

  const handleDelete = async (id: Id<"savedAvailabilities">) => {
    try {
      await deleteMut({ savedAvailabilityId: id });
      setDeletingId(null);
    } catch (err) {
      console.error("Failed to delete:", err);
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
            Manage Saved Availabilities
          </h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        {savedAvailabilities.length === 0 ? (
          <p className={styles.emptyState}>
            No saved availabilities yet.
          </p>
        ) : (
          <div className={cx(styles.listStack, styles.scrollAreaMedium)}>
            {savedAvailabilities.map((sa) => (
              <div
                key={sa._id}
                className={styles.savedAvailabilityItem}
              >
                {editingId === sa._id ? (
                  <div className={styles.fieldRow}>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={cx(styles.controlCompact, styles.flexGrow)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(sa._id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <button
                      onClick={() => handleRename(sa._id)}
                      className={styles.buttonPrimarySmall}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className={styles.buttonPlain}
                    >
                      Cancel
                    </button>
                  </div>
                ) : deletingId === sa._id ? (
                  <div>
                    <p className={styles.errorText}>
                      Delete &ldquo;{sa.name}&rdquo;? Any linked schedules will
                      keep their current nominations but will be unlinked.
                    </p>
                    <div className={styles.fieldRow}>
                      <button
                        onClick={() => handleDelete(sa._id)}
                        className={styles.buttonDangerSmall}
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className={styles.buttonPlain}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.itemHeader}>
                    <div>
                      <span className={styles.cardTitle}>
                        {sa.name}
                      </span>
                      {sa.isDefault && (
                        <span className={styles.miniBadge}>
                          default
                        </span>
                      )}
                      <span className={styles.miniBadge}>
                        {sa.slots.length} slot{sa.slots.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className={styles.itemActions}>
                      <button
                        onClick={() => {
                          setEditingId(sa._id);
                          setEditName(sa.name);
                          setDeletingId(null);
                        }}
                        className={styles.ghostButton}
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => {
                          setDeletingId(sa._id);
                          setEditingId(null);
                        }}
                        className={cx(styles.ghostButton, styles.dangerTextButton)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className={styles.modalFooter}>
          <button
            onClick={onClose}
            className={styles.buttonPlain}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
