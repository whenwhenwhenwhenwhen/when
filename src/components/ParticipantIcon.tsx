import styles from "../styles/app.module.css";

interface Props {
  profile: {
    _id: string;
    displayName: string;
    profileImageUrl?: string;
  };
  nomination?: string;
}

// Generate a consistent color for a user based on their ID.
function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function ParticipantIcon({ profile, nomination }: Props) {
  const iconProps = {
    className: styles.profileIcon,
    "aria-label": nomination && `${profile.displayName} (${nomination})`,
    "aria-hidden": nomination ? undefined : true,
    "data-nomination-profile": nomination ? profile._id : undefined,
  };

  return profile.profileImageUrl ? (
    <img
      {...iconProps}
      src={profile.profileImageUrl}
      alt={nomination ? profile.displayName : ""}
      draggable={false}
    />
  ) : (
    <span
      {...iconProps}
      role="img"
      style={{ backgroundColor: getUserColor(profile._id) }}
    >
      {getInitials(profile.displayName)}
    </span>
  );
}
