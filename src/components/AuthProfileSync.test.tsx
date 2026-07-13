// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProfileSync } from "./AuthProfileSync";

const mocks = vi.hoisted(() => ({
  ensureProfile: vi.fn(() => Promise.resolve("profile-id")),
}));

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

describe("AuthProfileSync", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    mocks.ensureProfile.mockClear();
  });

  it("includes the stored anonymous identity in the first authenticated sync", async () => {
    localStorage.setItem("whengames_anonymous_id", "mobile-anonymous-id");

    render(<AuthProfileSync />);

    await waitFor(() => {
      expect(mocks.ensureProfile).toHaveBeenCalledTimes(1);
    });
    expect(mocks.ensureProfile).toHaveBeenCalledWith({
      anonymousId: "mobile-anonymous-id",
      timezone: "Australia/Melbourne",
    });
  });
});
