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

// Discord signs the timestamp alongside the body, so an old-but-validly-signed
// request is a replay. The window has to absorb clock drift in both directions.
export const DISCORD_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const signedAtSeconds = Number(timestamp);
  if (!Number.isFinite(signedAtSeconds)) return false;
  if (
    Math.abs(nowMs - signedAtSeconds * 1000) > DISCORD_SIGNATURE_TOLERANCE_MS
  ) {
    console.error("Discord interaction timestamp outside freshness window", {
      timestamp,
    });
    return false;
  }

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
// Interaction routes are keyed by a single-use token, so these best-effort
// caches would otherwise grow for the lifetime of the isolate.
const DISCORD_RATE_LIMIT_CACHE_LIMIT = 500;
const routeToBucket = new Map<string, string>();
const rateLimitResetAtByKey = new Map<string, number>();
let globalRateLimitResetAt = 0;

function setBoundedCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
): void {
  // Re-inserting moves the key to the end, so the oldest write evicts first.
  cache.delete(key);
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= DISCORD_RATE_LIMIT_CACHE_LIMIT) break;
    cache.delete(oldest);
  }
}

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
  if (metadata.bucket) setBoundedCacheEntry(routeToBucket, routeKey, bucketKey);

  const resetAt = rateLimitResetAt(metadata);
  if (resetAt === undefined) return;
  if (metadata.global) {
    globalRateLimitResetAt = Math.max(globalRateLimitResetAt, resetAt);
  }
  if (forceLimited || metadata.remaining === 0) {
    setBoundedCacheEntry(rateLimitResetAtByKey, bucketKey, resetAt);
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

export async function deleteChannelMessage(
  channelId: string,
  messageId: string,
): Promise<void> {
  try {
    await discordRequest(
      "deleteChannelMessage",
      `DELETE:/channels/${channelId}/messages/:message`,
      `channel:${channelId}`,
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: authHeader(),
      },
    );
  } catch (error) {
    // Deleting an already-removed message has achieved the desired outcome.
    if (
      error instanceof DiscordApiError &&
      error.status === 404 &&
      error.code === 10008
    ) {
      return;
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
    recurringStartDate?: string;
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
  referenceTimeMs?: number;
  // Where to point the View Schedule button
  appBaseUrl: string;
};

export type DiscordSummaryLabel = "will-update" | "one-time";

export type DiscordDstNotice = {
  key: string;
  scheduleShift?: {
    timezone: string;
    transitionUnix: number;
    offsetChangeMinutes: number;
  };
  participantShifts: Array<{
    name: string;
    timezone: string;
    transitionUnix: number;
    offsetChangeMinutes: number;
  }>;
  noLongerAvailable: string[];
};

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

const SLOT_MINUTES = 30;

function inputReferenceDateTime(input: SummaryInput): DateTime {
  let reference: DateTime;
  if (input.referenceTimeMs !== undefined) {
    reference = DateTime.fromMillis(input.referenceTimeMs, {
      zone: input.schedule.creatorTimezone,
    });
  } else if (input.referenceDate) {
    reference = DateTime.fromISO(input.referenceDate, {
      zone: input.schedule.creatorTimezone,
    }).startOf("day");
  } else {
    reference = DateTime.now().setZone(input.schedule.creatorTimezone);
  }
  if (
    input.schedule.type === "recurring" &&
    input.schedule.recurringStartDate
  ) {
    const start = DateTime.fromISO(input.schedule.recurringStartDate, {
      zone: input.schedule.creatorTimezone,
    }).startOf("day");
    if (start.isValid && start.toMillis() > reference.toMillis()) return start;
  }
  return reference;
}

function jsDayOfWeek(value: DateTime): number {
  return value.weekday === 7 ? 0 : value.weekday;
}

function resolveUpcomingCellStart(
  input: SummaryInput,
  cell: { dayKey: string; timeSlot: string },
): DateTime {
  const [hour, minute] = cell.timeSlot.split(":").map(Number);
  if (input.schedule.type === "one-off") {
    return DateTime.fromISO(cell.dayKey, {
      zone: input.schedule.creatorTimezone,
    }).set({ hour, minute, second: 0, millisecond: 0 });
  }

  const reference = inputReferenceDateTime(input);
  const weekday = Number.parseInt(cell.dayKey, 10);
  const daysAhead = (weekday - jsDayOfWeek(reference) + 7) % 7;
  const occurrence = reference
    .startOf("day")
    .plus({ days: daysAhead })
    .set({ hour, minute, second: 0, millisecond: 0 });
  // Treat all cells on today's weekday as one occurrence, even after some of
  // that day's cells have passed. This keeps a contiguous block intact; the
  // six-hour refresh rolls the whole weekday forward after local midnight.
  return occurrence;
}

type TimedCell<T> = T & { start: DateTime; end: DateTime };

function groupContiguousCells<T extends { dayKey: string; timeSlot: string }>(
  input: SummaryInput,
  cells: T[],
  canMerge: (previous: T, next: T) => boolean = () => true,
): Array<{ cells: TimedCell<T>[]; start: DateTime; end: DateTime }> {
  const timed = cells
    .map((cell) => {
      const start = resolveUpcomingCellStart(input, cell);
      return { ...cell, start, end: start.plus({ minutes: SLOT_MINUTES }) };
    })
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const blocks: Array<{
    cells: TimedCell<T>[];
    start: DateTime;
    end: DateTime;
  }> = [];
  for (const cell of timed) {
    const current = blocks.at(-1);
    const previous = current?.cells.at(-1);
    if (
      current &&
      previous &&
      previous.end.toMillis() === cell.start.toMillis() &&
      canMerge(previous, cell)
    ) {
      current.cells.push(cell);
      current.end = cell.end;
    } else {
      blocks.push({ cells: [cell], start: cell.start, end: cell.end });
    }
  }
  return blocks;
}

function formatDiscordTimeBlock(start: DateTime, end: DateTime): string {
  if (!start.isValid || !end.isValid) return "Unknown time";
  return `<t:${Math.floor(start.toSeconds())}:F>–<t:${Math.floor(end.toSeconds())}:t>`;
}

function normalizedSelections(input: SummaryInput) {
  const referenceDate = inputReferenceDateTime(input);

  return input.selections.map((selection) => {
    if (input.schedule.type === "recurring" && !selection.isException) {
      const participantReference = referenceDate.setZone(selection.timezone);
      const participantWeekday = Number.parseInt(selection.dayKey, 10);
      const daysAhead =
        (participantWeekday - jsDayOfWeek(participantReference) + 7) % 7;
      const [hour, minute] = selection.timeSlot.split(":").map(Number);
      const converted = participantReference
        .startOf("day")
        .plus({ days: daysAhead })
        .set({ hour, minute, second: 0, millisecond: 0 })
        .setZone(input.schedule.creatorTimezone);
      return {
        ...selection,
        dayKey: String(jsDayOfWeek(converted)),
        timeSlot: converted.toFormat("HH:mm"),
      };
    }

    return {
      ...selection,
      ...convertCellToTimezone(
        input.schedule.type,
        selection,
        selection.timezone,
        input.schedule.creatorTimezone,
        referenceDate,
      ),
    };
  });
}

type LockedProjectionSnapshot = {
  occurrences: Record<string, number>;
  availability: Record<string, Record<string, SelectionState>>;
};

function buildLockedProjection(input: SummaryInput): LockedProjectionSnapshot {
  const normalized = normalizedSelections(input);
  const occurrences: LockedProjectionSnapshot["occurrences"] = {};
  const availability: LockedProjectionSnapshot["availability"] = {};

  for (const slot of input.schedule.lockedSlots ?? []) {
    const key = `${slot.dayKey}|${slot.timeSlot}`;
    occurrences[key] = Math.floor(resolveUpcomingCellStart(input, slot).toSeconds());
    const participants: Record<string, SelectionState> = {};
    for (const selection of normalized) {
      if (
        selection.isException ||
        selection.dayKey !== slot.dayKey ||
        selection.timeSlot !== slot.timeSlot
      ) {
        continue;
      }
      participants[selection.profileId] = selection.state;
    }
    availability[key] = participants;
  }
  for (const selection of normalized) {
    if (selection.isException || selection.state === "cant-do") continue;
    const key = `nomination:${selection.dayKey}|${selection.timeSlot}`;
    if (occurrences[key] === undefined) {
      occurrences[key] = Math.floor(
        resolveUpcomingCellStart(input, selection).toSeconds(),
      );
    }
  }
  return { occurrences, availability };
}

export function buildDiscordProjectionSnapshot(input: SummaryInput): string {
  return JSON.stringify(buildLockedProjection(input));
}

function parseProjectionSnapshot(
  snapshot: string | undefined,
): LockedProjectionSnapshot | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as Partial<LockedProjectionSnapshot>;
    if (!parsed.occurrences || !parsed.availability) return null;
    return parsed as LockedProjectionSnapshot;
  } catch {
    return null;
  }
}

