// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduleOptionsMenu } from "./ScheduleOptionsMenu";

describe("ScheduleOptionsMenu", () => {
  it("exposes schedule controls and opens the edit modal action", () => {
    const onDisallowOutsideNominations = vi.fn();
    const onToggleAcceptParticipation = vi.fn();
    const onToggleAnyoneCanLock = vi.fn();
    const onEditSchedule = vi.fn();

    render(
      <ScheduleOptionsMenu
        acceptParticipation
        anyoneCanLock={false}
        onDisallowOutsideNominations={onDisallowOutsideNominations}
        onToggleAcceptParticipation={onToggleAcceptParticipation}
        onToggleAnyoneCanLock={onToggleAnyoneCanLock}
        onEditSchedule={onEditSchedule}
        discordLinkAction={<button type="button">Link to Discord</button>}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Link to Discord" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Schedule options" }),
    );
    within(screen.getByRole("dialog", { name: "Schedule options" })).getByRole(
      "button",
      { name: "Link to Discord" },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close participation" }),
    );
    expect(onToggleAcceptParticipation).toHaveBeenCalledWith(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Allow anyone to lock in times" }),
    );
    expect(onToggleAnyoneCanLock).toHaveBeenCalledWith(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Disallow outside nominations" }),
    );
    expect(onDisallowOutsideNominations).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "Schedule options" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule…" }));
    expect(onEditSchedule).toHaveBeenCalledOnce();
  });
});
