import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Header } from "./Header";
import { useGoogleAuth } from "../lib/googleAuth";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import styles from "../styles/app.module.css";

const DISCORD_INSTALL_NONCE_KEY = "whengames_discord_install_session";

/**
 * Mounted at /discord/link-channel.
 *
 * Discord OAuth redirects (via our Convex callback) here with ?session=...
 * The callback has already fetched the guild's channel list and stored it
 * on the install session document. We poll for the session, render the
 * channel picker, then call `linkScheduleToChannel` once the user chooses.
 */
export function DiscordChannelPickerPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useGoogleAuth();
  const { anonymousId } = useAnonymousUser();
  const params = new URLSearchParams(window.location.search);
  const sessionToken = params.get("session");
  const error = params.get("error");

  // CSRF: only proceed if the token in the URL matches what we stashed
  // when starting the OAuth flow.
  const [tokenValidated, setTokenValidated] = useState<boolean | null>(null);
  useEffect(() => {
    const stored = sessionStorage.getItem(DISCORD_INSTALL_NONCE_KEY);
    if (!sessionToken) {
      setTokenValidated(false);
      return;
    }
    setTokenValidated(stored === sessionToken);
  }, [sessionToken]);

  const ownerReady = !authLoading && (isAuthenticated || !!anonymousId);
  const ownerArgs = {
    anonymousId: isAuthenticated ? undefined : anonymousId || undefined,
  };

  const session = useQuery(
    api.discord.getInstallSessionByToken,
    sessionToken && tokenValidated && ownerReady
      ? {
          sessionToken,
          ...ownerArgs,
        }
      : "skip"
  );

  const linkScheduleToChannel = useAction(api.discord.linkScheduleToChannel);

  const [picking, setPicking] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const channels = session?.channels ?? [];
  const sortedChannels = useMemo(
    () => [...channels].sort((a, b) => a.name.localeCompare(b.name)),
    [channels]
  );

  const handlePick = async (channelId: string, channelName: string) => {
    if (!sessionToken) return;
    setPicking(channelId);
    try {
      await linkScheduleToChannel({
        sessionToken,
        channelId,
        channelName,
        ...ownerArgs,
      });
      sessionStorage.removeItem(DISCORD_INSTALL_NONCE_KEY);
      setDone(true);
      // Bounce back to schedule view
      if (session?.scheduleId) {
        setTimeout(() => navigate(`/schedule/${session.scheduleId}`), 600);
      }
    } finally {
      setPicking(null);
    }
  };

  if (error) {
    return (
      <Wrap>
        <div className={styles.errorText}>
          Discord install failed: {error}
        </div>
        <BackButton scheduleId={session?.scheduleId} />
      </Wrap>
    );
  }

  if (tokenValidated === false) {
    return (
      <Wrap>
        <div className={styles.errorText}>
          This link is no longer valid. Start linking again from the schedule
          page.
        </div>
        <BackButton scheduleId={session?.scheduleId} />
      </Wrap>
    );
  }

  if (done) {
    return (
      <Wrap>
        <div className={styles.successText}>
          Channel linked. Returning to your schedule…
        </div>
      </Wrap>
    );
  }

  if (!session) {
    return (
      <Wrap>
        <div className={styles.subtleText}>
          Loading channels…
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <h2 className={styles.sectionTitle}>
        Pick a channel in {session.guildName ?? "your server"}
      </h2>
      <p className={styles.smallText}>
        The bot will send a summary message here. Updates are sent if a locked-in
        time changes or a participant becomes unavailable for a locked slot.
      </p>
      {sortedChannels.length === 0 ? (
        <p className={styles.subtleText}>
          No text channels visible to the bot. Make sure the bot has the View
          Channels permission, then retry.
        </p>
      ) : (
        <ul className={styles.listBox}>
          {sortedChannels.map((ch) => (
            <li key={ch.id} className={styles.channelRow}>
              <span className={styles.channelText}>
                #{ch.name}
              </span>
              <button
                onClick={() => handlePick(ch.id, ch.name)}
                disabled={picking !== null}
                className={styles.buttonIndigo}
              >
                {picking === ch.id ? "Linking…" : "Link here"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <BackButton scheduleId={session.scheduleId} />
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.appShell}>
      <Header />
      <main className={styles.mainNarrow}>{children}</main>
    </div>
  );
}

function BackButton({ scheduleId }: { scheduleId?: string }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(scheduleId ? `/schedule/${scheduleId}` : "/")}
      className={styles.linkButton}
    >
      Back to schedule
    </button>
  );
}
