import { useEffect, useRef } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { useTimezone } from "../hooks/useTimezone";

/**
 * Root-level component that creates / merges user profiles after Google
 * sign-in completes.
 *
 * When `isAuthenticated` flips to true the component asks the auth component
 * to upgrade or merge the current anonymous identity, then clears the retired
 * claim from the browser.
 */
export function AuthProfileSync() {
  const { isAuthenticated } = useConvexAuth();
  const { anonymousClaim, clearAnonymousUser } = useAnonymousUser();
  const { timezone } = useTimezone();
  const ensureProfile = useMutation(api.users.ensureProfile);
  const hasRun = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !hasRun.current) {
      hasRun.current = true;

      ensureProfile({
        anonymousClaim: anonymousClaim || undefined,
        timezone,
      })
        .then(() => {
          // Clear the anonymous identity so logging out returns to a
          // clean state instead of resurrecting the old cookie profile.
          clearAnonymousUser();
        })
        .catch((err) => {
          console.error("Failed to ensure auth profile:", err);
          hasRun.current = false; // allow retry
        });
    }
  }, [isAuthenticated, anonymousClaim, timezone, ensureProfile, clearAnonymousUser]);

  return null;
}
