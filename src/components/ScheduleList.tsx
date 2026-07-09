import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CreateScheduleModal } from "./CreateScheduleModal";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

export function ScheduleList() {
  const schedules = useQuery(api.schedules.list);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Schedules</h1>
        <button
          onClick={() => setShowCreate(true)}
          className={styles.buttonPrimary}
        >
          + New Schedule
        </button>
      </div>

      {schedules === undefined ? (
        <div className={styles.emptyState}>
          <span className={styles.faintText}>Loading...</span>
        </div>
      ) : schedules.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.subtleText}>No schedules yet.</p>
          <button
            onClick={() => setShowCreate(true)}
            className={styles.textButton}
          >
            Create the first one!
          </button>
        </div>
      ) : (
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
                    <p className={styles.subtleText}>
                      {schedule.description}
                    </p>
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
      )}

      {showCreate && (
        <CreateScheduleModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
