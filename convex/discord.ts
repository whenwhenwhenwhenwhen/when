import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  action,
  internalAction,
  ActionCtx,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  buildSummaryMessage,
  buildLockedSlotSnapshot,
  buildDiscordDstNotice,
  buildDiscordProjectionSnapshot,
  postChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  editOriginalInteractionResponse,
  fetchGuildChannels,
  fetchGuildInfo,
  findPinnedScheduleMessage,
  DiscordApiError,
  DISCORD_NEVER_START_NEW_MESSAGE,
  getDiscordNewMessageAfterMs,
  getDiscordRetryDelayMs,
  getMissingDiscordInstallConfiguration,
  shouldPostNewDiscordMessage,
  SummaryInput,
} from "./discordHelpers";

const INSTALL_SESSION_TTL_MS = 15 * 60 * 1000;
const INSTALL_SESSION_CLEANUP_BATCH_SIZE = 100;
const USER_LINK_SESSION_TTL_MS = 15 * 60 * 1000;
const USER_LINK_SESSION_CLEANUP_BATCH_SIZE = 100;
const MIN_NEW_MESSAGE_AFTER_MS = 60 * 1000;
const MAX_NEW_MESSAGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISCORD_DELIVERY_RETRIES = 5;
const MAX_DISCORD_RETRY_DELAY_MS = 15 * 60 * 1000;

function getAppBaseUrl(): string {
  const siteUrl = process.env.SITE_URL;
  // Embed URLs must be absolute: the pin override reads the schedule back out
  // of a posted message by parsing them.
  if (!siteUrl) {
    throw new Error(
      "SITE_URL must be set before When? can post schedules to Discord",
    );
  }
  return siteUrl;
}

function isInstallSessionExpired(session: Doc<"discordInstallSessions">): boolean {
  return Date.now() - session.createdAt > INSTALL_SESSION_TTL_MS;
}

async function getCallerProfile(
  ctx: QueryCtx | MutationCtx,
  args: { anonymousId?: string }
): Promise<Doc<"userProfiles">> {
  const identity = await ctx.auth.getUserIdentity();

  if (identity) {
    const authProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_authUserId", (q) =>
        q.eq("authUserId", identity.tokenIdentifier)
      )
      .unique();
    if (authProfile) return authProfile;
  }

  if (args.anonymousId) {
    const anonymousProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_anonymousId", (q) => q.eq("anonymousId", args.anonymousId))
      .unique();
    if (anonymousProfile) return anonymousProfile;
  }

  throw new Error("Not authorized");
}

// ---------------------------------------------------------------------------
// Queries — used by HTTP route handlers and frontend
// ---------------------------------------------------------------------------

export const getLink = internalQuery({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.linkId);
  },
});

export const getLinkForScheduleChannel = internalQuery({
  args: {
    scheduleId: v.id("schedules"),
    channelId: v.string(),
  },
  handler: async (ctx, args) => {
    const channelLinks = await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(100);
    return (
      channelLinks.find((link) => link.scheduleId === args.scheduleId) ?? null
    );
  },
});

export const getOwnedInstallSession = internalQuery({
  args: {
    sessionToken: v.string(),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!session || isInstallSessionExpired(session)) return null;

    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });
    if (session.profileId !== profile._id) {
      throw new Error("Not authorized");
    }
    return session;
  },
});

export const getInstallSessionByToken = query({
  args: {
    sessionToken: v.string(),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!session || isInstallSessionExpired(session)) return null;

    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });
    if (session.profileId !== profile._id) {
      throw new Error("Not authorized");
    }

    return {
      _id: session._id,
      scheduleId: session.scheduleId,
      guildId: session.guildId,
      guildName: session.guildName,
      channels: session.channels ?? [],
    };
  },
});

/**
 * Public query used by the schedule view to decide whether to show
 * "Linked to #channel" vs the link button.
 */
export const linksForScheduleSummary = query({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
    return links.map((l) => ({
      _id: l._id,
      channelId: l.channelId,
      channelName: l.channelName,
      guildId: l.guildId,
      guildName: l.guildName,
      linkedAt: l.linkedAt,
      lastMessageId: l.lastMessageId,
      pendingUpdateAt: l.pendingUpdateAt,
      pendingUpdateReason: l.pendingUpdateReason,
      pendingRetryAttempt: l.pendingRetryAttempt,
      lastNotifiedAt: l.lastNotifiedAt,
      lastUpdateAttemptAt: l.lastUpdateAttemptAt,
      lastUpdateError: l.lastUpdateError,
      newMessageAfterMs: l.newMessageAfterMs,
      dstChangeNotifications: l.dstChangeNotifications ?? false,
    }));
  },
});

/**
 * Lets the frontend fail before sending the user through Discord when the
 * server-side credentials required to finish the callback are absent.
 */
export const getInstallReadiness = action({
  args: {},
  handler: async (): Promise<{ ready: boolean }> => ({
    ready: getMissingDiscordInstallConfiguration().length === 0,
  }),
});

export const getDeliveryDefaults = action({
  args: {},
  handler: async (): Promise<{ newMessageAfterMs: number }> => ({
    newMessageAfterMs: getDiscordNewMessageAfterMs(),
  }),
});

/**
 * Build the SummaryInput object — used both by the slash command response
 * and the debounced update path. Centralised so format stays consistent.
 */
