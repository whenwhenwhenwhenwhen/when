import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { nominationLabels, type NominationState } from "./NominationDetails";
import styles from "../styles/app.module.css";

export const availabilityActions = [
  { state: "can-do", key: "A", label: nominationLabels["can-do"] },
  { state: "cant-do", key: "S", label: nominationLabels["cant-do"] },
  { state: "maybe", key: "D", label: nominationLabels.maybe },
  { state: "blank", key: "F", label: "Blank" },
] as const;

export type AvailabilityState = NominationState | "blank";

interface Props {
  startCell: HTMLTableCellElement;
  endCell: HTMLTableCellElement;
  container: HTMLDivElement;
  count: number;
  disallowCantDo?: boolean;
  onApply: (state: AvailabilityState) => void;
  onDismiss: () => void;
}

export function AvailabilitySelectionToolbar({
  startCell, endCell, container, count, disallowCantDo, onApply, onDismiss,
}: Props) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const reposition = () => {
      const toolbar = toolbarRef.current;
      if (!toolbar || !startCell || !endCell || !container) return;
      const first = startCell.getBoundingClientRect();
      const last = endCell.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      const popup = toolbar.getBoundingClientRect();
      const left = Math.max(first.left, viewport.left, 8);
      const right = Math.min(last.right, viewport.right, window.innerWidth - 8);
      const top = Math.max(first.top, viewport.top, 8);
      const bottom = Math.min(last.bottom, viewport.bottom, window.innerHeight - 8);
      if (left >= right || top >= bottom) {
        setPosition(null);
        return;
      }
      setPosition({
        left: Math.max(8, Math.min(right - popup.width, window.innerWidth - popup.width - 8)),
        top: Math.max(8, Math.min(top - popup.height - 6 >= viewport.top
          ? top - popup.height - 6 : top + 6, window.innerHeight - popup.height - 8)),
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reposition);
    observer?.observe(container);
    if (toolbarRef.current) observer?.observe(toolbarRef.current);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [startCell, endCell, container, count, disallowCantDo]);

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selected availability"
      data-availability-selection-toolbar
      className={styles.availabilitySelectionToolbar}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
    >
      <div className={styles.availabilitySelectionHeader}>
        <span>{count} {count === 1 ? "cell" : "cells"} selected</span>
        <button type="button" onClick={onDismiss} aria-label="Deselect cells" title="Deselect (Esc)">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.availabilitySelectionActions}>
        {availabilityActions.filter(({ state }) => state !== "cant-do" || !disallowCantDo).map(({ state, key, label }) => (
          <button
            key={state}
            type="button"
            data-state={state}
            aria-keyshortcuts={key}
            onClick={() => onApply(state)}
            title={`${label} (${key}). Press ${key} again or Esc to deselect.`}
          >
            <span className={styles.availabilitySelectionDot} aria-hidden="true" />
            {label}
            <kbd aria-hidden="true">{key}</kbd>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
