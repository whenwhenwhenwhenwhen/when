import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { getConfig } from "../config";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

const CALENDAR_NONCE_KEY = "whengames_calendar_oauth_nonce";
const CALENDAR_CONNECTED_KEY = "whengames_calendar_just_connected";

interface CalendarSource {
  _id: Id<"calendarSources">;
  type: "google" | "ics";
  availableCalendars?: { id: string; summary: string }[];
  selectedCalendarIds?: string[];
  hasIcsUrl?: boolean;
  lastSyncAt?: number;
  lastSyncStatus?: "success" | "error";
  lastSyncError?: string;
  enabled: boolean;
}

interface Props {
  profileId: Id<"userProfiles">;
  userEmail?: string;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function CalendarSyncSettings({ profileId, userEmail }: Props) {
  const sources = useQuery(api.calendarSources.getForProfile, { profileId });
  const updateSelectedCalendars = useMutation(api.calendarSources.updateSelectedCalendars);
  const saveIcsUrlMut = useMutation(api.calendarSources.saveIcsUrl);
  const removeSourceMut = useMutation(api.calendarSources.removeSource);
  const fetchGoogleCalendars = useAction(api.calendarSources.fetchGoogleCalendars);

  const [icsUrl, setIcsUrl] = useState("");
  const [calendarListLoading, setCalendarListLoading] = useState(false);
  const [calendarListError, setCalendarListError] = useState<string | null>(null);
  const refreshedSourceId = useRef<string | null>(null);

  const googleSource = (sources as CalendarSource[] | undefined)?.find((s: CalendarSource) => s.type === "google");
  const icsSource = (sources as CalendarSource[] | undefined)?.find((s: CalendarSource) => s.type === "ics");

  useEffect(() => {
    const flag = sessionStorage.getItem(CALENDAR_CONNECTED_KEY);
    if (flag) {
      sessionStorage.removeItem(CALENDAR_CONNECTED_KEY);
      if (flag.startsWith("error:")) {
        const error = flag.substring("error:".length);
        setCalendarListError(
          error === "calendar_list_failed"
            ? "Google authorization succeeded, but its calendar list could not be loaded. Check that the Google Calendar API is enabled for this project, then reconnect."
            : `Google Calendar connection failed (${error}).`,
        );
      }
    }
  }, []);

  const refreshCalendarList = useCallback(async () => {
    setCalendarListLoading(true);
    setCalendarListError(null);
    try {
      await fetchGoogleCalendars({ profileId });
    } catch (error) {
      console.error("Failed to fetch Google calendars:", error);
      setCalendarListError(
        "Could not load calendars from Google. Check that the Google Calendar API is enabled, then try again.",
      );
    } finally {
      setCalendarListLoading(false);
    }
  }, [fetchGoogleCalendars, profileId]);

  useEffect(() => {
    if (
      !googleSource ||
      (googleSource.availableCalendars?.length ?? 0) > 0 ||
      refreshedSourceId.current === googleSource._id
    ) {
      return;
    }

    refreshedSourceId.current = googleSource._id;
    void refreshCalendarList();
  }, [googleSource, refreshCalendarList]);

  const handleConnectGoogle = useCallback(() => {
    const config = getConfig();
    const nonce = crypto.randomUUID();
    sessionStorage.setItem(CALENDAR_NONCE_KEY, nonce);
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set("settings", "calendar");
    const currentPath =
      returnUrl.pathname + returnUrl.search + returnUrl.hash;
    const state = `${nonce}|${currentPath}`;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", `${config.CONVEX_SITE_URL}/auth/google/calendar-callback`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      "openid email https://www.googleapis.com/auth/calendar.readonly",
    );
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);
    if (userEmail) authUrl.searchParams.set("login_hint", userEmail);

    window.location.href = authUrl.toString();
  }, [userEmail]);

  const handleCalendarToggle = useCallback(
    async (calendarId: string, checked: boolean) => {
      if (!googleSource) return;
      const current = googleSource.selectedCalendarIds ?? [];
      const updated = checked
        ? [...current, calendarId]
        : current.filter((id: string) => id !== calendarId);
      await updateSelectedCalendars({ profileId, selectedCalendarIds: updated });
    },
    [googleSource, profileId, updateSelectedCalendars],
  );

  const handleDisconnectGoogle = useCallback(async () => {
    if (!googleSource) return;
    await removeSourceMut({ sourceId: googleSource._id });
  }, [googleSource, removeSourceMut]);

  const handleSaveIcsUrl = useCallback(async () => {
    const trimmed = icsUrl.trim();
    if (!trimmed) return;
    const normalized = trimmed.replace(/^webcal:\/\//, "https://");
    await saveIcsUrlMut({ profileId, icsUrl: normalized });
    setIcsUrl("");
  }, [icsUrl, profileId, saveIcsUrlMut]);

  const handleRemoveIcs = useCallback(async () => {
    if (!icsSource) return;
    await removeSourceMut({ sourceId: icsSource._id });
    setIcsUrl("");
  }, [icsSource, removeSourceMut]);

  const isValidUrl = (url: string) => {
    const trimmed = url.trim();
    return trimmed === "" || /^(https?:\/\/|webcal:\/\/)/.test(trimmed);
  };

  return (
    <div className={styles.calendarSettings}>
      <h3 className={styles.sectionTitle}>
        Calendar Sync
      </h3>

      {/* Google Calendar */}
      <div className={styles.calendarCard}>
        <div className={styles.calendarHeader}>
          <span className={styles.calendarLabel}>
            Google Calendar
          </span>
          {googleSource && (
            <button
              onClick={handleDisconnectGoogle}
              className={cx(styles.linkButton, styles.dangerTextButton)}
            >
              Disconnect
            </button>
          )}
        </div>

        {!googleSource ? (
          <button
            onClick={handleConnectGoogle}
            className={styles.buttonPrimary}
          >
            Connect Google Calendar
          </button>
        ) : (
          <div className={styles.stackTight}>
            {googleSource.availableCalendars && googleSource.availableCalendars.length > 0 ? (
              <div className={cx(styles.calendarOptions, styles.scrollAreaSmall)}>
                {googleSource.availableCalendars.map((cal: { id: string; summary: string }) => (
                  <label key={cal.id} className={styles.checkboxOption}>
                    <input
                      type="checkbox"
                      checked={(googleSource.selectedCalendarIds ?? []).includes(cal.id)}
                      onChange={(e) => handleCalendarToggle(cal.id, e.target.checked)}
                      className={styles.checkbox}
                    />
                    <span className={styles.truncate}>{cal.summary}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className={styles.stackTight}>
                <p className={styles.faintText}>
                  {calendarListLoading
                    ? "Loading calendars from Google..."
                    : "No calendars were returned by Google."}
                </p>
                {!calendarListLoading && (
                  <button
                    type="button"
                    onClick={() => void refreshCalendarList()}
                    className={styles.linkButton}
                  >
                    Try loading calendars again
                  </button>
                )}
              </div>
            )}

            {calendarListError && (
              <p className={styles.errorText}>
                {calendarListError}
              </p>
            )}

            {googleSource.lastSyncAt && (
              <div className={styles.calendarStatus}>
                <span>Last sync: {formatRelativeTime(googleSource.lastSyncAt)}</span>
                {googleSource.lastSyncStatus === "error" && (
                  <span className={styles.calendarStatusError} title={googleSource.lastSyncError}>
                    (error)
                  </span>
                )}
                {googleSource.lastSyncStatus === "success" && (
                  <span className={styles.calendarStatusOk}>
                    (ok)
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ICS URL */}
      <div className={styles.calendarCard}>
        <div className={styles.calendarHeader}>
          <span className={styles.calendarLabel}>
            ICS Calendar URL
          </span>
          {icsSource && (
            <button
              onClick={handleRemoveIcs}
              className={cx(styles.linkButton, styles.dangerTextButton)}
            >
              Remove
            </button>
          )}
        </div>
        <div className={styles.calendarUrlRow}>
          <input
            type="text"
            value={icsUrl}
            onChange={(e) => setIcsUrl(e.target.value)}
            placeholder={
              icsSource?.hasIcsUrl
                ? "Paste new URL to replace current calendar"
                : "https://example.com/calendar.ics"
            }
            className={cx(
              !isValidUrl(icsUrl) ? styles.invalidControl : styles.control,
              styles.flexGrow,
            )}
          />
          <button
            onClick={handleSaveIcsUrl}
            disabled={!icsUrl.trim() || !isValidUrl(icsUrl)}
            className={styles.buttonPrimarySmall}
          >
            {icsSource?.hasIcsUrl ? "Replace" : "Save"}
          </button>
        </div>
        {icsSource?.hasIcsUrl && (
          <p className={styles.faintText}>
            ICS calendar connected.
          </p>
        )}
        {!isValidUrl(icsUrl) && (
          <p className={styles.errorText}>
            URL must start with https:// or webcal://
          </p>
        )}
        {icsSource?.lastSyncAt && (
          <div className={styles.calendarStatus}>
            <span>Last sync: {formatRelativeTime(icsSource.lastSyncAt)}</span>
            {icsSource.lastSyncStatus === "error" && (
              <span className={styles.calendarStatusError} title={icsSource.lastSyncError}>
                (error)
              </span>
            )}
            {icsSource.lastSyncStatus === "success" && (
              <span className={styles.calendarStatusOk}>
                (ok)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
