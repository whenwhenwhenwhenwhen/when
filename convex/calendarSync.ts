import { v } from "convex/values";
import { DateTime } from "luxon";
import {
  internalAction,
  internalMutation,
  internalQuery,
  action,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { convertCellToTimezone } from "./timezone";

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SLOT_MS = 30 * 60 * 1000;
const MAX_CALENDAR_SYNC_SCHEDULES = 50;
const MAX_PROFILE_SELECTIONS_FOR_SYNC = 500;
const MAX_PROFILE_CREATED_SCHEDULES_FOR_SYNC = 50;

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

  let current = Math.floor(startMs / SLOT_MS) * SLOT_MS;

  const dowMap: Record<string, string> = {
    Sun: "0", Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6",
  };

  while (current < endMs) {
    const date = new Date(current);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(date);

    const partsMap: Record<string, string> = {};
    for (const p of parts) partsMap[p.type] = p.value;

    const year = partsMap.year;
    const month = partsMap.month;
    const day = partsMap.day;
    const hour = partsMap.hour === "24" ? "00" : partsMap.hour;
    const minute = partsMap.minute;
    const weekday = partsMap.weekday;

    const isoDate = `${year}-${month}-${day}`;
    const timeSlot = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    const dowStr = dowMap[weekday] ?? "0";

    if (scheduleType === "one-off") {
      slots.push({ dayKey: isoDate, timeSlot });
    } else if (isRecurring) {
      slots.push({ dayKey: dowStr, timeSlot });
    } else {
      slots.push({ dayKey: dowStr, timeSlot, isException: true, exceptionDate: isoDate });
    }

    current += SLOT_MS;
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
  const futureDate = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
  const timeMax = futureDate.toISOString();

  const events: NormalizedEvent[] = [];

  for (const calendarId of calendarIds) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      fields: "items(id,summary,start,end,status,transparency,recurringEventId)",
    });

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
  }

  return events;
}

function allDayDateToMs(dateStr: string, timezone: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(probe);
  const pm: Record<string, string> = {};
  for (const p of parts) pm[p.type] = p.value;

  const localHour = parseInt(pm.hour === "24" ? "0" : pm.hour, 10);
  const localMinute = parseInt(pm.minute, 10);
  const localSecond = parseInt(pm.second, 10);

  const offsetMs = (localHour * 3600 + localMinute * 60 + localSecond) * 1000;
  // probe was noon UTC; local time at probe tells us the offset
  // We want midnight local = start of that date in the timezone
  const midnightUtc = probe.getTime() - offsetMs;
  return midnightUtc;
}

async function fetchIcsEvents(
  icsUrl: string | undefined,
  timezone: string,
): Promise<NormalizedEvent[]> {
  if (!icsUrl) throw new Error("No ICS URL provided");

  const response = await fetch(icsUrl);
  if (!response.ok) {
    throw new Error(`ICS fetch failed (${response.status}): ${await response.text()}`);
  }
  const icsText = await response.text();
  return parseIcsEvents(icsText, timezone);
}

function parseIcsEvents(icsText: string, timezone: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  const now = Date.now();
  const windowEnd = now + 28 * 24 * 60 * 60 * 1000;

  const veventBlocks = icsText.split("BEGIN:VEVENT");
  // First element is preamble
  for (let i = 1; i < veventBlocks.length; i++) {
    const block = veventBlocks[i].split("END:VEVENT")[0];
    if (!block) continue;

    const uid = extractIcsField(block, "UID");
    const summary = extractIcsField(block, "SUMMARY");
    const transp = extractIcsField(block, "TRANSP") ?? "OPAQUE";
    const rrule = extractIcsField(block, "RRULE");

    if (transp === "TRANSPARENT") continue;
    if (!uid) continue;

    const dtstart = parseIcsDt(block, "DTSTART", timezone);
    const dtend = parseIcsDt(block, "DTEND", timezone);
    if (dtstart === null) continue;

    const duration = dtend !== null ? dtend - dtstart : 60 * 60 * 1000;

    if (rrule) {
      const occurrences = expandRRule(dtstart, duration, rrule, now, windowEnd);
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
      const endMs = dtstart + duration;
      if (endMs <= now || dtstart >= windowEnd) continue;
      events.push({
        externalEventId: uid,
        summary,
        startMs: dtstart,
        endMs,
        isRecurring: false,
      });
    }
  }

  return events;
}

