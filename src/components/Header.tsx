import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { useGoogleAuth } from "../lib/googleAuth";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { UserSettingsModal } from "./UserSettingsModal";
import { AnimatedTitle } from "./AnimatedTitle";
import favicon from "../assets/favicon.svg";
import styles from "../styles/app.module.css";

const CALENDAR_REOPEN_SETTINGS_KEY =
  "whengames_reopen_settings_after_calendar_oauth";

export function Header() {
  const { isAuthenticated, isLoading, signIn, signOut } = useGoogleAuth();
  const { anonymousId, hasInteracted, clearAnonymousUser } = useAnonymousUser();
  const location = useLocation();
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const settingsRequested =
    new URLSearchParams(location.search).get("settings") === "calendar";

  useEffect(() => {
    const reopenAfterCalendarOAuth =
      sessionStorage.getItem(CALENDAR_REOPEN_SETTINGS_KEY) === "true";
    if (reopenAfterCalendarOAuth) {
      sessionStorage.removeItem(CALENDAR_REOPEN_SETTINGS_KEY);
    }

    if (settingsRequested || reopenAfterCalendarOAuth) {
      setShowSettings(true);
    }
  }, [settingsRequested]);

  // Always pass anonymousId so the query can find the profile during the
  // transition window between SSO completion and profile linking.
  const profile = useQuery(api.users.currentUserProfile, {
    anonymousId: anonymousId || undefined,
  });

  // Refresh cached profile image on each app access (throttled to once/24h server-side)
  const refreshProfileImage = useMutation(
    api.users.refreshProfileImageIfNeeded
  );
  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (isAuthenticated && !isLoading && !hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshProfileImage().catch(() => {});
    }
  }, [isAuthenticated, isLoading, refreshProfileImage]);

  const handleLogin = () => {
    // Redirect back to the current page after OAuth sign-in
    const currentPath = location.pathname + location.search + location.hash;
    signIn(currentPath);
  };

  const handleLogout = () => {
    signOut();
  };

  const handleCloseSettings = () => {
    setShowSettings(false);
    if (!settingsRequested) return;

    const params = new URLSearchParams(location.search);
    params.delete("settings");
    const search = params.toString();
    navigate(
      `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
      { replace: true },
    );
  };

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a href="/" className={styles.brandLink}>
            <img
              src={favicon}
              alt=""
              aria-hidden="true"
              className={styles.brandIcon}
            />
            <AnimatedTitle />
          </a>

          <div className={styles.inlineCluster}>
            {isLoading ? (
              <span className={styles.faintText}>Loading...</span>
            ) : isAuthenticated || profile?.isAuthenticated ? (
              <>
                <div className={styles.userInfo}>
                  {(profile?.ssoImage || profile?.profileImageUrl) ? (
                    <img
                      src={profile.ssoImage || profile.profileImageUrl}
                      alt=""
                      className={styles.avatarSm}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : null}
                  <span className={styles.bodyText}>
                    {profile?.displayName ||
                      profile?.ssoName ||
                      profile?.ssoEmail ||
                      "User"}
                  </span>
                </div>
                <button
                  onClick={() => setShowSettings(true)}
                  className={styles.navButton}
                >
                  Settings
                </button>
                <button
                  onClick={handleLogout}
                  className={styles.navButton}
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                {hasInteracted && profile && (
                  <span className={styles.subtleText}>
                    {profile.displayName}
                  </span>
                )}
                <button
                  onClick={handleLogin}
                  className={styles.buttonPrimarySmall}
                >
                  {hasInteracted ? "Link Login" : "Login"}
                </button>
                {profile && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className={styles.navButton}
                  >
                    Settings
                  </button>
                )}
                {hasInteracted && profile && (
                  <button
                    onClick={() => {
                      clearAnonymousUser();
                      window.location.reload();
                    }}
                    className={styles.navButton}
                  >
                    Logout
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {showSettings && profile && (
        <UserSettingsModal
          profile={profile}
          anonymousId={anonymousId || undefined}
          onClose={handleCloseSettings}
        />
      )}
    </>
  );
}
