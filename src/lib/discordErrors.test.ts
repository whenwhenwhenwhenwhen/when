import { describe, expect, it } from "vitest";
import {
  getDiscordInstallErrorMessage,
  getDiscordLinkFailureMessage,
} from "./discordErrors";

describe("Discord user-facing errors", () => {
  it("names permissions declined during installation", () => {
    expect(
      getDiscordInstallErrorMessage("missing_permissions", [
        "Embed Links",
        "Read Message History",
      ]),
    ).toContain("Missing: Embed Links, Read Message History");
  });

  it("explains why a bot can join before backend setup fails", () => {
    expect(getDiscordInstallErrorMessage("discord_not_configured")).toContain(
      "Discord added When? to the server",
    );
  });

  it("provides channel-specific guidance for permission failures", () => {
    const message = getDiscordLinkFailureMessage(
      "missing_permissions",
      "scheduling",
    );
    expect(message).toContain("#scheduling");
    expect(message).toContain("Send Messages");
  });
});
