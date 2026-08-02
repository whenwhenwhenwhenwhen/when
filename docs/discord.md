# Discord Integration Setup

When?'s Discord integration provides two related features:

- A schedule creator can link a schedule to a Discord text or announcement
channel. The app posts a summary embed and either edits the latest summary or
  starts a fresh message when the schedule's locked times change.
- The `/when` command lets a Discord user choose from schedules created by or
  participated in by their connected When? profile, then post a summary into
  the current channel.

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
callback, then exchanges the code using the client secret. The flow also asks
for the standard `identify` scope so `/when` can connect the authorizing Discord
user to their When? profile; no email or other Discord account data is read.

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
| `DISCORD_DEBOUNCE_MS` | Optional delay before updating a linked summary; defaults to 60000 ms (60 seconds) |
| `DISCORD_NEW_MESSAGE_AFTER_MS` | Optional default age after which a relevant update starts a new message; defaults to 21600000 ms (6 hours), with `0` for latest-only and `-1` for never |

The existing `SITE_URL` variable is also required because the callback
redirects from Convex back to the frontend's `/discord/link-channel` route.

To change the 60-second update debounce:

```bash
npx convex env set DISCORD_DEBOUNCE_MS 60000
```

To change the deployment-wide six-hour message age:

```bash
npx convex env set DISCORD_NEW_MESSAGE_AFTER_MS 21600000
```

Set it to `0` to always edit the current latest maintained message, or `-1` to
stay anchored to the original linked message. Schedule creators can override
this default independently for each linked channel under **Schedule options →
Discord**.

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

The production GitHub Actions workflow registers the global command after each
successful Convex deployment. Discord treats registration by name as an upsert,
so repeated deployments update the existing command instead of creating
duplicates.

For development or a deployment outside that workflow, register it manually:

```bash
npx convex run discordSetup:registerCommands
```

Global command availability can be delayed by Discord.

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
2. Select **Schedule options → Discord → Link to Discord**.
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

Every public summary identifies its lifecycle in the embed footer:

- **Will update.** is the message When? currently maintains for that linked
  schedule and channel.
- **One time message.** is an informational `/when` share that is not currently
  maintained.

Schedule times use Discord's Unix timestamp markup, so every viewer sees dates
and times in their own Discord locale and timezone. Adjacent 30-minute cells
with the same nomination details are rendered as one start-to-end block.

For a schedule linked to the current channel, an unpinned `/when` share becomes
the new maintained message only when its effective **Start a new message after**
setting is a positive duration. With **Always update the latest message** (`0`)
or **Never** (`-1`), the share remains a one-time message.

The schedule linking flow connects the authorizing Discord user to the current
When? profile. Other Discord participants do not need to install the bot or
manage the server: if `/when` does not recognize them, its private response
contains a **Link When? account** button. That button opens a one-time link where
the user confirms the active When? profile. The link is tied to the Discord user
who invoked `/when`, expires after 15 minutes, and can only be used once.

After linking, `/when` offers up to 25 of that profile's most recently created
or participated-in schedules. Participation includes direct selections and
linked saved availability. It does not fall back to unrelated public schedules.

## Discord update debounce, retries, and status

The debounce prevents a burst of schedule edits from producing a burst of
Discord API calls. Locking or unlocking a time queues an update for
`DISCORD_DEBOUNCE_MS` milliseconds later (60 seconds by default). A subsequent
relevant change before that deadline cancels the old job and starts the delay
again. Availability changes only queue an update when they affect a currently
locked slot.

The initial message is sent immediately when a channel is linked. On a later
relevant change, When? checks the maintained target message's creation time:

- **Never** (`-1`) always edits the original linked message and never creates a
  replacement. If the original was deleted, the channel diagnostic reports a
  failed update instead of silently posting another message.
- **Always update the latest message** (`0`) edits the current maintained target
  without age-based rollover.
- If it is older than `DISCORD_NEW_MESSAGE_AFTER_MS` (six hours by default),
  When? posts a fresh message and treats it as the latest maintained summary.
