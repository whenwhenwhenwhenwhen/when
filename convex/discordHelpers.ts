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
    readonly failureKind:
      | "rate_limit"
      | "network"
      | "server"
      | "authentication"
      | "permission"
      | "not_found"
      | "bad_request"
      | "unknown" = "unknown",
    readonly retryAfterMs?: number,
    readonly rateLimit?: DiscordRateLimitMetadata,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }

  get retryable(): boolean {
    return (
      this.failureKind === "rate_limit" ||
      this.failureKind === "network" ||
      this.failureKind === "server"
    );
  }
}

export type DiscordRateLimitMetadata = {
  bucket?: string;
  limit?: number;
  remaining?: number;
  resetAt?: number;
  resetAfterMs?: number;
  retryAfterMs?: number;
  scope?: "user" | "global" | "shared";
  global: boolean;
};

const DISCORD_INLINE_RETRY_LIMIT = 2;
const DISCORD_MAX_INLINE_RATE_LIMIT_WAIT_MS = 5_000;
const DISCORD_RATE_LIMIT_SAFETY_MS = 100;
const DISCORD_WRITE_RATE_LIMIT_CODES = new Set([20016, 20022, 20028, 20029]);
const routeToBucket = new Map<string, string>();
const rateLimitResetAtByKey = new Map<string, number>();
let globalRateLimitResetAt = 0;

function finiteHeaderNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readDiscordRateLimitMetadata(
  response: Response,
  bodyRetryAfterSeconds?: number,
  bodyGlobal?: boolean,
): DiscordRateLimitMetadata {
  const resetAfterSeconds = finiteHeaderNumber(
    response.headers.get("X-RateLimit-Reset-After"),
  );
  const resetEpochSeconds = finiteHeaderNumber(
    response.headers.get("X-RateLimit-Reset"),
  );
  const retryAfterSeconds =
    bodyRetryAfterSeconds ?? finiteHeaderNumber(response.headers.get("Retry-After"));
  const rawScope = response.headers.get("X-RateLimit-Scope");
  const scope =
    rawScope === "user" || rawScope === "global" || rawScope === "shared"
      ? rawScope
      : undefined;

  return {
    bucket: response.headers.get("X-RateLimit-Bucket") ?? undefined,
    limit: finiteHeaderNumber(response.headers.get("X-RateLimit-Limit")),
    remaining: finiteHeaderNumber(
      response.headers.get("X-RateLimit-Remaining"),
    ),
    resetAt:
      resetEpochSeconds === undefined
        ? undefined
        : Math.ceil(resetEpochSeconds * 1000),
    resetAfterMs:
      resetAfterSeconds === undefined
        ? undefined
        : Math.ceil(resetAfterSeconds * 1000),
    retryAfterMs:
      retryAfterSeconds === undefined
        ? undefined
        : Math.ceil(retryAfterSeconds * 1000),
    scope,
    global:
      bodyGlobal === true ||
      response.headers.get("X-RateLimit-Global") === "true" ||
      scope === "global",
  };
}

function rateLimitResetAt(metadata: DiscordRateLimitMetadata): number | undefined {
  if (metadata.retryAfterMs !== undefined) {
    return Date.now() + metadata.retryAfterMs + DISCORD_RATE_LIMIT_SAFETY_MS;
  }
  if (metadata.resetAfterMs !== undefined) {
    return Date.now() + metadata.resetAfterMs + DISCORD_RATE_LIMIT_SAFETY_MS;
  }
  return metadata.resetAt === undefined
    ? undefined
    : metadata.resetAt + DISCORD_RATE_LIMIT_SAFETY_MS;
}

function recordRateLimitHeaders(
  routeKey: string,
  majorParameter: string,
  metadata: DiscordRateLimitMetadata,
  forceLimited: boolean,
): void {
  const bucketKey = metadata.bucket
    ? `bucket:${metadata.bucket}:${majorParameter}`
    : `route:${routeKey}`;
  if (metadata.bucket) routeToBucket.set(routeKey, bucketKey);

  const resetAt = rateLimitResetAt(metadata);
  if (resetAt === undefined) return;
  if (metadata.global) {
    globalRateLimitResetAt = Math.max(globalRateLimitResetAt, resetAt);
  }
  if (forceLimited || metadata.remaining === 0) {
    rateLimitResetAtByKey.set(bucketKey, resetAt);
  }
}

