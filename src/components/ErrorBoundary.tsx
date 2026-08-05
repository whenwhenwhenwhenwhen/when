import { Component, type ErrorInfo, type ReactNode } from "react";
import styles from "../styles/app.module.css";

export function MessageScreen({
  message,
  actionLabel = "Back to schedules",
}: {
  message: string;
  actionLabel?: string;
}) {
  return (
    <div className={styles.appShell}>
      <div className={styles.emptyState}>
        <p className={styles.subtleText}>{message}</p>
        {/* A full page load, not a router link: the app state that produced
            the failure must not survive the recovery. */}
        <a href="/" className={styles.linkButton}>
          {actionLabel}
        </a>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
  message?: string;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time failures below it so a single bad screen cannot blank
 * the whole app — Convex's `useQuery` throws during render when it is handed
 * a malformed document id, which a URL segment can always be.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <MessageScreen message={this.props.message ?? "Something went wrong."} />;
  }
}
