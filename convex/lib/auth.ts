import { GooglyAuth } from "@clammet/convex-googly-auth";
import type { Doc } from "../_generated/dataModel";
import { components } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const googlyAuth = new GooglyAuth(components.googlyAuth);

type ProfileCtx = QueryCtx | MutationCtx;

export async function getCurrentProfile(
  ctx: ProfileCtx,
  anonymousClaim?: string,
): Promise<Doc<"userProfiles"> | null> {
  const identityId = await googlyAuth.resolveIdentity(ctx, { anonymousClaim });
  if (identityId === null) return null;

  return await ctx.db
    .query("userProfiles")
    .withIndex("by_identityId", (q) => q.eq("identityId", identityId))
    .unique();
}

export async function requireCurrentProfile(
  ctx: ProfileCtx,
  anonymousClaim?: string,
): Promise<Doc<"userProfiles">> {
  const profile = await getCurrentProfile(ctx, anonymousClaim);
  if (profile === null) throw new Error("Not authorized");
  return profile;
}

export async function requireGoogleProfile(
  ctx: ProfileCtx,
): Promise<Doc<"userProfiles">> {
  if ((await ctx.auth.getUserIdentity()) === null) {
    throw new Error("Not authenticated");
  }
  const profile = await getCurrentProfile(ctx);
  if (profile === null) throw new Error("Authenticated profile not found");
  return profile;
}
