import { useState } from "react";
import { useLocation } from "react-router";
import { useGoogleAuth } from "../lib/googleAuth";
import styles from "../styles/app.module.css";

interface Props {
  currentName: string;
  onSubmit: (name: string) => void;
}

export function DisplayNamePrompt({ currentName, onSubmit }: Props) {
  const [name, setName] = useState(currentName);
  const { signIn } = useGoogleAuth();
  const location = useLocation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSubmit(name.trim());
    }
  };

  const handleLogin = () => {
    const currentPath = location.pathname + location.search + location.hash;
    signIn(currentPath);
  };

  return (
    <div className={styles.displayNamePrompt}>
      <form onSubmit={handleSubmit} className={styles.displayNameForm}>
        <label className={styles.displayNameLabel}>
          Display Name:
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your name to participate"
          className={styles.displayNameInput}
          autoFocus
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className={styles.buttonWarning}
        >
          Join
        </button>
        <button
          type="button"
          onClick={handleLogin}
          className={styles.displayLogin}
        >
          Login to access saved availabilityies, changes across devices &amp; more
        </button>
      </form>
    </div>
  );
}
