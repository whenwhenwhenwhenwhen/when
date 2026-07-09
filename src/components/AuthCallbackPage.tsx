import { useEffect } from "react";
import {
  TOKEN_KEY,
  SESSION_KEY,
  OAUTH_NONCE_KEY,
  validateGoogleJwt,
} from "../lib/googleAuth";
import styles from "../styles/app.module.css";

/**
 * Route component mounted at /auth/callback.
 *
 * After the Convex HTTP endpoint exchanges the Google authorization code for
 * an ID token, it redirects the browser here with the token, session token,
 * and state in the URL fragment:
 *
 *   /auth/callback#token=<jwt>&session=<uuid>&redirect=<nonce|path>
 *
 * This component:
 * 1. Verifies the CSRF nonce against sessionStorage (prevents session fixation)
 * 2. Validates the JWT structure and claims (defense-in-depth)
 * 3. Stores the ID token and session token in localStorage
 * 4. Navigates to the original page via full-page load so the
 *    GoogleAuthProvider re-initialises with the fresh token
 *
 * The session token is an opaque UUID — it does not contain any secrets.
 * The actual refresh token is stored server-side only and is never sent
 * to the client.
 */
export function AuthCallbackPage() {
  useEffect(() => {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    const sessionToken = params.get("session");
    const fullState = params.get("redirect") || "/";

    // ── CSRF nonce verification ──────────────────────────────────────────
    const pipeIndex = fullState.indexOf("|");
    const nonce = pipeIndex >= 0 ? fullState.substring(0, pipeIndex) : "";
    const redirect =
      pipeIndex >= 0 ? fullState.substring(pipeIndex + 1) : fullState;

    const storedNonce = sessionStorage.getItem(OAUTH_NONCE_KEY);
    sessionStorage.removeItem(OAUTH_NONCE_KEY);

    if (!storedNonce || nonce !== storedNonce) {
      console.warn(
        "OAuth CSRF verification failed — nonce mismatch. " +
          "Possible session-fixation attempt. Discarding token.",
      );
      window.location.replace("/");
      return;
    }

    // ── Token validation & storage ───────────────────────────────────────
    if (token) {
      if (validateGoogleJwt(token)) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        console.warn(
          "Received Google ID token failed client-side validation. " +
            "Discarding token.",
        );
      }
    }

    if (sessionToken) {
      localStorage.setItem(SESSION_KEY, sessionToken);
    }

    window.location.replace(redirect || "/");
  }, []);

  return (
    <div className={styles.callbackShell}>
      <span className={styles.mutedText}>Signing in...</span>
    </div>
  );
}
