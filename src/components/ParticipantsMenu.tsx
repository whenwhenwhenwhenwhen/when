import { useState, useRef, useEffect } from "react";
import { Id } from "../../convex/_generated/dataModel";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Participant {
  _id: Id<"userProfiles">;
  displayName: string;
  profileImageUrl?: string;
  timezone: string;
}

interface AvailabilityLink {
  profileId: string;
  savedAvailabilityId: string;
  savedAvailabilityName: string;
}

interface Props {
  participants: Participant[];
  availabilityLinks: AvailabilityLink[];
  lockEditors: string[];
  editingProfileId: Id<"userProfiles"> | null;
  onEditUser: (profileId: Id<"userProfiles">) => void;
  onStopEditing: () => void;
  onDeleteUser: (profileId: Id<"userProfiles">) => void;
  onBlockUser: (profileId: Id<"userProfiles">) => void;
  onPromoteLockEditor: (profileId: Id<"userProfiles">) => void;
  onDemoteLockEditor: (profileId: Id<"userProfiles">) => void;
}

export function ParticipantsMenu({
  participants,
  availabilityLinks,
  lockEditors,
  editingProfileId,
  onEditUser,
  onStopEditing,
  onDeleteUser,
  onBlockUser,
  onPromoteLockEditor,
  onDemoteLockEditor,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "delete" | "block";
    profileId: Id<"userProfiles">;
    displayName: string;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setConfirmAction(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const isEditing = editingProfileId !== null;
  const editingParticipant = isEditing
    ? participants.find((p) => p._id === editingProfileId)
    : null;

  // Check if a user has linked availability
  const hasLinkedAvailability = (profileId: Id<"userProfiles">) => {
    return availabilityLinks.some(
      (l) => String(l.profileId) === String(profileId)
    );
  };

  let buttonLabel = "Users";
  let buttonStateClass = "";

  if (isEditing && editingParticipant) {
    buttonStateClass = styles.menuButtonWarning;
    buttonLabel = editingParticipant.displayName;
  }

  if (participants.length === 0) return null;

  return (
    <div className={styles.menuWrapper} ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cx(styles.menuButton, buttonStateClass)}
        title={
          isEditing
            ? `Editing ${editingParticipant?.displayName}'s availability`
            : "Manage participant availabilities"
        }
      >
        <svg
          className={styles.iconSm}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
          />
        </svg>
        {buttonLabel}
        <svg
          className={styles.iconXs}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div className={cx(styles.menuDropdown, styles.menuDropdownWide)}>
          {/* Header */}
          <div className={styles.menuHeader}>
            <span className={styles.menuHeaderText}>
              Participants ({participants.length})
            </span>
          </div>

          {/* Stop editing button if currently editing */}
          {isEditing && (
            <>
              <button
                onClick={() => {
                  onStopEditing();
                  setIsOpen(false);
                }}
                className={cx(styles.menuItem, styles.warningText)}
              >
                Stop editing {editingParticipant?.displayName}&apos;s availability
              </button>
              <div className={styles.menuDivider} />
            </>
          )}

          {/* Confirmation dialog */}
          {confirmAction && (
            <div className={cx(styles.panel, styles.panelDanger)}>
              <p className={styles.smallText}>
                {confirmAction.type === "delete" ? (
                  <>
                    Remove all of{" "}
                    <strong>
                      {confirmAction.displayName}
                    </strong>
                    &apos;s availability from this schedule?
                  </>
                ) : (
                  <>
                    Block{" "}
                    <strong>
                      {confirmAction.displayName}
                    </strong>{" "}
                    and remove all their availability? They won&apos;t be able to
                    participate again.
                  </>
                )}
              </p>
              <div className={styles.fieldRow}>
                <button
                  onClick={() => setConfirmAction(null)}
                  className={cx(styles.buttonSecondarySmall, styles.flexGrow)}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (confirmAction.type === "delete") {
                      onDeleteUser(confirmAction.profileId);
                    } else {
                      onBlockUser(confirmAction.profileId);
                    }
                    setConfirmAction(null);
                    setIsOpen(false);
                  }}
                  className={cx(
                    confirmAction.type === "block"
                      ? styles.buttonDangerSmall
                      : styles.buttonWarning,
                    styles.flexGrow,
                  )}
                >
                  {confirmAction.type === "delete" ? "Remove" : "Block"}
                </button>
              </div>
            </div>
          )}

          {/* Participant list */}
          <div className={styles.participantList}>
            {participants.map((participant) => {
              const isLinked = hasLinkedAvailability(participant._id);
              const isCurrentlyEditing = editingProfileId === participant._id;
              const isLockEditor = lockEditors.includes(participant._id as string);

              return (
                <div
                  key={participant._id}
                  className={cx(
                    styles.participantRow,
                    isCurrentlyEditing && styles.participantRowActive,
                  )}
                >
                  {/* Avatar */}
                  {participant.profileImageUrl ? (
                    <img
                      src={participant.profileImageUrl}
                      alt=""
                      className={styles.avatarXs}
                    />
                  ) : (
                    <div className={styles.avatarFallback}>
                      {participant.displayName.charAt(0).toUpperCase()}
                    </div>
                  )}

                  {/* Name */}
                  <span className={styles.participantName}>
                    {participant.displayName}
                    {isLinked && (
                      <span
                        className={styles.linkedMarker}
                        title="Linked to saved availability"
                      >
                        *
                      </span>
                    )}
                    {isLockEditor && (
                      <span
                        className={styles.lockMarker}
                        title="Can lock in times"
                      >
                        <svg className={cx(styles.iconXs, styles.iconInline)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </span>
                    )}
                  </span>

                  {/* Action icons */}
                  <div className={styles.rowActions}>
                    {/* Promote/Demote lock editor */}
                    <button
                      onClick={() => {
                        if (isLockEditor) {
                          onDemoteLockEditor(participant._id);
                        } else {
                          onPromoteLockEditor(participant._id);
                        }
                      }}
                      className={cx(
                        styles.iconButton,
                        styles.iconButtonPurple,
                        isLockEditor && styles.iconButtonPurpleActive,
                      )}
                      title={
                        isLockEditor
                          ? `Revoke ${participant.displayName}'s lock-in permission`
                          : `Allow ${participant.displayName} to lock in times`
                      }
                    >
                      <svg
                        className={styles.iconSm}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        {isLockEditor ? (
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
                          />
                        ) : (
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                          />
                        )}
                      </svg>
                    </button>

                    {/* Edit */}
                    <button
                      onClick={() => {
                        if (!isLinked) {
                          if (isCurrentlyEditing) {
                            onStopEditing();
                          } else {
                            onEditUser(participant._id);
                          }
                          setIsOpen(false);
                        }
                      }}
                      disabled={isLinked}
                      className={cx(
                        styles.iconButton,
                        isLinked
                          ? styles.iconButtonDisabled
                          : isCurrentlyEditing
                            ? styles.iconButtonAmberActive
                            : styles.iconButtonBlue,
                      )}
                      title={
                        isLinked
                          ? "Cannot edit: user has linked their availability to a saved availability"
                          : isCurrentlyEditing
                            ? "Stop editing"
                            : `Edit ${participant.displayName}'s availability`
                      }
                    >
                      <svg
                        className={styles.iconSm}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() =>
                        setConfirmAction({
                          type: "delete",
                          profileId: participant._id,
                          displayName: participant.displayName,
                        })
                      }
                      className={cx(styles.iconButton, styles.iconButtonOrange)}
                      title={`Remove ${participant.displayName}'s availability`}
                    >
                      <svg
                        className={styles.iconSm}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>

                    {/* Block */}
                    <button
                      onClick={() =>
                        setConfirmAction({
                          type: "block",
                          profileId: participant._id,
                          displayName: participant.displayName,
                        })
                      }
                      className={cx(styles.iconButton, styles.iconButtonDanger)}
                      title={`Block ${participant.displayName}`}
                    >
                      <svg
                        className={styles.iconSm}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
