import { Header } from "./components/Header";
import { ScheduleList } from "./components/ScheduleList";
import styles from "./styles/app.module.css";

export default function App() {
  return (
    <div className={styles.appShell}>
      <Header />
      <main className={styles.main}>
        <ScheduleList />
      </main>
    </div>
  );
}
