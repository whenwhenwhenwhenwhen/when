import {
  createElement,
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

const ANON_ID_KEY = "whengames_anonymous_id";
const ANON_NAME_KEY = "whengames_anonymous_name";

function generateUUID(): string {
  return crypto.randomUUID();
}

interface AnonymousUserContextValue {
  anonymousId: string;
  displayName: string;
  setDisplayName: (name: string) => void;
  clearAnonymousUser: () => void;
  hasInteracted: boolean;
}

const AnonymousUserContext = createContext<AnonymousUserContextValue | null>(
  null,
);

/**
 * Provides the app's anonymous user identity, persisted via localStorage.
 *
 * - Generates/retrieves a persistent anonymous ID
 * - Stores display name
 * - Shares updates between every mounted consumer
 */
export function AnonymousUserProvider({ children }: PropsWithChildren) {
  const [anonymousId, setAnonymousId] = useState<string>(() => {
    let id = localStorage.getItem(ANON_ID_KEY);
    if (!id) {
      id = generateUUID();
      localStorage.setItem(ANON_ID_KEY, id);
    }
    return id;
  });
  const [displayName, setDisplayNameState] = useState<string>(
    () => localStorage.getItem(ANON_NAME_KEY) || "",
  );

  const setDisplayName = useCallback((name: string) => {
    localStorage.setItem(ANON_NAME_KEY, name);
    setDisplayNameState(name);
  }, []);

  const clearAnonymousUser = useCallback(() => {
    localStorage.removeItem(ANON_ID_KEY);
    localStorage.removeItem(ANON_NAME_KEY);
    setAnonymousId("");
    setDisplayNameState("");
  }, []);

  const hasInteracted = displayName.length > 0;

  const value = useMemo(
    () => ({
      anonymousId,
      displayName,
      setDisplayName,
      clearAnonymousUser,
      hasInteracted,
    }),
    [
      anonymousId,
      clearAnonymousUser,
      displayName,
      hasInteracted,
      setDisplayName,
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
