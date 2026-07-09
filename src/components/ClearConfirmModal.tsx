import { useState } from "react";
import styles from "../styles/app.module.css";

interface Props {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ClearConfirmModal({ title, message, onConfirm, onClose }: Props) {
  const [clearing, setClearing] = useState(false);

  const handleConfirm = async () => {
    setClearing(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      console.error("Failed to clear:", err);
    } finally {
      setClearing(false);
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
          <h2 className={styles.modalTitle}>{title}</h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <p className={styles.bodyText}>{message}</p>

        <div className={styles.modalFooter}>
          <button
            onClick={onClose}
            className={styles.buttonPlain}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={clearing}
            className={styles.buttonDanger}
          >
            {clearing ? "Clearing..." : "Clear"}
          </button>
        </div>
      </div>
    </div>
  );
}
