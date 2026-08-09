// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnonymousUserProvider } from "../hooks/useAnonymousUser";
import { AuthProfileSync } from "./AuthProfileSync";

const mocks = vi.hoisted(() => ({
  ensureProfile: vi.fn(() => Promise.resolve("profile-id")),
  clearAnonymousClaim: vi.fn(),
}));
const CLAIM = "a".repeat(64);

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useMutation: () => mocks.ensureProfile,
}));

vi.mock("../hooks/useTimezone", () => ({
  useTimezone: () => ({ timezone: "Australia/Melbourne" }),
}));

vi.mock("../lib/authClient", () => ({
  getOrCreateAnonymousClaim: () => CLAIM,
  clearAnonymousClaim: mocks.clearAnonymousClaim,
}));

describe("AuthProfileSync", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    mocks.ensureProfile.mockClear();
    mocks.clearAnonymousClaim.mockClear();
  });

  it("upgrades the module-owned anonymous claim on the first authenticated sync", async () => {
    render(
      <AnonymousUserProvider>
        <AuthProfileSync />
      </AnonymousUserProvider>,
    );

    await waitFor(() => {
      expect(mocks.ensureProfile).toHaveBeenCalledTimes(1);
    });
    expect(mocks.ensureProfile).toHaveBeenCalledWith({
      anonymousClaim: CLAIM,
      timezone: "Australia/Melbourne",
    });
    expect(mocks.clearAnonymousClaim).toHaveBeenCalledTimes(1);
  });
});
