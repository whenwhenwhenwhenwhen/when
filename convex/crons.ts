import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.cron(
  "dst-notification-check",
  "0 0 * * *",
  internal.dstNotifications.checkUpcomingDstChanges,
  {}
);

crons.interval(
  "calendar-sync-dispatch",
  { minutes: 30 },
  internal.calendarSync.dispatchOverdueSyncs,
  {}
);

crons.interval(
  "discord-install-session-cleanup",
  { hours: 1 },
  internal.discord.cleanupExpiredInstallSessions,
  {}
);

crons.interval(
  "discord-recurring-timestamp-refresh",
  { hours: 6 },
  internal.discord.refreshRecurringDiscordMessages,
  {},
);

export default crons;
