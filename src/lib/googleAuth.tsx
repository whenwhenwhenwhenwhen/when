/**
 * Google OAuth authentication for Convex.
 *
 * ## Security model
 *
 * **Authenticated users (Google)**
 * The credential is a Google-issued ID token (JWT, RS256). It is signed by
 * Google's private RSA key and verified in two places:
 *
 * 1. **Server-side (authoritative)** — Convex fetches Google's JWKS via OIDC
 *    discovery (`https://accounts.google.com/.well-known/openid-configuration`)
 *    and cryptographically verifies the signature on every request. This is
 *    configured in `convex/auth.config.ts`. Forging a token requires Google's
 *    private key, which is cryptographically infeasible.
 *
 * 2. **Client-side (defense-in-depth)** — Before storing a token we validate
 *    its structure, algorithm (`RS256`), issuer (`accounts.google.com`),
 *    audience (our Google Client ID), and expiry. This prevents storing
 *    garbage, expired, or misrouted tokens — but is NOT a substitute for
 *    server-side verification.
 *
 * **Session persistence**
 * On login, the Convex backend exchanges the OAuth code for tokens. If Google
 * returns a refresh token it is stored **server-side only** in the
 * `authSessions` table — it never leaves the backend. The client receives an
 * opaque session token (random UUID) which it stores in `localStorage`. When
 * the short-lived ID token (~1 hour) expires, the client sends its session
 * token to `/auth/refresh`; the backend uses the stored refresh token to
 * obtain a new ID token from Google and returns **only the ID token**.
 *
 * The refresh token is never included in any HTTP response, URL fragment, or
 * client-accessible storage. It is only used inside Convex HTTP actions.
 *
 * **Token storage**
 * The ID token and session token are stored in `localStorage`. This is the
 * standard approach for SPAs that use `ConvexProviderWithAuth`. The main risk
 * is XSS exfiltration, mitigated by:
 *   - Short ID token lifetime (~1 hour, set by Google)
 *   - Session token is an opaque UUID with no embedded secrets
 *   - No refresh tokens stored client-side
 *   - CSP headers in production (recommended)
 *
 * **CSRF protection**
 * The OAuth `state` parameter carries a random nonce alongside the redirect
 * path. The nonce is stored in `sessionStorage` (per-tab, same-origin) before
 * redirecting to Google, and verified in `AuthCallbackPage` before accepting
 * the token. This prevents session-fixation attacks where an attacker tricks
 * a user into authenticating with the attacker's credentials.
 *
 * **Anonymous users**
 * Identified by a `crypto.randomUUID()` stored in `localStorage`. The UUID
 * has 122 bits of entropy and is practically unguessable. It is NOT signed
 * or verified — this is inherent to anonymous identity. The server never
 * grants elevated privileges based on an anonymous ID alone; features like
 * saved availabilities require Google authentication.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getConfig } from "../config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_KEY = "whengames_google_token";
const SESSION_KEY = "whengames_session_token";
const OAUTH_NONCE_KEY = "whengames_oauth_nonce";

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function decodeBase64Url(str: string): string {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(decodeBase64Url(part));
}

/**
 * Client-side validation of a Google ID token's structure and claims.
 *
 * This is defense-in-depth. The authoritative verification happens server-side
 * in Convex using Google's public JWKS keys.
 */
function validateGoogleJwt(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);

    if (header.alg !== "RS256") return false;

    if (
      payload.iss !== "https://accounts.google.com" &&
      payload.iss !== "accounts.google.com"
    ) {
      return false;
    }

    if (payload.aud !== getConfig().GOOGLE_CLIENT_ID) return false;

    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return false;
    }

    if (typeof payload.sub !== "string" || !payload.sub) return false;

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Silent token refresh (server-side refresh token, client never sees it)
// ---------------------------------------------------------------------------

let refreshPromise: Promise<string | null> | null = null;

/**
 * Call the backend `/auth/refresh` endpoint with the opaque session token.
 * The backend uses the stored refresh token internally and returns only a
 * fresh Google ID token. The refresh token never appears in the response.
 */
