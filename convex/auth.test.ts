// @vitest-environment edge-runtime

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  isSessionExpired,
} from "./authSessions";

const modules = import.meta.glob("./**/*.ts");

const GOOGLE_ISSUER = "https://accounts.google.com";
const tokenIdentifier = (subject: string) => `${GOOGLE_ISSUER}|${subject}`;

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;

async function createAnonProfile(
  t: T,
  anonymousId: string,
  displayName: string
): Promise<Id<"userProfiles">> {
  return await t.mutation(api.users.getOrCreateAnonymousProfile, {
    anonymousId,
    displayName,
    timezone: "UTC",
  });
}

async function createSchedule(
  t: T,
  creatorProfileId: Id<"userProfiles">,
  anonymousId: string
): Promise<Id<"schedules">> {
  return await t.mutation(api.schedules.create, {
    title: "Test schedule",
    type: "recurring",
    creatorProfileId,
    anonymousId,
    creatorTimezone: "UTC",
  });
}

// Mirrors the pre-fix production shape: a profile that signed in with Google
// but kept the `anonymousId` it was created with.
async function createLegacySsoProfile(
  t: T,
  subject: string,
  anonymousId: string
): Promise<Id<"userProfiles">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("userProfiles", {
      authUserId: tokenIdentifier(subject),
      anonymousId,
      displayName: "Victim",
      email: "victim@example.com",
      timezone: "UTC",
      weekStartDay: 0,
      dstNotifications: true,
    })
  );
}

describe("profile disclosure", () => {
  it("never returns anonymousId, email or authUserId to the public", async () => {
    const t = setup();
    const profileId = await createAnonProfile(t, "anon-secret", "Alice");

    const [profile] = await t.query(api.users.getPublicProfiles, {
      profileIds: [profileId],
    });

    expect(profile).toBeDefined();
    expect(profile).not.toHaveProperty("anonymousId");
    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("authUserId");
    expect(profile.displayName).toBe("Alice");
  });

  it("exposes no query that returns a raw profile document", async () => {
    // `anonymousId` authenticates its profile, so any public lookup that
    // returns whole documents hands out a working credential.
    const userModule = await import("./users");
    const removed = [
      "getProfile",
      "getProfiles",
      "getProfileByAnonymousId",
      "getProfileByAuthUserId",
    ];

    for (const name of removed) {
      expect(Object.keys(userModule)).not.toContain(name);
    }
  });

  it("does not leak participants' anonymousId through a shared schedule", async () => {
    const t = setup();
    const victim = await createAnonProfile(t, "victim-anon", "Victim");
    const scheduleId = await createSchedule(t, victim, "victim-anon");

    await t.mutation(api.selections.set, {
      scheduleId,
      profileId: victim,
      dayKey: "1",
      timeSlot: "09:00",
      timezone: "UTC",
      state: "can-do",
      anonymousId: "victim-anon",
    });

    // Anyone holding the share link can reach these, so they are the realistic
    // starting point for harvesting profile ids.
    const detail = await t.query(api.schedules.get, { scheduleId });
    const serialised = JSON.stringify(detail);

    expect(serialised).not.toContain("victim-anon");
    expect(detail!.profiles.every((p) => !("anonymousId" in p))).toBe(true);
  });
});