function findNextOffsetTransition(
  timezone: string,
  fromMs: number,
): { transitionUnix: number; offsetChangeMinutes: number } | null {
  const start = DateTime.fromMillis(fromMs, { zone: timezone });
  if (!start.isValid) return null;
  const initialOffset = start.offset;
  let previous = start;
  for (let hours = 6; hours <= 8 * 24; hours += 6) {
    const candidate = start.plus({ hours });
    if (candidate.offset === initialOffset) {
      previous = candidate;
      continue;
    }

    let low = previous.toMillis();
    let high = candidate.toMillis();
    while (high - low > 60_000) {
      const midpoint = Math.floor((low + high) / 2);
      if (DateTime.fromMillis(midpoint, { zone: timezone }).offset === initialOffset) {
        low = midpoint;
      } else {
        high = midpoint;
      }
    }
    const nextOffset = DateTime.fromMillis(high, { zone: timezone }).offset;
    return {
      transitionUnix: Math.floor(high / 1000),
      offsetChangeMinutes: nextOffset - initialOffset,
    };
  }
  return null;
}

export function buildDiscordDstNotice(
  input: SummaryInput,
  previousProjectionSnapshot?: string,
): DiscordDstNotice | null {
  if (input.schedule.type !== "recurring") return null;
  const referenceMs = inputReferenceDateTime(input).toMillis();
  const participantZones = new Map<string, string>();
  for (const selection of input.selections) {
    if (!selection.isException && !participantZones.has(selection.profileId)) {
      participantZones.set(selection.profileId, selection.timezone);
    }
  }

  const participantShiftEntries = [...participantZones.entries()]
    .map(([profileId, timezone]) => {
      const transition = findNextOffsetTransition(timezone, referenceMs);
      return transition
        ? {
            profileId,
            name: input.profileNames[profileId] ?? "?",
            timezone,
            ...transition,
          }
        : null;
    })
    .filter((shift): shift is NonNullable<typeof shift> => shift !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const creatorTransition = findNextOffsetTransition(
    input.schedule.creatorTimezone,
    referenceMs,
  );
  if (participantShiftEntries.length === 0 && !creatorTransition) return null;

  const affectedProfileIds = creatorTransition
    ? new Set(participantZones.keys())
    : new Set(participantShiftEntries.map((shift) => shift.profileId));

  const previous = parseProjectionSnapshot(previousProjectionSnapshot);
  const current = buildLockedProjection(input);
  const unavailableProfileIds = new Set<string>();
  if (previous) {
    for (const [slotKey, priorParticipants] of Object.entries(
      previous.availability,
    )) {
      const nextParticipants = current.availability[slotKey] ?? {};
      for (const [profileId, previousState] of Object.entries(
        priorParticipants,
      )) {
        if (!affectedProfileIds.has(profileId)) continue;
        if (previousState !== "can-do" && previousState !== "maybe") continue;
        const nextState = nextParticipants[profileId];
        if (nextState !== "can-do" && nextState !== "maybe") {
          unavailableProfileIds.add(profileId);
        }
      }
    }
  }

  const noLongerAvailable = [...unavailableProfileIds]
    .map((profileId) => input.profileNames[profileId] ?? "?")
    .sort((a, b) => a.localeCompare(b));
  const scheduleShift = creatorTransition
    ? { timezone: input.schedule.creatorTimezone, ...creatorTransition }
    : undefined;
  const participantShifts = participantShiftEntries.map(
    ({ profileId: _profileId, ...shift }) => shift,
  );
  const key = JSON.stringify({
    scheduleShift,
    participantShifts: participantShifts.map((shift) => ({
      timezone: shift.timezone,
      transitionUnix: shift.transitionUnix,
      offsetChangeMinutes: shift.offsetChangeMinutes,
    })),
  });
  return { key, scheduleShift, participantShifts, noLongerAvailable };
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
  dstNotice?: DiscordDstNotice | null,
): Record<string, unknown> {
  const { schedule, profileNames } = input;
  const lockedSlots = schedule.lockedSlots ?? [];
  const normalized = normalizedSelections(input);

  // Build "Locked Times" field
  let lockedField = "";
  if (lockedSlots.length === 0) {
    lockedField = "_No locked-in times yet._";
  } else {
    const lockedLines = groupContiguousCells(input, lockedSlots).map((block) => {
        const timeLabel = formatDiscordTimeBlock(block.start, block.end);
        // Summarise availability across the complete contiguous block. A
        // participant is listed as available only when every cell is covered.
        const statesByProfile = new Map<string, SelectionState[]>();
        for (const cell of block.cells) {
          const cellStates = new Map<string, SelectionState>();
          for (const selection of normalized) {
            if (
              !selection.isException &&
              selection.dayKey === cell.dayKey &&
              selection.timeSlot === cell.timeSlot
            ) {
              cellStates.set(selection.profileId, selection.state);
            }
          }
          const profileIds = new Set([
            ...statesByProfile.keys(),
            ...cellStates.keys(),
          ]);
          for (const profileId of profileIds) {
            const states = statesByProfile.get(profileId) ?? [];
            const state = cellStates.get(profileId);
            if (state) states.push(state);
            statesByProfile.set(profileId, states);
          }
        }

        const canDo: string[] = [];
        const cantDo: string[] = [];
        const maybe: string[] = [];
        for (const [profileId, states] of statesByProfile) {
          const name = profileNames[profileId] ?? "?";
          if (states.includes("cant-do")) cantDo.push(name);
          else if (
            states.length === block.cells.length &&
            states.every((state) => state === "can-do")
          ) {
            canDo.push(name);
          } else if (
            states.length === block.cells.length &&
            states.every((state) => state === "can-do" || state === "maybe")
          ) {
            maybe.push(name);
          }
        }
        const parts: string[] = [];
        if (canDo.length) parts.push(`✅ ${canDo.sort().join(", ")}`);
        if (maybe.length) parts.push(`❔ ${maybe.sort().join(", ")}`);
        if (cantDo.length) parts.push(`❌ ${cantDo.sort().join(", ")}`);
        const detail = parts.length ? `\n  ${parts.join(" · ")}` : "";
        return `🔒 **${timeLabel}**${detail}`;
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
  const tallyEntries = [...tally.values()]
    .map((e) => ({ ...e, score: e.canDo.length * 2 + e.maybe.length }))
    .map((entry) => ({
      ...entry,
      signature: JSON.stringify({
        canDo: [...entry.canDo].sort(),
        maybe: [...entry.maybe].sort(),
      }),
    }));
  const nominationBlocks = groupContiguousCells(
    input,
    tallyEntries,
    (previous, next) => previous.signature === next.signature,
  )
    .map((block) => ({
      ...block,
      score: block.cells[0]?.score ?? 0,
      canDo: block.cells[0]?.canDo ?? [],
      maybe: block.cells[0]?.maybe ?? [],
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.start.toMillis() - b.start.toMillis(),
    )
    .slice(0, 5);

  let nominationsField = "";
  if (nominationBlocks.length === 0) {
    nominationsField = "_No nominations yet._";
  } else {
    nominationsField = nominationBlocks
      .map((block) => {
        const timeLabel = formatDiscordTimeBlock(block.start, block.end);
        const parts: string[] = [];
        if (block.canDo.length) parts.push(`✅ ${block.canDo.sort().join(", ")}`);
        if (block.maybe.length) parts.push(`❔ ${block.maybe.sort().join(", ")}`);
        return `**${timeLabel}** — ${parts.join(" · ")}`;
      })
      .join("\n");
  }

  let dstField: { name: string; value: string; inline: boolean } | undefined;
  if (dstNotice) {
    const lines: string[] = [];
    if (dstNotice.scheduleShift) {
      const direction =
        dstNotice.scheduleShift.offsetChangeMinutes > 0 ? "forward" : "back";
      lines.push(
        `🕒 Schedule timezone (${dstNotice.scheduleShift.timezone}) moves ${direction} <t:${dstNotice.scheduleShift.transitionUnix}:R>.`,
      );
    }
    for (const shift of dstNotice.participantShifts) {
      const direction = shift.offsetChangeMinutes > 0 ? "forward" : "back";
      lines.push(
        `🕒 ${shift.name} (${shift.timezone}) moves ${direction} <t:${shift.transitionUnix}:R>.`,
      );
    }
    lines.push(
      dstNotice.noLongerAvailable.length > 0
        ? `⚠️ No longer available for at least one locked-in block: ${dstNotice.noLongerAvailable.join(", ")}.`
        : "✅ No participants have fallen out of the locked-in blocks.",
    );
    dstField = {
      name: "Upcoming DST change",
      value: lines.join("\n"),
      inline: false,
    };
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
      ...(dstField ? [dstField] : []),
    ],
    footer: {
      text: `${label === "will-update" ? "Will update." : "One time message."} · Schedule type: ${schedule.type} · Times display in your Discord timezone`,
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
