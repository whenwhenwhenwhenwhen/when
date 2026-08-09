/**
 * Mock replacement for "src/lib/authClient.tsx".
 *
 * In design mode, the user is always anonymous (not authenticated).
 * All auth actions are no-ops.
 */

import { type ReactNode } from "react";
import { MOCK_ANONYMOUS_CLAIM } from "./identity";

// ---------------------------------------------------------------------------
// GoogleAuthProvider — renders children, no auth context needed
// ---------------------------------------------------------------------------

export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// useGoogleAuth — always anonymous
// ---------------------------------------------------------------------------

export function useGoogleAuth() {
  return {
    isLoading: false,
    isAuthenticated: false,
    token: null as string | null,
    signIn: (_returnPath?: string) => {
      console.log("[mock] signIn called — no-op in design mode");
    },
    signOut: () => {
      console.log("[mock] signOut called — no-op in design mode");
    },
    refreshAuth: async () => null as string | null,
  };
}

// ---------------------------------------------------------------------------
// useConvexGooglyAuth — consumed by ConvexProviderWithAuth
// ---------------------------------------------------------------------------

export function useConvexGooglyAuth() {
  return {
    isLoading: false,
    isAuthenticated: false,
    fetchAccessToken: async () => null as string | null,
  };
}

export function getOrCreateAnonymousClaim() {
  return MOCK_ANONYMOUS_CLAIM;
}

export function clearAnonymousClaim() {}

export function handleAuthCallback() {
  return { redirect: "/", error: "Authentication is disabled in design mode" };
}
