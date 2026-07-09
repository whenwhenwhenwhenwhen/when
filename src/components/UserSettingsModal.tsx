import { useState, useMemo } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useGoogleAuth } from "../lib/googleAuth";
import { getCommonTimezones } from "../lib/timezone";
import { Id } from "../../convex/_generated/dataModel";
import { CalendarSyncSettings } from "./CalendarSyncSettings";
import { useToast } from "../hooks/useToast";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Profile {
  _id: Id<"userProfiles">;
  displayName: string;
  timezone: string;
  weekStartDay: number;
  dstNotifications: boolean;
  authUserId?: string;
  email?: string;
  profileImageUrl?: string;
  isAuthenticated: boolean;
  authType: "sso" | "anonymous";
  ssoName?: string;
  ssoEmail?: string;
  ssoImage?: string;
}

interface Props {
  profile: Profile;
  anonymousId?: string;
  onClose: () => void;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const ANON_ID_KEY = "whengames_anonymous_id";
const ANON_NAME_KEY = "whengames_anonymous_name";

function formatTzLabel(tz: string): string {
  // "America/New_York" -> "New York (America)"
  const parts = tz.split("/");
  if (parts.length === 1) return tz;
  const city = parts[parts.length - 1].replace(/_/g, " ");
  const region = parts.slice(0, -1).join("/");
  return `${city} (${region})`;
}

function TimezoneSearchSelect({
  value,
  onChange,
  search,
  onSearchChange,
}: {
  value: string;
  onChange: (tz: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const allTimezones = useMemo(() => getCommonTimezones(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return allTimezones;
    const q = search.toLowerCase();
    return allTimezones.filter(
      (tz) =>
        tz.toLowerCase().includes(q) ||
        formatTzLabel(tz).toLowerCase().includes(q)
    );
  }, [allTimezones, search]);

  return (
    <div className={styles.timezoneWrapper}>
      <input
        type="text"
        value={isOpen ? search : value}
        onChange={(e) => {
          onSearchChange(e.target.value);
          if (!isOpen) setIsOpen(true);
        }}
        onFocus={() => {
          setIsOpen(true);
          onSearchChange("");
        }}
        onBlur={() => {
          // Delay to allow click on option
          setTimeout(() => setIsOpen(false), 200);
        }}
        placeholder="Search timezones..."
        className={styles.control}
      />
      {isOpen && (
        <div className={styles.timezoneDropdown}>
          {filtered.length === 0 ? (
            <div className={styles.menuItemDisabled}>
              No matching timezones
            </div>
          ) : (
            filtered.map((tz) => (
              <button
                key={tz}
                type="button"
                className={cx(
                  styles.timezoneOption,
                  tz === value && styles.timezoneOptionSelected,
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent blur
                  onChange(tz);
                  onSearchChange("");
                  setIsOpen(false);
                }}
              >
                {formatTzLabel(tz)}
                <span className={styles.faintText}> ({tz})</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function UserSettingsModal({ profile, anonymousId, onClose }: Props) {
  const updateProfile = useMutation(api.users.updateProfile);
  const unlinkSso = useMutation(api.users.unlinkSso);
  const triggerSync = useAction(api.calendarSync.triggerSyncForProfile);
  const { signOut } = useGoogleAuth();
  const { showToast, updateToast } = useToast();

  const calendarSources = useQuery(
    api.calendarSources.getForProfile,
    profile.authType === "sso" && profile._id ? { profileId: profile._id } : "skip",
  );
  const hasCalendarSources = (calendarSources ?? []).some((s: { enabled: boolean }) => s.enabled);

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [weekStartDay, setWeekStartDay] = useState(profile.weekStartDay);
  const [dstNotifications, setDstNotifications] = useState(
    profile.dstNotifications
  );
  const [saving, setSaving] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [timezoneSearch, setTimezoneSearch] = useState("");

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      // Generate a new anonymous ID
      const newAnonymousId = crypto.randomUUID();

      const result = await unlinkSso({
        newAnonymousId,
      });

      // Store the new anonymous identity in localStorage
      localStorage.setItem(ANON_ID_KEY, newAnonymousId);
      localStorage.setItem(ANON_NAME_KEY, result.displayName);

      // Sign out (clear Google token)
      signOut();
      setShowUnlinkConfirm(false);
      onClose();
      window.location.reload();
    } catch (err) {
      console.error("Failed to unlink SSO:", err);
    } finally {
      setUnlinking(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({
        anonymousId: profile.authType === "anonymous" ? anonymousId : undefined,
        displayName,
        timezone,
        weekStartDay,
        dstNotifications,
      });
      onClose();

      if (hasCalendarSources && profile._id) {
        const toastId = showToast("Calendar sync in progress...", "info", 0);
        try {
          await triggerSync({ profileId: profile._id });
          updateToast(toastId, { message: "Calendar sync complete!", type: "success", duration: 4000 });
        } catch {
          updateToast(toastId, { message: "Calendar sync failed. Will retry automatically.", type: "error", duration: 6000 });
        }
      }
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.modalBackdrop}>
      <div className={styles.modalPanelMd}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>User Settings</h2>
          <button
            onClick={onClose}
            className={styles.closeButton}
          >
            &times;
          </button>
        </div>

        <div className={styles.formStack}>
          <div className={cx(styles.panel, styles.panelInfo)}>
            <div className={styles.inlineStart}>
              {profile.authType === "sso" && profile.ssoImage && (
                <img
                  src={profile.ssoImage}
                  alt=""
                  className={styles.avatarMd}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className={styles.flexGrow}>
                <p className={styles.accentText}>
                  Account Type
                </p>
                {profile.authType === "sso" ? (
                  <div className={styles.stackTight}>
                    <p className={styles.accentText}>SSO (Google Account)</p>
                    {profile.ssoName && (
                      <p className={styles.accentText}>{profile.ssoName}</p>
                    )}
                    {profile.ssoEmail && (
                      <p className={styles.accentText}>{profile.ssoEmail}</p>
                    )}
                    {!showUnlinkConfirm ? (
                      <button
                        onClick={() => setShowUnlinkConfirm(true)}
                        className={cx(styles.linkButton, styles.dangerTextButton)}
                      >
                        Unlink SSO &amp; convert to cookie account
                      </button>
                    ) : (
                      <div className={cx(styles.panel, styles.panelDanger)}>
                        <p className={styles.errorText}>
                          This will disconnect your Google account. Your data
                          will be stored only in this browser. Are you sure?
                        </p>
                        <div className={styles.fieldRow}>
                          <button
                            onClick={handleUnlink}
                            disabled={unlinking}
                            className={styles.buttonDangerSmall}
                          >
                            {unlinking ? "Unlinking..." : "Yes, unlink"}
                          </button>
                          <button
                            onClick={() => setShowUnlinkConfirm(false)}
                            className={styles.buttonSecondarySmall}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={styles.stackTight}>
                    <p className={styles.accentText}>Cookie User</p>
                    <p className={styles.accentText}>
                      Your identity is stored in this browser only. Link a
                      Google account to access your data from any device.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <label className={styles.fieldLabel}>
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={styles.control}
            />
          </div>

          <div>
            <label className={styles.fieldLabel}>
              Timezone
            </label>
            <TimezoneSearchSelect
              value={timezone}
              onChange={setTimezone}
              search={timezoneSearch}
              onSearchChange={setTimezoneSearch}
            />
          </div>

          <div>
            <label className={styles.fieldLabel}>
              Week Starts On
            </label>
            <select
              value={weekStartDay}
              onChange={(e) => setWeekStartDay(Number(e.target.value))}
              className={styles.control}
            >
              {DAY_NAMES.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="dst-notifications"
              checked={dstNotifications}
              onChange={(e) => setDstNotifications(e.target.checked)}
              className={styles.checkbox}
            />
            <label
              htmlFor="dst-notifications"
              className={styles.checkboxOption}
            >
              DST change notifications
            </label>
          </div>

          {profile.authType === "sso" && profile._id && (
            <CalendarSyncSettings
              profileId={profile._id}
              userEmail={profile.ssoEmail}
            />
          )}

          <div className={styles.modalFooter}>
            <button
              onClick={onClose}
              className={styles.buttonPlain}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={styles.buttonPrimary}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
