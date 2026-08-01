// Pure helpers for Discord integration: signature verification, formatting,
// REST API wrappers. Kept side-effect free so they can be imported by the
// V8 runtime (http.ts) and node runtime alike.

import { DateTime } from "luxon";
import { cellKey, convertCellToTimezone } from "./timezone";

// ---------------------------------------------------------------------------
// Ed25519 signature verification (Discord requirement for interaction webhooks)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): ArrayBuffer {
  const buf = new ArrayBuffer(hex.length / 2);
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) {
    view[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      // Ed25519 in WebCrypto is supported in modern V8 runtimes.
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"]
    );
    const message = new TextEncoder().encode(timestamp + body)
      .buffer as ArrayBuffer;
    return await crypto.subtle.verify(
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      publicKey,
      hexToBytes(signatureHex),
      message
    );
  } catch (err) {
    console.error("Discord signature verification failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discord REST API helpers
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";
export const DEFAULT_DISCORD_NEW_MESSAGE_AFTER_MS = 6 * 60 * 60 * 1000;
export const DISCORD_NEVER_START_NEW_MESSAGE = -1;

const DISCORD_INSTALL_ENVIRONMENT_VARIABLES = [
  "DISCORD_APP_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
] as const;

export function getMissingDiscordInstallConfiguration(): string[] {
  return DISCORD_INSTALL_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name],
  );
}

export function getDiscordNewMessageAfterMs(): number {
  const raw = process.env.DISCORD_NEW_MESSAGE_AFTER_MS;
  if (!raw) return DEFAULT_DISCORD_NEW_MESSAGE_AFTER_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= DISCORD_NEVER_START_NEW_MESSAGE
    ? parsed
    : DEFAULT_DISCORD_NEW_MESSAGE_AFTER_MS;
}

export function shouldPostNewDiscordMessage(
  lastNotifiedAt: number | undefined,
  newMessageAfterMs: number,
  now: number,
): boolean {
  if (lastNotifiedAt === undefined || newMessageAfterMs <= 0) return false;
  return now - lastNotifiedAt > newMessageAfterMs;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

async function discordApiError(
  operation: string,
  response: Response,
): Promise<DiscordApiError> {
  const body = await response.text();
  let code: number | undefined;
  let message = body || `Discord returned HTTP ${response.status}`;

  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "number") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Keep the raw response text for diagnostics when it is not JSON.
  }

  console.error(`${operation} failed`, response.status, code, message);
  return new DiscordApiError(message, response.status, code);
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function postChannelMessage(
  channelId: string,
  payload: Record<string, unknown>
): Promise<{ id: string }> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw await discordApiError("postChannelMessage", res);
  }
  return (await res.json()) as { id: string };
}

export async function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw await discordApiError("editOriginalInteractionResponse", res);
  }
}

export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: authHeader(),
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const error = await discordApiError("editChannelMessage", res);
    // The stored message may have been manually deleted. In that one case,
    // fall back to posting a replacement; permission failures must surface.
    if (error.status === 404 && error.code === 10008) return false;
    throw error;
  }
  return true;
}

export type DiscordChannelMessage = {
  id: string;
  pinned?: boolean;
  author?: { id?: string; bot?: boolean };
  embeds?: Array<{ url?: string }>;
};

type DiscordMessagePin = {
  pinned_at: string;
  message: DiscordChannelMessage;
};

export function discordMessageMatchesSchedule(
  message: DiscordChannelMessage,
  scheduleId: string,
): boolean {
  const appId = process.env.DISCORD_APP_ID;
  if (appId && message.author?.id !== appId) return false;
  if (!appId && !message.author?.bot) return false;

  return (message.embeds ?? []).some((embed) => {
    if (!embed.url) return false;
    try {
      return new URL(embed.url).pathname === `/schedule/${scheduleId}`;
    } catch {
      return false;
    }
  });
}

