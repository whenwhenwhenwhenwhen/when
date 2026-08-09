// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnonymousUserProvider,
  useAnonymousUser,
} from "./useAnonymousUser";

const authMocks = vi.hoisted(() => ({ clearAnonymousClaim: vi.fn() }));

vi.mock("../lib/authClient", () => ({
  getOrCreateAnonymousClaim: () => "a".repeat(64),
  clearAnonymousClaim: authMocks.clearAnonymousClaim,
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

function GuestStatus() {
  const { displayName, hasInteracted } = useAnonymousUser();
  return (
    <output data-testid="guest-status">
      {hasInteracted ? displayName : "anonymous"}
    </output>
  );
}

function GuestJoin() {
  const { setDisplayName } = useAnonymousUser();
  return <button onClick={() => setDisplayName("Ada")}>Join as guest</button>;
}

function IdentityControls() {
  const { anonymousClaim, clearAnonymousUser, startAnonymousUser } =
    useAnonymousUser();
  return (
    <>
      <output data-testid="claim">{anonymousClaim}</output>
      <button onClick={clearAnonymousUser}>Clear identity</button>
      <button onClick={startAnonymousUser}>Start identity</button>
    </>
  );
}

describe("AnonymousUserProvider", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    authMocks.clearAnonymousClaim.mockClear();
  });

  it("shares the anonymous-to-guest transition with every mounted consumer", () => {
    render(
      <AnonymousUserProvider>
        <GuestStatus />
        <GuestJoin />
      </AnonymousUserProvider>,
    );

    expect(screen.getByTestId("guest-status").textContent).toBe("anonymous");

    fireEvent.click(screen.getByRole("button", { name: "Join as guest" }));

    expect(screen.getByTestId("guest-status").textContent).toBe("Ada");
    expect(localStorage.getItem("when_anonymous_name")).toBe("Ada");
  });

  it("can mint a fresh anonymous identity after Google sign-out", () => {
    render(
      <AnonymousUserProvider>
        <IdentityControls />
      </AnonymousUserProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear identity" }));
    expect(screen.getByTestId("claim").textContent).toBe("");
    expect(authMocks.clearAnonymousClaim).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Start identity" }));
    expect(screen.getByTestId("claim").textContent).toBe("a".repeat(64));
  });
});
