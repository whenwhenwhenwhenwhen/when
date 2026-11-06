# Development

This guide is for contributors changing the app.

## Setup

Prerequisites:

- Node.js 22+
- pnpm

For a new checkout, install dependencies and create the local environment file:

```bash
pnpm install
cp .env.example .env.local
```

Set `VITE_GOOGLE_CLIENT_ID` in `.env.local` and initialize Convex. The CLI saves
the anonymous deployment name and its localhost URLs in `.env.local`.

```bash
pnpm exec convex init
```

Set `AUTH_GOOGLE_ID` to the same Google client ID on the local backend and set
the URL that OAuth should return to.

```bash
pnpm exec convex env set AUTH_GOOGLE_ID your_google_client_id
pnpm exec convex env set SITE_URL http://localhost:5173
```

For Google sign-in and Calendar sync, also set `AUTH_GOOGLE_SECRET` on the
local deployment with `pnpm exec convex env set AUTH_GOOGLE_SECRET`. In Google
Cloud, register `/auth/google/callback` and `/auth/google/calendar-callback`
under the exact origin in `VITE_CONVEX_SITE_URL`.

Start Vite and Convex together:

```bash
pnpm dev
```

For separate processes:

```bash
npx convex dev
npx vite
```

## Build And Check

Use this build command instead of `pnpm build` in the sandbox:

```bash
tsc -b --pretty false && vite build
```

## Architecture Notes

The app is a React/Vite frontend backed by Convex.

Authentication is provided by the `@clammet/convex-googly-auth` Convex component:

1. The component's React client starts Google sign-in.
2. Component-backed Convex HTTP routes exchange the authorization code and
   keep refresh tokens server-side.
3. Convex verifies Google JWTs through `convex/auth.config.ts`.
4. App profiles store only the component's opaque `identityId`; credentials,
   anonymous claims, and auth sessions never live in app tables.

Normal login and Calendar sync are separate OAuth flows but share the same
configured Google OAuth client today:

- Login uses `openid profile email` and stores a short-lived Google ID token
  client-side.
- Calendar sync asks for `calendar.readonly`, stores the calendar refresh token
  server-side, and imports busy time from selected calendars.

Anonymous users hold a 256-bit cookie claim. Only its hash is stored by the
component. Signing in retires the claim and upgrades or merges the profile.

## Schedule Model

- One-off schedules store specific dates and absolute time references.
- Recurring schedules store weekly wall-clock slots with user timezone context.
- `schedules.creatorTimezone` is the immutable coordinate anchor for date
  ranges, allow/disallow limits, and locked slots. A creator changing their
  profile timezone changes their view, not the meaning of existing schedule
  cells.
- Each participant selection retains the timezone in which that cell was
  created. Existing cells keep that address after a settings change; new cells
  use the participant or linked saved-availability timezone.
- Calendar sync converts external events into busy slots for selected
  schedules.
- Creators can disallow cells, nominate cells, and lock final times.

## Timezone And DST Behavior

One-off schedules should display the same absolute moment for everyone.

Recurring schedules should preserve the creator or participant's wall-clock
intent. Around daylight-saving transitions, the visible time may shift for
people in other timezones.

A daily Convex cron checks upcoming DST transitions. Notification delivery is
currently placeholder logic.

## Discord Notes

Discord integration supports:

- `/when` schedule selection.
- Schedule summary embeds.
- Schedule-to-channel links with debounced updates.

Discord user identity linking is partially modeled, but the public user-link UI
is not complete. Until then, `/when` falls back to listed schedules when it
cannot identify a user's When? profile.

Discord Activities are not implemented. They would require a separate embedded
app entrypoint, Discord Embedded App SDK setup, URL mappings, and an iframe-safe
schedule view.