- Otherwise, When? edits the latest message.
- If that latest message was manually deleted, When? posts a replacement.

A matching pinned When? summary always overrides these rules. It becomes the
maintained target on the next `/when` share or relevant debounced update, even
when the channel is set to **Never**. If the current maintained message is one
of several matching pinned summaries, it remains the stable target; otherwise
the most recently pinned match wins.

Whenever the maintained target changes, When? updates the previous target with
the current schedule data and changes its footer from **Will update.** to **One
time message.** The new target receives **Will update.**.

Each linked channel can override the deployment default with **Start a new
message after** in **Schedule options → Discord**. Recurring schedules also
offer **DST change notifications**, enabled by default for newly linked
channels. When enabled, an upcoming schedule or
participant UTC-offset change posts a fresh localized summary regardless of
the age policy, identifies the shifting participants, and reports participants
who have fallen out of at least one locked block. A matching pinned summary
still remains the maintained target instead of creating a duplicate.

Unlinking a channel queues deletion of every message recorded as part of that
channel link's lifecycle, including older rollover targets. Messages explicitly
created through `/when` are recorded separately and are preserved.

Open **Schedule options → Discord** to see each channel's diagnostics:

- **Update queued for …** means Convex has a scheduled update waiting for the
  debounce deadline.
- **Last sent …** is the last successful Discord post or edit.
- **Update failed …** includes the Discord HTTP error retained for that link.
- **View message in Discord** opens the message being maintained.
- **Start a new message after** controls whether the next relevant update edits
  the current message or posts a fresh one.

Detailed failures also appear in Convex logs under
`discord:sendDebouncedUpdate` and the Discord REST operation name, such as
`editChannelMessage` or `postChannelMessage`.

### Exact delivery and timer chain

Most work begins from a relevant When? mutation, a link action, or a `/when`
interaction. A separate six-hour recurring projection job keeps absolute
Discord timestamps pointing at the upcoming weekdays and detects DST changes.

For schedule-driven updates:

1. The schedule or selection mutation commits first.
2. Locking/unlocking times always counts as relevant. An availability change
   counts only when it overlaps a currently locked slot.
3. When? finds the schedule's linked Discord channels in bounded batches.
4. For each link, it cancels the currently pending debounce/retry action and
   schedules a new action for `DISCORD_DEBOUNCE_MS` later (60 seconds by
   default). Every newer relevant change restarts this 60-second window.
5. When the scheduled action starts, it atomically claims the link by matching
   its Convex scheduled-function ID. A cancelled or superseded action exits.
6. The action builds the current summary and checks Discord for the maintained
   message and matching pins. Pin state is read here; it is not polled between
   deliveries.
7. If neither the meaningful schedule snapshot nor the pinned target changed,
   the action exits without a Discord write.
8. Otherwise it selects the pinned/original/latest/new message according to the
   configured message policy and performs the Discord REST operations.
9. After success, When? stores the snapshot, maintained message ID, and the
   target message's creation time. A previous update target is relabelled in a
   separate idempotent edit.

`DISCORD_NEW_MESSAGE_AFTER_MS` is not a scheduled timer. Its six-hour default is
an age threshold evaluated only when step 8 runs, using the last successful
Discord target-message creation time. Likewise, a newly pinned message is discovered on the
next relevant delivery or `/when` share; pinning alone does not wake Convex.

For recurring timestamp and DST refreshes:

1. Every six hours, a bounded dispatcher walks linked channels and schedules a
   refresh action per link.
2. One-off schedules exit without a Discord request. Recurring schedules build
   the next occurrence of each weekday in the schedule timezone and compare it
   with the stored projection.
3. A normal weekday rollover edits the maintained message in place and does
   not reset or invoke the age threshold.
4. If DST notifications are enabled and a new transition appears within the
   upcoming eight-day projection, When? compares participant availability with
   the prior projection and posts a fresh message. The **Never** policy adopts
   that DST message as its new anchor; pinned summaries are edited in place.
