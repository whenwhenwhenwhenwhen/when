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
import { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  buildSummaryMessage,
  buildLockedSlotSnapshot,
  postChannelMessage,
  editChannelMessage,
  fetchGuildChannels,
  fetchGuildInfo,
  SummaryInput,
} from "./discordHelpers";

const INSTALL_SESSION_TTL_MS = 15 * 60 * 1000;
const INSTALL_SESSION_CLEANUP_BATCH_SIZE = 100;

function getAppBaseUrl(): string {
  return process.env.SITE_URL ?? "";
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

export const listLinksForSchedule = query({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
  },
});

export const getLink = internalQuery({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.linkId);
  },
});

export const getInstallSession = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", args.sessionToken))
      .unique();
    if (!session || isInstallSessionExpired(session)) return null;
    return session;
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
    }));
  },
});

/**
 * Build the SummaryInput object — used both by the slash command response
 * and the debounced update path. Centralised so format stays consistent.
 */
export const buildSummaryInput = internalQuery({
  args: { scheduleId: v.id("schedules") },
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
      state: SummaryInput["selections"][number]["state"];
      isException?: boolean;
    };

    const flat: FlatSelection[] = dbSelections.map((s) => ({
      profileId: s.profileId as unknown as string,
      dayKey: s.dayKey,
      timeSlot: s.timeSlot,
      state: s.state,
      isException: s.isException,
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
      if (p) profileNames[id] = p.displayName;
    }

    return {
      schedule: {
        _id: schedule._id as unknown as string,
        title: schedule.title,
        description: schedule.description,
        type: schedule.type,
        creatorTimezone: schedule.creatorTimezone,
        lockedSlots: schedule.lockedSlots,
        isLocked: schedule.isLocked,
      },
      profileNames,
      selections: flat,
      appBaseUrl: getAppBaseUrl(),
    };
  },
});

/**
 * For the /when slash command — fetch a discord-linked user's schedules
 * (created or participated in). Falls back to listed schedules if the
 * discord user hasn't linked their account yet.
 */
