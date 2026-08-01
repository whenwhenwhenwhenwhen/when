export type DiscordLinkFailureReason =
  | "missing_permissions"
  | "channel_unavailable"
  | "discord_unavailable"
  | "configuration_error";

export function getDiscordInstallErrorMessage(
  code: string,
  missingPermissions: string[] = [],
): string {
  switch (code) {
    case "access_denied":
      return "Discord authorization was cancelled. No channel was linked.";
    case "missing_permissions": {
      const detail = missingPermissions.length
        ? ` Missing: ${missingPermissions.join(", ")}.`
        : "";
      return `Discord added When? to the server, but not all required permissions were granted.${detail} No channel was linked. Grant all four permissions and try again.`;
    }
    case "discord_not_configured":
      return "Discord added When? to the server, but this When? deployment is missing its Discord application credentials. Ask the administrator to finish configuring the integration, then try again.";
    case "oauth_exchange_failed":
      return "Discord added When? to the server, but the authorization code could not be validated. Check the Discord client secret and callback URL, then try again.";
    case "discord_credentials_invalid":
      return "Discord added When? to the server, but the configured bot credentials were rejected. Ask the administrator to update the Discord bot token, then try again.";
    case "discord_server_access_failed":
      return "Discord added When? to the server, but the bot could not access that server. Confirm the bot is still installed and try again.";
    case "missing_params":
      return "Discord returned an incomplete authorization response. No channel was linked; please start again.";
    case "install_callback_failed":
      return "Discord added When? to the server, but When? could not finish reading the server details. No channel was linked. Please retry, and check the Convex logs if it happens again.";
    default:
      return "Discord authorization could not be completed. No channel was linked; please start again.";
  }
}

export function getDiscordLinkFailureMessage(
  reason: DiscordLinkFailureReason,
  channelName: string,
): string {
  switch (reason) {
    case "missing_permissions":
      return `When? cannot post in #${channelName}. Grant View Channels, Send Messages, Embed Links, and Read Message History to the When? bot in this channel, then try again.`;
    case "channel_unavailable":
      return `#${channelName} is no longer available to the When? bot. Choose another channel or update its channel permissions.`;
    case "configuration_error":
      return "Discord rejected the configured bot credentials. Ask the When? administrator to update the Discord configuration.";
    case "discord_unavailable":
      return "Discord could not be reached while linking this channel. No link was saved; please try again.";
  }
}
