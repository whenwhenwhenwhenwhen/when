import { useState, useCallback } from "react";

const ANON_ID_KEY = "whengames_anonymous_id";
const ANON_NAME_KEY = "whengames_anonymous_name";

function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Hook to manage anonymous user identity via localStorage.
 *
 * - Generates/retrieves a persistent anonymous ID
 * - Stores display name
 * - Provides methods to update the display name
 */
export function useAnonymousUser() {
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

  return {
    anonymousId,
    displayName,
    setDisplayName,
    clearAnonymousUser,
    hasInteracted,
  };
}