async function refreshIdToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const sessionToken = localStorage.getItem(SESSION_KEY);
      if (!sessionToken) return null;

      const response = await fetch(
        `${getConfig().CONVEX_SITE_URL}/auth/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionToken }),
        },
      );

      if (response.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        return null;
      }

      if (!response.ok) return null;

      const data = (await response.json()) as { idToken?: string };
      if (data.idToken && validateGoogleJwt(data.idToken)) {
        localStorage.setItem(TOKEN_KEY, data.idToken);
        return data.idToken;
      }

      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface GoogleAuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  signIn: (redirectTo?: string) => void;
  signOut: () => void;
  refreshAuth: () => Promise<string | null>;
}

const GoogleAuthContext = createContext<GoogleAuthContextType>({
  isLoading: true,
  isAuthenticated: false,
  token: null,
  signIn: () => {},
  signOut: () => {},
  refreshAuth: async () => null,
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function GoogleAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored && validateGoogleJwt(stored)) return stored;
    if (stored) localStorage.removeItem(TOKEN_KEY);
    return null;
  });

  const [isLoading, setIsLoading] = useState(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    const hasValidToken = stored !== null && validateGoogleJwt(stored);
    const hasSession = localStorage.getItem(SESSION_KEY) !== null;
    return !hasValidToken && hasSession;
  });

  // On mount: if we have a session but no valid token, silently refresh
  useEffect(() => {
    if (token || !localStorage.getItem(SESSION_KEY)) return;

    refreshIdToken().then((newToken) => {
      if (newToken) {
        setToken(newToken);
      }
      setIsLoading(false);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Proactively refresh 5 minutes before the ID token expires
  useEffect(() => {
    if (!token || !localStorage.getItem(SESSION_KEY)) return;

    try {
      const parts = token.split(".");
      const payload = decodeJwtPart(parts[1]);
      if (typeof payload.exp !== "number") return;

      const msUntilExpiry = payload.exp * 1000 - Date.now();
      const refreshIn = msUntilExpiry - 5 * 60 * 1000;

      if (refreshIn <= 0) {
        refreshIdToken().then((newToken) => {
          if (newToken) setToken(newToken);
        });
        return;
      }

      const timeout = setTimeout(() => {
        refreshIdToken().then((newToken) => {
          if (newToken) setToken(newToken);
        });
      }, refreshIn);

      return () => clearTimeout(timeout);
    } catch {
      // Malformed token — ignore, fetchAccessToken will handle it
    }
  }, [token]);

  const refreshAuth = useCallback(async () => {
    const newToken = await refreshIdToken();
    if (newToken) {
      setToken(newToken);
      return newToken;
    }
    return null;
  }, []);

  const signIn = useCallback((redirectTo?: string) => {
    const redirectUri = `${getConfig().CONVEX_SITE_URL}/auth/google/callback`;
    const path =
      redirectTo ??
      window.location.pathname + window.location.search + window.location.hash;

    const nonce = crypto.randomUUID();
    sessionStorage.setItem(OAUTH_NONCE_KEY, nonce);
    const state = `${nonce}|${path}`;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", getConfig().GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    window.location.href = authUrl.toString();
  }, []);

  const signOut = useCallback(() => {
    const sessionToken = localStorage.getItem(SESSION_KEY);

    // Local state is cleared first so the UI signs out immediately even if the
    // network call fails; the request destroys the server-side session, without
    // which the token would stay usable indefinitely.
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setToken(null);

    if (!sessionToken) return;

    void fetch(`${getConfig().CONVEX_SITE_URL}/auth/signout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
      keepalive: true,
    }).catch(() => {
      // Revocation is best-effort from the client; the session still expires
      // on its own deadline and the cleanup cron reaps it.
    });
  }, []);

  const value = useMemo<GoogleAuthContextType>(
    () => ({
      isLoading,
      isAuthenticated: !!token,
      token,
      signIn,
      signOut,
      refreshAuth,
    }),
    [isLoading, token, signIn, signOut, refreshAuth],
  );

  return (
    <GoogleAuthContext.Provider value={value}>
      {children}
    </GoogleAuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useGoogleAuth() {
  return useContext(GoogleAuthContext);
}

/**
 * Hook consumed by `ConvexProviderWithAuth`.
 * Returns `{ isLoading, isAuthenticated, fetchAccessToken }`.
 */
export function useConvexGoogleAuth() {
  const { isLoading, isAuthenticated, token, refreshAuth } = useGoogleAuth();

  // Read token from a ref so fetchAccessToken has a stable identity —
  // otherwise every refresh recreates the callback, ConvexProviderWithAuth
  // re-calls setAuth(), and the client briefly clears auth (flicker).
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: {
      forceRefreshToken: boolean;
    }) => {
      const t = tokenRef.current;
      if (t && validateGoogleJwt(t) && !forceRefreshToken) return t;

      const refreshed = await refreshAuth();
      if (refreshed) return refreshed;

      const current = tokenRef.current;
      if (current && validateGoogleJwt(current)) return current;
      return null;
    },
    [refreshAuth],
  );

  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}

export { TOKEN_KEY, SESSION_KEY, OAUTH_NONCE_KEY, validateGoogleJwt };
