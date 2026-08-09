import { v } from "convex/values";
import { DateTime, IANAZone } from "luxon";
import {
  internalAction,
  internalMutation,
  internalQuery,
  action,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { convertCellToTimezone } from "./timezone";
import { googlyAuth } from "./lib/auth";

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SLOT_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_WINDOW_MS = 28 * DAY_MS;
const MAX_CALENDAR_SYNC_SCHEDULES = 50;
const MAX_PROFILE_SELECTIONS_FOR_SYNC = 500;
const MAX_PROFILE_CREATED_SCHEDULES_FOR_SYNC = 50;
// Bounds for a single sync. Each mutation batch handles a few schedules, so the
// per-schedule ceilings below are what has to fit in one transaction.
const MAX_SYNC_EVENTS = 400;
const SCHEDULES_PER_SYNC_BATCH = 3;
const MAX_SLOT_WRITES_PER_SCHEDULE = 1200;
const MAX_EXISTING_CALENDAR_SELECTIONS = 2000;
const MAX_OVERRIDES_PER_SCHEDULE = 1000;
const GOOGLE_PAGE_SIZE = 250;
const MAX_GOOGLE_EVENTS_PER_CALENDAR = 1000;
const ICS_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DISPATCH_SCAN = 500;
const MAX_DISPATCH_PER_RUN = 20;

type NormalizedEvent = {
  externalEventId: string;
  summary?: string;
  startMs: number;
  endMs: number;
  isRecurring: boolean;
};

const normalizedEventValidator = v.object({
  externalEventId: v.string(),
  summary: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  isRecurring: v.boolean(),
});

// ── Helpers ──────────────────────────────────────────────────────────

function eventToSlots(
  startMs: number,
  endMs: number,
  timezone: string,
  scheduleType: "one-off" | "recurring",
  isRecurring: boolean,
): { dayKey: string; timeSlot: string; isException?: boolean; exceptionDate?: string }[] {
  const slots: { dayKey: string; timeSlot: string; isException?: boolean; exceptionDate?: string }[] = [];

  // The grid only has :00/:30 cells in the viewer's wall clock, so snap there
  // rather than to epoch-aligned boundaries: zones offset by :15 or :45 would
  // otherwise produce slots that no cell can render. Rounding is outward so a
  // busy interval never under-reports.
  const start = DateTime.fromMillis(startMs, { zone: timezone });
  let cursor = start.set({
    minute: start.minute < SLOT_MINUTES ? 0 : SLOT_MINUTES,
    second: 0,
    millisecond: 0,
  });

  while (cursor.toMillis() < endMs) {
    const isoDate = cursor.toISODate()!;
    const timeSlot = cursor.toFormat("HH:mm");
    const dowStr = String(cursor.weekday % 7);

    if (scheduleType === "one-off") {
      slots.push({ dayKey: isoDate, timeSlot });
    } else if (isRecurring) {
      slots.push({ dayKey: dowStr, timeSlot });
    } else {
      slots.push({ dayKey: dowStr, timeSlot, isException: true, exceptionDate: isoDate });
    }

    cursor = cursor.plus({ minutes: SLOT_MINUTES });
  }

  if (scheduleType === "recurring") {
    const seen = new Set<string>();
    return slots.filter((s) => {
      const key = s.isException
        ? `exc:${s.dayKey}|${s.timeSlot}|${s.exceptionDate}`
        : `${s.dayKey}|${s.timeSlot}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return slots;
}

// Dropping events silently would leave their selections looking stale, so the
// overflow is reported back through the source's sync status.
function capSyncEvents(events: NormalizedEvent[]): {
  events: NormalizedEvent[];
  note?: string;
} {
  if (events.length <= MAX_SYNC_EVENTS) return { events };
  return {
    events: events.slice(0, MAX_SYNC_EVENTS),
    note: `Only the first ${MAX_SYNC_EVENTS} of ${events.length} calendar events were synced.`,
  };
}

async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${body}`);
  }
  const data = await response.json();
  return data.access_token as string;
}

async function fetchGoogleEvents(
  source: Doc<"calendarSources">,
  timezone: string,
): Promise<NormalizedEvent[]> {
  if (!source.calendarRefreshToken) {
    throw new Error("No refresh token available for Google calendar source");
  }
  const calendarIds = source.selectedCalendarIds ?? [];
  if (calendarIds.length === 0) return [];

  const accessToken = await refreshGoogleAccessToken(source.calendarRefreshToken);

  const now = new Date();
  const timeMin = now.toISOString();
  const futureDate = new Date(now.getTime() + SYNC_WINDOW_MS);
  const timeMax = futureDate.toISOString();

  const events: NormalizedEvent[] = [];

  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    let fetchedForCalendar = 0;

    do {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(GOOGLE_PAGE_SIZE),
        // nextPageToken has to be listed explicitly or the fields mask drops it.
        fields:
          "nextPageToken,items(id,summary,start,end,status,transparency,recurringEventId)",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Google Calendar API error for ${calendarId} (${response.status}): ${body}`,
        );
      }

      const data = await response.json();
      const items = (data.items ?? []) as Array<{
        id: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        status?: string;
        transparency?: string;
        recurringEventId?: string;
      }>;

      for (const item of items) {
        if (item.status === "cancelled") continue;
        if (item.transparency === "transparent") continue;
        if (!item.start || !item.end) continue;

        let startMs: number;
        let endMs: number;

        if (item.start.dateTime) {
          startMs = new Date(item.start.dateTime).getTime();
        } else if (item.start.date) {
          startMs = allDayDateToMs(item.start.date, timezone);
        } else {
          continue;
        }

        if (item.end.dateTime) {
          endMs = new Date(item.end.dateTime).getTime();
        } else if (item.end.date) {
          endMs = allDayDateToMs(item.end.date, timezone);
        } else {
          continue;
        }

        if (endMs <= startMs) continue;

        events.push({
          externalEventId: item.id,
          summary: item.summary,
          startMs,
          endMs,
          isRecurring: !!item.recurringEventId,
        });
      }

      fetchedForCalendar += items.length;
      pageToken =
        typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    } while (pageToken && fetchedForCalendar < MAX_GOOGLE_EVENTS_PER_CALENDAR);
  }

  return events;
}

// Feeds (Outlook especially) emit Windows zone names that no IANA database
// knows. Falling back keeps one bad event from failing the whole source.
function resolveTimezone(
  candidate: string | undefined,
  fallback: string,
): string {
  if (candidate && IANAZone.isValidZone(candidate)) return candidate;
  if (IANAZone.isValidZone(fallback)) return fallback;
  return "UTC";
}

function allDayDateToMs(dateStr: string, timezone: string): number {
  return DateTime.fromISO(dateStr, { zone: resolveTimezone(timezone, "UTC") })
    .startOf("day")
    .toMillis();
}

function isBlockedIpv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((o) => Number(o));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parsed;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    const ipv6 = host.slice(1, -1);
    if (ipv6 === "::" || ipv6 === "::1") return true;
    // fc00::/7 unique local, fe80::/10 link local.
    if (/^f[cd][0-9a-f]{0,2}:/.test(ipv6)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(ipv6)) return true;
    const mapped = ipv6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isBlockedIpv4(mapped[1]);
    return false;
  }

  return isBlockedIpv4(host);
}

/**
 * Validates a user-supplied calendar URL and returns the URL to fetch.
 *
 * Hostnames are only checked as written: the Convex runtime exposes no
 * resolution hook, so a name that resolves to a private address still gets
 * through. Fetch-time checks in `fetchIcsEvents` are the second layer.
 */
export function normalizeIcsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/^webcal:\/\//i, "https://");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid calendar URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Calendar URL must start with https:// or webcal://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Calendar URL must not contain credentials");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Calendar URL must point at a public host");
  }

  return parsed.toString();
}

async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error("Calendar feed is larger than the allowed size");
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Calendar feed is larger than the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const ALLOWED_ICS_CONTENT_TYPES = [
  "text/calendar",
  "text/x-vcalendar",
  "text/plain",
  "application/ics",
  "application/octet-stream",
];

async function fetchIcsEvents(
  icsUrl: string | undefined,
  timezone: string,
): Promise<NormalizedEvent[]> {
  if (!icsUrl) throw new Error("No ICS URL provided");

  // Revalidated here because stored URLs may predate write-time validation.
  const url = normalizeIcsUrl(icsUrl);

  const response = await fetch(url, {
    redirect: "manual",
    headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
  });

  // A redirect could point at an internal address that never passed validation.
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new Error("ICS URL redirects; use the final calendar URL instead");
  }
  if (!response.ok) {
    throw new Error(`ICS fetch failed (${response.status})`);
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType && !ALLOWED_ICS_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`ICS URL returned unexpected content type "${contentType}"`);
  }

  const icsText = await readCappedText(response, ICS_MAX_BYTES);
  return parseIcsEvents(icsText, timezone);
}

function parseIcsEvents(icsText: string, timezone: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  const now = Date.now();
  const windowEnd = now + SYNC_WINDOW_MS;

  // RFC 5545 folds lines past 75 octets; unfold first or every long value is
  // truncated at the fold point.
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");

  const veventBlocks = unfolded.split("BEGIN:VEVENT");
  // First element is preamble
  for (let i = 1; i < veventBlocks.length; i++) {
    const block = veventBlocks[i].split("END:VEVENT")[0];
    if (!block) continue;

    try {
      const uid = extractIcsField(block, "UID");
      const summary = extractIcsField(block, "SUMMARY");
      const transp = extractIcsField(block, "TRANSP") ?? "OPAQUE";
      const rrule = extractIcsField(block, "RRULE");

      if (transp === "TRANSPARENT") continue;
      if (!uid) continue;

      const dtstart = parseIcsDt(block, "DTSTART", timezone);
      if (dtstart === null) continue;
      const dtend = parseIcsDt(block, "DTEND", timezone);

      const duration =
        dtend !== null
          ? dtend.ms - dtstart.ms
          : dtstart.isAllDay
            ? // An all-day event without DTEND spans the whole day (RFC 5545).
              DateTime.fromMillis(dtstart.ms, { zone: dtstart.timezone })
                .plus({ days: 1 })
                .toMillis() - dtstart.ms
            : 60 * 60 * 1000;

      if (rrule) {
        const occurrences = expandRRule(
          dtstart.ms,
          duration,
          rrule,
          now,
          windowEnd,
          dtstart.timezone,
        );
        for (const occ of occurrences) {
          events.push({
            externalEventId: `${uid}_${occ.startMs}`,
            summary,
            startMs: occ.startMs,
            endMs: occ.endMs,
            isRecurring: true,
          });
        }
      } else {
        const endMs = dtstart.ms + duration;
        if (endMs <= now || dtstart.ms >= windowEnd) continue;
        events.push({
          externalEventId: uid,
          summary,
          startMs: dtstart.ms,
          endMs,
          isRecurring: false,
        });
      }
    } catch {
      // One malformed VEVENT must not take the rest of the feed with it.
      continue;
    }
  }

  return events;
}

function extractIcsField(block: string, field: string): string | undefined {
  // Handle both "FIELD:value" and "FIELD;params:value". The block is already
  // unfolded by parseIcsEvents.
  const regex = new RegExp(`(?:^|\\n)${field}(?:[;:])([^\\r\\n]*)`, "i");
  const match = block.match(regex);
  if (!match) return undefined;
  const line = match[0].replace(/^\n/, "");
  // Strip field name (everything up to the first colon after the field name)
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return undefined;
  return line.slice(colonIdx + 1).trim();
}

type IcsDateTime = { ms: number; timezone: string; isAllDay: boolean };

function parseIcsDt(
  block: string,
  field: string,
  defaultTimezone: string,
): IcsDateTime | null {
  const regex = new RegExp(
    `(?:^|\\n)(${field}(?:;[^:]*)?):([^\\r\\n]+)`,
    "i",
  );
  const match = block.match(regex);
  if (!match) return null;

  const params = match[1];
  const value = match[2].trim();

  let tzid: string | undefined;
  const tzidMatch = params.match(/TZID=([^;:]+)/i);
  // Zone names containing spaces are commonly quoted.
  if (tzidMatch) tzid = tzidMatch[1].trim().replace(/^"(.*)"$/, "$1");
  const zone = resolveTimezone(tzid, defaultTimezone);

  // All-day: 8 digits
  if (/^\d{8}$/.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10);
    const day = parseInt(value.slice(6, 8), 10);
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { ms: allDayDateToMs(dateStr, zone), timezone: zone, isAllDay: true };
  }

  // UTC: ends with Z
  if (/^\d{8}T\d{6}Z$/i.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10) - 1;
    const day = parseInt(value.slice(6, 8), 10);
    const hour = parseInt(value.slice(9, 11), 10);
    const minute = parseInt(value.slice(11, 13), 10);
    const second = parseInt(value.slice(13, 15), 10);
    return {
      ms: Date.UTC(year, month, day, hour, minute, second),
      timezone: "UTC",
      isAllDay: false,
    };
  }

  // Local time (with or without TZID)
  if (/^\d{8}T\d{6}$/.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10);
    const day = parseInt(value.slice(6, 8), 10);
    const hour = parseInt(value.slice(9, 11), 10);
    const minute = parseInt(value.slice(11, 13), 10);
    const second = parseInt(value.slice(13, 15), 10);
    return {
      ms: DateTime.fromObject(
        { year, month, day, hour, minute, second },
        { zone },
      ).toMillis(),
      timezone: zone,
      isAllDay: false,
    };
  }

  return null;
}

function expandRRule(
  dtstart: number,
  duration: number,
  rrule: string,
  windowStart: number,
  windowEnd: number,
  timezone: string,
): { startMs: number; endMs: number }[] {
  const results: { startMs: number; endMs: number }[] = [];

  const parts: Record<string, string> = {};
  for (const part of rrule.split(";")) {
    const [key, val] = part.split("=");
    if (key && val) parts[key.toUpperCase()] = val.toUpperCase();
  }

  const freq = parts.FREQ;
  if (!freq) return results;

  // Exclusive bound; UNTIL itself is an allowed occurrence per RFC 5545.
  let until = windowEnd;
  if (parts.UNTIL) {
    const untilMs = parseIcsDateBasic(parts.UNTIL);
    if (untilMs !== null && untilMs + 1 < until) until = untilMs + 1;
  }

  // A malformed COUNT or INTERVAL must still leave the walk able to terminate.
  const count = (parts.COUNT ? parseInt(parts.COUNT, 10) : 1000) || 1000;
  const interval = Math.max(1, parseInt(parts.INTERVAL ?? "1", 10) || 1);
  const maxOccurrences = Math.min(count, 500);

  // Occurrences are walked in the event's own zone so a DST transition inside
  // the window keeps the wall-clock time, and so BYDAY matches the local day.
  const start = DateTime.fromMillis(dtstart, { zone: timezone });
  const timeOfDay = {
    hour: start.hour,
    minute: start.minute,
    second: start.second,
    millisecond: start.millisecond,
  };

  let generated = 0;

  const push = (startMs: number) => {
    const endMs = startMs + duration;
    if (endMs > windowStart && startMs < windowEnd) {
      results.push({ startMs, endMs });
    }
  };

  if (freq === "DAILY") {
    let current = start;
    while (current.toMillis() < until && generated < maxOccurrences) {
      push(current.toMillis());
      current = current.plus({ days: interval });
      generated++;
    }
  } else if (freq === "WEEKLY") {
    const byDay = parts.BYDAY?.split(",") ?? [];
    const dayMap: Record<string, number> = {
      SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
    };

    if (byDay.length === 0) {
      let current = start;
      while (current.toMillis() < until && generated < maxOccurrences) {
        push(current.toMillis());
        current = current.plus({ weeks: interval });
        generated++;
      }
    } else {
      const targetDays = byDay.map((d) => dayMap[d]).filter((d) => d !== undefined);
      let weekStart = start.startOf("day").minus({ days: start.weekday % 7 });

      while (weekStart.toMillis() < until && generated < maxOccurrences) {
        for (const targetDay of targetDays) {
          const candidate = weekStart
            .plus({ days: targetDay })
            .set(timeOfDay)
            .toMillis();

          if (candidate < dtstart) continue;
          if (candidate >= until) continue;

          push(candidate);
          generated++;
          if (generated >= maxOccurrences) break;
        }
        weekStart = weekStart.plus({ weeks: interval });
      }
    }
  } else if (freq === "MONTHLY") {
    const dayOfMonth = start.day;
    let monthStart = start.startOf("month");

    while (generated < maxOccurrences) {
      const candidate = monthStart.set({ day: dayOfMonth, ...timeOfDay });
      if (candidate.toMillis() >= until) break;

      // Verify the day didn't overflow (e.g. Feb 31 -> Mar 3)
      if (candidate.day === dayOfMonth) {
        push(candidate.toMillis());
        generated++;
      }

      monthStart = monthStart.plus({ months: interval });
    }
  }

  return results;
}

function parseIcsDateBasic(value: string): number | null {
  const clean = value.trim();
  if (/^\d{8}T\d{6}Z?$/i.test(clean)) {
    const year = parseInt(clean.slice(0, 4), 10);
    const month = parseInt(clean.slice(4, 6), 10) - 1;
    const day = parseInt(clean.slice(6, 8), 10);
    const hour = parseInt(clean.slice(9, 11), 10);
    const minute = parseInt(clean.slice(11, 13), 10);
    const second = parseInt(clean.slice(13, 15), 10);
    return Date.UTC(year, month, day, hour, minute, second);
  }
  if (/^\d{8}$/.test(clean)) {
    const year = parseInt(clean.slice(0, 4), 10);
    const month = parseInt(clean.slice(4, 6), 10) - 1;
    const day = parseInt(clean.slice(6, 8), 10);
    return Date.UTC(year, month, day);
  }
  return null;
}

// ── Convex functions ────────────────────────────────────────────────

export const getSource = internalQuery({
  args: { calendarSourceId: v.id("calendarSources") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.calendarSourceId);
  },
});

export const getProfile = internalQuery({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.profileId);
  },
});

export const getEnabledSourcesForProfile = internalQuery({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("calendarSources")
      .withIndex("by_profileId_and_enabled", (q) =>
        q.eq("profileId", args.profileId).eq("enabled", true)
      )
      .collect();
  },
});

export const updateSourceSyncStatus = internalMutation({
  args: {
    calendarSourceId: v.id("calendarSources"),
    lastSyncAt: v.number(),
    lastSyncStatus: v.union(v.literal("success"), v.literal("error")),
    lastSyncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.calendarSourceId, {
      lastSyncAt: args.lastSyncAt,
      lastSyncStatus: args.lastSyncStatus,
      lastSyncError: args.lastSyncError,
    });
  },
});

export const dispatchOverdueSyncs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SYNC_INTERVAL_MS;

    // Disabled sources never advance lastSyncAt, so they sit permanently at the
    // head of this index. Skip past them under a scan budget instead of letting
    // them consume the dispatch budget, and keep least-recently-synced order.
    const overdue = ctx.db
      .query("calendarSources")
      .withIndex("by_lastSyncAt")
      .order("asc");

    let scanned = 0;
    let dispatched = 0;

    for await (const source of overdue) {
      if (source.lastSyncAt !== undefined && source.lastSyncAt >= cutoff) break;
      if (scanned++ >= MAX_DISPATCH_SCAN) break;
      if (!source.enabled) continue;

      await ctx.scheduler.runAfter(0, internal.calendarSync.syncForSource, {
        calendarSourceId: source._id,
      });

      if (++dispatched >= MAX_DISPATCH_PER_RUN) break;
    }
  },
});

export const syncForSource = internalAction({
  args: { calendarSourceId: v.id("calendarSources") },
  handler: async (ctx, args) => {
    const source: Doc<"calendarSources"> | null = await ctx.runQuery(
      internal.calendarSync.getSource,
      { calendarSourceId: args.calendarSourceId },
    );
    if (!source || !source.enabled) return;

    const profile: Doc<"userProfiles"> | null = await ctx.runQuery(
      internal.calendarSync.getProfile,
      { profileId: source.profileId },
    );
    if (!profile) return;

    const timezone = profile.timezone;

    try {
      let events: NormalizedEvent[];

      if (source.type === "google") {
        events = await fetchGoogleEvents(source, timezone);
      } else {
        events = await fetchIcsEvents(source.icsUrl, timezone);
      }

      const capped = capSyncEvents(events);

      await ctx.runMutation(internal.calendarSync.processCalendarEvents, {
        profileId: source.profileId,
        calendarSourceId: args.calendarSourceId,
        events: capped.events,
        timezone,
      });

      await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
        calendarSourceId: args.calendarSourceId,
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        lastSyncError: capped.note,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
        calendarSourceId: args.calendarSourceId,
        lastSyncAt: Date.now(),
        lastSyncStatus: "error",
        lastSyncError: message,
      });
    }
  },
});

async function participatingScheduleIds(
  ctx: MutationCtx,
  profileId: Id<"userProfiles">,
): Promise<Id<"schedules">[]> {
  // Find schedules where user is creator
  const createdSchedules = await ctx.db
    .query("schedules")
    .withIndex("by_creatorProfileId", (q) => q.eq("creatorProfileId", profileId))
    .take(MAX_PROFILE_CREATED_SCHEDULES_FOR_SYNC);

  const scheduleIds: Id<"schedules">[] = createdSchedules.map((s) => s._id);
  const seen = new Set(scheduleIds.map((id) => id.toString()));

  const profileSelections = await ctx.db
    .query("selections")
    .withIndex("by_profileId", (q) => q.eq("profileId", profileId))
    .take(MAX_PROFILE_SELECTIONS_FOR_SYNC);

  for (const selection of profileSelections) {
    if (scheduleIds.length >= MAX_CALENDAR_SYNC_SCHEDULES) break;
    if (seen.has(selection.scheduleId.toString())) continue;
    const schedule = await ctx.db.get(selection.scheduleId);
    if (!schedule) continue;
    scheduleIds.push(selection.scheduleId);
    seen.add(selection.scheduleId.toString());
  }

  return scheduleIds.slice(0, MAX_CALENDAR_SYNC_SCHEDULES);
}

async function syncScheduleSelections(
  ctx: MutationCtx,
  args: {
    schedule: Doc<"schedules">;
    profileId: Id<"userProfiles">;
    calendarSourceId: Id<"calendarSources">;
    events: NormalizedEvent[];
    timezone: string;
  },
) {
  const { schedule, profileId, calendarSourceId, events, timezone } = args;

  const overrides = await ctx.db
    .query("calendarOverrides")
    .withIndex("by_profile_schedule", (q) =>
      q.eq("profileId", profileId).eq("scheduleId", schedule._id),
    )
    .take(MAX_OVERRIDES_PER_SCHEDULE);

  const overridesByEvent = new Map<string, Doc<"calendarOverrides">[]>();
  // Rows for events that have left the feed have no occurrence to normalise
  // against, so those are matched on their stored coordinates.
  const storedOverrideKeys = new Set<string>();
  for (const override of overrides) {
    const forEvent = overridesByEvent.get(override.externalEventId);
    if (forEvent) forEvent.push(override);
    else overridesByEvent.set(override.externalEventId, [override]);
    storedOverrideKeys.add(
      `${override.externalEventId}|${override.dayKey}|${override.timeSlot}`,
    );
  }

  const currentEventIds = new Set(events.map((e) => e.externalEventId));

  const existingCalendarSelections = await ctx.db
    .query("selections")
    .withIndex("by_schedule_profile_source", (q) =>
      q
        .eq("scheduleId", schedule._id)
        .eq("profileId", profileId)
        .eq("source", "calendar"),
    )
    .take(MAX_EXISTING_CALENDAR_SELECTIONS);

  // Only this source's rows are ours to remove; another source owns the rest.
  // Rows written before calendarSourceId existed are adopted by whichever
  // source syncs first.
  const ownedSelections = existingCalendarSelections.filter(
    (sel) =>
      sel.calendarSourceId === undefined ||
      sel.calendarSourceId === calendarSourceId,
  );

  // Delete stale calendar selections (event no longer in feed)
  for (const sel of ownedSelections) {
    if (sel.externalEventId && !currentEventIds.has(sel.externalEventId)) {
      const overrideKey = `${sel.externalEventId}|${sel.dayKey}|${sel.timeSlot}`;
      if (!storedOverrideKeys.has(overrideKey)) {
        await ctx.db.delete(sel._id);
      }
    }
  }

  // Build map of remaining calendar selections for upsert
  const existingMap = new Map<string, Id<"selections">>();
  for (const sel of ownedSelections) {
    if (sel.externalEventId && currentEventIds.has(sel.externalEventId)) {
      const key = sel.isException
        ? `${sel.dayKey}|${sel.timeSlot}|exc|${sel.exceptionDate}`
        : `${sel.dayKey}|${sel.timeSlot}|base`;
      existingMap.set(key, sel._id);
    }
  }

  const retainedCalendarSelectionIds = new Set<Id<"selections">>();
  const patchedOverrideIds = new Set<Id<"calendarOverrides">>();
  const processedEventIds = new Set<string>();
  let slotWrites = 0;

  for (const event of events) {
    // Guards the transaction write limit. Events left unprocessed keep the rows
    // they already have rather than being treated as stale.
    if (slotWrites >= MAX_SLOT_WRITES_PER_SCHEDULE) break;
    processedEventIds.add(event.externalEventId);

    // An override is stored in the timezone it was dismissed in. Normalise it
    // against the same instant the slots below are derived from, or the two
    // disagree across a DST boundary and the override stops matching.
    const reference = DateTime.fromMillis(event.startMs, { zone: timezone });
    const overrideKeys = new Set<string>();

    for (const override of overridesByEvent.get(event.externalEventId) ?? []) {
      const normalized = override.timezone
        ? convertCellToTimezone(
            schedule.type,
            override,
            override.timezone,
            timezone,
            reference,
          )
        : override;
      overrideKeys.add(`${normalized.dayKey}|${normalized.timeSlot}`);

      if (
        override.timezone &&
        !patchedOverrideIds.has(override._id) &&
        (override.timezone !== timezone ||
          override.dayKey !== normalized.dayKey ||
          override.timeSlot !== normalized.timeSlot ||
          override.exceptionDate !== normalized.exceptionDate)
      ) {
        patchedOverrideIds.add(override._id);
        await ctx.db.patch(override._id, {
          dayKey: normalized.dayKey,
          timeSlot: normalized.timeSlot,
          timezone,
          isException: normalized.isException,
          exceptionDate: normalized.exceptionDate,
        });
      }
    }

    const slots = eventToSlots(
      event.startMs,
      event.endMs,
      timezone,
      schedule.type,
      event.isRecurring,
    );

    for (const slot of slots) {
      // Check override
      if (overrideKeys.has(`${slot.dayKey}|${slot.timeSlot}`)) continue;

      // Check date range for one-off schedules
      if (schedule.type === "one-off") {
        const scheduleCell = convertCellToTimezone(
          schedule.type,
          slot,
          timezone,
          schedule.creatorTimezone,
          DateTime.fromMillis(event.startMs, {
            zone: schedule.creatorTimezone,
          })
        );
        if (
          schedule.dateRangeStart &&
          schedule.dateRangeEnd &&
          (scheduleCell.dayKey < schedule.dateRangeStart ||
            scheduleCell.dayKey > schedule.dateRangeEnd)
        ) {
          continue;
        }
      }

      const mapKey = slot.isException
        ? `${slot.dayKey}|${slot.timeSlot}|exc|${slot.exceptionDate}`
        : `${slot.dayKey}|${slot.timeSlot}|base`;

      const existingId = existingMap.get(mapKey);
      if (existingId) {
        await ctx.db.patch(existingId, {
          state: "cant-do" as const,
          timezone,
          source: "calendar" as const,
          externalEventId: event.externalEventId,
          calendarSourceId,
        });
        retainedCalendarSelectionIds.add(existingId);
      } else {
        const newId = await ctx.db.insert("selections", {
          scheduleId: schedule._id,
          profileId,
          dayKey: slot.dayKey,
          timeSlot: slot.timeSlot,
          timezone,
          state: "cant-do",
          isException: slot.isException,
          exceptionDate: slot.exceptionDate,
          source: "calendar",
          externalEventId: event.externalEventId,
          calendarSourceId,
        });
        existingMap.set(mapKey, newId);
        retainedCalendarSelectionIds.add(newId);
      }
      slotWrites++;
    }
  }

  // A profile timezone change can move every slot while keeping the same
  // external event IDs. Remove the old coordinates once the desired
  // coordinates for those events have been retained or inserted.
  for (const selection of ownedSelections) {
    if (
      selection.externalEventId &&
      processedEventIds.has(selection.externalEventId) &&
      !retainedCalendarSelectionIds.has(selection._id)
    ) {
      await ctx.db.delete(selection._id);
    }
  }
}

export const processCalendarEvents = internalMutation({
  args: {
    profileId: v.id("userProfiles"),
    calendarSourceId: v.id("calendarSources"),
    events: v.array(normalizedEventValidator),
    timezone: v.string(),
    // Continuation cursor. Resolved once on the first call so that the rows a
    // batch writes cannot reshuffle the schedules the next batch sees.
    scheduleIds: v.optional(v.array(v.id("schedules"))),
  },
  handler: async (ctx, args) => {
    const { profileId, calendarSourceId, events, timezone } = args;

    const scheduleIds =
      args.scheduleIds ?? (await participatingScheduleIds(ctx, profileId));

    const batch = scheduleIds.slice(0, SCHEDULES_PER_SYNC_BATCH);
    const remaining = scheduleIds.slice(SCHEDULES_PER_SYNC_BATCH);

    for (const scheduleId of batch) {
      const schedule = await ctx.db.get(scheduleId);
      if (!schedule) continue;
      await syncScheduleSelections(ctx, {
        schedule,
        profileId,
        calendarSourceId,
        events,
        timezone,
      });
    }

    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.processCalendarEvents,
        {
          profileId,
          calendarSourceId,
          events,
          timezone,
          scheduleIds: remaining,
        },
      );
    }
  },
});

export const cleanupSelectionsForProfile = internalMutation({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const BATCH_LIMIT = 500;
    const selections = await ctx.db
      .query("selections")
      .withIndex("by_profileId_source", (q) =>
        q.eq("profileId", args.profileId).eq("source", "calendar")
      )
      .take(BATCH_LIMIT);

    for (const sel of selections) {
      await ctx.db.delete(sel._id);
    }

    if (selections.length === BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, internal.calendarSync.cleanupSelectionsForProfile, {
        profileId: args.profileId,
      });
    }
  },
});

export const triggerSyncForProfile = action({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not authenticated");
    }
    const identityId = await ctx.runQuery(googlyAuth.component.lib.resolve, {
      googleSubject: identity.tokenIdentifier,
    });
    if (identityId === null) throw new Error("Not authenticated");

    const profile: Doc<"userProfiles"> | null = await ctx.runQuery(
      internal.calendarSync.getProfile,
      { profileId: args.profileId },
    );
    if (!profile || profile.identityId !== identityId) {
      throw new Error("Not authorized");
    }

    const sources: Doc<"calendarSources">[] = await ctx.runQuery(
      internal.calendarSync.getEnabledSourcesForProfile,
      { profileId: args.profileId },
    );

    const timezone = profile.timezone;
    const results: { sourceId: Id<"calendarSources">; status: "success" | "error"; error?: string }[] = [];

    for (const source of sources) {
      try {
        let events: NormalizedEvent[];

        if (source.type === "google") {
          events = await fetchGoogleEvents(source, timezone);
        } else {
          events = await fetchIcsEvents(source.icsUrl, timezone);
        }

        const capped = capSyncEvents(events);

        await ctx.runMutation(internal.calendarSync.processCalendarEvents, {
          profileId: args.profileId,
          calendarSourceId: source._id,
          events: capped.events,
          timezone,
        });

        await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
          calendarSourceId: source._id,
          lastSyncAt: Date.now(),
          lastSyncStatus: "success",
          lastSyncError: capped.note,
        });

        results.push({ sourceId: source._id, status: "success" });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);

        await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
          calendarSourceId: source._id,
          lastSyncAt: Date.now(),
          lastSyncStatus: "error",
          lastSyncError: message,
        });

        results.push({ sourceId: source._id, status: "error", error: message });
      }
    }

    return results;
  },
});
