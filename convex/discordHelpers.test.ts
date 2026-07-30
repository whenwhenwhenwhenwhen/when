import { describe, expect, it } from "vitest";
import {
  buildLockedSlotSnapshot,
  buildSummaryMessage,
  SummaryInput,
} from "./discordHelpers";

describe("Discord schedule summaries across timezones", () => {
  const input: SummaryInput = {
    schedule: {
      _id: "schedule",
      title: "Timezone summary",
      type: "recurring",
      creatorTimezone: "America/New_York",
      lockedSlots: [{ dayKey: "1", timeSlot: "09:00" }],
      isLocked: true,
    },
    profileNames: {
      alice: "Alice",
      bob: "Bob",
      charlie: "Charlie",
    },
    selections: [
      {
        profileId: "alice",
        dayKey: "1",
        timeSlot: "09:00",
        timezone: "America/New_York",
        state: "can-do",
      },
      {
        profileId: "bob",
        dayKey: "1",
        timeSlot: "23:00",
        timezone: "Australia/Melbourne",
        state: "maybe",
      },
      {
        profileId: "charlie",
        dayKey: "1",
        timeSlot: "09:00",
        timezone: "Australia/Melbourne",
        state: "cant-do",
      },
    ],
    referenceDate: "2026-07-29",
    appBaseUrl: "https://example.com",
  };

  it("matches and tallies nominations in the schedule timezone", () => {
    const snapshot = buildLockedSlotSnapshot(input);
    expect(snapshot).toContain("alice:can-do");
    expect(snapshot).toContain("bob:maybe");
    expect(snapshot).not.toContain("charlie:cant-do");

    const payload = buildSummaryMessage(input);
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("Bob");
    expect(rendered).toContain("America/New_York");
  });
});
