import { describe, expect, it } from "vitest";
import {
  DISCORD_REQUIRED_PERMISSION_BITS,
  DISCORD_REQUIRED_PERMISSIONS,
  getMissingDiscordPermissions,
} from "./discordPermissions";

describe("Discord install permissions", () => {
  it("keeps the OAuth permission bitfield in sync with the required list", () => {
    expect(DISCORD_REQUIRED_PERMISSION_BITS).toBe("84992");
    expect(getMissingDiscordPermissions(DISCORD_REQUIRED_PERMISSION_BITS)).toEqual(
      [],
    );
  });

  it.each(DISCORD_REQUIRED_PERMISSIONS)(
    "reports a missing $label grant",
    ({ bit, label }) => {
      const granted = BigInt(DISCORD_REQUIRED_PERMISSION_BITS) & ~bit;
      expect(getMissingDiscordPermissions(granted.toString())).toEqual([label]);
    },
  );

  it("treats an absent or malformed callback bitfield as missing every grant", () => {
    const labels = DISCORD_REQUIRED_PERMISSIONS.map(({ label }) => label);
    expect(getMissingDiscordPermissions(null)).toEqual(labels);
    expect(getMissingDiscordPermissions("not-a-number")).toEqual(labels);
  });
});
