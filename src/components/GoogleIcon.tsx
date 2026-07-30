import googleG from "../assets/google-g.svg";
import styles from "../styles/app.module.css";

export function GoogleIcon() {
  return (
    <img
      src={googleG}
      alt=""
      className={styles.googleIcon}
      aria-hidden="true"
    />
  );
}
