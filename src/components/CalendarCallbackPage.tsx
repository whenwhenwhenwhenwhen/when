import { useEffect } from "react";
import styles from "../styles/app.module.css";

const CALENDAR_NONCE_KEY = "whengames_calendar_oauth_nonce";
const CALENDAR_CONNECTED_KEY = "whengames_calendar_just_connected";
const CALENDAR_REOPEN_SETTINGS_KEY =
  "whengames_reopen_settings_after_calendar_oauth";

export function CalendarCallbackPage() {
  useEffect(() => {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const success = params.get("success");
    const error = params.get("error");
    const fullState = params.get("state") || "/";

    const pipeIndex = fullState.indexOf("|");
    const nonce = pipeIndex >= 0 ? fullState.substring(0, pipeIndex) : "";
    const redirect = pipeIndex >= 0 ? fullState.substring(pipeIndex + 1) : fullState;

    const storedNonce = sessionStorage.getItem(CALENDAR_NONCE_KEY);
    sessionStorage.removeItem(CALENDAR_NONCE_KEY);

    if (!storedNonce || nonce !== storedNonce) {
      console.warn("Calendar OAuth nonce mismatch");
      window.location.replace("/");
      return;
    }

    if (success === "true") {
      sessionStorage.setItem(CALENDAR_CONNECTED_KEY, "true");
    } else if (error) {
      sessionStorage.setItem(CALENDAR_CONNECTED_KEY, `error:${error}`);
    }
    sessionStorage.setItem(CALENDAR_REOPEN_SETTINGS_KEY, "true");

    window.location.replace(redirect || "/");
  }, []);

  return (
    <div className={styles.callbackShell}>
      <span className={styles.mutedText}>Connecting calendar...</span>
    </div>
  );
}