async function fetchChannelMessage(
  channelId: string,
  messageId: string,
): Promise<DiscordChannelMessage | null> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    { headers: authHeader() },
  );
  if (!res.ok) {
    const error = await discordApiError("fetchChannelMessage", res);
    if (error.status === 404 && error.code === 10008) return null;
    throw error;
  }
  return (await res.json()) as DiscordChannelMessage;
}

async function fetchChannelPinsPage(
  channelId: string,
  before?: string,
): Promise<{ items: DiscordMessagePin[]; hasMore: boolean }> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages/pins`);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);

  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw await discordApiError("fetchChannelPins", res);
  const data = (await res.json()) as {
    items?: DiscordMessagePin[];
    has_more?: boolean;
  };
  return { items: data.items ?? [], hasMore: data.has_more === true };
}

/**
 * Finds the maintained schedule message that should win the pin override.
 * Keep the current target stable when it is pinned; otherwise use the most
 * recently pinned matching message. Pagination is bounded to 500 pins.
 */
export async function findPinnedScheduleMessage(
  channelId: string,
  scheduleId: string,
  preferredMessageId?: string,
): Promise<DiscordChannelMessage | null> {
  if (preferredMessageId) {
    const preferred = await fetchChannelMessage(channelId, preferredMessageId);
    if (
      preferred?.pinned &&
      discordMessageMatchesSchedule(preferred, scheduleId)
    ) {
      return preferred;
    }
  }

  let before: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await fetchChannelPinsPage(channelId, before);
    const match = result.items.find((pin) =>
      discordMessageMatchesSchedule(pin.message, scheduleId),
    );
    if (match) return match.message;
    if (!result.hasMore || result.items.length === 0) return null;
    before = result.items.at(-1)?.pinned_at;
    if (!before) return null;
  }
  return null;
}

export async function fetchGuildChannels(
  guildId: string
): Promise<{ id: string; name: string; type: number }[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: authHeader(),
  });
  if (!res.ok) {
    throw await discordApiError("fetchGuildChannels", res);
  }
  const data = (await res.json()) as Array<{
    id: string;
    name: string;
    type: number;
  }>;
  // 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT — the channel types the bot can send to
  return data
    .filter((c) => c.type === 0 || c.type === 5)
    .map((c) => ({ id: c.id, name: c.name, type: c.type }));
}

export async function fetchGuildInfo(
  guildId: string
): Promise<{ name?: string } | null> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}`, {
    headers: authHeader(),
  });
  if (!res.ok) return null;
  return (await res.json()) as { name?: string };
}

export async function exchangeDiscordOAuthCode(
  code: string,
  redirectUri: string
): Promise<string | null> {
  const clientId = process.env.DISCORD_APP_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("DISCORD_APP_ID and DISCORD_CLIENT_SECRET must be set");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    console.error("exchangeDiscordOAuthCode failed", res.status, await res.text());
    return null;
  }

  const data = (await res.json()) as { access_token?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    console.error("exchangeDiscordOAuthCode returned no access token");
    return null;
  }

  return data.access_token;
}

export async function fetchDiscordCurrentUser(
  accessToken: string,
): Promise<{ id: string; username: string }> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw await discordApiError("fetchDiscordCurrentUser", res);
  }

  const data = (await res.json()) as { id?: unknown; username?: unknown };
  if (typeof data.id !== "string" || typeof data.username !== "string") {
    throw new Error("Discord user response was incomplete");
  }
  return { id: data.id, username: data.username };
}

// ---------------------------------------------------------------------------
// Summary formatting — used by the linking flow + debounced updates
// ---------------------------------------------------------------------------

export type SelectionState = "can-do" | "cant-do" | "maybe";
export type SummaryInput = {
  schedule: {
    _id: string;
    title: string;
    description?: string;
    type: "one-off" | "recurring";
    creatorTimezone: string;
    lockedSlots?: { dayKey: string; timeSlot: string }[];
    isLocked?: boolean;
  };
  // (profileId -> displayName)
  profileNames: Record<string, string>;
  // ALL selections (non-link generated) for the schedule
  selections: {
    profileId: string;
    dayKey: string;
    timeSlot: string;
    timezone: string;
    state: SelectionState;
    isException?: boolean;
    exceptionDate?: string;
  }[];
  referenceDate?: string;
  // Where to point the View Schedule button
  appBaseUrl: string;
};

