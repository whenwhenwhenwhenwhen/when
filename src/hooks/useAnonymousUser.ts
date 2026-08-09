import {
  createElement,
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  clearAnonymousClaim,
  getOrCreateAnonymousClaim,
} from "../lib/authClient";

const ANON_NAME_KEY = "when_anonymous_name";

interface AnonymousUserContextValue {
  anonymousClaim: string;
  displayName: string;
  setDisplayName: (name: string) => void;
  clearAnonymousUser: () => void;
  startAnonymousUser: () => void;
  hasInteracted: boolean;
}

const AnonymousUserContext = createContext<AnonymousUserContextValue | null>(
  null,
);

/**
 * Adds app profile state to the auth module's anonymous identity claim.
 *
 * - The bearer claim is stored in a cookie by @clammet/convex-googly-auth
 * - Stores display name
 * - Shares updates between every mounted consumer
 */
export function AnonymousUserProvider({ children }: PropsWithChildren) {
  const [anonymousClaim, setAnonymousClaim] = useState<string>(
    () => getOrCreateAnonymousClaim() ?? "",
  );
  const [displayName, setDisplayNameState] = useState<string>(
    () => localStorage.getItem(ANON_NAME_KEY) || "",
  );

  const setDisplayName = useCallback((name: string) => {
    localStorage.setItem(ANON_NAME_KEY, name);
    setDisplayNameState(name);
  }, []);

  const clearAnonymousUser = useCallback(() => {
    clearAnonymousClaim();
    localStorage.removeItem(ANON_NAME_KEY);
    setAnonymousClaim("");
    setDisplayNameState("");
  }, []);

  const startAnonymousUser = useCallback(() => {
    setAnonymousClaim(getOrCreateAnonymousClaim() ?? "");
  }, []);

  const hasInteracted = displayName.length > 0;

  const value = useMemo(
    () => ({
      anonymousClaim,
      displayName,
      setDisplayName,
      clearAnonymousUser,
      startAnonymousUser,
      hasInteracted,
    }),
    [
      anonymousClaim,
      clearAnonymousUser,
      displayName,
      hasInteracted,
      setDisplayName,
      startAnonymousUser,
    ],
  );

  return createElement(AnonymousUserContext.Provider, { value }, children);
}

export function useAnonymousUser() {
  const context = useContext(AnonymousUserContext);
  if (!context) {
    throw new Error(
      "useAnonymousUser must be used within an AnonymousUserProvider",
    );
  }
  return context;
}