describe("acting as another profile", () => {
  it("rejects writing selections for a profile the caller does not own", async () => {
    const t = setup();
    const victim = await createAnonProfile(t, "victim-anon", "Victim");
    const attacker = await createAnonProfile(t, "attacker-anon", "Attacker");
    const scheduleId = await createSchedule(t, victim, "victim-anon");

    await t.mutation(api.selections.set, {
      scheduleId,
      profileId: victim,
      dayKey: "1",
      timeSlot: "09:00",
      timezone: "UTC",
      state: "can-do",
      anonymousId: "attacker-anon",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selections")
        .withIndex("by_schedule_profile", (q) =>
          q.eq("scheduleId", scheduleId).eq("profileId", victim)
        )
        .collect()
    );
    expect(rows).toHaveLength(0);
    expect(attacker).not.toEqual(victim);
  });

  it("rejects deleting a schedule the caller does not own", async () => {
    const t = setup();
    const victim = await createAnonProfile(t, "victim-anon", "Victim");
    await createAnonProfile(t, "attacker-anon", "Attacker");
    const scheduleId = await createSchedule(t, victim, "victim-anon");

    await expect(
      t.mutation(api.schedules.remove, {
        scheduleId,
        anonymousId: "attacker-anon",
      })
    ).rejects.toThrow();

    expect(await t.run(async (ctx) => ctx.db.get(scheduleId))).not.toBeNull();
  });
});

describe("anonymous to SSO upgrade", () => {
  it("clears the anonymousId so it cannot be reused as a credential", async () => {
    const t = setup();
    await createAnonProfile(t, "alice-anon", "Alice");

    const asAlice = t.withIdentity({
      tokenIdentifier: tokenIdentifier("alice"),
      name: "Alice",
      email: "alice@example.com",
    });
    const profileId = await asAlice.mutation(api.users.ensureAuthProfile, {
      anonymousId: "alice-anon",
      timezone: "UTC",
    });

    const profile = await t.run(async (ctx) => ctx.db.get(profileId));
    expect(profile!.authUserId).toBe(tokenIdentifier("alice"));
    expect(profile!.anonymousId).toBeUndefined();
  });

  it("stops a retired anonymousId from authorizing schedule mutations", async () => {
    const t = setup();
    const profileId = await createAnonProfile(t, "alice-anon", "Alice");
    const scheduleId = await createSchedule(t, profileId, "alice-anon");

    const asAlice = t.withIdentity({
      tokenIdentifier: tokenIdentifier("alice"),
      name: "Alice",
    });
    await asAlice.mutation(api.users.ensureAuthProfile, {
      anonymousId: "alice-anon",
      timezone: "UTC",
    });

    // Whoever else still holds the old id must not inherit the SSO account.
    await expect(
      t.mutation(api.schedules.remove, {
        scheduleId,
        anonymousId: "alice-anon",
      })
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.get(scheduleId))).not.toBeNull();
  });

  it("rejects a legacy anonymousId still attached to an SSO profile", async () => {
    const t = setup();
    // Profiles upgraded before the upgrade path cleared `anonymousId` still
    // carry both identifiers, so the guard has to hold independently of it.
    const victimId = await createLegacySsoProfile(t, "victim", "victim-anon");
    const scheduleId = await t.run(async (ctx) =>
      ctx.db.insert("schedules", {
        title: "Victim's schedule",
        type: "recurring",
        creatorProfileId: victimId,
        creatorTimezone: "UTC",
        createdAt: Date.now(),
      })
    );

    await expect(
      t.mutation(api.schedules.remove, {
        scheduleId,
        anonymousId: "victim-anon",
      })
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.get(scheduleId))).not.toBeNull();

    await expect(
      t.mutation(api.schedules.update, {
        scheduleId,
        anonymousId: "victim-anon",
        title: "Hijacked",
      })
    ).rejects.toThrow();

    await expect(
      t.mutation(api.users.updateProfile, {
        anonymousId: "victim-anon",
        displayName: "Hijacked",
      })
    ).rejects.toThrow();

    const victim = await t.run(async (ctx) => ctx.db.get(victimId));
    expect(victim!.displayName).toBe("Victim");
  });

  it("refuses to re-point an SSO-linked profile at another Google account", async () => {
    const t = setup();
    const victimId = await createLegacySsoProfile(t, "victim", "victim-anon");

    const asAttacker = t.withIdentity({
      tokenIdentifier: tokenIdentifier("attacker"),
      name: "Attacker",
      email: "attacker@example.com",
    });
    const resultId = await asAttacker.mutation(api.users.ensureAuthProfile, {
      anonymousId: "victim-anon",
      timezone: "UTC",
    });

    expect(resultId).not.toBe(victimId);

    const victim = await t.run(async (ctx) => ctx.db.get(victimId));
    expect(victim).not.toBeNull();
    expect(victim!.authUserId).toBe(tokenIdentifier("victim"));
    expect(victim!.email).toBe("victim@example.com");
  });

  it("refuses to merge an SSO-linked profile into the caller's account", async () => {
    const t = setup();
    const victimId = await createLegacySsoProfile(t, "victim", "victim-anon");
    const scheduleId = await t.run(async (ctx) =>
      ctx.db.insert("schedules", {
        title: "Victim's schedule",
        type: "recurring",
        creatorProfileId: victimId,
        creatorTimezone: "UTC",
        createdAt: Date.now(),
      })
    );

    const asAttacker = t.withIdentity({
      tokenIdentifier: tokenIdentifier("attacker"),
      name: "Attacker",
    });
    await asAttacker.mutation(api.users.ensureAuthProfile, {
      anonymousId: "unrelated",
      timezone: "UTC",
    });
    await asAttacker.mutation(api.users.mergeAnonymousToAuth, {
      anonymousId: "victim-anon",
    });

    // The victim must keep both their profile and everything they created.
    expect(await t.run(async (ctx) => ctx.db.get(victimId))).not.toBeNull();
    const schedule = await t.run(async (ctx) => ctx.db.get(scheduleId));
    expect(schedule!.creatorProfileId).toBe(victimId);
  });

  it("does not hand back an SSO-linked profile for its stale anonymousId", async () => {
    const t = setup();
    const victimId = await createLegacySsoProfile(t, "victim", "victim-anon");

    const profileId = await createAnonProfile(t, "victim-anon", "Not Victim");

    expect(profileId).not.toBe(victimId);
    const victim = await t.run(async (ctx) => ctx.db.get(victimId));
    expect(victim!.anonymousId).toBeUndefined();
  });
});

