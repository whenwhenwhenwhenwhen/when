import { useEffect, useRef } from "react";
import { handleAuthCallback } from "../lib/authClient";
import styles from "../styles/app.module.css";

/**
 * Route component mounted at /auth/callback.
 *
 * The auth module verifies the signed OAuth state and nonce, validates and
 * stores the returned token pair, and supplies the safe relative redirect.
 */
export function AuthCallbackPage() {
  // The nonce is single-use, so a second invocation (StrictMode remounts the
  // effect in development) would always fail verification.
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const result = handleAuthCallback();
    if (result.error !== null) {
      console.warn("Google sign-in failed:", result.error);
    }
    window.location.replace(result.redirect);
  }, []);

  return (
    <div className={styles.callbackShell}>
      <span className={styles.mutedText}>Signing in...</span>
    </div>
  );
}
