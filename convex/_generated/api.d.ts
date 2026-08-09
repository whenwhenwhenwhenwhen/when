/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as calendarSources from "../calendarSources.js";
import type * as calendarSync from "../calendarSync.js";
import type * as crons from "../crons.js";
import type * as discord from "../discord.js";
import type * as discordHelpers from "../discordHelpers.js";
import type * as discordPermissions from "../discordPermissions.js";
import type * as discordSetup from "../discordSetup.js";
import type * as dstNotifications from "../dstNotifications.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as profileImages from "../profileImages.js";
import type * as savedAvailabilities from "../savedAvailabilities.js";
import type * as scheduleMemberships from "../scheduleMemberships.js";
import type * as schedules from "../schedules.js";
import type * as selections from "../selections.js";
import type * as timezone from "../timezone.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  calendarSources: typeof calendarSources;
  calendarSync: typeof calendarSync;
  crons: typeof crons;
  discord: typeof discord;
  discordHelpers: typeof discordHelpers;
  discordPermissions: typeof discordPermissions;
  discordSetup: typeof discordSetup;
  dstNotifications: typeof dstNotifications;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  profileImages: typeof profileImages;
  savedAvailabilities: typeof savedAvailabilities;
  scheduleMemberships: typeof scheduleMemberships;
  schedules: typeof schedules;
  selections: typeof selections;
  timezone: typeof timezone;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  googlyAuth: import("@clammet/convex-googly-auth/_generated/component.js").ComponentApi<"googlyAuth">;
};
