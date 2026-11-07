import { useEffect, useState, type PointerEventHandler, type RefObject } from "react";
import { getNominationPopupStyle } from "../lib/nominationPopup";
import styles from "../styles/app.module.css";
import { ParticipantIcon } from "./ParticipantIcon";

export const nominationOrder = ["can-do", "maybe", "cant-do"] as const;
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
  nominations: Nomination[];
  slotLabel: string;
  highlightedId?: string;
  cursorRef: RefObject<{ x: number; y: number }>;
  distance: number;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
}

export function NominationDetails({
  nominations,
  slotLabel,
  highlightedId,
  cursorRef,
  distance,
  onPointerLeave,
}: Props) {
  const [popupStyle, setPopupStyle] = useState(() => getNominationPopupStyle(cursorRef.current, {
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  }, distance, parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));

  useEffect(() => {
    const reposition = () => setPopupStyle(getNominationPopupStyle(cursorRef.current, {
      width: document.documentElement.clientWidth,
      height: window.innerHeight,
    }, distance, parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
    reposition();
    // Cursor movement updates only the popup, without rendering the entire grid.
    window.addEventListener("pointermove", reposition);
    return () => window.removeEventListener("pointermove", reposition);
  }, [cursorRef, distance]);

  if (!popupStyle) return null;

  return (
    <section
      aria-label="Cell availability"
      style={popupStyle}
      className={`${styles.nominationDetails} ${styles.nominationPopup}`}
      onPointerLeave={onPointerLeave}
    >
      <header className={styles.nominationDetailsHeader}>
        <strong>{slotLabel}</strong>
      </header>
      <div className={styles.nominationBoard}>
        {nominationOrder.map((state) => {
          const people = nominations.filter((nomination) => nomination.state === state);
          return (
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
          );
        })}
      </div>
    </section>
  );
}