export const buildSummaryInput = internalQuery({
  args: {
    scheduleId: v.id("schedules"),
    referenceTimeMs: v.number(),
  },
  handler: async (ctx, args): Promise<SummaryInput | null> => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return null;

    const dbSelections = await ctx.db
      .query("selections")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();

    type FlatSelection = {
      profileId: string;
      dayKey: string;
      timeSlot: string;
      timezone: string;
      state: SummaryInput["selections"][number]["state"];
      isException?: boolean;
      exceptionDate?: string;
    };

    const flat: FlatSelection[] = dbSelections.map((s) => ({
      profileId: s.profileId as unknown as string,
      dayKey: s.dayKey,
      timeSlot: s.timeSlot,
      timezone: s.timezone,
      state: s.state,
      isException: s.isException,
      exceptionDate: s.exceptionDate,
    }));

    // Add virtual selections from linked saved availabilities
    const links = await ctx.db
      .query("availabilityLinks")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();

    for (const link of links) {
      const savedAvail = await ctx.db.get(link.savedAvailabilityId);
      if (!savedAvail) continue;
      for (const slot of savedAvail.slots) {
        flat.push({
          profileId: link.profileId as unknown as string,
          dayKey: slot.dayKey,
          timeSlot: slot.timeSlot,
          timezone: savedAvail.timezone,
          state: slot.state,
        });
      }
    }

    // Collect display names
    const profileIds = new Set<string>(flat.map((s) => s.profileId));
    profileIds.add(schedule.creatorProfileId as unknown as string);
    const profileNames: Record<string, string> = {};
    for (const id of profileIds) {
      const p = await ctx.db.get(id as Id<"userProfiles">);
      if (p) {
        profileNames[id] = p.displayName;
      }
    }

    return {
      schedule: {
        _id: schedule._id as unknown as string,
        title: schedule.title,
        description: schedule.description,
        type: schedule.type,
        creatorTimezone: schedule.creatorTimezone,
        recurringStartDate: schedule.recurringStartDate,
        lockedSlots: schedule.lockedSlots,
        isLocked: schedule.isLocked,
      },
      profileNames,
      selections: flat,
      referenceTimeMs: args.referenceTimeMs,
      appBaseUrl: getAppBaseUrl(),
    };
  },
});

/**
 * For the /when slash command — fetch schedules created by or participated in
 * by the profile connected to the invoking Discord account.
 */
export const listSchedulesForDiscordUser = internalQuery({
  args: { discordUserId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{
    accountLinked: boolean;
    schedules: Array<{
      _id: Id<"schedules">;
      title: string;
      type: "one-off" | "recurring";
      isLocked?: boolean;
    }>;
  }> => {
    const link = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", args.discordUserId)
      )
      .unique();

    if (!link) return { accountLinked: false, schedules: [] };

    const [created, selections, availabilityLinks, blockedProfiles] =
      await Promise.all([
        ctx.db
          .query("schedules")
          .withIndex("by_creatorProfileId", (q) =>
            q.eq("creatorProfileId", link.profileId)
          )
          .order("desc")
          .take(100),
        ctx.db
          .query("selections")
          .withIndex("by_profileId", (q) => q.eq("profileId", link.profileId))
          .order("desc")
          .take(5000),
        ctx.db
          .query("availabilityLinks")
          .withIndex("by_profileId", (q) => q.eq("profileId", link.profileId))
          .order("desc")
          .take(500),
        ctx.db
          .query("blockedProfiles")
          .withIndex("by_profileId", (q) => q.eq("profileId", link.profileId))
          .take(1000),
      ]);

    const participatedIds = new Set<Id<"schedules">>();
    for (const selection of selections) {
      participatedIds.add(selection.scheduleId);
    }

    const linkedAvailabilities = await Promise.all(
      availabilityLinks.map(async (availabilityLink) => ({
        availabilityLink,
        savedAvailability: await ctx.db.get(
          availabilityLink.savedAvailabilityId,
        ),
      })),
    );
    for (const { availabilityLink, savedAvailability } of linkedAvailabilities) {
      if ((savedAvailability?.slots.length ?? 0) > 0) {
        participatedIds.add(availabilityLink.scheduleId);
      }
    }

    const createdById = new Map(
      created.map((schedule) => [schedule._id, schedule]),
    );
    const participated = await Promise.all(
      [...participatedIds]
        .filter((scheduleId) => !createdById.has(scheduleId))
        .slice(0, 100)
        .map((scheduleId) => ctx.db.get(scheduleId)),
    );
    const blockedScheduleIds = new Set(
      blockedProfiles.map((blocked) => blocked.scheduleId),
    );
    const schedules = [...created, ...participated.filter((s) => s !== null)]
      .filter(
        (schedule) =>
          schedule.creatorProfileId === link.profileId ||
          !blockedScheduleIds.has(schedule._id),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((schedule) => ({
        _id: schedule._id,
        title: schedule.title,
        type: schedule.type,
        isLocked: schedule.isLocked,
      }));

    return { accountLinked: true, schedules };
  },
});

// ---------------------------------------------------------------------------
// Mutations — install session, link create/delete, snapshot updates
// ---------------------------------------------------------------------------

export const createInstallSession = mutation({
  args: {
    scheduleId: v.id("schedules"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) throw new Error("Schedule not found");
    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });

    // Only the creator should be able to link (matches the schedule edit gating)
    if (schedule.creatorProfileId !== profile._id) {
      throw new Error("Only the schedule creator can link Discord");
    }

    const sessionToken = crypto.randomUUID();
    await ctx.db.insert("discordInstallSessions", {
      sessionToken,
      scheduleId: args.scheduleId,
      profileId: profile._id,
      createdAt: Date.now(),
    });
    return sessionToken;
  },
});

export const updateInstallSessionGuild = internalMutation({
  args: {
    sessionToken: v.string(),
    guildId: v.string(),
    guildName: v.optional(v.string()),
    channels: v.array(
      v.object({ id: v.string(), name: v.string(), type: v.number() })
    ),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken)
      )
      .unique();
    if (!session) throw new Error("Install session not found");
    if (isInstallSessionExpired(session)) {
      await ctx.db.delete(session._id);
      throw new Error("Install session expired");
    }
    await ctx.db.patch(session._id, {
      guildId: args.guildId,
      guildName: args.guildName,
      channels: args.channels,
    });
  },
});

export const deleteInstallSession = internalMutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken)
      )
      .unique();
    if (session) await ctx.db.delete(session._id);
  },
});

export const createLink = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    profileId: v.id("userProfiles"),
    channelId: v.string(),
    channelName: v.optional(v.string()),
    guildId: v.string(),
    guildName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ linkId: Id<"scheduleDiscordLinks">; created: boolean }> => {
    // Dedup: if a link for this (scheduleId, channelId) exists, reuse it
    const existing = await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
    const dup = existing.find((l) => l.channelId === args.channelId);
    if (dup) return { linkId: dup._id, created: false };

    const linkId = await ctx.db.insert("scheduleDiscordLinks", {
      scheduleId: args.scheduleId,
      channelId: args.channelId,
      channelName: args.channelName,
      guildId: args.guildId,
      guildName: args.guildName,
      linkedByProfileId: args.profileId,
      linkedAt: Date.now(),
      dstChangeNotifications: true,
    });
    return { linkId, created: true };
  },
});

