import { useCallback, useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { DISCORD_REQUIRED_PERMISSION_BITS } from "../../convex/discordPermissions";
import { getConfig } from "../config";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Props {
  scheduleId: Id<"schedules">;
  profileId: Id<"userProfiles"> | null;
  anonymousId?: string;
  isCreator: boolean;
  showLinks?: boolean;
  showLinkButton?: boolean;
  linkButtonClassName?: string;
}

const DISCORD_INSTALL_NONCE_KEY = "whengames_discord_install_session";
const HOUR_MS = 60 * 60 * 1000;
const NEW_MESSAGE_AGE_OPTIONS = [
  { value: -1, label: "Never" },
  { value: 0, label: "Always update the latest message" },
  { value: HOUR_MS, label: "1 hour" },
  { value: 6 * HOUR_MS, label: "6 hours" },
  { value: 12 * HOUR_MS, label: "12 hours" },
  { value: 24 * HOUR_MS, label: "24 hours" },
  { value: 3 * 24 * HOUR_MS, label: "3 days" },
] as const;

function formatStatusTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatDuration(durationMs: number): string {
  if (durationMs === -1) return "never";
  if (durationMs === 0) return "always update latest";
  const hours = durationMs / HOUR_MS;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function DiscordLinkButton({
  scheduleId,
  profileId,
  anonymousId,
  isCreator,
  showLinks = true,
  showLinkButton = true,
  linkButtonClassName = styles.buttonSecondarySmall,
}: Props) {
  const links = useQuery(api.discord.linksForScheduleSummary, { scheduleId });
  const createInstallSession = useMutation(api.discord.createInstallSession);
  const getInstallReadiness = useAction(api.discord.getInstallReadiness);
  const getDeliveryDefaults = useAction(api.discord.getDeliveryDefaults);
  const unlink = useMutation(api.discord.unlink);
  const setNewMessageAfter = useMutation(api.discord.setNewMessageAfter);
  const [busy, setBusy] = useState(false);
  const [defaultNewMessageAfterMs, setDefaultNewMessageAfterMs] = useState<
    number | null
  >(null);
  const [savingPolicyFor, setSavingPolicyFor] = useState<
    Id<"scheduleDiscordLinks"> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void getDeliveryDefaults()
      .then((defaults) => {
        if (!cancelled) setDefaultNewMessageAfterMs(defaults.newMessageAfterMs);
      })
      .catch(() => {
        // The link and diagnostics remain usable if defaults cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [getDeliveryDefaults]);

  const handleLink = useCallback(async () => {
    if (!profileId) return;
    setBusy(true);
    try {
      const cfg = getConfig();
      const clientId = cfg.DISCORD_CLIENT_ID;
      if (!clientId) {
        alert(
          "Discord linking is not configured on this When? deployment. Ask the administrator to configure the Discord client ID.",
        );
        return;
      }

      const readiness = await getInstallReadiness();
      if (!readiness.ready) {
        alert(
          "Discord linking is not configured on this When? deployment. Ask the administrator to configure the Discord application credentials.",
        );
        return;
      }

      const sessionToken = await createInstallSession({
        scheduleId,
        anonymousId,
      });
      sessionStorage.setItem(DISCORD_INSTALL_NONCE_KEY, sessionToken);

      const url = new URL("https://discord.com/api/oauth2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", "identify bot applications.commands");
      url.searchParams.set("permissions", DISCORD_REQUIRED_PERMISSION_BITS);
      url.searchParams.set("state", sessionToken);
      url.searchParams.set(
        "redirect_uri",
        `${cfg.CONVEX_SITE_URL}/discord/install-callback`
      );
      url.searchParams.set("response_type", "code");
      window.location.href = url.toString();
    } catch (error) {
      console.error("Could not start Discord linking", error);
      alert(
        "When? could not start Discord linking. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    scheduleId,
    profileId,
    anonymousId,
    createInstallSession,
    getInstallReadiness,
  ]);

  const handleUnlink = useCallback(
    async (linkId: Id<"scheduleDiscordLinks">) => {
      if (!profileId) return;
      await unlink({ linkId, anonymousId });
    },
    [profileId, anonymousId, unlink]
  );

  const handlePolicyChange = useCallback(
    async (
      linkId: Id<"scheduleDiscordLinks">,
      value: string,
    ) => {
      if (!profileId) return;
      setSavingPolicyFor(linkId);
      try {
        await setNewMessageAfter({
          linkId,
          newMessageAfterMs: value === "default" ? null : Number(value),
          anonymousId,
        });
      } catch (error) {
        console.error("Could not update Discord message policy", error);
        alert("When? could not update this Discord channel setting.");
      } finally {
        setSavingPolicyFor(null);
      }
    },
    [anonymousId, profileId, setNewMessageAfter],
  );

  const hasLinks = links && links.length > 0;
  const shouldShowLinks = showLinks && hasLinks;
  const shouldShowLinkButton = showLinkButton && isCreator;

  if (!shouldShowLinks && !shouldShowLinkButton) {
    return null;
  }

  return (
    <div
      className={
        showLinks ? styles.discordMenuPanel : styles.inlineClusterTight
      }
    >
      {showLinks && links === undefined && (
        <p className={styles.discordLinkEmpty}>Loading linked channels…</p>
      )}
      {showLinks && links?.length === 0 && (
        <p className={styles.discordLinkEmpty}>No Discord channels linked.</p>
      )}
      {shouldShowLinks && (
        <div className={styles.discordLinkList} aria-live="polite">
          {links!.map((link) => (
            <div key={link._id} className={styles.discordLinkCard}>
              <div className={styles.discordLinkHeader}>
                <div className={styles.discordLinkName}>
                  <DiscordIcon
                    className={cx(styles.iconMd, styles.discordIcon)}
                  />
                  <div>
                    <div>#{link.channelName ?? link.channelId.slice(0, 6)}</div>
                    {link.guildName && (
                      <div className={styles.discordGuildName}>
                        {link.guildName}
                      </div>
                    )}
                  </div>
                </div>
                {isCreator && (
                  <button
                    type="button"
                    onClick={() => handleUnlink(link._id)}
                    className={cx(styles.iconButton, styles.iconButtonDanger)}
                    title="Unlink"
                    aria-label={`Unlink #${link.channelName ?? link.channelId.slice(0, 6)}`}
                  >
                    <X className={styles.iconXs} aria-hidden="true" />
                  </button>
                )}
              </div>

              {link.lastUpdateError ? (
                <p className={cx(styles.discordLinkStatus, styles.errorText)}>
                  Update failed
                  {link.lastUpdateAttemptAt
                    ? ` ${formatStatusTime(link.lastUpdateAttemptAt)}`
                    : ""}
                  : {link.lastUpdateError}
                </p>
              ) : link.pendingUpdateAt ? (
                <p className={styles.discordLinkStatus}>
                  Update queued for {formatStatusTime(link.pendingUpdateAt)}
                </p>
              ) : link.lastNotifiedAt ? (
                <p className={styles.discordLinkStatus}>
                  Last sent {formatStatusTime(link.lastNotifiedAt)}
                </p>
              ) : (
                <p className={styles.discordLinkStatus}>
                  Waiting for the first Discord message
                </p>
              )}

              {link.lastMessageId && (
                <a
                  href={`https://discord.com/channels/${link.guildId}/${link.channelId}/${link.lastMessageId}`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.discordMessageLink}
                >
                  View message in Discord
                </a>
              )}

              {isCreator && (
                <label className={styles.discordPolicyLabel}>
                  <span>Start a new message after</span>
                  <select
                    value={link.newMessageAfterMs ?? "default"}
                    onChange={(event) =>
                      void handlePolicyChange(link._id, event.target.value)
                    }
                    disabled={savingPolicyFor === link._id}
                    className={styles.selectControl}
                    aria-label={`New-message age for #${link.channelName ?? link.channelId.slice(0, 6)}`}
                  >
                    <option value="default">
                      Server default
                      {defaultNewMessageAfterMs === null
                        ? ""
                        : ` (${formatDuration(defaultNewMessageAfterMs)})`}
                    </option>
                    {NEW_MESSAGE_AGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ))}
        </div>
      )}
      {shouldShowLinkButton && (
        <button
          type="button"
          onClick={handleLink}
          disabled={busy || !profileId}
          className={linkButtonClassName}
          title={
            hasLinks ? "Link another Discord channel" : "Link a Discord channel"
          }
        >
          <DiscordIcon className={cx(styles.iconSm, styles.discordIcon)} />
          {busy
            ? "Opening Discord..."
            : hasLinks
              ? "Link another channel"
              : "Link to Discord"}
        </button>
      )}
    </div>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.42-2.157 2.42zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.42-2.157 2.42z" />
    </svg>
  );
}
