import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

// A session dies at whichever of these comes first: a hard deadline measured
// from sign-in, and an idle window measured from the last successful refresh.
// The absolute deadline bounds how long a stolen token is useful even if the
// thief keeps it warm; the idle window retires sessions people have abandoned.
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_CLEANUP_BATCH_SIZE = 200;

// Rows created before expiry tracking existed carry neither field, so their
// deadlines are derived from createdAt.
export function sessionExpiresAt(session: Doc<"authSessions">): number {
  const absolute = session.expiresAt ?? session.createdAt + SESSION_ABSOLUTE_TTL_MS;
  const idle = (session.lastUsedAt ?? session.createdAt) + SESSION_IDLE_TTL_MS;
  return Math.min(absolute, idle);
}

export function isSessionExpired(
  session: Doc<"authSessions">,
  nowMs: number
): boolean {
  return nowMs >= sessionExpiresAt(session);
}

export const createSession = internalMutation({
  args: {
    sessionToken: v.string(),
    refreshToken: v.string(),
    googleUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("authSessions", {
      sessionToken: args.sessionToken,
      refreshToken: args.refreshToken,
      googleUserId: args.googleUserId,
      createdAt: now,
      expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
      lastUsedAt: now,
    });
  },
});

export const getBySessionToken = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("authSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
  },
});

export const getRefreshTokenByGoogleUser = internalQuery({
  args: { googleUserId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("by_googleUserId", (q) =>
        q.eq("googleUserId", args.googleUserId),
      )
      .order("desc")
      .take(10);

    const session = sessions.find((s) => !isSessionExpired(s, now));
    if (!session) return null;
    return { refreshToken: session.refreshToken };
  },
});

// Restarts the idle window. Called only after Google accepts the refresh
// token, so an attacker probing with a valid-but-expired token cannot use the
// attempt itself to keep the session alive.
export const touchSession = internalMutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
    if (!session) return;

    await ctx.db.patch(session._id, { lastUsedAt: Date.now() });
  },
});

export const deleteBySessionToken = internalMutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

// Returns the revoked session's Google refresh token so the caller can also
// invalidate it upstream; sign-out should not leave a usable grant behind.
export const revokeSession = internalMutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
    if (!session) return null;

    await ctx.db.delete(session._id);
    return { refreshToken: session.refreshToken };
  },
});

export const cleanupExpiredSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();

    // Ordering by the absolute deadline puts the rows most likely to be
    // expired first, including legacy rows whose `expiresAt` is undefined.
    const candidates = await ctx.db
      .query("authSessions")
      .withIndex("by_expiresAt")
      .order("asc")
      .take(SESSION_CLEANUP_BATCH_SIZE);

    let deleted = 0;
    for (const session of candidates) {
      if (isSessionExpired(session, now)) {
        await ctx.db.delete(session._id);
        deleted++;
      }
    }

    if (deleted === SESSION_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.authSessions.cleanupExpiredSessions,
        {}
      );
    }

    return deleted;
  },
});
