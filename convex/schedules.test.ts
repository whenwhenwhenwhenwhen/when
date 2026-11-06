/// <reference types="vite/client" />
// @vitest-environment edge-runtime

import googlyAuthComponent from "@clammet/convex-googly-auth/test";
import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  googlyAuthComponent.register(t);
  const owner = t.withIdentity({ tokenIdentifier: "https://accounts.google.com|owner" });
  const participant = t.withIdentity({ tokenIdentifier: "https://accounts.google.com|participant" });
  const creatorProfileId = await owner.mutation(api.users.ensureProfile, { timezone: "UTC" });
  const profileId = await participant.mutation(api.users.ensureProfile, { timezone: "UTC" });
  const scheduleFields = {
    title: "Game night",
    type: "recurring" as const,
    creatorProfileId,
    creatorTimezone: "UTC",
  };
  return { t, owner, participant, profileId, scheduleFields };
}

const cantDo = { dayKey: "2", timeSlot: "09:00", state: "cant-do" } as const;
const maybe = { dayKey: "2", timeSlot: "09:30", state: "maybe" } as const;

it("defaults new schedules to disallow Can't Do and accepts it on opted-out and legacy schedules", async () => {
  const { t, owner, participant, profileId, scheduleFields } = await setup();
  const scheduleId = await owner.mutation(api.schedules.create, scheduleFields);
  const explicitOptOutId = await owner.mutation(api.schedules.create, {
    ...scheduleFields,
    disallowCantDo: false,
  });
  const legacyId = await t.run((ctx) =>
    ctx.db.insert("schedules", { ...scheduleFields, createdAt: Date.now() })
  );

  const response = { scheduleId, profileId, timezone: "UTC" };
  expect(await participant.mutation(api.selections.set, { ...response, ...cantDo })).toBeNull();
  await participant.mutation(api.selections.batchSet, {
    ...response,
    selections: [cantDo, maybe],
  });
  const schedule = await t.query(api.schedules.get, { scheduleId });
  expect(schedule?.disallowCantDo).toBe(true);
  expect(schedule?.selections.map(({ state }) => state)).toEqual(["maybe"]);

  for (const id of [explicitOptOutId, legacyId]) {
    await participant.mutation(api.selections.set, { ...response, scheduleId: id, ...cantDo });
    const allowingSchedule = await t.query(api.schedules.get, { scheduleId: id });
    expect(allowingSchedule?.selections.map(({ state }) => state)).toEqual(["cant-do"]);
  }
});

it("lets only the creator turn off Can't Do and removes stored responses across cleanup batches", async () => {
  vi.useFakeTimers();
  try {
    const { t, owner, participant, profileId, scheduleFields } = await setup();
    const scheduleId = await owner.mutation(api.schedules.create, {
      ...scheduleFields,
      disallowCantDo: false,
    });
    const response = { scheduleId, profileId, timezone: "UTC" };
    await participant.mutation(api.selections.set, { ...response, ...maybe });
    await t.run(async (ctx) => {
      for (let day = 0; day < 501; day++) {
        const date = new Date(Date.UTC(2026, 0, 1 + day));
        await ctx.db.insert("selections", {
          ...response,
          ...cantDo,
          dayKey: String(date.getUTCDay()),
          isException: true,
          exceptionDate: date.toISOString().slice(0, 10),
          ...(day === 0 ? { source: "calendar", externalEventId: "event" } : {}),
        });
      }
    });

    const disable = { scheduleId, disallowCantDo: true };
    await expect(participant.mutation(api.schedules.setDisallowCantDo, disable))
      .rejects.toThrow("Unauthorized");
    await owner.mutation(api.schedules.setDisallowCantDo, disable);
    const schedule = await t.query(api.schedules.get, { scheduleId });
    expect(schedule?.selections.map(({ state }) => state)).toEqual(["maybe"]);

    await expect(owner.mutation(api.schedules.setDisallowCantDo, {
      scheduleId,
      disallowCantDo: false,
    })).rejects.toThrow("still being removed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await owner.mutation(api.schedules.setDisallowCantDo, {
      scheduleId,
      disallowCantDo: false,
    });

    await t.mutation(internal.selections.continueBatchSet, {
      ...response,
      selections: [cantDo],
      actorIsCreator: false,
      batchStartedAt: Date.now(),
    });
    const stored = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(stored.map(({ state }) => state)).toEqual(["maybe"]);
    expect(await participant.mutation(api.selections.set, { ...response, ...cantDo })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("omits Can't Do from linked availability and keeps the saved template intact", async () => {
  const { t, owner, participant, profileId, scheduleFields } = await setup();
  const scheduleId = await owner.mutation(api.schedules.create, scheduleFields);
  const savedAvailabilityId = await t.run((ctx) =>
    ctx.db.insert("savedAvailabilities", {
      profileId,
      name: "Usual week",
      timezone: "UTC",
      slots: [cantDo, maybe],
    })
  );
  await participant.mutation(api.savedAvailabilities.applyToSchedule, {
    scheduleId,
    savedAvailabilityId,
  });

  const linked = await t.query(api.schedules.get, { scheduleId });
  expect(linked?.selections.map(({ state }) => state)).toEqual(["maybe"]);
  await participant.mutation(api.selections.remove, {
    scheduleId,
    profileId,
    dayKey: cantDo.dayKey,
    timeSlot: cantDo.timeSlot,
    timezone: "UTC",
  });
  await participant.mutation(api.savedAvailabilities.unlinkFromSchedule, { scheduleId });
  const unlinked = await t.query(api.schedules.get, { scheduleId });
  expect(unlinked?.selections.map(({ state }) => state)).toEqual(["maybe"]);
  const template = await t.run((ctx) => ctx.db.get(savedAvailabilityId));
  expect(template?.slots).toEqual([cantDo, maybe]);
});
