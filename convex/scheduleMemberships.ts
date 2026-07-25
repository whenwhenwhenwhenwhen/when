import { Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";

type MembershipReader = Pick<QueryCtx, "db">;

export async function hasScheduleParticipation(
  ctx: MembershipReader,
  scheduleId: Id<"schedules">,
  profileId: Id<"userProfiles">
): Promise<boolean> {
  const [selection, availabilityLink] = await Promise.all([
    ctx.db
      .query("selections")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", scheduleId).eq("profileId", profileId)
      )
      .first(),
    ctx.db
      .query("availabilityLinks")
      .withIndex("by_schedule_profile", (q) =>
        q.eq("scheduleId", scheduleId).eq("profileId", profileId)
      )
      .unique(),
  ]);

  if (selection) return true;
  if (!availabilityLink) return false;

  const savedAvailability = await ctx.db.get(
    availabilityLink.savedAvailabilityId
  );
  return (savedAvailability?.slots.length ?? 0) > 0;
}