export type DiscordSummaryLabel = "will-update" | "one-time";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const EMBED_TITLE_LIMIT = 256;
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;

function truncateText(value: string | undefined, limit: number): string | undefined {
  if (!value) return value;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function truncateFieldValue(value: string): string {
  return truncateText(value, EMBED_FIELD_VALUE_LIMIT) ?? "";
}

function trimEmbedToDiscordLimits(embed: Record<string, unknown>): Record<string, unknown> {
  const fields = (embed.fields as Array<{ name: string; value: string; inline: boolean }>) ?? [];
  const title = truncateText(embed.title as string | undefined, EMBED_TITLE_LIMIT);
  const description = truncateText(
    embed.description as string | undefined,
    EMBED_DESCRIPTION_LIMIT
  );
  const trimmedFields = fields.map((field) => ({
    ...field,
    value: truncateFieldValue(field.value),
  }));

  let total =
    (title?.length ?? 0) +
    (description?.length ?? 0) +
    trimmedFields.reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0
    );

  for (let i = trimmedFields.length - 1; total > EMBED_TOTAL_LIMIT && i >= 0; i--) {
    const field = trimmedFields[i];
    const overage = total - EMBED_TOTAL_LIMIT;
    const nextLength = Math.max(1, field.value.length - overage - 1);
    const nextValue = truncateText(field.value, nextLength) ?? "";
    total -= field.value.length - nextValue.length;
    field.value = nextValue;
  }

  return {
    ...embed,
    title,
    description,
    fields: trimmedFields,
  };
}

function formatSlotLabel(
  scheduleType: "one-off" | "recurring",
  dayKey: string,
  timeSlot: string
): string {
  if (scheduleType === "recurring") {
    const dow = parseInt(dayKey, 10);
    const name = DAY_NAMES[dow] ?? `Day ${dayKey}`;
    return `${name} ${timeSlot}`;
  }
  const dt = DateTime.fromISO(dayKey);
  return `${dt.toFormat("EEE MMM d")} ${timeSlot}`;
}

function normalizedSelections(input: SummaryInput) {
  const referenceDate = input.referenceDate
    ? DateTime.fromISO(input.referenceDate, {
        zone: input.schedule.creatorTimezone,
      })
    : DateTime.now().setZone(input.schedule.creatorTimezone);

  return input.selections.map((selection) => ({
    ...selection,
    ...convertCellToTimezone(
      input.schedule.type,
      selection,
      selection.timezone,
      input.schedule.creatorTimezone,
      referenceDate
    ),
  }));
}

/** Build a snapshot string used to detect "did anything meaningful change" */
export function buildLockedSlotSnapshot(input: SummaryInput): string {
  const locked = input.schedule.lockedSlots ?? [];
  const selections = normalizedSelections(input);
  // Sort for stability
  const sortedLocked = [...locked].sort((a, b) =>
    (a.dayKey + a.timeSlot).localeCompare(b.dayKey + b.timeSlot)
  );

  const lines: string[] = [];
  for (const slot of sortedLocked) {
    const participants = selections
      .filter(
        (s) =>
          !s.isException &&
          s.dayKey === slot.dayKey &&
          s.timeSlot === slot.timeSlot
      )
      .map((s) => `${s.profileId}:${s.state}`)
      .sort();
    lines.push(`${slot.dayKey}|${slot.timeSlot}|${participants.join(",")}`);
  }
  return lines.join("\n");
}

/**
 * Build a Discord interaction payload (used both for follow-up sends and
 * for the response data when a user clicks "Send" in the slash command).
 *
 * Returns the `data` object that can be plugged into either
 *   { type: 4, data: ... }  (interaction response)
 *   or a POST /channels/{id}/messages body.
 */
