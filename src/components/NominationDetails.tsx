import type { CSSProperties, PointerEventHandler, Ref } from "react";
import { ArrowDownFromLine, ArrowLeftToLine, ArrowRightFromLine, ArrowUpToLine } from "lucide-react";
import type { NominationHoverStyle } from "../../shared/nominationHover";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";
import { ParticipantIcon } from "./ParticipantIcon";

export const nominationOrder = ["can-do", "cant-do", "maybe"] as const;
export type NominationState = typeof nominationOrder[number];
export const nominationLabels: Record<NominationState, string> = {
  "can-do": "Can Do",
  "cant-do": "Can't Do",
  maybe: "Maybe",
};

interface Nomination {
  profile: { _id: string; displayName: string; profileImageUrl?: string };
  state: NominationState;
}

interface Props {
  layout: NominationHoverStyle;
  nominations: Nomination[];
  slotLabel?: string;
  highlightedId?: string;
  popupRef?: Ref<HTMLElement>;
  popupStyle?: CSSProperties;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  collapsed?: boolean;
  collapsedStyle?: CSSProperties;
  onToggle?: () => void;
}

export function NominationDetails({
  layout,
  nominations,
  slotLabel,
  highlightedId,
  popupRef,
  popupStyle,
  onPointerLeave,
  collapsed = false,
  collapsedStyle,
  onToggle,
}: Props) {
  const groups = nominationOrder.map((state) => ({
    state,
    people: nominations.filter((nomination) => nomination.state === state),
  }));
  const toggleLabel = `${collapsed ? "Show" : "Collapse"} ${layout === "ribbon" ? "name ribbon" : "side inspector"}`;
  const ToggleIcon = layout === "ribbon"
    ? (collapsed ? ArrowDownFromLine : ArrowUpToLine)
    : (collapsed ? ArrowRightFromLine : ArrowLeftToLine);

  return (
    <section
      aria-label="Cell availability"
      ref={popupRef}
      style={collapsed ? collapsedStyle : popupStyle}
      className={cx(styles.nominationDetails, popupStyle && styles.nominationPopup)}
      data-layout={layout}
      data-collapsed={collapsed || undefined}
      onPointerLeave={onPointerLeave}
    >
      <header className={styles.nominationDetailsHeader}>
        {!collapsed && (
          <div className={styles.nominationDetailsHeading}>
            <span>Availability</span>
            {slotLabel && <strong>{slotLabel}</strong>}
          </div>
        )}
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className={styles.nominationPanelToggle}
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            <ToggleIcon aria-hidden="true" />
          </button>
        )}
      </header>
      {!collapsed && (!slotLabel ? (
        <p className={styles.nominationHint}>Hover over a cell with nominations.</p>
      ) : layout === "board" ? (
        <div className={styles.nominationBoard}>
          {groups.map(({ state, people }) => (
            <div key={state} className={styles.nominationColumn} data-state={state}>
              <div className={styles.nominationCount}>
                <span>{nominationLabels[state]}</span>
                <strong>{people.length}</strong>
              </div>
              <ul aria-label={nominationLabels[state]} className={styles.nominationList}>
                {people.map(({ profile }) => (
                  <li key={profile._id} data-highlighted={highlightedId === profile._id || undefined}>
                    <ParticipantIcon profile={profile} />
                    <span>{profile.displayName}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <>
          {layout === "inspector" && (
            <div className={styles.nominationCounts}>
              {groups.map(({ state, people }) => (
                <div key={state} className={styles.nominationCount} data-state={state}>
                  <strong>{people.length}</strong>
                  <span>{nominationLabels[state]}</span>
                </div>
              ))}
            </div>
          )}
          <ul aria-label="Nominations" className={styles.nominationList}>
            {nominations.map(({ profile, state }) => (
              <li
                key={profile._id}
                className={styles.nominationPerson}
                data-state={state}
                data-highlighted={highlightedId === profile._id || undefined}
              >
                <ParticipantIcon profile={profile} />
                <span>{profile.displayName}</span>
                <small className={styles.nominationStatus}>{nominationLabels[state]}</small>
              </li>
            ))}
          </ul>
        </>
      ))}
    </section>
  );
}