function extractIcsField(block: string, field: string): string | undefined {
  // Handle both "FIELD:value" and "FIELD;params:value" with possible line folding
  const regex = new RegExp(`(?:^|\\n)${field}(?:[;:])([^\\r\\n]*)`, "i");
  const match = block.match(regex);
  if (!match) return undefined;
  let line = match[0].replace(/^\n/, "");
  // Strip field name (everything up to the first colon after the field name)
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return undefined;
  let value = line.slice(colonIdx + 1).trim();
  // Handle line folding (lines starting with space or tab)
  const remaining = block.slice(block.indexOf(match[0]) + match[0].length);
  const foldedLines = remaining.split(/\r?\n/);
  for (const fl of foldedLines) {
    if (fl.startsWith(" ") || fl.startsWith("\t")) {
      value += fl.slice(1);
    } else {
      break;
    }
  }
  return value;
}

function parseIcsDt(
  block: string,
  field: string,
  defaultTimezone: string,
): number | null {
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
  if (tzidMatch) tzid = tzidMatch[1];

  // All-day: 8 digits
  if (/^\d{8}$/.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10);
    const day = parseInt(value.slice(6, 8), 10);
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return allDayDateToMs(dateStr, tzid ?? defaultTimezone);
  }

  // UTC: ends with Z
  if (/^\d{8}T\d{6}Z$/i.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10) - 1;
    const day = parseInt(value.slice(6, 8), 10);
    const hour = parseInt(value.slice(9, 11), 10);
    const minute = parseInt(value.slice(11, 13), 10);
    const second = parseInt(value.slice(13, 15), 10);
    return Date.UTC(year, month, day, hour, minute, second);
  }

  // Local time (with or without TZID)
  if (/^\d{8}T\d{6}$/.test(value)) {
    const year = parseInt(value.slice(0, 4), 10);
    const month = parseInt(value.slice(4, 6), 10);
    const day = parseInt(value.slice(6, 8), 10);
    const hour = parseInt(value.slice(9, 11), 10);
    const minute = parseInt(value.slice(11, 13), 10);
    const second = parseInt(value.slice(13, 15), 10);
    return localTimeToMs(year, month, day, hour, minute, second, tzid ?? defaultTimezone);
  }

  return null;
}

function localTimeToMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): number {
  // Estimate UTC by creating a date, then adjust based on offset
  const estimate = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(estimate));
  const pm: Record<string, string> = {};
  for (const p of parts) pm[p.type] = p.value;

  const localYear = parseInt(pm.year, 10);
  const localMonth = parseInt(pm.month, 10);
  const localDay = parseInt(pm.day, 10);
  const localHour = parseInt(pm.hour === "24" ? "0" : pm.hour, 10);
  const localMinute = parseInt(pm.minute, 10);
  const localSecond = parseInt(pm.second, 10);

  const localEstimate = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond);
  const offset = localEstimate - estimate;

  return estimate - offset;
}

