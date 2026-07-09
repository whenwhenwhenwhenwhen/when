import { createContext, useState, useCallback, useRef } from "react";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "error";
}

export interface ToastContextType {
  showToast: (message: string, type?: "info" | "success" | "error", duration?: number) => string;
  updateToast: (id: string, updates: { message?: string; type?: "info" | "success" | "error"; duration?: number }) => void;
  dismissToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextType>({
  showToast: () => "",
  updateToast: () => {},
  dismissToast: () => {},
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const startTimer = useCallback((id: string, duration: number) => {
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    if (duration > 0) {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
      timersRef.current.set(id, timer);
    }
  }, []);

  const showToast = useCallback(
    (message: string, type: "info" | "success" | "error" = "info", duration = 5000) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      startTimer(id, duration);
      return id;
    },
    [startTimer],
  );

  const updateToast = useCallback(
    (id: string, updates: { message?: string; type?: "info" | "success" | "error"; duration?: number }) => {
      setToasts((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, ...(updates.message !== undefined && { message: updates.message }), ...(updates.type !== undefined && { type: updates.type }) }
            : t,
        ),
      );
      if (updates.duration !== undefined) {
        startTimer(id, updates.duration);
      }
    },
    [startTimer],
  );

  const toastTypeClass = (type: Toast["type"]) => {
    if (type === "success") return styles.toastSuccess;
    if (type === "error") return styles.toastError;
    return styles.toastInfo;
  };

  return (
    <ToastContext.Provider value={{ showToast, updateToast, dismissToast }}>
      {children}
      <div className={styles.toastStack}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(styles.toast, toastTypeClass(toast.type))}
          >
            <span className={styles.toastMessage}>{toast.message}</span>
            <button
              onClick={() => dismissToast(toast.id)}
              className={styles.closeButton}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