export function buildSummaryMessage(
  input: SummaryInput,
  label: DiscordSummaryLabel,
): Record<string, unknown> {
  const { schedule, profileNames } = input;
  const lockedSlots = schedule.lockedSlots ?? [];
  const normalized = normalizedSelections(input);

  // Build "Locked Times" field
  let lockedField = "";
  if (lockedSlots.length === 0) {
    lockedField = "_No locked-in times yet._";
  } else {
    const lockedLines = lockedSlots
      .slice()
      .sort((a, b) =>
        (a.dayKey + a.timeSlot).localeCompare(b.dayKey + b.timeSlot)
      )
      .map((slot) => {
        const label = formatSlotLabel(schedule.type, slot.dayKey, slot.timeSlot);
        // Show who can / can't make this slot
        const canDo: string[] = [];
        const cantDo: string[] = [];
        const maybe: string[] = [];
        for (const s of normalized) {
          if (s.isException) continue;
          if (s.dayKey !== slot.dayKey || s.timeSlot !== slot.timeSlot) continue;
          const name = profileNames[s.profileId] ?? "?";
          if (s.state === "can-do") canDo.push(name);
          else if (s.state === "cant-do") cantDo.push(name);
          else maybe.push(name);
        }
        const parts: string[] = [];
        if (canDo.length) parts.push(`✅ ${canDo.join(", ")}`);
        if (maybe.length) parts.push(`❔ ${maybe.join(", ")}`);
        if (cantDo.length) parts.push(`❌ ${cantDo.join(", ")}`);
        const detail = parts.length ? `\n  ${parts.join(" · ")}` : "";
        return `🔒 **${label}**${detail}`;
      });
    lockedField = lockedLines.join("\n\n");
  }

  // Build "Top Nominations" field — most-popular cells
  const tally = new Map<string, { dayKey: string; timeSlot: string; canDo: string[]; maybe: string[] }>();
  for (const s of normalized) {
    if (s.isException) continue;
    if (s.state === "cant-do") continue;
    const key = cellKey(s);
    const entry = tally.get(key) ?? {
      dayKey: s.dayKey,
      timeSlot: s.timeSlot,
      canDo: [],
      maybe: [],
    };
    const name = profileNames[s.profileId] ?? "?";
    if (s.state === "can-do") entry.canDo.push(name);
    else if (s.state === "maybe") entry.maybe.push(name);
    tally.set(key, entry);
  }
  const sortedTally = [...tally.values()]
    .map((e) => ({ ...e, score: e.canDo.length * 2 + e.maybe.length }))
    .sort((a, b) => b.score - a.score || (a.dayKey + a.timeSlot).localeCompare(b.dayKey + b.timeSlot))
    .slice(0, 5);

  let nominationsField = "";
  if (sortedTally.length === 0) {
    nominationsField = "_No nominations yet._";
  } else {
    nominationsField = sortedTally
      .map((e) => {
        const label = formatSlotLabel(schedule.type, e.dayKey, e.timeSlot);
        const parts: string[] = [];
        if (e.canDo.length) parts.push(`✅ ${e.canDo.join(", ")}`);
        if (e.maybe.length) parts.push(`❔ ${e.maybe.join(", ")}`);
        return `**${label}** — ${parts.join(" · ")}`;
      })
      .join("\n");
  }

  const url = `${input.appBaseUrl}/schedule/${schedule._id}`;

  const embed: Record<string, unknown> = trimEmbedToDiscordLimits({
    title: schedule.title,
    url,
    description: schedule.description || undefined,
    color: schedule.isLocked ? 0x8b5cf6 : 0x3b82f6,
    fields: [
      { name: "Locked-in times", value: lockedField || "—", inline: false },
      { name: "Top nominations", value: nominationsField || "—", inline: false },
    ],
    footer: {
      text: `${label === "will-update" ? "Will update." : "One time message."} · Schedule type: ${schedule.type} · Times: ${schedule.creatorTimezone}`,
    },
    timestamp: new Date().toISOString(),
  });

  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5, // link button
            label: "Open in When?",
            url,
          },
        ],
      },
    ],
  };
}
