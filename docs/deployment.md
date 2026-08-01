# Deployment

This guide is for deploying When? with Convex, Google OAuth, and a hosted
frontend.

## Required Services

- A Convex project.
- A Google OAuth 2.0 web client.
- A frontend host: Docker/nginx, Caddy, another static server, or any host that
  can serve a Vite SPA.

## Convex

Create a project at `convex.dev`, then note both deployment URLs:

| Value | Example | Used by |
| --- | --- | --- |
| Convex URL | `https://your-deployment.convex.cloud` | Frontend client |
| Convex Site URL | `https://your-deployment.convex.site` | HTTP callbacks |

Deploy backend functions:

```bash
npx convex deploy
```

## Google OAuth

Create an OAuth 2.0 Client ID in Google Cloud Console using the Web application
type.

Add both authorized redirect URIs:

```text
https://your-deployment.convex.site/auth/google/callback
https://your-deployment.convex.site/auth/google/calendar-callback
```

These are two different OAuth surfaces:

| Flow | Redirect URI | Scope | Purpose |
| --- | --- | --- | --- |
| Normal login | `/auth/google/callback` | `openid profile email` | Signs users into When? |
| Calendar sync | `/auth/google/calendar-callback` | `https://www.googleapis.com/auth/calendar.readonly` | Lets signed-in users import busy times |

The current app uses the same Google OAuth web client for both flows. Set the
client ID and secret on Convex:

```bash
npx convex env set AUTH_GOOGLE_ID your_google_client_id
npx convex env set AUTH_GOOGLE_SECRET your_google_client_secret
npx convex env set SITE_URL https://your-frontend-domain.com
```

`SITE_URL` is the public frontend URL. For local development use
`http://localhost:5173`.

Convex automatically provides `CONVEX_SITE_URL` to functions. The frontend
still needs the same Site URL in its runtime config.

You can review Convex environment variables with:

```bash
npx convex env list
```

## Frontend Runtime Config

The frontend needs these public values:

| Value | Description |
| --- | --- |
| `CONVEX_URL` | `https://your-deployment.convex.cloud` |
| `CONVEX_SITE_URL` | `https://your-deployment.convex.site` |
| `GOOGLE_CLIENT_ID` | Same public client ID as `AUTH_GOOGLE_ID` |
| `DISCORD_CLIENT_ID` | Optional; only needed for Discord integration |

In Docker these are environment variables. In static hosting they are written
to `config.json`.

## Docker

Run the published image:

```bash
docker pull ghcr.io/whenwhenwhenwhenwhen/when:latest

docker run -d -p 3000:80 \
  -e CONVEX_URL=https://your-deployment.convex.cloud \
  -e CONVEX_SITE_URL=https://your-deployment.convex.site \
  -e GOOGLE_CLIENT_ID=your_google_client_id \
  ghcr.io/whenwhenwhenwhenwhen/when:latest
```

For Docker Compose, create `.env`:

```env
CONVEX_URL=https://your-deployment.convex.cloud
CONVEX_SITE_URL=https://your-deployment.convex.site
GOOGLE_CLIENT_ID=your_google_client_id
```

Then run:

```bash
docker compose up -d
```

Changing runtime config only requires restarting the container.

## Static Hosting

Build the app:

```bash
pnpm install
tsc -b --pretty false && vite build
```

Create `dist/config.json`:

```json
{
  "CONVEX_URL": "https://your-deployment.convex.cloud",
  "CONVEX_SITE_URL": "https://your-deployment.convex.site",
  "GOOGLE_CLIENT_ID": "your_google_client_id"
}
```

Serve `dist/` with an SPA fallback so unknown routes return `index.html`.

nginx:

```nginx
root /path/to/dist;
index index.html;

location / {
    try_files $uri $uri/ /index.html;
}
```

Caddy:

```caddy
your-domain.com {
    root * /path/to/dist
    try_files {path} /index.html
    file_server
}
```

## Production Checklist

- `SITE_URL` on Convex is the production frontend URL.
- Google OAuth includes both production Convex Site redirect URIs.
- Convex functions have been deployed with `npx convex deploy`.
- Frontend runtime config points to the production Convex URL and Site URL.
- If using Google Calendar sync, the Google OAuth consent screen includes the
  Calendar API scope and the Google Calendar API is enabled for the project.

## Optional Discord Integration

Discord support lets schedule creators post live schedule summaries into a
channel and exposes a `/when` command.

Create a Discord application, then set these Convex env vars:

```bash
npx convex env set DISCORD_APP_ID your_application_id
npx convex env set DISCORD_BOT_TOKEN your_bot_token
npx convex env set DISCORD_PUBLIC_KEY your_public_key
npx convex env set DISCORD_CLIENT_SECRET your_client_secret
```

Expose the application ID to the frontend as `DISCORD_CLIENT_ID` or
`VITE_DISCORD_CLIENT_ID`.

In Discord OAuth2 settings, add:

```text
https://your-deployment.convex.site/discord/install-callback
```

Set the Interactions Endpoint URL:

```text
https://your-deployment.convex.site/discord/interactions
```

The production GitHub Actions workflow registers the global slash command after
deploying Convex. For other deployments, register it manually:

```bash
npx convex run discordSetup:registerCommands
```

For faster single-server iteration:

```bash
npx convex run discordSetup:registerGuildCommands '{"guildId":"YOUR_GUILD_ID"}'
```

Optional debounce override:

```bash
npx convex env set DISCORD_DEBOUNCE_MS 60000
```

Optional default age before a relevant update posts a new summary message
instead of editing the latest one:

```bash
npx convex env set DISCORD_NEW_MESSAGE_AFTER_MS 21600000
```

Set this to `0` to always edit the current latest message, or `-1` to never
start a replacement and stay anchored to the original linked message. Schedule
creators can override the default per linked channel in the Discord schedule
submenu. A matching pinned When? schedule message overrides the age policy.