describe("unlinkSso", () => {
  it("refuses an anonymousId that already belongs to another profile", async () => {
    const t = setup();
    await createAnonProfile(t, "bystander-anon", "Bystander");

    const asAlice = t.withIdentity({
      tokenIdentifier: tokenIdentifier("alice"),
      name: "Alice",
    });
    await asAlice.mutation(api.users.ensureAuthProfile, { timezone: "UTC" });

    // Sharing an id would make every `by_anonymousId` lookup throw on
    // `.unique()`, locking the bystander out of the app entirely.
    await expect(
      asAlice.mutation(api.users.unlinkSso, {
        newAnonymousId: "bystander-anon",
      })
    ).rejects.toThrow();
  });
});

describe("blocked participants", () => {
  it("cannot re-add themselves by linking a saved availability", async () => {
    const t = setup();
    const creatorId = await createAnonProfile(t, "creator-anon", "Creator");
    const scheduleId = await createSchedule(t, creatorId, "creator-anon");

    const asBlocked = t.withIdentity({
      tokenIdentifier: tokenIdentifier("blocked"),
      name: "Blocked",
    });
    const blockedId = await asBlocked.mutation(api.users.ensureAuthProfile, {
      timezone: "UTC",
    });

    const savedId = await t.run(async (ctx) =>
      ctx.db.insert("savedAvailabilities", {
        profileId: blockedId,
        name: "Weekdays",
        timezone: "UTC",
        slots: [{ dayKey: "1", timeSlot: "09:00", state: "can-do" }],
      })
    );

    await t.mutation(api.schedules.blockParticipant, {
      scheduleId,
      anonymousId: "creator-anon",
      profileId: blockedId,
    });

    await asBlocked.mutation(api.savedAvailabilities.applyToSchedule, {
      savedAvailabilityId: savedId,
      scheduleId,
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query("availabilityLinks")
        .withIndex("by_schedule_profile", (q) =>
          q.eq("scheduleId", scheduleId).eq("profileId", blockedId)
        )
        .collect()
    );
    expect(links).toHaveLength(0);
  });

  it("cannot rejoin a schedule that has closed participation", async () => {
    const t = setup();
    const creatorId = await createAnonProfile(t, "creator-anon", "Creator");
    const scheduleId = await createSchedule(t, creatorId, "creator-anon");

    const asOutsider = t.withIdentity({
      tokenIdentifier: tokenIdentifier("outsider"),
      name: "Outsider",
    });
    const outsiderId = await asOutsider.mutation(api.users.ensureAuthProfile, {
      timezone: "UTC",
    });

    const savedId = await t.run(async (ctx) =>
      ctx.db.insert("savedAvailabilities", {
        profileId: outsiderId,
        name: "Weekdays",
        timezone: "UTC",
        slots: [{ dayKey: "1", timeSlot: "09:00", state: "can-do" }],
      })
    );

    await t.mutation(api.schedules.setAcceptParticipation, {
      scheduleId,
      anonymousId: "creator-anon",
      acceptParticipation: false,
    });

    await asOutsider.mutation(api.savedAvailabilities.applyToSchedule, {
      savedAvailabilityId: savedId,
      scheduleId,
    });

    const links = await t.run(async (ctx) =>
      ctx.db
        .query("availabilityLinks")
        .withIndex("by_schedule_profile", (q) =>
          q.eq("scheduleId", scheduleId).eq("profileId", outsiderId)
        )
        .collect()
    );
    expect(links).toHaveLength(0);
  });
});

describe("auth session lifetime", () => {
  const baseSession = {
    _id: "x" as Id<"authSessions">,
    _creationTime: 0,
    sessionToken: "uuid",
    refreshToken: "refresh",
    googleUserId: "google-user",
  };

  it("expires at the absolute deadline even while in active use", () => {
    const createdAt = 1_000_000;
    const session = {
      ...baseSession,
      createdAt,
      expiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS,
      lastUsedAt: createdAt + SESSION_ABSOLUTE_TTL_MS - 1000,
    };

    expect(isSessionExpired(session, createdAt + SESSION_ABSOLUTE_TTL_MS - 1)).toBe(false);
    expect(isSessionExpired(session, createdAt + SESSION_ABSOLUTE_TTL_MS)).toBe(true);
  });

  it("expires after the idle window despite a distant absolute deadline", () => {
    const createdAt = 1_000_000;
    const lastUsedAt = createdAt + 1000;
    const session = {
      ...baseSession,
      createdAt,
      expiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS,
      lastUsedAt,
    };

    expect(isSessionExpired(session, lastUsedAt + SESSION_IDLE_TTL_MS - 1)).toBe(false);
    expect(isSessionExpired(session, lastUsedAt + SESSION_IDLE_TTL_MS)).toBe(true);
  });

  it("derives deadlines from createdAt for rows predating expiry tracking", () => {
    const createdAt = 1_000_000;
    const legacy = { ...baseSession, createdAt };

    expect(isSessionExpired(legacy, createdAt + SESSION_IDLE_TTL_MS - 1)).toBe(false);
    expect(isSessionExpired(legacy, createdAt + SESSION_IDLE_TTL_MS)).toBe(true);
  });

  it("rejects an expired session on refresh and deletes it", async () => {
    const t = setup();
    const stale = Date.now() - SESSION_ABSOLUTE_TTL_MS - 1;
    await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        sessionToken: "stale-uuid",
        refreshToken: "refresh",
        googleUserId: "google-user",
        createdAt: stale,
        expiresAt: stale + SESSION_ABSOLUTE_TTL_MS,
        lastUsedAt: stale,
      })
    );

    expect(await t.run(async (ctx) => ctx.db.query("authSessions").collect()))
      .toHaveLength(1);

    await t.mutation(internal.authSessions.cleanupExpiredSessions, {});

    expect(await t.run(async (ctx) => ctx.db.query("authSessions").collect()))
      .toHaveLength(0);
  });

  it("keeps live sessions when the cleanup cron runs", async () => {
    const t = setup();
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        sessionToken: "live-uuid",
        refreshToken: "refresh",
        googleUserId: "google-user",
        createdAt: now,
        expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
        lastUsedAt: now,
      })
    );

    await t.mutation(internal.authSessions.cleanupExpiredSessions, {});

    expect(await t.run(async (ctx) => ctx.db.query("authSessions").collect()))
      .toHaveLength(1);
  });

  it("revoking a session returns its refresh token so the grant can be dropped", async () => {
    const t = setup();
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        sessionToken: "uuid-to-revoke",
        refreshToken: "the-refresh-token",
        googleUserId: "google-user",
        createdAt: now,
        expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
        lastUsedAt: now,
      })
    );

    const revoked = await t.mutation(internal.authSessions.revokeSession, {
      sessionToken: "uuid-to-revoke",
    });

    expect(revoked).toEqual({ refreshToken: "the-refresh-token" });
    expect(await t.run(async (ctx) => ctx.db.query("authSessions").collect()))
      .toHaveLength(0);
  });

  it("ignores an expired session when looking up a refresh token", async () => {
    const t = setup();
    const stale = Date.now() - SESSION_ABSOLUTE_TTL_MS - 1;
    await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        sessionToken: "stale-uuid",
        refreshToken: "refresh",
        googleUserId: "google-user",
        createdAt: stale,
        expiresAt: stale + SESSION_ABSOLUTE_TTL_MS,
        lastUsedAt: stale,
      })
    );

    const result = await t.query(
      internal.authSessions.getRefreshTokenByGoogleUser,
      { googleUserId: "google-user" }
    );
    expect(result).toBeNull();
  });
});
