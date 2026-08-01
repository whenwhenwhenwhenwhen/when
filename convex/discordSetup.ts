import { v } from "convex/values";
import { action } from "./_generated/server";
import { registerDiscordWhenCommand } from "./discordHelpers";

/**
 * One-shot registration action — run from the Convex dashboard or with
 *   npx convex run discordSetup:registerCommands
 *
 * Registers the global `/when` slash command on Discord. You only need
 * to run this when the command definition changes (rare). Global
 * command propagation can take up to an hour the first time; for
 * faster iteration during setup, register against a guild instead
 * using `registerGuildCommands`.
 *
 * Required env vars (set on the Convex deployment):
 *   DISCORD_APP_ID
 *   DISCORD_BOT_TOKEN
 */
export const registerCommands = action({
  args: {},
  handler: async () => await registerDiscordWhenCommand(),
});

/**
 * Register the command against a specific guild for fast iteration —
 * guild commands appear immediately and don't need to wait for the
 * global cache to propagate.
 */
export const registerGuildCommands = action({
  args: { guildId: v.string() },
  handler: async (_ctx, args) =>
    await registerDiscordWhenCommand(args.guildId),
});
