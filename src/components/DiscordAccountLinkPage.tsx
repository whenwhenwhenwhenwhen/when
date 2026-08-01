import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { useAnonymousUser } from "../hooks/useAnonymousUser";
import { useGoogleAuth } from "../lib/googleAuth";
import { cx } from "../lib/classes";
import styles from "../styles/app.module.css";
import { Header } from "./Header";

export function DiscordAccountLinkPage() {
  const navigate = useNavigate();
  const { anonymousId } = useAnonymousUser();
  const { isAuthenticated, isLoading: authLoading } = useGoogleAuth();
  const [currentTime] = useState(() => Date.now());
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = new URLSearchParams(window.location.search).get("token");
  const session = useQuery(
    api.discord.getDiscordUserLinkSession,
    token ? { sessionToken: token, currentTime } : "skip",
  );
  const profile = useQuery(
    api.users.currentUserProfile,
    authLoading
      ? "skip"
      : {
          anonymousId: isAuthenticated ? undefined : anonymousId || undefined,
        },
  );
  const completeLink = useMutation(api.discord.completeDiscordUserLink);

  const handleLink = async () => {
    if (!token || !profile?._id) return;
    setLinking(true);
    setError(null);
    try {
      const result = await completeLink({
        sessionToken: token,
        anonymousId: isAuthenticated ? undefined : anonymousId || undefined,
      });
      if (!result.ok) {
        setError(
          result.reason === "expired"
            ? "This link has expired. Run /when in Discord to request another one."
            : "That Discord account is already linked to another When? profile.",
        );
        return;
      }
      setLinked(true);
    } catch {
      setError("When? could not link this Discord account. Please try again.");
    } finally {
      setLinking(false);
    }
  };

  let content: React.ReactNode;
  if (linked) {
    content = (
      <>
        <h1 className={styles.sectionTitle}>Discord account linked</h1>
        <p className={styles.successText}>
          Return to Discord and run /when again to choose one of your schedules.
        </p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className={styles.buttonPrimary}
        >
          Continue to When?
        </button>
      </>
    );
  } else if (!token || session === null) {
    content = (
      <>
        <h1 className={styles.sectionTitle}>Discord link expired</h1>
        <p className={styles.errorText}>
          Run /when in Discord to request a fresh private link. Links expire
          after 15 minutes and can only be used once.
        </p>
      </>
    );
  } else if (session === undefined || authLoading || profile === undefined) {
    content = <p className={styles.subtleText}>Checking your accounts…</p>;
  } else if (!profile?._id) {
    content = (
      <>
        <h1 className={styles.sectionTitle}>Open your When? profile</h1>
        <p className={styles.subtleText}>
          Open this private link in the same browser where you use When?, or
          sign in to the Google account connected to your When? profile, then
          reopen the link from Discord.
        </p>
      </>
    );
  } else {
    content = (
      <>
        <h1 className={styles.sectionTitle}>Link Discord to When?</h1>
        <p className={styles.subtleText}>
          Connect Discord user
          {session.discordUsername ? ` @${session.discordUsername}` : ""} to
          the When? profile <strong>{profile.displayName}</strong>.
        </p>
        <p className={styles.smallText}>
          This lets /when show schedules this profile created or participated
          in. The private link expires after 15 minutes.
        </p>
        {error && (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={handleLink}
          disabled={linking}
          className={styles.buttonPrimary}
        >
          {linking ? "Linking…" : "Link accounts"}
        </button>
      </>
    );
  }

  return (
    <div className={styles.appShell}>
      <Header />
      <main className={styles.mainNarrow}>
        <section className={cx(styles.panel, styles.formStack)}>{content}</section>
      </main>
    </div>
  );
}
