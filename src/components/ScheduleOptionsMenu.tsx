import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Props {
  acceptParticipation: boolean;
  anyoneCanLock: boolean;
  onDisallowOutsideNominations: () => void | Promise<void>;
  onToggleAcceptParticipation: (accept: boolean) => void | Promise<void>;
  onToggleAnyoneCanLock: (enabled: boolean) => void | Promise<void>;
  onEditSchedule: () => void;
  discordLinkAction: ReactNode;
}

export function ScheduleOptionsMenu({
  acceptParticipation,
  anyoneCanLock,
  onDisallowOutsideNominations,
  onToggleAcceptParticipation,
  onToggleAnyoneCanLock,
  onEditSchedule,
  discordLinkAction,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<"schedule" | "discord">(
    "schedule",
  );
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setActivePanel("schedule");
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, isOpen]);

  return (
    <div className={styles.menuWrapper} ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          if (isOpen) {
            closeMenu();
          } else {
            setIsOpen(true);
          }
        }}
        className={styles.buttonSecondarySmall}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        Schedule options
        <ChevronDown
          className={styles.iconXs}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          className={cx(
            styles.menuDropdown,
            styles.menuDropdownWide,
            styles.menuDropdownRight,
          )}
          role="dialog"
          aria-label="Schedule options"
        >
          {activePanel === "schedule" ? (
            <>
              <div className={styles.menuHeader}>
                <span className={styles.menuHeaderText}>Schedule options</span>
              </div>

              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  void onDisallowOutsideNominations();
                }}
                className={cx(styles.menuItem, styles.warningText)}
                title="Mark all times without 'Can Do' or 'Maybe' nominations as disallowed"
              >
                Disallow outside nominations
              </button>

              <div className={styles.menuDivider} />

              <div className={styles.scheduleOptionRow}>
                <span className={styles.calendarLabel}>
                  Accept participation
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void onToggleAcceptParticipation(!acceptParticipation)
                  }
                  className={cx(
                    styles.toggle,
                    acceptParticipation && styles.toggleOn,
                  )}
                  aria-label={
                    acceptParticipation
                      ? "Close participation"
                      : "Accept participation"
                  }
                  aria-pressed={acceptParticipation}
                  title={
                    acceptParticipation
                      ? "Participation is open. Click to close."
                      : "Participation is closed. Click to open."
                  }
                >
                  <span
                    className={cx(
                      styles.toggleKnob,
                      acceptParticipation && styles.toggleKnobOn,
                    )}
                  />
                </button>
              </div>

              <div className={styles.scheduleOptionRow}>
                <span className={styles.calendarLabel}>Anyone can lock</span>
                <button
                  type="button"
                  onClick={() => void onToggleAnyoneCanLock(!anyoneCanLock)}
                  className={cx(
                    styles.toggle,
                    anyoneCanLock && styles.togglePurpleOn,
                  )}
                  aria-label={
                    anyoneCanLock
                      ? "Restrict who can lock in times"
                      : "Allow anyone to lock in times"
                  }
                  aria-pressed={anyoneCanLock}
                  title={
                    anyoneCanLock
                      ? "Anyone can lock in times. Click to restrict."
                      : "Only the creator and promoted users can lock in times. Click to allow anyone."
                  }
                >
                  <span
                    className={cx(
                      styles.toggleKnob,
                      anyoneCanLock && styles.toggleKnobOn,
                    )}
                  />
                </button>
              </div>

              <div className={styles.menuDivider} />

              <button
                type="button"
                onClick={() => setActivePanel("discord")}
                className={cx(styles.menuItem, styles.menuItemSplit)}
                aria-haspopup="dialog"
              >
                <span>Discord</span>
                <ChevronRight className={styles.iconXs} aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  onEditSchedule();
                }}
                className={styles.menuItem}
              >
                Edit schedule…
              </button>
            </>
          ) : (
            <>
              <div className={cx(styles.menuHeader, styles.submenuHeader)}>
                <button
                  type="button"
                  onClick={() => setActivePanel("schedule")}
                  className={styles.submenuBackButton}
                  aria-label="Back to Schedule options"
                >
                  <ChevronLeft className={styles.iconSm} aria-hidden="true" />
                </button>
                <span className={styles.menuHeaderText}>Discord</span>
              </div>
              {discordLinkAction}
            </>
          )}
        </div>
      )}
    </div>
  );
}