function expandRRule(
  dtstart: number,
  duration: number,
  rrule: string,
  windowStart: number,
  windowEnd: number,
): { startMs: number; endMs: number }[] {
  const results: { startMs: number; endMs: number }[] = [];

  const parts: Record<string, string> = {};
  for (const part of rrule.split(";")) {
    const [key, val] = part.split("=");
    if (key && val) parts[key.toUpperCase()] = val.toUpperCase();
  }

  const freq = parts.FREQ;
  if (!freq) return results;

  let until = windowEnd;
  if (parts.UNTIL) {
    const untilMs = parseIcsDateBasic(parts.UNTIL);
    if (untilMs !== null && untilMs < until) until = untilMs;
  }

  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : 1000;
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1;
  const maxOccurrences = Math.min(count, 500);

  let generated = 0;

  if (freq === "DAILY") {
    let current = dtstart;
    while (current < until && generated < maxOccurrences) {
      const endMs = current + duration;
      if (endMs > windowStart && current < windowEnd) {
        results.push({ startMs: current, endMs });
      }
      current += interval * 24 * 60 * 60 * 1000;
      generated++;
    }
  } else if (freq === "WEEKLY") {
    const byDay = parts.BYDAY?.split(",") ?? [];
    const dayMap: Record<string, number> = {
      SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
    };

    if (byDay.length === 0) {
      let current = dtstart;
      while (current < until && generated < maxOccurrences) {
        const endMs = current + duration;
        if (endMs > windowStart && current < windowEnd) {
          results.push({ startMs: current, endMs });
        }
        current += interval * 7 * 24 * 60 * 60 * 1000;
        generated++;
      }
    } else {
      const targetDays = byDay.map((d) => dayMap[d]).filter((d) => d !== undefined);
      const startDate = new Date(dtstart);
      const startDow = startDate.getUTCDay();

      let weekStart = dtstart - startDow * 24 * 60 * 60 * 1000;

      while (weekStart < until && generated < maxOccurrences) {
        for (const targetDay of targetDays) {
          const dayOffset = targetDay * 24 * 60 * 60 * 1000;
          const timeOfDay = dtstart - (dtstart - (dtstart % (24 * 60 * 60 * 1000)));
          const candidate = weekStart + dayOffset + (dtstart % (24 * 60 * 60 * 1000));

          if (candidate < dtstart) continue;
          if (candidate >= until) continue;

          const endMs = candidate + duration;
          if (endMs > windowStart && candidate < windowEnd) {
            results.push({ startMs: candidate, endMs });
          }
          generated++;
          if (generated >= maxOccurrences) break;
        }
        weekStart += interval * 7 * 24 * 60 * 60 * 1000;
      }
    }
  } else if (freq === "MONTHLY") {
    const startDate = new Date(dtstart);
    let currentYear = startDate.getUTCFullYear();
    let currentMonth = startDate.getUTCMonth();
    const dayOfMonth = startDate.getUTCDate();
    const timeOffset = dtstart - Date.UTC(currentYear, currentMonth, dayOfMonth);

    while (generated < maxOccurrences) {
      const candidate = Date.UTC(currentYear, currentMonth, dayOfMonth) + timeOffset;
      if (candidate >= until) break;

      // Verify the day didn't overflow (e.g. Feb 31 -> Mar 3)
      const check = new Date(candidate - timeOffset);
      if (check.getUTCDate() === dayOfMonth) {
        const endMs = candidate + duration;
        if (endMs > windowStart && candidate < windowEnd) {
          results.push({ startMs: candidate, endMs });
        }
        generated++;
      }

      currentMonth += interval;
      if (currentMonth > 11) {
        currentYear += Math.floor(currentMonth / 12);
        currentMonth = currentMonth % 12;
      }
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

    const sources = await ctx.db
      .query("calendarSources")
      .withIndex("by_lastSyncAt")
      .order("asc")
      .take(20);

    for (const source of sources) {
      if (!source.enabled) continue;
      if (source.lastSyncAt !== undefined && source.lastSyncAt >= cutoff) continue;

      await ctx.scheduler.runAfter(0, internal.calendarSync.syncForSource, {
        calendarSourceId: source._id,
      });
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

      await ctx.runMutation(internal.calendarSync.processCalendarEvents, {
        profileId: source.profileId,
        calendarSourceId: args.calendarSourceId,
        events,
        timezone,
      });

      await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
        calendarSourceId: args.calendarSourceId,
        lastSyncAt: Date.now(),
        lastSyncStatus: "success",
        lastSyncError: undefined,
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

export const processCalendarEvents = internalMutation({
  args: {
    profileId: v.id("userProfiles"),
    calendarSourceId: v.id("calendarSources"),
    events: v.array(normalizedEventValidator),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const { profileId, events, timezone } = args;

    // Find schedules where user is creator
    const createdSchedules = await ctx.db
      .query("schedules")
      .withIndex("by_creatorProfileId", (q) => q.eq("creatorProfileId", profileId))
      .take(MAX_PROFILE_CREATED_SCHEDULES_FOR_SYNC);

    const profileSelections = await ctx.db
      .query("selections")
      .withIndex("by_profileId", (q) => q.eq("profileId", profileId))
      .take(MAX_PROFILE_SELECTIONS_FOR_SYNC);

    const createdIds = new Set(createdSchedules.map((s) => s._id.toString()));
    const participatingSchedules: Doc<"schedules">[] = [...createdSchedules];
    const participatingIds = new Set(createdIds);

    for (const selection of profileSelections) {
      if (participatingIds.has(selection.scheduleId.toString())) continue;
      const schedule = await ctx.db.get(selection.scheduleId);
      if (!schedule) continue;
      participatingSchedules.push(schedule);
      participatingIds.add(selection.scheduleId.toString());
      if (participatingSchedules.length >= MAX_CALENDAR_SYNC_SCHEDULES) break;
    }

    const currentEventIds = new Set(events.map((e) => e.externalEventId));

    // Cap schedules and events to stay within transaction limits.
    const limitedSchedules = participatingSchedules.slice(0, MAX_CALENDAR_SYNC_SCHEDULES);
    const limitedEvents = events.slice(0, 200);

    for (const schedule of limitedSchedules) {
      const overrides = await ctx.db
        .query("calendarOverrides")
        .withIndex("by_profile_schedule", (q) =>
          q.eq("profileId", profileId).eq("scheduleId", schedule._id),
        )
        .collect();

      const overrideSet = new Set<string>();
      const overrideReferenceDate = DateTime.now().setZone(timezone);
      for (const override of overrides) {
        const normalized = override.timezone
          ? convertCellToTimezone(
              schedule.type,
              override,
              override.timezone,
              timezone,
              overrideReferenceDate
            )
          : override;
        overrideSet.add(
          `${override.externalEventId}|${normalized.dayKey}|${normalized.timeSlot}`
        );

        if (
          override.timezone &&
          (override.timezone !== timezone ||
            override.dayKey !== normalized.dayKey ||
            override.timeSlot !== normalized.timeSlot ||
            override.exceptionDate !== normalized.exceptionDate)
        ) {
          await ctx.db.patch(override._id, {
            dayKey: normalized.dayKey,
            timeSlot: normalized.timeSlot,
            timezone,
            isException: normalized.isException,
            exceptionDate: normalized.exceptionDate,
          });
        }
      }

      const existingCalendarSelections = await ctx.db
        .query("selections")
        .withIndex("by_schedule_profile_source", (q) =>
          q
            .eq("scheduleId", schedule._id)
            .eq("profileId", profileId)
            .eq("source", "calendar"),
        )
        .collect();

      // Delete stale calendar selections (event no longer in feed)
      for (const sel of existingCalendarSelections) {
        if (sel.externalEventId && !currentEventIds.has(sel.externalEventId)) {
          const overrideKey = `${sel.externalEventId}|${sel.dayKey}|${sel.timeSlot}`;
          if (!overrideSet.has(overrideKey)) {
            await ctx.db.delete(sel._id);
          }
        }
      }

      // Build map of remaining calendar selections for upsert
      const existingMap = new Map<string, Id<"selections">>();
      for (const sel of existingCalendarSelections) {
        if (sel.externalEventId && currentEventIds.has(sel.externalEventId)) {
          const key = sel.isException
            ? `${sel.dayKey}|${sel.timeSlot}|exc|${sel.exceptionDate}`
            : `${sel.dayKey}|${sel.timeSlot}|base`;
          existingMap.set(key, sel._id);
        }
      }
      const retainedCalendarSelectionIds = new Set<Id<"selections">>();

      for (const event of limitedEvents) {
        const slots = eventToSlots(
          event.startMs,
          event.endMs,
          timezone,
          schedule.type,
          event.isRecurring,
        );

        for (const slot of slots) {
          // Check override
          const overrideKey = `${event.externalEventId}|${slot.dayKey}|${slot.timeSlot}`;
          if (overrideSet.has(overrideKey)) continue;

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
            });
            existingMap.set(mapKey, newId);
            retainedCalendarSelectionIds.add(newId);
          }
        }
      }

      // A profile timezone change can move every slot while keeping the same
      // external event IDs. Remove the old coordinates once the desired
      // coordinates for those events have been retained or inserted.
      for (const selection of existingCalendarSelections) {
        if (
          selection.externalEventId &&
          currentEventIds.has(selection.externalEventId) &&
          !retainedCalendarSelectionIds.has(selection._id)
        ) {
          await ctx.db.delete(selection._id);
        }
      }
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
    if (!identity) throw new Error("Not authenticated");

    const profile: Doc<"userProfiles"> | null = await ctx.runQuery(
      internal.calendarSync.getProfile,
      { profileId: args.profileId },
    );
    if (!profile || profile.authUserId !== identity.tokenIdentifier) {
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

        await ctx.runMutation(internal.calendarSync.processCalendarEvents, {
          profileId: args.profileId,
          calendarSourceId: source._id,
          events,
          timezone,
        });

        await ctx.runMutation(internal.calendarSync.updateSourceSyncStatus, {
          calendarSourceId: source._id,
          lastSyncAt: Date.now(),
          lastSyncStatus: "success",
          lastSyncError: undefined,
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
