import { useEffect, useLayoutEffect, useRef, useState, type PointerEventHandler, type RefObject } from "react";
import { getNominationPopupStyle, getNominationSummary, splitNominationColumns } from "../lib/nominationPopup";
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
  const popupRef = useRef<HTMLElement>(null);
  const getSpace = () => ({
    cursor: { ...cursorRef.current },
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
  });
  const [space, setSpace] = useState(getSpace);
  const [metrics, setMetrics] = useState<{ overhead?: number; rowHeights: Map<string, number> }>({
    rowHeights: new Map(),
  });

  useEffect(() => {
    const reposition = () => setSpace(getSpace());
    reposition();
    // Cursor movement updates only the popup, without rendering the entire grid.
    window.addEventListener("pointermove", reposition);
    return () => window.removeEventListener("pointermove", reposition);
  }, [cursorRef, distance]);

  const baseStyle = getNominationPopupStyle(space.cursor, space.viewport, distance, space.rem);
  const availableHeight = Math.max(0, Number(baseStyle?.maxHeight ?? 0) - (metrics.overhead ?? 6 * space.rem));
  const groups = nominationOrder.map((state) => {
    const people = nominations.filter((nomination) => nomination.state === state);
    return {
      state,
      people,
      columns: splitNominationColumns(people, availableHeight, ({ profile }) =>
        metrics.rowHeights.get(profile._id) ?? 1.75 * space.rem),
    };
  });
  const columnCount = groups.reduce((total, group) => total + group.columns.length, 0);
  const summary = getNominationSummary(groups[0].people.length, groups[1].people.length, nominations.length);
  const preferredWidth = Number(baseStyle?.width ?? 26 * space.rem) + (columnCount - 3) * 8.5 * space.rem;
  const popupStyle = getNominationPopupStyle(
    space.cursor, space.viewport, distance, space.rem,
    preferredWidth,
  );

  // Use actual row heights so long or wrapped names also fit. Measuring in a
  // layout effect fills the available height before the popup is painted.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup || popup.getBoundingClientRect().width === 0) return;
    const rowHeights = new Map<string, number>();
    popup.querySelectorAll<HTMLElement>("[data-nomination-person]").forEach((row) => {
      rowHeights.set(row.dataset.nominationPerson!, row.getBoundingClientRect().height);
    });
    const popupBounds = popup.getBoundingClientRect();
    const popupCss = getComputedStyle(popup);
    const scrollbarHeight = popup.offsetHeight - popup.clientHeight
      - parseFloat(popupCss.borderTopWidth) - parseFloat(popupCss.borderBottomWidth);
    let overhead = 0;
    popup.querySelectorAll<HTMLElement>("[data-nomination-group]").forEach((group) => {
      const list = group.querySelector("ul")!;
      const css = getComputedStyle(group);
      overhead = Math.max(overhead, list.getBoundingClientRect().top - popupBounds.top
        + parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth)
        + parseFloat(popupCss.paddingBottom) + parseFloat(popupCss.borderBottomWidth) + scrollbarHeight);
    });
    setMetrics((current) => {
      const changed = current.overhead === undefined || Math.abs(current.overhead - overhead) > 0.25
        || current.rowHeights.size !== rowHeights.size
        || [...rowHeights].some(([id, height]) => Math.abs((current.rowHeights.get(id) ?? 0) - height) > 0.25);
      return changed ? { overhead, rowHeights } : current;
    });
  });

  if (!popupStyle) return null;

  return (
    <section
      aria-label="Cell availability"
      ref={popupRef}
      style={popupStyle}
      className={`${styles.nominationDetails} ${styles.nominationPopup}`}
      onPointerLeave={onPointerLeave}
    >
      <header className={styles.nominationDetailsHeader}>
        <strong>{slotLabel}</strong>
        <strong className={styles.nominationTotal} aria-label={`${summary.available} of ${summary.total} participants available${summary.maybe > 0 ? `, including ${summary.maybe} maybe` : ""}`}>
          <span className={styles.nominationAvailable} data-coverage={summary.color}>{summary.available}</span>
          {summary.maybe > 0 && <span className={styles.nominationMaybe}>({summary.maybe})</span>}
          /{summary.total}
        </strong>
      </header>
      <div className={styles.nominationBoard} style={{
        gridTemplateColumns: groups.map((group) => `minmax(0, ${group.columns.length}fr)`).join(" "),
        minWidth: `calc(${preferredWidth}px - 2 * var(--space-2) - 2px)`,
      }}>
        {groups.map(({ state, people, columns }) => (
          <div key={state} className={styles.nominationColumn} data-state={state} data-nomination-group>
            <div className={styles.nominationCount}>
              <span>{nominationLabels[state]}</span>
              <strong>{people.length}</strong>
            </div>
            <div className={styles.nominationGroupColumns} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
              {columns.map((column, index) => (
                <ul key={index} aria-label={nominationLabels[state]} className={styles.nominationList}>
                  {column.map(({ profile }) => (
                    <li key={profile._id} data-nomination-person={profile._id} data-highlighted={highlightedId === profile._id || undefined}>
                      <ParticipantIcon profile={profile} />
                      <span>{profile.displayName}</span>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
