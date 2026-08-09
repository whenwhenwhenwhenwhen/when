/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import googlyAuthComponent from "@clammet/convex-googly-auth/test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const CLAIM_A = "a".repeat(64);
const CLAIM_B = "b".repeat(64);
const GOOGLE_ISSUER = "https://accounts.google.com";

function setup() {
  const t = convexTest(schema, modules);
  googlyAuthComponent.register(t);
  return t;
}

function asGoogleUser(t: ReturnType<typeof setup>, subject: string) {
  return t.withIdentity({
    tokenIdentifier: `${GOOGLE_ISSUER}|${subject}`,
    name: subject,
    email: `${subject}@example.com`,
  });
}

async function ensureAnonymous(
  t: ReturnType<typeof setup>,
  claim: string,
  displayName: string,
) {
  return await t.mutation(api.users.ensureProfile, {
    anonymousClaim: claim,
    displayName,
    timezone: "UTC",
  });
}

describe("googly auth profile integration", () => {
  it("creates and resolves an anonymous profile without exposing identity data", async () => {
    const t = setup();
    const profileId = await ensureAnonymous(t, CLAIM_A, "Alice");

    const current = await t.query(api.users.currentUserProfile, {
      anonymousClaim: CLAIM_A,
    });
    expect(current?._id).toBe(profileId);
    expect(current?.authType).toBe("anonymous");
    expect(current).not.toHaveProperty("identityId");
    expect(JSON.stringify(current)).not.toContain(CLAIM_A);

    const stored = await t.run(async (ctx) => ctx.db.get(profileId));
    expect(stored?.identityId).toBeTruthy();
    expect(stored).not.toHaveProperty("anonymousClaim");
  });

  it("rejects malformed anonymous claims", async () => {
    const t = setup();
    await expect(
      t.mutation(api.users.ensureProfile, {
        anonymousClaim: "not-a-claim",
        displayName: "Alice",
        timezone: "UTC",
      }),
    ).rejects.toThrow("A valid anonymous claim is required");
  });

  it("upgrades in place and permanently retires the anonymous claim", async () => {
    const t = setup();
    const anonymousProfileId = await ensureAnonymous(t, CLAIM_A, "Alice");
    const alice = asGoogleUser(t, "alice");

    const upgradedProfileId = await alice.mutation(api.users.ensureProfile, {
      anonymousClaim: CLAIM_A,
      timezone: "UTC",
    });

    expect(upgradedProfileId).toBe(anonymousProfileId);
    expect(
      await t.query(api.users.currentUserProfile, {
        anonymousClaim: CLAIM_A,
      }),
    ).toBeNull();
    expect((await alice.query(api.users.currentUserProfile, {}))?.authType).toBe(
      "sso",
    );
  });

  it("moves app data when an existing Google identity absorbs an anonymous one", async () => {
    const t = setup();
    const bob = asGoogleUser(t, "bob");
    const googleProfileId = await bob.mutation(api.users.ensureProfile, {
      timezone: "UTC",
    });
    const anonymousProfileId = await ensureAnonymous(t, CLAIM_B, "Guest Bob");
    const scheduleId = await t.mutation(api.schedules.create, {
      title: "Game night",
      type: "recurring",
      creatorProfileId: anonymousProfileId,
      anonymousClaim: CLAIM_B,
      creatorTimezone: "UTC",
    });

    expect(
      await bob.mutation(api.users.ensureProfile, {
        anonymousClaim: CLAIM_B,
        timezone: "UTC",
      }),
    ).toBe(googleProfileId);

    const schedule = await t.run(async (ctx) => ctx.db.get(scheduleId));
    expect(schedule?.creatorProfileId).toBe(googleProfileId);
    expect(
      await t.run(async (ctx) => ctx.db.get(anonymousProfileId)),
    ).toBeNull();
    expect(
      await t.query(api.users.currentUserProfile, {
        anonymousClaim: CLAIM_B,
      }),
    ).toBeNull();
  });

  it("does not authorize one anonymous identity as another", async () => {
    const t = setup();
    const ownerId = await ensureAnonymous(t, CLAIM_A, "Owner");
    await ensureAnonymous(t, CLAIM_B, "Attacker");
    const scheduleId = await t.mutation(api.schedules.create, {
      title: "Private controls",
      type: "recurring",
      creatorProfileId: ownerId,
      anonymousClaim: CLAIM_A,
      creatorTimezone: "UTC",
    });

    await expect(
      t.mutation(api.schedules.remove, {
        scheduleId,
        anonymousClaim: CLAIM_B,
      }),
    ).rejects.toThrow("Unauthorized");
  });
});