export const listSchedulesForDiscordUser = internalQuery({
  args: { discordUserId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<
    Array<{
      _id: Id<"schedules">;
      title: string;
      type: "one-off" | "recurring";
      isLocked?: boolean;
    }>
  > => {
    const link = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", args.discordUserId)
      )
      .unique();

    let schedules: Doc<"schedules">[] = [];

    if (link) {
      // Schedules user created
      const created = await ctx.db
        .query("schedules")
        .withIndex("by_creatorProfileId", (q) =>
          q.eq("creatorProfileId", link.profileId)
        )
        .collect();

      // Schedules user has selections in
      const sels = await ctx.db
        .query("selections")
        .withIndex("by_profileId", (q) => q.eq("profileId", link.profileId))
        .take(500);
      const participatedIds = new Set<string>(sels.map((s) => s.scheduleId));
      const participated: Doc<"schedules">[] = [];
      for (const id of participatedIds) {
        const s = await ctx.db.get(id as Id<"schedules">);
        if (s && !created.find((c) => c._id === s._id)) participated.push(s);
      }
      schedules = [...created, ...participated];
    } else {
      // Fallback: most-recent listed schedules
      const recent = await ctx.db
        .query("schedules")
        .withIndex("by_createdAt")
        .order("desc")
        .take(20);
      schedules = recent.filter((s) => !s.isPrivate);
    }

    return schedules.slice(0, 25).map((s) => ({
      _id: s._id,
      title: s.title,
      type: s.type,
      isLocked: s.isLocked,
    }));
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
  handler: async (ctx, args): Promise<Id<"scheduleDiscordLinks">> => {
    // Dedup: if a link for this (scheduleId, channelId) exists, reuse it
    const existing = await ctx.db
      .query("scheduleDiscordLinks")
      .withIndex("by_schedule", (q) => q.eq("scheduleId", args.scheduleId))
      .collect();
    const dup = existing.find((l) => l.channelId === args.channelId);
    if (dup) return dup._id;

    return await ctx.db.insert("scheduleDiscordLinks", {
      scheduleId: args.scheduleId,
      channelId: args.channelId,
      channelName: args.channelName,
      guildId: args.guildId,
      guildName: args.guildName,
      linkedByProfileId: args.profileId,
      linkedAt: Date.now(),
    });
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
    await ctx.db.delete(args.linkId);
  },
});

export const updateLinkSnapshot = internalMutation({
  args: {
    linkId: v.id("scheduleDiscordLinks"),
    snapshotJson: v.string(),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return;
    const patch: Partial<Doc<"scheduleDiscordLinks">> = {
      lastSnapshotJson: args.snapshotJson,
      lastNotifiedAt: Date.now(),
    };
    if (args.messageId) patch.lastMessageId = args.messageId;
    await ctx.db.patch(args.linkId, patch);
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

    await ctx.db.patch(args.linkId, { pendingScheduledId: undefined });
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
 * `onlyIfChanged` — when true, skips if the snapshot equals the stored one.
 */
async function sendSummaryFor(
  ctx: ActionCtx,
  linkId: Id<"scheduleDiscordLinks">,
  options: { onlyIfChanged: boolean }
): Promise<void> {
  const link = await ctx.runQuery(internal.discord.getLink, { linkId });
  if (!link) return;

  const input = await ctx.runQuery(internal.discord.buildSummaryInput, {
    scheduleId: link.scheduleId,
  });
  if (!input) return;

  const snapshot = buildLockedSlotSnapshot(input);
  if (options.onlyIfChanged && snapshot === link.lastSnapshotJson) {
    await ctx.runMutation(internal.discord.updateLinkSnapshot, {
      linkId,
      snapshotJson: snapshot,
    });
    return;
  }

  const payload = buildSummaryMessage(input);

  let messageId: string | undefined;
  if (link.lastMessageId) {
    // Edit the existing message in place — keeps the channel cleaner
    const ok = await editChannelMessage(
      link.channelId,
      link.lastMessageId,
      payload
    );
    if (ok) messageId = link.lastMessageId;
  }
  if (!messageId) {
    const res = await postChannelMessage(link.channelId, payload);
    messageId = res?.id;
  }

  await ctx.runMutation(internal.discord.updateLinkSnapshot, {
    linkId,
    snapshotJson: snapshot,
    messageId,
  });
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
  ): Promise<{ linkId: Id<"scheduleDiscordLinks"> }> => {
    const session = await ctx.runQuery(internal.discord.getOwnedInstallSession, {
      sessionToken: args.sessionToken,
      anonymousId: args.anonymousId,
    });
    if (!session || !session.guildId) throw new Error("Install session missing");

    const channels = session.channels ?? [];
    const ch = channels.find((c) => c.id === args.channelId);
    if (!ch) throw new Error("Selected channel is not available for this install");

    const linkId: Id<"scheduleDiscordLinks"> = await ctx.runMutation(
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

    await sendSummaryFor(ctx, linkId, { onlyIfChanged: false });

    // Cleanup the install session
    await ctx.runMutation(internal.discord.deleteInstallSession, {
      sessionToken: args.sessionToken,
    });

    return { linkId };
  },
});

/**
 * Fires `debounceMs` after a change was first observed. If a newer change
 * came in, this run will have been cancelled & replaced.
 */
export const sendDebouncedUpdate = internalAction({
  args: { linkId: v.id("scheduleDiscordLinks") },
  handler: async (ctx, args) => {
    const claimed: boolean = await ctx.runMutation(
      internal.discord.claimDebouncedUpdate,
      { linkId: args.linkId }
    );
    if (!claimed) return;

    await sendSummaryFor(ctx, args.linkId, { onlyIfChanged: true });
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

export const linkDiscordUser = internalMutation({
  args: {
    profileId: v.id("userProfiles"),
    discordUserId: v.string(),
    discordUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingByDiscord = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_discordUserId", (q) =>
        q.eq("discordUserId", args.discordUserId)
      )
      .unique();
    if (existingByDiscord && existingByDiscord.profileId !== args.profileId) {
      throw new Error("Discord user is already linked to another profile");
    }

    const existingByProfile = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", args.profileId))
      .unique();
    if (existingByProfile) {
      await ctx.db.patch(existingByProfile._id, {
        discordUserId: args.discordUserId,
        discordUsername: args.discordUsername,
      });
      return;
    }
    await ctx.db.insert("discordUserLinks", {
      profileId: args.profileId,
      discordUserId: args.discordUserId,
      discordUsername: args.discordUsername,
      linkedAt: Date.now(),
    });
  },
});

export const unlinkDiscordUser = mutation({
  args: { anonymousId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });
    const link = await ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .unique();
    if (link) await ctx.db.delete(link._id);
  },
});

export const getDiscordLinkForProfile = query({
  args: { anonymousId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const profile = await getCallerProfile(ctx, { anonymousId: args.anonymousId });
    return await ctx.db
      .query("discordUserLinks")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .unique();
  },
});

export const cleanupExpiredInstallSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - INSTALL_SESSION_TTL_MS;
    const expired = await ctx.db
      .query("discordInstallSessions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(INSTALL_SESSION_CLEANUP_BATCH_SIZE);

    for (const session of expired) {
      await ctx.db.delete(session._id);
    }

    if (expired.length === INSTALL_SESSION_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.discord.cleanupExpiredInstallSessions,
        {}
      );
    }

    return expired.length;
  },
});

// ---------------------------------------------------------------------------
// Re-export for convenience: build payload for slash-command response
// ---------------------------------------------------------------------------

/**
 * Build the interaction response payload for a chosen schedule. Used by
 * the HTTP interaction handler when a user picks from the /when menu.
 */
export const buildInteractionSummary = internalAction({
  args: {
    scheduleId: v.id("schedules"),
    discordUserId: v.string(),
  },
  handler: async (ctx, args): Promise<Record<string, unknown> | null> => {
    const allowedSchedules = await ctx.runQuery(
      internal.discord.listSchedulesForDiscordUser,
      { discordUserId: args.discordUserId }
    );
    if (!allowedSchedules.some((schedule) => schedule._id === args.scheduleId)) {
      return null;
    }

    const input = await ctx.runQuery(internal.discord.buildSummaryInput, {
      scheduleId: args.scheduleId,
    });
    if (!input) return null;
    return buildSummaryMessage(input);
  },
});
