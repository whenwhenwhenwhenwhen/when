// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AnonymousUserProvider,
  useAnonymousUser,
} from "./useAnonymousUser";

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

describe("AnonymousUserProvider", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
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
    expect(localStorage.getItem("whengames_anonymous_name")).toBe("Ada");
  });
});
