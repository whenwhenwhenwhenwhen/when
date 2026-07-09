import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { getConfig } from "../config";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";

interface Props {
  scheduleId: Id<"schedules">;
  profileId: Id<"userProfiles"> | null;
  anonymousId?: string;
  isCreator: boolean;
}

const DISCORD_INSTALL_NONCE_KEY = "whengames_discord_install_session";

// View Channel + Send Messages + Embed Links + Read Message History
//   0x400  +    0x800     +   0x4000     +  0x10000        = 0x14C00 = 84992
const DISCORD_BOT_PERMISSIONS = "84992";

export function DiscordLinkButton({
  scheduleId,
  profileId,
  anonymousId,
  isCreator,
}: Props) {
  const links = useQuery(api.discord.linksForScheduleSummary, { scheduleId });
  const createInstallSession = useMutation(api.discord.createInstallSession);
  const unlink = useMutation(api.discord.unlink);
  const [busy, setBusy] = useState(false);

  const handleLink = useCallback(async () => {
    if (!profileId) return;
    setBusy(true);
    try {
      const sessionToken = await createInstallSession({
        scheduleId,
        anonymousId,
      });
      sessionStorage.setItem(DISCORD_INSTALL_NONCE_KEY, sessionToken);

      const cfg = getConfig();
      const clientId = cfg.DISCORD_CLIENT_ID;
      if (!clientId) {
        alert(
          "Discord client ID is not configured. Set DISCORD_CLIENT_ID on the deployment."
        );
        return;
      }

      const url = new URL("https://discord.com/api/oauth2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", "bot applications.commands");
      url.searchParams.set("permissions", DISCORD_BOT_PERMISSIONS);
      url.searchParams.set("state", sessionToken);
      url.searchParams.set(
        "redirect_uri",
        `${cfg.CONVEX_SITE_URL}/discord/install-callback`
      );
      url.searchParams.set("response_type", "code");
      window.location.href = url.toString();
    } finally {
      setBusy(false);
    }
  }, [scheduleId, profileId, anonymousId, createInstallSession]);

  const handleUnlink = useCallback(
    async (linkId: Id<"scheduleDiscordLinks">) => {
      if (!profileId) return;
      await unlink({ linkId, anonymousId });
    },
    [profileId, anonymousId, unlink]
  );

  const hasLinks = links && links.length > 0;

  if (!isCreator && !hasLinks) {
    // Nothing to show to non-creators when nothing is linked
    return null;
  }

  return (
    <div className={styles.inlineClusterTight}>
      {hasLinks && (
        <div className={styles.discordLinks}>
          <DiscordIcon className={cx(styles.iconMd, styles.discordIcon)} />
          {links!.map((l) => (
            <span key={l._id} className={styles.inlineClusterTight}>
              <span title={l.guildName ?? undefined}>
                #{l.channelName ?? l.channelId.slice(0, 6)}
              </span>
              {isCreator && (
                <button
                  onClick={() => handleUnlink(l._id)}
                  className={cx(styles.iconButton, styles.iconButtonDanger)}
                  title="Unlink"
                  aria-label="Unlink Discord channel"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {isCreator && (
        <button
          onClick={handleLink}
          disabled={busy || !profileId}
          className={styles.buttonSecondarySmall}
          title={
            hasLinks ? "Link another Discord channel" : "Link a Discord channel"
          }
        >
          <DiscordIcon className={cx(styles.iconSm, styles.discordIcon)} />
          {busy ? "Opening Discord..." : hasLinks ? "Link another" : "Link to Discord"}
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