export const deleteLink = internalMutation({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (link) await ctx.db.delete(args.linkId);
  },
});

export const unlink = mutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return;
    const schedule = await ctx.db.get(link.scheduleId);
    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });
    // Only the schedule creator OR the original linker may unlink.
    if (
      schedule?.creatorProfileId !== profile._id &&
      link.linkedByProfileId !== profile._id
    ) {
      throw new Error("Not authorized to unlink");
    }
    if (link.pendingScheduledId) {
      try {
        await ctx.scheduler.cancel(link.pendingScheduledId);
      } catch {
        // already fired
      }
    }
    await ctx.scheduler.runAfter(
      0,
      internal.discord.cleanupUnlinkedDiscordMessages,
      {
        linkId: link._id,
        channelId: link.channelId,
        legacyOriginalMessageId: link.originalMessageId,
        retryAttempt: 0,
      },
    );
    await ctx.db.delete(args.linkId);
  },
});

export const setNewMessageAfter = mutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    newMessageAfterMs: v.union(v.number(), v.null()),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) throw new Error("Discord link not found");
    const schedule = await ctx.db.get(link.scheduleId);
    const profile = await getCallerProfile(ctx, {
      anonymousId: args.anonymousId,
    });
    if (
      schedule?.creatorProfileId !== profile._id &&
      link.linkedByProfileId !== profile._id
    ) {
      throw new Error("Not authorized to update this Discord link");
    }

    const value = args.newMessageAfterMs;
    if (
      value !== null &&
      value !== 0 &&
      value !== DISCORD_NEVER_START_NEW_MESSAGE &&
      (!Number.isFinite(value) ||
        value < MIN_NEW_MESSAGE_AFTER_MS ||
        value > MAX_NEW_MESSAGE_AFTER_MS)
    ) {
      throw new Error(
        "Discord message age must be Never, Always update latest, or between 1 minute and 30 days",
      );
    }

    await ctx.db.patch(link._id, {
      newMessageAfterMs: value === null ? undefined : value,
    });
  },
});

export const setDstChangeNotifications = mutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    enabled: v.boolean(),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) throw new Error("Discord link not found");
    const schedule = await ctx.db.get(link.scheduleId);
    const profile = await getCallerProfile(ctx, {
      anonymousId: args.anonymousId,
    });
    if (
      schedule?.creatorProfileId !== profile._id &&
      link.linkedByProfileId !== profile._id
    ) {
      throw new Error("Not authorized to update this Discord link");
    }

    await ctx.db.patch(link._id, {
      dstChangeNotifications: args.enabled,
      lastDstNotificationKey: args.enabled
        ? link.lastDstNotificationKey
        : undefined,
    });
    if (args.enabled && schedule?.type === "recurring") {
      await ctx.scheduler.runAfter(
        0,
        internal.discord.refreshRecurringDiscordLink,
        { linkId: link._id },
      );
    }
  },
});

export const updateLinkSnapshot = internalMutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    snapshotJson: v.string(),
    projectionSnapshotJson: v.string(),
    dstNotificationKey: v.union(v.string(), v.null()),
    messageId: v.optional(v.string()),
    notified: v.boolean(),
    replaceOriginal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return;
    const now = Date.now();
    const patch: Partial<Doc<"scheduleDiscordLinks">> = {
      lastSnapshotJson: args.snapshotJson,
      lastProjectionSnapshotJson: args.projectionSnapshotJson,
      lastDstNotificationKey: args.dstNotificationKey ?? undefined,
      lastUpdateAttemptAt: now,
      lastUpdateError: undefined,
    };
    if (args.notified) patch.lastNotifiedAt = now;
    if (args.messageId) {
      patch.lastMessageId = args.messageId;
      if (args.replaceOriginal) {
        patch.originalMessageId = args.messageId;
      } else if (!link.originalMessageId) {
        patch.originalMessageId = link.lastMessageId ?? args.messageId;
      }
    }
    await ctx.db.patch(args.linkId, patch);
  },
});

/**
 * Records a delivery attempt that ended up writing nothing to the channel.
 *
 * Only the locked-slot snapshot may be persisted here, and only when the skip
 * decision was made against it: `lastProjectionSnapshotJson` is the pre-DST
 * baseline a later notice is computed from, and `lastDstNotificationKey` means
 * "this notice already reached the channel".
 */
export const recordUnchangedSummary = internalMutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    snapshotJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return;
    await ctx.db.patch(args.linkId, {
      ...(args.snapshotJson === undefined
        ? {}
        : { lastSnapshotJson: args.snapshotJson }),
      lastUpdateAttemptAt: Date.now(),
      lastUpdateError: undefined,
    });
  },
});

export const recordDiscordScheduleMessage = internalMutation({
  args: {
    linkId: v.optional(v.id("scheduleDiscordLinks")),
    scheduleId: v.id("schedules"),
    channelId: v.string(),
    messageId: v.string(),
    source: v.union(v.literal("channel-link"), v.literal("slash-command")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("discordScheduleMessages")
      .withIndex("by_channelId_and_messageId", (q) =>
        q.eq("channelId", args.channelId).eq("messageId", args.messageId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        linkId: args.linkId,
        scheduleId: args.scheduleId,
        source: args.source,
      });
      return;
    }
    await ctx.db.insert("discordScheduleMessages", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listDiscordMessagesForLink = internalQuery({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("discordScheduleMessages")
      .withIndex("by_linkId", (q) => q.eq("linkId", args.linkId))
      .take(50);
  },
});

export const deleteDiscordScheduleMessageRecord = internalMutation({
  args: { messageRecordId: v.id("discordScheduleMessages") },
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.messageRecordId);
    if (record) await ctx.db.delete(record._id);
  },
});

export const recordLinkUpdateFailure = internalMutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.pendingScheduledId) return false;
    await ctx.db.patch(args.linkId, {
      pendingScheduledId: undefined,
      pendingUpdateAt: undefined,
      pendingUpdateReason: undefined,
      pendingRetryAttempt: undefined,
      lastUpdateAttemptAt: Date.now(),
      lastUpdateError: args.error,
    });
    return true;
  },
});