5. The transition key is stored so the same DST change produces only one fresh
   notification. After it passes, the notice is removed on a later refresh.

For `/when`:

1. The command immediately returns a private account-link prompt or schedule
   picker.
2. Selecting a schedule sends Discord a deferred acknowledgement immediately.
3. Convex starts the public share action 250 ms later, outside Discord's
   three-second interaction-response deadline. The 60-second debounce does not
   apply.
4. The action checks the linked-channel policy and pins, posts/updates the
   public message, records its ID when it becomes maintained, and then replaces
   the private picker with success or failure text.

The initial channel-link message is also immediate and does not use the
60-second debounce. Unknown-user account-link tokens have a separate 15-minute
expiry; that expiry does not trigger a Discord delivery.

### Discord rate limits and failure actions

Every Discord REST response is inspected for `X-RateLimit-Bucket`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`, and
`X-RateLimit-Reset-After`. Known exhausted route/global buckets wait until their
reset before another request is made. A `429` uses the response's `Retry-After`
header or JSON `retry_after` value, plus a small safety margin.

- A rate-limit wait of at most five seconds is handled inside the current
  action, for up to two retries after the original request.
- A longer or repeated rate limit becomes a durable Convex scheduled retry.
  The scheduled time is Discord's requested delay plus 100–349 ms of safety
  margin/jitter.
- Network failures, `502`, and other `5xx` responses receive two short inline
  retries, then durable retries after approximately 1, 2, 4, 8, and 16 seconds
  (plus up to 249 ms jitter).
- Discord write-limit codes `20016`, `20022`, `20028`, and `20029` are treated
  as rate limits even if Discord does not return HTTP `429`.
- `400`, `401`, and `403` failures are permanent configuration/payload/
  permission errors and are not retried. Missing channels, guilds, webhooks,
  and interactions are also not retried.
- A missing maintained message (`404` / code `10008`) retains the message-policy
  behavior: replace it for normal policies, but report failure for **Never**.

Durable delivery retries reuse the same Discord message nonce with
`enforce_nonce`, so an ambiguous network or server failure cannot create a
duplicate post. A new relevant schedule change that arrives while a retry is
waiting cancels/supersedes that retry and starts a fresh 60-second debounce.
After five durable failures, When? stops and records **Update failed** for the
linked channel. Relabelling the previous target and completing the private
`/when` response use their own bounded retry actions so they cannot duplicate
the primary delivery.

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

If an installer clears any requested permission, the OAuth callback aborts the
link and reports the missing permissions. When a channel is selected, When?
also requires the initial summary post to succeed before saving the link, so a
channel override cannot leave behind a link that never delivered a message.

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

### Installation reports that Discord is not configured

The active Convex deployment must have `DISCORD_APP_ID`,
`DISCORD_CLIENT_SECRET`, and `DISCORD_BOT_TOKEN`. When? checks this before
opening Discord and checks again in the callback. The bot may already have
joined the server if configuration changed while the authorization page was
open; no schedule-to-channel link is saved in that case.

### No channels appear in the channel picker

- Confirm the bot was added to the selected server.
- Confirm `DISCORD_BOT_TOKEN` is valid.
- Confirm the bot can view the intended channel.
- Only normal text channels and announcement channels are listed.

### The bot cannot post or edit a summary

Check View Channel, Send Messages, Embed Links, and Read Message History on the
specific channel. Open **Schedule options → Discord** to check whether an update
is queued, succeeded, or failed. Also check Convex logs for Discord API status
codes.

### `/when` is missing

Register a guild command for immediate testing. If the guild command works,
register the global command and allow time for Discord to propagate it.

### `/when` asks the user to link an account

This is expected the first time a Discord participant uses `/when`. Open the
private **Link When? account** button in the browser where that participant uses
When?, confirm the displayed profile, then run `/when` again. If the link has
expired, run `/when` again to create a fresh one.

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
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [HTTP status and JSON error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#http)
