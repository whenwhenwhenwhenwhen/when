/**
 * Mock replacement for "convex/react".
 *
 * Vite aliases "convex/react" → this file in design mode. Components that
 * import { useQuery, useMutation, useAction } from "convex/react" transparently get
 * these mock implementations instead.
 *
 * Reactivity: every useQuery subscribes to a global version counter via
 * useSyncExternalStore. Mutations bump the counter, causing all queries
 * to re-execute synchronously in the next render.
 */

import { useSyncExternalStore, useCallback, useMemo, type ReactNode } from "react";
import { subscribe, getSnapshot } from "./store";
import { queryHandlers } from "./handlers/queries";
import { mutationHandlers } from "./handlers/mutations";

// Side-effect: populate the in-memory store with seed data on first load
import "./seed";

// ---------------------------------------------------------------------------
// useConvexAuth
// ---------------------------------------------------------------------------

/** Design mode is always anonymous and finishes auth initialization immediately. */
export function useConvexAuth() {
  return { isLoading: false, isAuthenticated: false };
}

// ---------------------------------------------------------------------------
// Function name extraction
// ---------------------------------------------------------------------------

/**
 * Extract the function name from a Convex function reference.
 *
 * The `anyApi` proxy stores function names under `Symbol.for("functionName")`.
 * e.g. api.schedules.list  →  "schedules:list"
 */
const FUNCTION_NAME_SYM = Symbol.for("functionName");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFnName(ref: any): string {
  if (typeof ref === "string") return ref;
  const name = ref[FUNCTION_NAME_SYM];
  if (!name) {
    throw new Error(`[mock] Cannot resolve function name from reference: ${String(ref)}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// useQuery
// ---------------------------------------------------------------------------

/**
 * Mock useQuery — returns data synchronously from the in-memory store.
 *
 * - Returns `undefined` when args === "skip" (matches real Convex behavior).
 * - Re-executes the handler whenever the store version changes (mutation fired)
 *   or when the args change.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useQuery(functionRef: any, args?: any): any {
  const fnName = getFnName(functionRef);

  // Subscribe to store changes for reactivity
  const version = useSyncExternalStore(subscribe, getSnapshot);

  // Stable key for args so useMemo can compare
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args ?? {});

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (args === "skip") return undefined;

    const handler = queryHandlers[fnName];
    if (!handler) {
      console.warn(`[mock] No query handler for "${fnName}" — returning undefined`);
      return undefined;
    }
    return handler(args ?? {});
    // version is included so queries re-run when mutations change data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fnName, argsKey]);
}

// ---------------------------------------------------------------------------
// useMutation
// ---------------------------------------------------------------------------

/**
 * Mock useMutation — returns an async function that runs the mutation handler
 * against the in-memory store.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation(functionRef: any): (args?: any) => Promise<any> {
  const fnName = getFnName(functionRef);

  return useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args?: any) => {
      const handler = mutationHandlers[fnName];
      if (!handler) {
        console.warn(`[mock] No mutation handler for "${fnName}" — no-op`);
        return;
      }
      return handler(args ?? {});
    },
    [fnName],
  );
}

// ---------------------------------------------------------------------------
// useAction
// ---------------------------------------------------------------------------

/**
 * Mock useAction — returns an async no-op for action-backed flows.
 *
 * Design mode does not model external services such as Google Calendar or
 * Discord, but components still need the hook export so they can render.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useAction(functionRef: any): (args?: any) => Promise<any> {
  const fnName = getFnName(functionRef);

  return useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    async (_args?: any) => {
      console.warn(`[mock] No action handler for "${fnName}" — no-op`);
      return undefined;
    },
    [fnName],
  );
}

// ---------------------------------------------------------------------------
// ConvexReactClient
// ---------------------------------------------------------------------------

/**
 * No-op mock of ConvexReactClient. Accepts any URL (including undefined).
 */
export class ConvexReactClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_url: string) {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// ConvexProviderWithAuth
// ---------------------------------------------------------------------------

/**
 * Mock provider that simply renders its children.
 * The real provider sets up WebSocket connections and auth — none of that
 * is needed in design mode.
 */
export function ConvexProviderWithAuth({
  children,
}: {
  children: ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}) {
  return children;
}
