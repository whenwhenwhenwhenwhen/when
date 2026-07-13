import { useEffect, useRef } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { useTimezone } from "../hooks/useTimezone";

/**
 * Root-level component that creates / merges user profiles after Google
 * sign-in completes.
 *
 * When `isAuthenticated` flips to true the component calls
 * `ensureAuthProfile` exactly once. The mutation server-side reads the
 * user's Google identity via `ctx.auth.getUserIdentity()` and either
 * links the existing anonymous profile or creates a new authenticated one.
 */
export function AuthProfileSync() {
  const { isAuthenticated } = useConvexAuth();
  const { anonymousId, clearAnonymousUser } = useAnonymousUser();
  const { timezone } = useTimezone();
  const ensureProfile = useMutation(api.users.ensureAuthProfile);
  const hasRun = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !hasRun.current) {
      hasRun.current = true;

      ensureProfile({
        anonymousId: anonymousId || undefined,
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
  }, [isAuthenticated, anonymousId, timezone, ensureProfile, clearAnonymousUser]);

  return null;
}