async function waitForKnownDiscordRateLimit(routeKey: string): Promise<void> {
  const bucketKey = routeToBucket.get(routeKey) ?? `route:${routeKey}`;
  const resetAt = Math.max(
    globalRateLimitResetAt,
    rateLimitResetAtByKey.get(bucketKey) ?? 0,
  );
  const waitMs = resetAt - Date.now();
  if (waitMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

function discordFailureKind(
  status: number,
  code: number | undefined,
): DiscordApiError["failureKind"] {
  if (status === 429 || (code !== undefined && DISCORD_WRITE_RATE_LIMIT_CODES.has(code))) {
    return "rate_limit";
  }
  if (status === 0) return "network";
  if (status === 502 || status >= 500) return "server";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "bad_request";
  return "unknown";
}

async function discordApiError(
  operation: string,
  response: Response,
): Promise<DiscordApiError> {
  const body = await response.text();
  let code: number | undefined;
  let message = body || `Discord returned HTTP ${response.status}`;

  let bodyRetryAfterSeconds: number | undefined;
  let bodyGlobal: boolean | undefined;
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      message?: unknown;
      retry_after?: unknown;
      global?: unknown;
    };
    if (typeof parsed.code === "number") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
    if (
      typeof parsed.retry_after === "number" &&
      Number.isFinite(parsed.retry_after)
    ) {
      bodyRetryAfterSeconds = parsed.retry_after;
    }
    if (typeof parsed.global === "boolean") bodyGlobal = parsed.global;
  } catch {
    // Keep the raw response text for diagnostics when it is not JSON.
  }

  const rateLimit = readDiscordRateLimitMetadata(
    response,
    bodyRetryAfterSeconds,
    bodyGlobal,
  );
  const failureKind = discordFailureKind(response.status, code);
  console.error(`${operation} failed`, response.status, code, message);
  return new DiscordApiError(
    message,
    response.status,
    code,
    failureKind,
    rateLimit.retryAfterMs ?? rateLimit.resetAfterMs,
    rateLimit,
  );
}

function discordUserAgent(): string {
  return `DiscordBot (${process.env.SITE_URL ?? "https://when.games"}, 1.0)`;
}

async function discordRequest(
  operation: string,
  routeKey: string,
  majorParameter: string,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    await waitForKnownDiscordRateLimit(routeKey);

    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", discordUserAgent());
      response = await fetch(url, {
        ...init,
        headers,
      });
    } catch (cause) {
      const error = new DiscordApiError(
        cause instanceof Error ? cause.message : "Discord network request failed",
        0,
        undefined,
        "network",
      );
      if (attempt >= DISCORD_INLINE_RETRY_LIMIT) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 500 * 2 ** attempt),
      );
      continue;
    }

    const successRateLimit = readDiscordRateLimitMetadata(response);
    recordRateLimitHeaders(
      routeKey,
      majorParameter,
      successRateLimit,
      response.status === 429,
    );
    if (response.ok) return response;

    const error = await discordApiError(operation, response);
    if (error.rateLimit) {
      recordRateLimitHeaders(
        routeKey,
        majorParameter,
        error.rateLimit,
        error.failureKind === "rate_limit",
      );
    }
    const retryDelayMs =
      error.retryAfterMs ?? (error.failureKind === "server" ? 500 * 2 ** attempt : undefined);
    const canRetryInline =
      error.retryable &&
      attempt < DISCORD_INLINE_RETRY_LIMIT &&
      retryDelayMs !== undefined &&
      (error.failureKind !== "rate_limit" ||
        retryDelayMs <= DISCORD_MAX_INLINE_RATE_LIMIT_WAIT_MS);
    if (!canRetryInline) throw error;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, retryDelayMs + DISCORD_RATE_LIMIT_SAFETY_MS),
    );
  }
}

