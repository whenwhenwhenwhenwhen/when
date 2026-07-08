# Discord Integration Setup

When?'s Discord integration provides two related features:

- A schedule creator can link a schedule to a Discord text or announcement
  channel. The app posts a summary embed and edits that message when the
  schedule's locked times change.
- The `/when` command lets a Discord user choose a schedule and post its
  summary into the current channel.

Discord Activities are not part of this integration.

## Prerequisites

Before configuring Discord, the normal When? deployment must already work:

- The frontend has a public URL.
- Convex functions are deployed.
- `SITE_URL` on the Convex deployment is the frontend URL.
- The frontend's Convex Site URL points to
  `https://your-deployment.convex.site`.

For local frontend development, the Discord callback still uses the public
Convex Site URL. Set `SITE_URL=http://localhost:5173` on the development Convex
deployment so Convex can redirect back to the local frontend after Discord
finishes.

The person installing the bot into a Discord server must have permission to
add apps to that server, normally through the **Manage Server** permission.

## 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application and give it the name and icon that should appear in
   Discord.
3. On **General Information**, copy:
   - **Application ID**: used as both the application ID and client ID.
   - **Public Key**: used to verify incoming Discord interactions.
4. On **OAuth2**, copy or reset the **Client Secret**.
5. On **Bot**, reset and copy the **Bot Token**.

The client ID is safe to expose in frontend configuration. The client secret,
bot token, and public key configuration belong on the Convex deployment and
must not be placed in frontend environment files or committed.

No Gateway connection or privileged Gateway intents are used by the current
implementation.

### Bot installation settings

The application must support installation to a Discord server, also called
**Guild Install**.

Enable **Requires OAuth2 Code Grant** on the bot. The When? install flow expects
Discord to return an authorization code, `guild_id`, and state to the Convex
callback, then exchanges the code using the client secret.

Enable **Public Bot** if people other than the Discord application owner should
be able to install it.

## 2. Configure Discord URLs

Replace `your-deployment` with the Convex deployment name used by the
frontend.

Under **OAuth2 > Redirects**, add this exact redirect:

```text
https://your-deployment.convex.site/discord/install-callback
```

Under **General Information > Interactions Endpoint URL**, set:

```text
https://your-deployment.convex.site/discord/interactions
```

Discord validates the interactions endpoint by sending a signed PING request.
The Convex functions must be deployed and `DISCORD_PUBLIC_KEY` must be set
before this validation can succeed.

The redirect URL must match exactly. Do not use the frontend URL and do not add
a trailing slash.

## 3. Set Convex environment variables

Set these on each Convex deployment where Discord should work:

```bash
npx convex env set DISCORD_APP_ID your_application_id
npx convex env set DISCORD_BOT_TOKEN your_bot_token
npx convex env set DISCORD_PUBLIC_KEY your_public_key
npx convex env set DISCORD_CLIENT_SECRET your_client_secret
```

The variables have the following roles:

| Variable | Purpose |
| --- | --- |
| `DISCORD_APP_ID` | Discord Application ID; the same value as the client ID |
| `DISCORD_BOT_TOKEN` | Authenticates outbound Discord REST API requests |
| `DISCORD_PUBLIC_KEY` | Verifies signed requests to the interactions endpoint |
| `DISCORD_CLIENT_SECRET` | Exchanges the installation authorization code |
| `DISCORD_DEBOUNCE_MS` | Optional delay before updating a linked summary; defaults to 300000 ms |

The existing `SITE_URL` variable is also required because the callback
redirects from Convex back to the frontend's `/discord/link-channel` route.

To change the five-minute update debounce:

```bash
npx convex env set DISCORD_DEBOUNCE_MS 60000
```

Make sure the Convex CLI is targeting the intended development or production
deployment before setting values or registering commands. The same Discord
application can be used for both, but every Convex Site callback URL must be
registered in Discord.

## 4. Expose the client ID to the frontend

For Vite development, add this to `.env.local`:

```env
VITE_DISCORD_CLIENT_ID=your_application_id
```

For the Docker image, pass:

```bash
-e DISCORD_CLIENT_ID=your_application_id
```

Docker writes that value into `/config.json` at container startup. Restart the
container after changing it. For a statically built Vite deployment, rebuild
the frontend after changing `VITE_DISCORD_CLIENT_ID`.

The frontend also needs its existing Convex Site URL:

```env
VITE_CONVEX_SITE_URL=https://your-deployment.convex.site
```

or, for Docker:

```bash
-e CONVEX_SITE_URL=https://your-deployment.convex.site
```

## 5. Deploy the Convex functions

Deploy after the Discord HTTP routes and backend functions are present:

```bash
npx convex deploy
```

For a development deployment, keep `npx convex dev` running while testing.

## 6. Register the `/when` command

Register the global command once:

```bash
npx convex run discordSetup:registerCommands
```

Run this again only when the command definition changes. Global command
availability can be delayed by Discord.

For immediate testing in one server, enable Discord Developer Mode, copy the
server ID, and register a guild-scoped command:

```bash
npx convex run discordSetup:registerGuildCommands '{"guildId":"YOUR_GUILD_ID"}'
```

Guild commands update immediately. A guild command and a global command can
temporarily coexist during testing.

## 7. Verify the integration

### Schedule-to-channel linking

1. Open a schedule as its creator.
2. Select **Link to Discord**.
3. Choose a server in Discord and authorize the bot.
4. Back in When?, choose a text or announcement channel.
5. Confirm that an initial schedule summary appears in that channel.
6. Lock schedule times or change availability that affects locked times.
7. Confirm that the existing Discord message is edited after the debounce
   period rather than a new message being posted each time.

Only the schedule creator can start a link. Text channels and announcement
channels are shown in the channel picker. Installation sessions expire after
15 minutes, so restart the flow if the callback is left open too long.

### Slash command

1. Run `/when` in a channel where the app is installed.
2. Choose a schedule from the private selection menu.
3. Confirm that the selected summary is posted publicly.

Discord user-to-When? profile linking exists in the data model, but its public
UI is not complete. Until that is implemented, `/when` falls back to schedules
that are listed and available to the caller rather than reliably showing only
that Discord user's schedules.

## Required Discord channel permissions

The bot needs these permissions in every linked channel:

- View Channel
- Send Messages
- Embed Links
- Read Message History

Channel-specific permission overrides can still deny these permissions even
when the bot's server role allows them.

The frontend requests permission integer `84992`, which combines all four
permissions above. Server and channel permission overrides still apply after
installation.

## Troubleshooting

### “Discord client ID is not configured”

Set `VITE_DISCORD_CLIENT_ID` for Vite or `DISCORD_CLIENT_ID` for Docker, then
rebuild or restart the frontend as appropriate.

### Discord reports an invalid redirect URI

Confirm that the authorization request and Discord portal both use:

```text
https://your-deployment.convex.site/discord/install-callback
```

Check the deployment name, scheme, path, and trailing slash.

### Discord rejects the interactions endpoint

- Confirm the latest Convex functions are deployed.
- Confirm `DISCORD_PUBLIC_KEY` came from the same Discord application as
  `DISCORD_APP_ID`.
- Confirm the endpoint uses the Convex Site URL, not the `.convex.cloud` URL or
  the frontend URL.
- Check Convex logs for `DISCORD_PUBLIC_KEY env var not set` or signature
  verification errors.

### Installation returns `oauth_exchange_failed`

- Confirm `DISCORD_CLIENT_SECRET` is set on the same Convex deployment handling
  the callback.
- Confirm the secret belongs to the same application as `DISCORD_APP_ID`.
- Confirm **Requires OAuth2 Code Grant** is enabled.
- If the client secret was reset in Discord, update the Convex value.

### No channels appear in the channel picker

- Confirm the bot was added to the selected server.
- Confirm `DISCORD_BOT_TOKEN` is valid.
- Confirm the bot can view the intended channel.
- Only normal text channels and announcement channels are listed.

### The bot cannot post or edit a summary

Check View Channel, Send Messages, Embed Links, and Read Message History on the
specific channel. Also check Convex logs for Discord API status codes.

### `/when` is missing

Register a guild command for immediate testing. If the guild command works,
register the global command and allow time for Discord to propagate it.

## Relevant implementation files

- `src/components/DiscordLinkButton.tsx`: starts bot installation and defines
  the requested scopes and permissions.
- `src/components/DiscordChannelPickerPage.tsx`: validates the install state and
  lets the schedule creator select a channel.
- `convex/http.ts`: Discord interactions and installation callback routes.
- `convex/discord.ts`: install sessions, links, summary sends, and debounced
  updates.
- `convex/discordHelpers.ts`: Discord API, OAuth exchange, signature
  verification, and embed formatting.
- `convex/discordSetup.ts`: global and guild `/when` registration actions.

## Discord references

- [OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Receiving and responding to interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