export const scheduleDiscordDeliveryRetry = internalMutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    delayMs: v.number(),
    retryAttempt: v.number(),
    deliveryNonce: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const link = await ctx.db.get(args.linkId);
    // A new schedule change supersedes an in-flight retry and owns the pending
    // slot. Do not cancel or overwrite that fresher debounced delivery.
    if (!link || link.pendingScheduledId) return false;

    // A pathological `retry_after` would otherwise park the link's single
    // pending slot far enough out to block every later retry.
    const delayMs = Math.min(
      MAX_DISCORD_RETRY_DELAY_MS,
      Math.max(250, Math.ceil(args.delayMs)),
    );
    const scheduledId: Id<"_scheduled_functions"> = await ctx.scheduler.runAfter(
      delayMs,
      internal.discord.sendDebouncedUpdate,
      {
        linkId: args.linkId,
        retryAttempt: args.retryAttempt,
        deliveryNonce: args.deliveryNonce,
      },
    );
    await ctx.db.patch(args.linkId, {
      pendingScheduledId: scheduledId,
      pendingUpdateAt: Date.now() + delayMs,
      pendingUpdateReason: args.reason.slice(0, 200),
      pendingRetryAttempt: args.retryAttempt,
      lastUpdateError: undefined,
    });
    return true;
  },
});

/**
 * Atomically claims a debounced update before it performs external I/O.
 *
 * A scheduled action that has already started cannot be cancelled. Comparing
 * its request metadata with the link's current pending ID prevents an older
 * action from sending after a newer replacement has been scheduled.
 */
