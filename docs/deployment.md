# Deployment

This guide is for deploying When? with Convex, Google OAuth, and a hosted
frontend.

## Required Services

- A Convex project.
- A Google OAuth 2.0 web client.
- A frontend host: nginx, Caddy, another static server, or any host that can
  serve a Vite SPA.

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

## Session Lifetime

Signing in creates a component-owned session holding the Google refresh token.
The browser only ever receives an opaque, HMAC-signed session token, which is
rotated on refresh; the refresh token itself never leaves the backend.

Sessions end at whichever of these comes first:

| Bound | Default | Measured from | Enforced in |
| --- | --- | --- | --- |
| Absolute | 180 days | initial sign-in | `/auth/refresh` |
| Idle | 60 days | last successful refresh | `/auth/refresh` |
| Explicit | immediate | sign-out (`/auth/sign-out`) | client sign-out |

These are the `@clammet/convex-googly-auth` defaults. They can be changed in the shared
`GooglyAuth` instance with `sessionAbsoluteTtlMs` and `sessionIdleTtlMs`.

Signing out deletes the component session and asks Google to revoke the refresh
token. Expired component sessions are swept every 6 hours by the
`auth-session-cleanup` cron.

## Frontend Runtime Config

The frontend needs these public values:

| Value | Description |
| --- | --- |
| `CONVEX_URL` | `https://your-deployment.convex.cloud` |
| `CONVEX_SITE_URL` | `https://your-deployment.convex.site` |
| `GOOGLE_CLIENT_ID` | Same public client ID as `AUTH_GOOGLE_ID` |
| `DISCORD_CLIENT_ID` | Optional; only needed for Discord integration |

They are written to a `config.json` served at the site root (see below).

## Docker Image

The published image `ghcr.io/whenwhenwhenwhenwhen/when:latest` is a file-only
artifact built `FROM scratch`: it contains the built site under `/srv/www` and
nothing else — no web server, no entrypoint. It cannot be run. Instead, extract
the files and let your reverse proxy serve them:

```bash
docker pull ghcr.io/whenwhenwhenwhenwhen/when:latest
id=$(docker create ghcr.io/whenwhenwhenwhenwhen/when:latest true)
docker cp "$id:/srv/www/." /path/to/dist/
docker rm "$id"
```

Then follow [Static Hosting](#static-hosting) with `/path/to/dist`. Because
the site is served from a file mount, updating means re-extracting the new
image; nothing needs restarting.

## Static Hosting

Either extract `dist/` from the Docker image as above, or build it yourself:

```bash
pnpm install
tsc -b --pretty false && vite build
```

Create `dist/config.json` (or serve it from an overlay directory alongside
`dist/` so re-extracting the image does not overwrite it):

```json
{
  "CONVEX_URL": "https://your-deployment.convex.cloud",
  "CONVEX_SITE_URL": "https://your-deployment.convex.site",
  "GOOGLE_CLIENT_ID": "your_google_client_id"
}
```

Serve `dist/` with an SPA fallback so unknown routes return `index.html`.
`config.json` should not be cached; Vite's content-hashed `/assets/` can be
cached indefinitely.

nginx:

```nginx
root /path/to/dist;
index index.html;

location = /config.json {
    add_header Cache-Control "no-store" always;
}

location ^~ /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}

location / {
    add_header Cache-Control "no-cache" always;
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