export function getDiscordRetryDelayMs(
  error: DiscordApiError,
  attempt: number,
): number | null {
  if (!error.retryable) return null;
  if (error.retryAfterMs !== undefined) {
    return Math.max(
      250,
      Math.ceil(error.retryAfterMs) +
        DISCORD_RATE_LIMIT_SAFETY_MS +
        Math.floor(Math.random() * 250),
    );
  }
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt)) +
    Math.floor(Math.random() * 250);
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function postChannelMessage(
  channelId: string,
  payload: Record<string, unknown>,
  nonce?: string,
): Promise<{ id: string }> {
  const res = await discordRequest(
    "postChannelMessage",
    `POST:/channels/${channelId}/messages`,
    `channel:${channelId}`,
    `${DISCORD_API}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(
        nonce ? { ...payload, nonce, enforce_nonce: true } : payload,
      ),
    },
  );
  return (await res.json()) as { id: string };
}

export async function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await discordRequest(
    "editOriginalInteractionResponse",
    `PATCH:/webhooks/${applicationId}/${interactionToken}/messages/:message`,
    `webhook:${applicationId}:${interactionToken}`,
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    await discordRequest(
      "editChannelMessage",
      `PATCH:/channels/${channelId}/messages/:message`,
      `channel:${channelId}`,
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: authHeader(),
        body: JSON.stringify(payload),
      },
    );
    return true;
  } catch (error) {
    // The stored message may have been manually deleted. In that one case,
    // fall back to posting a replacement; permission failures must surface.
    if (
      error instanceof DiscordApiError &&
      error.status === 404 &&
      error.code === 10008
    ) {
      return false;
    }
    throw error;
  }
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
  try {
    const res = await discordRequest(
      "fetchChannelMessage",
      `GET:/channels/${channelId}/messages/:message`,
      `channel:${channelId}`,
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      { headers: authHeader() },
    );
    return (await res.json()) as DiscordChannelMessage;
  } catch (error) {
    if (
      error instanceof DiscordApiError &&
      error.status === 404 &&
      error.code === 10008
    ) {
      return null;
    }
    throw error;
  }
}

async function fetchChannelPinsPage(
  channelId: string,
  before?: string,
): Promise<{ items: DiscordMessagePin[]; hasMore: boolean }> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages/pins`);
  url.searchParams.set("limit", "50");
  if (before) url.searchParams.set("before", before);

  const res = await discordRequest(
    "fetchChannelPins",
    `GET:/channels/${channelId}/messages/pins`,
    `channel:${channelId}`,
    url,
    { headers: authHeader() },
  );
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
  const res = await discordRequest(
    "fetchGuildChannels",
    `GET:/guilds/${guildId}/channels`,
    `guild:${guildId}`,
    `${DISCORD_API}/guilds/${guildId}/channels`,
    { headers: authHeader() },
  );
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
  try {
    const res = await discordRequest(
      "fetchGuildInfo",
      `GET:/guilds/${guildId}`,
      `guild:${guildId}`,
      `${DISCORD_API}/guilds/${guildId}`,
      { headers: authHeader() },
    );
    return (await res.json()) as { name?: string };
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return null;
    throw error;
  }
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

  let res: Response;
  try {
    res = await discordRequest(
      "exchangeDiscordOAuthCode",
      "POST:/oauth2/token",
      "oauth2",
      `${DISCORD_API}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
  } catch (error) {
    if (
      error instanceof DiscordApiError &&
      (error.status === 400 || error.status === 401)
    ) {
      return null;
    }
    throw error;
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
  const res = await discordRequest(
    "fetchDiscordCurrentUser",
    "GET:/users/@me",
    "oauth-user",
    `${DISCORD_API}/users/@me`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  const data = (await res.json()) as { id?: unknown; username?: unknown };
  if (typeof data.id !== "string" || typeof data.username !== "string") {
    throw new Error("Discord user response was incomplete");
  }
  return { id: data.id, username: data.username };
}

export async function registerDiscordWhenCommand(
  guildId?: string,
): Promise<unknown> {
  const appId = process.env.DISCORD_APP_ID;
  if (!appId || !process.env.DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_APP_ID and DISCORD_BOT_TOKEN must be set");
  }
  const path = guildId
    ? `/applications/${appId}/guilds/${guildId}/commands`
    : `/applications/${appId}/commands`;
  const res = await discordRequest(
    "registerDiscordWhenCommand",
    guildId
      ? `POST:/applications/${appId}/guilds/${guildId}/commands`
      : `POST:/applications/${appId}/commands`,
    guildId ? `guild:${guildId}` : `application:${appId}`,
    `${DISCORD_API}${path}`,
    {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        name: "when",
        description: "Share a When? schedule into this channel",
        type: 1,
      }),
    },
  );
  return await res.json();
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
const EMBED_FOOTER_LIMIT = 2048;
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
  const rawFooter = embed.footer as { text?: string } | undefined;
  const footerText = truncateText(rawFooter?.text, EMBED_FOOTER_LIMIT);
  const footer = rawFooter ? { ...rawFooter, text: footerText } : undefined;
  const trimmedFields = fields.map((field) => ({
    ...field,
    value: truncateFieldValue(field.value),
  }));

  let total =
    (title?.length ?? 0) +
    (description?.length ?? 0) +
    (footerText?.length ?? 0) +
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
    footer,
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
