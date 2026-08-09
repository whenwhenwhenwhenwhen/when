import { createElement, type ReactNode } from "react";
import { createGooglyAuthClient } from "@clammet/convex-googly-auth/react";
import { getConfig } from "../config";

type AuthClient = ReturnType<typeof createGooglyAuthClient>;

let client: AuthClient | null = null;

function getAuthClient(): AuthClient {
  if (client !== null) return client;
  const config = getConfig();
  client = createGooglyAuthClient({
    convexSiteUrl: config.CONVEX_SITE_URL,
    googleClientId: config.GOOGLE_CLIENT_ID,
    storagePrefix: "when",
  });
  return client;
}

export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  return createElement(getAuthClient().GoogleAuthProvider, null, children);
}

export function useGoogleAuth() {
  return getAuthClient().useGoogleAuth();
}

export function useConvexGooglyAuth() {
  return getAuthClient().useConvexGooglyAuth();
}

export function getOrCreateAnonymousClaim() {
  return getAuthClient().getOrCreateAnonymousClaim();
}

export function clearAnonymousClaim() {
  getAuthClient().clearAnonymousClaim();
}

export function handleAuthCallback() {
  return getAuthClient().handleAuthCallback();
}
