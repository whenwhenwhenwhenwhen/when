import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { DateTime } from "luxon";
import { api } from "../../convex/_generated/api";
import { Doc } from "../../convex/_generated/dataModel";
import { CreateScheduleModal } from "./CreateScheduleModal";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

type ListedSchedule = Doc<"schedules"> & {
  creatorName: string;
  creatorImage?: string;
  isParticipated: boolean;
  isArchived: boolean;
  isExpired: boolean;
  isManuallyArchived: boolean;
};

function ScheduleCards({ schedules }: { schedules: ListedSchedule[] }) {
  return (
    <div className={styles.cardsGrid}>
      {schedules.map((schedule) => (
        <a
          key={schedule._id}
          href={`/schedule/${schedule._id}`}
          className={styles.scheduleCard}
        >
          <div className={styles.cardHeader}>
            <div>
              <h3 className={styles.cardTitle}>{schedule.title}</h3>
              {schedule.description && (
                <p className={styles.subtleText}>{schedule.description}</p>
              )}
              <div className={styles.scheduleMeta}>
                <span
                  className={cx(
                    styles.badge,
                    schedule.type === "one-off"
                      ? styles.badgeOneOff
                      : styles.badgeRecurring,
                  )}
                >
                  {schedule.type === "one-off" ? "One-off" : "Recurring"}
                </span>
                {schedule.isArchived && (
                  <span className={styles.miniBadge}>
                    {schedule.isExpired ? "Ended" : "Archived"}
                  </span>
                )}
                {schedule.type === "one-off" &&
                  schedule.dateRangeStart &&
                  schedule.dateRangeEnd && (
                    <span className={styles.faintText}>
                      {schedule.dateRangeStart} to {schedule.dateRangeEnd}
                    </span>
                  )}
              </div>
            </div>
            <div className={styles.creatorMeta}>
              {schedule.creatorImage && (
                <img
                  src={schedule.creatorImage}
                  alt=""
                  className={styles.avatarXs}
                />
              )}
              <span>{schedule.creatorName}</span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function ScheduleList() {
  const { anonymousId } = useAnonymousUser();
  const currentDate = DateTime.local().toISODate() ?? "";
  const schedules = useQuery(api.schedules.list, {
    anonymousId: anonymousId || undefined,
    currentDate,
  });
  const [showCreate, setShowCreate] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (schedules && !schedules.hasArchived) {
      setShowArchived(false);
    }
  }, [schedules]);

  const currentScheduleCount = schedules
    ? schedules.participated.length + schedules.publicSchedules.length
    : 0;

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>
          {showArchived ? "Archived schedules" : "Schedules"}
        </h1>
        <div className={styles.pageActions}>
          {schedules?.hasArchived && (
            <button
              type="button"
              onClick={() => setShowArchived((value) => !value)}
              className={cx(
                styles.buttonSecondary,
                showArchived && styles.archiveToggleActive,
              )}
              aria-pressed={showArchived}
            >
              {showArchived ? "Current schedules" : "Archived"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className={styles.buttonPrimary}
          >
            + New Schedule
          </button>
        </div>
      </div>

      {schedules === undefined ? (
        <div className={styles.emptyState}>
          <span className={styles.faintText}>Loading...</span>
        </div>
      ) : showArchived ? (
        schedules.archived.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.subtleText}>No archived schedules.</p>
          </div>
        ) : (
          <section className={styles.scheduleSection}>
            <h2 className={styles.scheduleSectionTitle}>Archived</h2>
            <ScheduleCards schedules={schedules.archived} />
          </section>
        )
      ) : currentScheduleCount === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.subtleText}>No current schedules.</p>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className={styles.textButton}
          >
            Create the first one!
          </button>
        </div>
      ) : (
        <div className={styles.scheduleSections}>
          {schedules.participated.length > 0 && (
            <section className={styles.scheduleSection}>
              <h2 className={styles.scheduleSectionTitle}>Participated in</h2>
              <ScheduleCards schedules={schedules.participated} />
            </section>
          )}

          {schedules.publicSchedules.length > 0 && (
            <section
              className={cx(
                styles.scheduleSection,
                schedules.participated.length > 0 &&
                  styles.scheduleSectionDivided,
              )}
            >
              <h2 className={styles.scheduleSectionTitle}>Public schedules</h2>
              <ScheduleCards schedules={schedules.publicSchedules} />
            </section>
          )}
        </div>
      )}

      {showCreate && (
        <CreateScheduleModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