export const claimDebouncedUpdate = internalMutation({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args): Promise<boolean> => {
    const { scheduledFunctionId } = await ctx.meta.getRequestMetadata();
    if (!scheduledFunctionId) return false;

    const link = await ctx.db.get(args.linkId);
    if (!link || link.pendingScheduledId !== scheduledFunctionId) return false;

    await ctx.db.patch(args.linkId, {
      pendingScheduledId: undefined,
      pendingUpdateAt: undefined,
      pendingUpdateReason: undefined,
      pendingRetryAttempt: undefined,
    });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Actions — outbound Discord traffic
// ---------------------------------------------------------------------------

/**
 * Shared send-summary helper. Used by both the initial-link send and the
 * debounced update path so the formatting stays in lockstep.
 *
 * `onlyIfChanged` — when true, skips if the snapshot equals the stored one and
 * the pinned-message override has not selected a different update target.
 */
async function demotePreviousDiscordMessage(
  ctx: ActionCtx,
  scheduleId: Id<"schedules">,
  channelId: string,
  previousMessageId: string | undefined,
  nextMessageId: string,
  input: SummaryInput,
): Promise<void> {
  if (!previousMessageId || previousMessageId === nextMessageId) return;
  try {
    await editChannelMessage(
      channelId,
      previousMessageId,
      buildSummaryMessage(input, "one-time"),
    );
  } catch (error) {
    if (error instanceof DiscordApiError) {
      const retryDelayMs = getDiscordRetryDelayMs(error, 0);
      if (retryDelayMs !== null) {
        await ctx.scheduler.runAfter(
          retryDelayMs,
          internal.discord.retryDemoteDiscordMessage,
          {
            scheduleId,
            channelId,
            messageId: previousMessageId,
            retryAttempt: 1,
          },
        );
        return;
      }
    }
    // The new target is already authoritative. Permanent relabel failures are
    // logged without causing a duplicate primary delivery.
    console.error("demotePreviousDiscordMessage failed", {
      channelId,
      previousMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendSummaryFor(
  ctx: ActionCtx,
  linkId: Id<"scheduleDiscordLinks">,
  options: {
    onlyIfChanged: boolean;
    messageNonce: string;
    deliveryKind: "initial" | "schedule-change" | "projection-refresh";
  },
): Promise<boolean> {
  const link = await ctx.runQuery(internal.discord.getLink, { linkId });
  if (!link) return false;

  const input = await ctx.runQuery(internal.discord.buildSummaryInput, {
    scheduleId: link.scheduleId,
    referenceTimeMs: Date.now(),
  });
  if (!input) return false;
  if (
    options.deliveryKind === "projection-refresh" &&
    input.schedule.type !== "recurring"
  ) {
    return true;
  }

  const snapshot = buildLockedSlotSnapshot(input);
  const projectionSnapshot = buildDiscordProjectionSnapshot(input);
  const dstChangeNotificationsEnabled =
    link.dstChangeNotifications === true;
  const dstNotice = dstChangeNotificationsEnabled
    ? buildDiscordDstNotice(input, link.lastProjectionSnapshotJson)
    : null;
  const dstNotificationKey = dstNotice?.key ?? null;
  const newDstNotification =
    dstChangeNotificationsEnabled &&
    dstNotice !== null &&
    dstNotice.key !== link.lastDstNotificationKey;
  let pinnedMessage = await findPinnedScheduleMessage(
    link.channelId,
    link.scheduleId,
    link.lastMessageId,
  );
  const pinnedTargetChanged =
    pinnedMessage !== null && pinnedMessage.id !== link.lastMessageId;
  if (
    options.onlyIfChanged &&
    (options.deliveryKind === "projection-refresh"
      ? projectionSnapshot === link.lastProjectionSnapshotJson &&
        dstNotificationKey === (link.lastDstNotificationKey ?? null)
      : snapshot === link.lastSnapshotJson) &&
    !pinnedTargetChanged
  ) {
    await ctx.runMutation(internal.discord.recordUnchangedSummary, {
      linkId,
      snapshotJson:
        options.deliveryKind === "projection-refresh" ? undefined : snapshot,
    });
    return true;
  }

  const payload = buildSummaryMessage(input, "will-update", dstNotice);
  const previousMessageId = link.lastMessageId;
  let messageId: string | undefined;
  let forcedDstPost = false;
  let postedNewMessage = false;
  const newMessageAfterMs =
    link.newMessageAfterMs ?? getDiscordNewMessageAfterMs();

  if (pinnedMessage) {
    const ok = await editChannelMessage(
      link.channelId,
      pinnedMessage.id,
      payload,
    );
    if (ok) messageId = pinnedMessage.id;
    else pinnedMessage = null;
  }

  if (!messageId) {
    if (newDstNotification) {
      // DST notifications explicitly roll forward to a fresh message. Pinned
      // targets above remain authoritative, as required by the pin override.
      forcedDstPost = true;
    } else if (newMessageAfterMs === DISCORD_NEVER_START_NEW_MESSAGE) {
      const originalMessageId =
        link.originalMessageId ?? link.lastMessageId;
      if (originalMessageId) {
        const ok = await editChannelMessage(
          link.channelId,
          originalMessageId,
          payload,
        );
        if (!ok) {
          throw new Error(
            "The original Discord message was deleted. The Never policy prevents When? from posting a replacement.",
          );
        }
        messageId = originalMessageId;
      }
    } else if (options.deliveryKind === "projection-refresh") {
      if (link.lastMessageId) {
        const ok = await editChannelMessage(
          link.channelId,
          link.lastMessageId,
          payload,
        );
        if (ok) messageId = link.lastMessageId;
      }
    } else {
      const startNewMessage = shouldPostNewDiscordMessage(
        link.lastNotifiedAt,
        newMessageAfterMs,
        Date.now(),
      );
      if (link.lastMessageId && !startNewMessage) {
        const ok = await editChannelMessage(
          link.channelId,
          link.lastMessageId,
          payload,
        );
        if (ok) messageId = link.lastMessageId;
      }
    }
  }

  if (!messageId) {
    // A new link needs its original message. Non-Never policies also replace a
    // deleted target or roll forward after their configured age.
    const res = await postChannelMessage(
      link.channelId,
      payload,
      options.messageNonce,
    );
    messageId = res.id;
    postedNewMessage = true;
    await ctx.runMutation(internal.discord.recordDiscordScheduleMessage, {
      linkId,
      scheduleId: link.scheduleId,
      channelId: link.channelId,
      messageId,
      source: "channel-link",
    });
  }

  await ctx.runMutation(internal.discord.updateLinkSnapshot, {
    linkId,
    snapshotJson: snapshot,
    projectionSnapshotJson: projectionSnapshot,
    dstNotificationKey,
    messageId,
    notified: postedNewMessage,
    replaceOriginal:
      forcedDstPost &&
      newMessageAfterMs === DISCORD_NEVER_START_NEW_MESSAGE,
  });
  await demotePreviousDiscordMessage(
    ctx,
    link.scheduleId,
    link.channelId,
    previousMessageId,
    messageId,
    input,
  );
  return true;
}

type LinkScheduleResult =
  | { ok: true; linkId: Id<"scheduleDiscordLinks"> }
  | {
      ok: false;
      reason:
        | "missing_permissions"
        | "channel_unavailable"
        | "discord_unavailable"
        | "configuration_error";
    };

function discordLinkFailureReason(
  error: DiscordApiError,
): Exclude<LinkScheduleResult, { ok: true }>["reason"] {
  if (error.status === 401) return "configuration_error";
  if (error.status === 403 || error.code === 50001 || error.code === 50013) {
    return "missing_permissions";
  }
  if (error.status === 404 || error.code === 10003) {
    return "channel_unavailable";
  }
  return "discord_unavailable";
}

function createDiscordMessageNonce(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 25);
}

function discordDeliveryErrorMessage(error: unknown): string {
  if (error instanceof DiscordApiError) {
    const status = error.status === 0 ? "network" : String(error.status);
    return `Discord API ${status}${error.code ? ` (${error.code})` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown Discord update error";
}

function discordRetryReason(error: DiscordApiError): string {
  if (error.failureKind === "rate_limit") {
    const scope = error.rateLimit?.scope;
    return `Discord ${scope ? `${scope} ` : ""}rate limit`;
  }
  if (error.failureKind === "server") return "Discord server unavailable";
  return "Discord network unavailable";
}

/**
 * Resolves the install session into a final link, then sends the initial
 * summary message to the chosen channel. Called from the frontend after
 * the user picks a channel.
 */
export const linkScheduleToChannel = action({
  args: {
    sessionToken: v.string(),
    channelId: v.string(),
    channelName: v.optional(v.string()),
    anonymousId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<LinkScheduleResult> => {
    const session = await ctx.runQuery(internal.discord.getOwnedInstallSession, {
      sessionToken: args.sessionToken,
      anonymousId: args.anonymousId,
    });
    if (!session || !session.guildId) throw new Error("Install session missing");

    const channels = session.channels ?? [];
    const ch = channels.find((c) => c.id === args.channelId);
    if (!ch) throw new Error("Selected channel is not available for this install");

    const createdLink: {
      linkId: Id<"scheduleDiscordLinks">;
      created: boolean;
    } = await ctx.runMutation(
      internal.discord.createLink,
      {
        scheduleId: session.scheduleId,
        profileId: session.profileId,
        channelId: args.channelId,
        channelName: ch.name,
        guildId: session.guildId,
        guildName: session.guildName,
      }
    );
    const messageNonce = createDiscordMessageNonce();

    try {
      const sent = await sendSummaryFor(ctx, createdLink.linkId, {
        onlyIfChanged: false,
        messageNonce,
        deliveryKind: "initial",
      });
      if (!sent) throw new Error("Discord link disappeared before initial send");
    } catch (error) {
      if (error instanceof DiscordApiError) {
        const retryDelayMs = getDiscordRetryDelayMs(error, 0);
        if (retryDelayMs !== null) {
          const scheduled: boolean = await ctx.runMutation(
            internal.discord.scheduleDiscordDeliveryRetry,
            {
              linkId: createdLink.linkId,
              delayMs: retryDelayMs,
              retryAttempt: 1,
              deliveryNonce: messageNonce,
              reason: discordRetryReason(error),
            },
          );
          if (scheduled) {
            await ctx.runMutation(internal.discord.deleteInstallSession, {
              sessionToken: args.sessionToken,
            });
            return { ok: true, linkId: createdLink.linkId };
          }
        }
      }
      if (createdLink.created) {
        await ctx.runMutation(internal.discord.deleteLink, {
          linkId: createdLink.linkId,
        });
      }
      if (error instanceof DiscordApiError) {
        return { ok: false, reason: discordLinkFailureReason(error) };
      }
      throw error;
    }

    // Cleanup the install session
    await ctx.runMutation(internal.discord.deleteInstallSession, {
      sessionToken: args.sessionToken,
    });

    return { ok: true, linkId: createdLink.linkId };
  },
});

/**
 * Fires `debounceMs` after a change was first observed. If a newer change
 * came in, this run will have been cancelled & replaced.
 */
export const sendDebouncedUpdate = internalAction({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    retryAttempt: v.optional(v.number()),
    deliveryNonce: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const claimed: boolean = await ctx.runMutation(
      internal.discord.claimDebouncedUpdate,
      { linkId: args.linkId }
    );
    if (!claimed) return;

    const retryAttempt = args.retryAttempt ?? 0;
    const deliveryNonce = args.deliveryNonce ?? createDiscordMessageNonce();
    try {
      await sendSummaryFor(ctx, args.linkId, {
        onlyIfChanged: true,
        messageNonce: deliveryNonce,
        deliveryKind: "schedule-change",
      });
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.runMutation(
            internal.discord.scheduleDiscordDeliveryRetry,
            {
              linkId: args.linkId,
              delayMs: retryDelayMs,
              retryAttempt: retryAttempt + 1,
              deliveryNonce,
              reason: discordRetryReason(error),
            },
          );
          // If a newer debounced update already owns the pending slot, it
          // supersedes this retry. Either way, no permanent failure is recorded.
          return;
        }
      }

      const message = discordDeliveryErrorMessage(error);
      console.error("Discord debounced update failed", {
        linkId: args.linkId,
        retryAttempt,
        message,
      });
      await ctx.runMutation(internal.discord.recordLinkUpdateFailure, {
        linkId: args.linkId,
        error: message.slice(0, 500),
      });
      throw error;
    }
  },
});

export const cleanupUnlinkedDiscordMessages = internalAction({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    channelId: v.string(),
    legacyOriginalMessageId: v.optional(v.string()),
    retryAttempt: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      if (args.legacyOriginalMessageId) {
        await deleteChannelMessage(
          args.channelId,
          args.legacyOriginalMessageId,
        );
      }

      const records = await ctx.runQuery(
        internal.discord.listDiscordMessagesForLink,
        { linkId: args.linkId },
      );
      for (const record of records) {
        if (record.source === "channel-link") {
          await deleteChannelMessage(record.channelId, record.messageId);
        }
        // /when messages are deliberately preserved; their provenance record
        // no longer needs to remain attached to a deleted channel link.
        await ctx.runMutation(
          internal.discord.deleteDiscordScheduleMessageRecord,
          { messageRecordId: record._id },
        );
      }

      if (records.length === 50) {
        await ctx.scheduler.runAfter(
          0,
          internal.discord.cleanupUnlinkedDiscordMessages,
          {
            linkId: args.linkId,
            channelId: args.channelId,
            retryAttempt: 0,
          },
        );
      }
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        args.retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, args.retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.scheduler.runAfter(
            retryDelayMs,
            internal.discord.cleanupUnlinkedDiscordMessages,
            {
              ...args,
              retryAttempt: args.retryAttempt + 1,
            },
          );
          return;
        }
      }
      console.error("Discord unlink message cleanup failed permanently", {
        linkId: args.linkId,
        channelId: args.channelId,
        retryAttempt: args.retryAttempt,
        error: discordDeliveryErrorMessage(error),
      });
    }
  },
});

export const listDiscordLinksForProjectionRefresh = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scheduleDiscordLinks")
      .order("asc")
      .paginate(args.paginationOpts);
  },
});

export const refreshRecurringDiscordLink = internalAction({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    retryAttempt: v.optional(v.number()),
    deliveryNonce: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const retryAttempt = args.retryAttempt ?? 0;
    const deliveryNonce = args.deliveryNonce ?? createDiscordMessageNonce();
    try {
      await sendSummaryFor(ctx, args.linkId, {
        onlyIfChanged: true,
        messageNonce: deliveryNonce,
        deliveryKind: "projection-refresh",
      });
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.scheduler.runAfter(
            retryDelayMs,
            internal.discord.refreshRecurringDiscordLink,
            {
              linkId: args.linkId,
              retryAttempt: retryAttempt + 1,
              deliveryNonce,
            },
          );
          return;
        }
      }
      const message = discordDeliveryErrorMessage(error);
      console.error("Discord recurring timestamp refresh failed", {
        linkId: args.linkId,
        retryAttempt,
        message,
      });
      await ctx.runMutation(internal.discord.recordLinkUpdateFailure, {
        linkId: args.linkId,
        error: message.slice(0, 500),
      });
    }
  },
});

export const refreshRecurringDiscordMessages = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page: {
      page: Doc<"scheduleDiscordLinks">[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(
      internal.discord.listDiscordLinksForProjectionRefresh,
      {
        paginationOpts: {
          numItems: 25,
          cursor: args.cursor ?? null,
        },
      },
    );
    for (const link of page.page) {
      await ctx.scheduler.runAfter(
        0,
        internal.discord.refreshRecurringDiscordLink,
        { linkId: link._id },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.discord.refreshRecurringDiscordMessages,
        { cursor: page.continueCursor },
      );
    }
  },
});

export const retryDemoteDiscordMessage = internalAction({
  args: {
    scheduleId: v.id("schedules"),
    channelId: v.string(),
    messageId: v.string(),
    retryAttempt: v.number(),
  },
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.discord.buildSummaryInput, {
      scheduleId: args.scheduleId,
      referenceTimeMs: Date.now(),
    });
    if (!input) return;

    try {
      await editChannelMessage(
        args.channelId,
        args.messageId,
        buildSummaryMessage(input, "one-time"),
      );
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        args.retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, args.retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.scheduler.runAfter(
            retryDelayMs,
            internal.discord.retryDemoteDiscordMessage,
            { ...args, retryAttempt: args.retryAttempt + 1 },
          );
          return;
        }
      }
      console.error("Discord previous-message relabel failed permanently", {
        scheduleId: args.scheduleId,
        channelId: args.channelId,
        messageId: args.messageId,
        retryAttempt: args.retryAttempt,
        error: discordDeliveryErrorMessage(error),
      });
    }
  },
});

/**
 * Called from the OAuth install callback. The HTTP route is in the V8
 * runtime, but Discord's REST API is happy with our fetch calls there
 * too, so we keep this in the default runtime.
 */
export const completeInstallSession = internalAction({
  args: {
    sessionToken: v.string(),
    guildId: v.string(),
  },
  handler: async (ctx, args) => {
    const channels = await fetchGuildChannels(args.guildId);
    const guild = await fetchGuildInfo(args.guildId);
    await ctx.runMutation(internal.discord.updateInstallSessionGuild, {
      sessionToken: args.sessionToken,
      guildId: args.guildId,
      guildName: guild?.name,
      channels,
    });
  },
});

// ---------------------------------------------------------------------------
// User-level Discord identity linking (so /when can list "your" schedules)
// ---------------------------------------------------------------------------

export const linkDiscordUserForInstallSession = internalMutation({
  args: {
    sessionToken: v.string(),
    discordUserId: v.string(),
    discordUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!session || isInstallSessionExpired(session)) {
      throw new Error("Install session missing");
    }

    const existingByDiscord = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", args.discordUserId)
      )
      .unique();
    if (
      existingByDiscord &&
      existingByDiscord.profileId !== session.profileId
    ) {
      throw new Error("Discord user is already linked to another profile");
    }

    const existingByProfile = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", session.profileId))
      .unique();
    if (existingByProfile) {
      await ctx.db.patch(existingByProfile._id, {
        discordUserId: args.discordUserId,
        discordUsername: args.discordUsername,
        linkedAt: Date.now(),
      });
      return existingByProfile._id;
    }

    return await ctx.db.insert("discordUserLinks", {
      profileId: session.profileId,
      discordUserId: args.discordUserId,
      discordUsername: args.discordUsername,
      linkedAt: Date.now(),
    });
  },
});

export const createDiscordUserLinkSession = internalMutation({
  args: {
    discordUserId: v.string(),
    discordUsername: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const previousSessions = await ctx.db
      .query("discordUserLinkSessions")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", args.discordUserId)
      )
      .take(10);
    for (const session of previousSessions) {
      await ctx.db.delete(session._id);
    }

    const sessionToken = crypto.randomUUID();
    await ctx.db.insert("discordUserLinkSessions", {
      sessionToken,
      discordUserId: args.discordUserId,
      discordUsername: args.discordUsername,
      createdAt: Date.now(),
    });
    return sessionToken;
  },
});

export const getDiscordUserLinkSession = query({
  args: {
    sessionToken: v.string(),
    currentTime: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordUserLinkSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken)
      )
      .unique();
    // `currentTime` is an argument so the client can re-run this query as the
    // session ages, but it may only ever bring expiry forward.
    const serverTime = Date.now();
    const effectiveTime =
      args.currentTime > serverTime ? args.currentTime : serverTime;
    if (
      !session ||
      effectiveTime - session.createdAt > USER_LINK_SESSION_TTL_MS
    ) {
      return null;
    }
    return {
      discordUsername: session.discordUsername,
      expiresAt: session.createdAt + USER_LINK_SESSION_TTL_MS,
    };
  },
});

type CompleteDiscordUserLinkResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "already_linked" };

export const completeDiscordUserLink = mutation({
  args: {
    sessionToken: v.string(),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CompleteDiscordUserLinkResult> => {
    const session = await ctx.db
      .query("discordUserLinkSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken)
      )
      .unique();
    if (!session || Date.now() - session.createdAt > USER_LINK_SESSION_TTL_MS) {
      if (session) await ctx.db.delete(session._id);
      return { ok: false, reason: "expired" };
    }

    const profile = await getCallerProfile(ctx, {
      anonymousId: args.anonymousId,
    });
    const existingByDiscord = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", session.discordUserId)
      )
      .unique();
    if (existingByDiscord && existingByDiscord.profileId !== profile._id) {
      await ctx.db.delete(session._id);
      return { ok: false, reason: "already_linked" };
    }

    const existingByProfile = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .unique();
    if (existingByProfile) {
      await ctx.db.patch(existingByProfile._id, {
        discordUserId: session.discordUserId,
        discordUsername: session.discordUsername,
        linkedAt: Date.now(),
      });
    } else if (existingByDiscord) {
      await ctx.db.patch(existingByDiscord._id, {
        discordUsername: session.discordUsername,
        linkedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("discordUserLinks", {
        profileId: profile._id,
        discordUserId: session.discordUserId,
        discordUsername: session.discordUsername,
        linkedAt: Date.now(),
      });
    }

    await ctx.db.delete(session._id);
    return { ok: true };
  },
});

export const cleanupExpiredInstallSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - INSTALL_SESSION_TTL_MS;
    const expiredInstallSessions = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(INSTALL_SESSION_CLEANUP_BATCH_SIZE);
    const expiredUserLinkSessions = await ctx.db
      .query("discordUserLinkSessions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(USER_LINK_SESSION_CLEANUP_BATCH_SIZE);

    for (const session of [
      ...expiredInstallSessions,
      ...expiredUserLinkSessions,
    ]) {
      await ctx.db.delete(session._id);
    }

    if (
      expiredInstallSessions.length === INSTALL_SESSION_CLEANUP_BATCH_SIZE ||
      expiredUserLinkSessions.length === USER_LINK_SESSION_CLEANUP_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.discord.cleanupExpiredInstallSessions,
        {}
      );
    }

    return expiredInstallSessions.length + expiredUserLinkSessions.length;
  },
});

// ---------------------------------------------------------------------------
// Re-export for convenience: build payload for slash-command response
// ---------------------------------------------------------------------------

/**
 * Posts the schedule chosen from /when through the bot REST API. Posting it
 * ourselves (rather than asking Discord to create the interaction response)
 * gives us the message ID needed for pin overrides and update-target handoff.
 */
export const shareInteractionSummary = internalAction({
  args: {
    scheduleId: v.id("schedules"),
    discordUserId: v.string(),
    channelId: v.string(),
    applicationId: v.string(),
    interactionToken: v.string(),
    messageNonce: v.string(),
    retryAttempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; messageId: string; willUpdate: boolean }
    | { ok: false; reason: "not_found" | "send_failed" }
  > => {
    type ShareResult =
      | { ok: true; messageId: string; willUpdate: boolean }
      | { ok: false; reason: "not_found" | "send_failed" };
    const finish = async (result: ShareResult): Promise<ShareResult> => {
      const content = result.ok
        ? result.willUpdate
          ? "Shared. This message is now the schedule's update target."
          : "Shared as a one-time message."
        : result.reason === "not_found"
          ? "Sorry, that schedule could not be found."
          : "When? could not send that schedule. Check the channel permissions and try again.";
      try {
        await editOriginalInteractionResponse(
          args.applicationId,
          args.interactionToken,
          { content, components: [] },
        );
      } catch (error) {
        if (error instanceof DiscordApiError) {
          const retryDelayMs = getDiscordRetryDelayMs(error, 0);
          if (retryDelayMs !== null) {
            await ctx.scheduler.runAfter(
              retryDelayMs,
              internal.discord.retryDiscordInteractionResponse,
              {
                applicationId: args.applicationId,
                interactionToken: args.interactionToken,
                content,
                retryAttempt: 1,
              },
            );
            return result;
          }
        }
        console.error("Could not finish the private /when response", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    };

    try {
      const allowedSchedules = await ctx.runQuery(
        internal.discord.listSchedulesForDiscordUser,
        { discordUserId: args.discordUserId },
      );
      if (
        !allowedSchedules.schedules.some(
          (schedule) => schedule._id === args.scheduleId,
        )
      ) {
        return await finish({ ok: false, reason: "not_found" });
      }

      const input = await ctx.runQuery(internal.discord.buildSummaryInput, {
        scheduleId: args.scheduleId,
        referenceTimeMs: Date.now(),
      });
      if (!input) return await finish({ ok: false, reason: "not_found" });

      const link: Doc<"scheduleDiscordLinks"> | null = await ctx.runQuery(
        internal.discord.getLinkForScheduleChannel,
        { scheduleId: args.scheduleId, channelId: args.channelId },
      );
      const postSlashCommandMessage = async (
        payload: Record<string, unknown>,
      ): Promise<{ id: string }> => {
        const posted = await postChannelMessage(
          args.channelId,
          payload,
          args.messageNonce,
        );
        await ctx.runMutation(internal.discord.recordDiscordScheduleMessage, {
          linkId: link?._id,
          scheduleId: args.scheduleId,
          channelId: args.channelId,
          messageId: posted.id,
          source: "slash-command",
        });
        return posted;
      };
      if (!link) {
        const posted = await postSlashCommandMessage(
          buildSummaryMessage(input, "one-time"),
        );
        return await finish({
          ok: true,
          messageId: posted.id,
          willUpdate: false,
        });
      }

      const snapshot = buildLockedSlotSnapshot(input);
      const projectionSnapshot = buildDiscordProjectionSnapshot(input);
      const dstChangeNotificationsEnabled =
        link.dstChangeNotifications === true;
      const dstNotice = dstChangeNotificationsEnabled
        ? buildDiscordDstNotice(input, link.lastProjectionSnapshotJson)
        : null;
      const dstNotificationKey = dstNotice?.key ?? null;
      const pinnedMessage = await findPinnedScheduleMessage(
        link.channelId,
        link.scheduleId,
        link.lastMessageId,
      );
      if (pinnedMessage) {
        const updated = await editChannelMessage(
          link.channelId,
          pinnedMessage.id,
          buildSummaryMessage(input, "will-update", dstNotice),
        );
        if (updated) {
          await ctx.runMutation(internal.discord.updateLinkSnapshot, {
            linkId: link._id,
            snapshotJson: snapshot,
            projectionSnapshotJson: projectionSnapshot,
            dstNotificationKey,
            messageId: pinnedMessage.id,
            notified: false,
          });
          await demotePreviousDiscordMessage(
            ctx,
            link.scheduleId,
            link.channelId,
            link.lastMessageId,
            pinnedMessage.id,
            input,
          );
          const posted = await postSlashCommandMessage(
            buildSummaryMessage(input, "one-time", dstNotice),
          );
          return await finish({
            ok: true,
            messageId: posted.id,
            willUpdate: false,
          });
        }
      }

      const newMessageAfterMs =
        link.newMessageAfterMs ?? getDiscordNewMessageAfterMs();
      if (newMessageAfterMs > 0) {
        const posted = await postSlashCommandMessage(
          buildSummaryMessage(input, "will-update", dstNotice),
        );
        await ctx.runMutation(internal.discord.updateLinkSnapshot, {
          linkId: link._id,
          snapshotJson: snapshot,
          projectionSnapshotJson: projectionSnapshot,
          dstNotificationKey,
          messageId: posted.id,
          notified: true,
        });
        await demotePreviousDiscordMessage(
          ctx,
          link.scheduleId,
          link.channelId,
          link.lastMessageId,
          posted.id,
          input,
        );
        return await finish({
          ok: true,
          messageId: posted.id,
          willUpdate: true,
        });
      }

      const posted = await postSlashCommandMessage(
        buildSummaryMessage(input, "one-time", dstNotice),
      );
      return await finish({
        ok: true,
        messageId: posted.id,
        willUpdate: false,
      });
    } catch (error) {
      const retryAttempt = args.retryAttempt ?? 0;
      if (
        error instanceof DiscordApiError &&
        retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.scheduler.runAfter(
            retryDelayMs,
            internal.discord.shareInteractionSummary,
            { ...args, retryAttempt: retryAttempt + 1 },
          );
          return { ok: false, reason: "send_failed" };
        }
      }
      console.error("Discord /when share failed", {
        scheduleId: args.scheduleId,
        channelId: args.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return await finish({ ok: false, reason: "send_failed" });
    }
  },
});

export const retryDiscordInteractionResponse = internalAction({
  args: {
    applicationId: v.string(),
    interactionToken: v.string(),
    content: v.string(),
    retryAttempt: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      await editOriginalInteractionResponse(
        args.applicationId,
        args.interactionToken,
        { content: args.content, components: [] },
      );
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        args.retryAttempt < MAX_DISCORD_DELIVERY_RETRIES
      ) {
        const retryDelayMs = getDiscordRetryDelayMs(error, args.retryAttempt);
        if (retryDelayMs !== null) {
          await ctx.scheduler.runAfter(
            retryDelayMs,
            internal.discord.retryDiscordInteractionResponse,
            { ...args, retryAttempt: args.retryAttempt + 1 },
          );
          return;
        }
      }
      console.error("Discord private /when response failed permanently", {
        retryAttempt: args.retryAttempt,
        error: discordDeliveryErrorMessage(error),
      });
    }
  },
});
