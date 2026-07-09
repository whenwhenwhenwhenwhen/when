import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import styles from "../styles/app.module.css";

type AnimState = "games" | "hangout" | "movies";
type Phase = "idle" | "entering" | "displaying" | "exiting";

const STATE_ORDER: AnimState[] = ["games", "hangout", "movies"];
const MAX_LOOPS = 4;
const STORAGE_KEY = "when_title_loops_done";
const STAGGER = 80; // ms between each element start
const DURATION = 100; // ms per element animation
const GAP = 350; // ms showing "When?" between animations
const INITIAL_DELAY = 600; // ms before first animation starts

function randHold() {
  return 1000 + Math.random() * 1000;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function animTime(n: number) {
  return (n - 1) * STAGGER + DURATION;
}

const GAMES_CHARS = ["g", "a", "m", "e", "s", "?"];
const HANGOUT_CHUNKS = ["hang", "out", "?"];
const MOVIES_CHARS = ["m", "o", "v", "i", "e", "s", "?"];

function elems(s: AnimState) {
  return s === "games"
    ? GAMES_CHARS.length
    : s === "hangout"
      ? HANGOUT_CHUNKS.length
      : MOVIES_CHARS.length;
}

const CSS = `
@keyframes wt-slideInRight {
  0% { transform: translateX(20px); opacity: 0; }
  60% { transform: translateX(-3px); opacity: 1; }
  100% { transform: translateX(0); opacity: 1; }
}

@keyframes wt-slideOutRight {
  0% { transform: translateX(0); opacity: 1; }
  30% { transform: translateX(-3px); opacity: 1; }
  100% { transform: translateX(20px); opacity: 0; }
}

@keyframes wt-slideDown {
  0% { transform: translateY(-20px); opacity: 0; }
  60% { transform: translateY(3px); opacity: 1; }
  100% { transform: translateY(0); opacity: 1; }
}

@keyframes wt-slideUp {
  0% { transform: translateY(0); opacity: 1; }
  25% { transform: translateY(4px); opacity: 1; }
  100% { transform: translateY(-20px); opacity: 0; }
}

@keyframes wt-fadeIn {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

@keyframes wt-fadeOut {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
`;

function getCharStyle(
  phase: Phase,
  type: "slide" | "fade",
  index: number,
  total: number,
): CSSProperties {
  const base: CSSProperties = { display: "inline-block" };

  if (phase === "displaying") return base;

  const isExit = phase === "exiting";
  const delay = isExit ? (total - 1 - index) * STAGGER : index * STAGGER;

  if (type === "slide") {
    return {
      ...base,
      opacity: isExit ? 1 : 0,
      animation: `${isExit ? "wt-slideOutRight" : "wt-slideInRight"} ${DURATION}ms ${delay}ms ease-out forwards`,
    };
  }

  return {
    ...base,
    opacity: isExit ? 1 : 0,
    animation: `${isExit ? "wt-fadeOut" : "wt-fadeIn"} ${DURATION}ms ${delay}ms ease-out forwards`,
  };
}

function getChunkStyle(
  phase: Phase,
  index: number,
  total: number,
): CSSProperties {
  const base: CSSProperties = { display: "inline-block" };

  if (phase === "displaying") return base;

  const isExit = phase === "exiting";
  const delay = isExit ? (total - 1 - index) * STAGGER : index * STAGGER;

  return {
    ...base,
    opacity: isExit ? 1 : 0,
    animation: `${isExit ? "wt-slideUp" : "wt-slideDown"} ${DURATION}ms ${delay}ms ease-out forwards`,
  };
}

function renderSuffix(state: AnimState, phase: Phase) {
  if (state === "games") {
    return (
      <>
        {" "}
        {GAMES_CHARS.map((c, i) => (
          <span key={i} style={getCharStyle(phase, "slide", i, GAMES_CHARS.length)}>
            {c}
          </span>
        ))}
      </>
    );
  }

  if (state === "hangout") {
    return (
      <>
        {" "}
        {HANGOUT_CHUNKS.map((chunk, i) => (
          <span key={i} style={getChunkStyle(phase, i, HANGOUT_CHUNKS.length)}>
            {chunk}
          </span>
        ))}
      </>
    );
  }

  if (state === "movies") {
    return (
      <>
        {" "}
        {MOVIES_CHARS.map((c, i) => (
          <span key={i} style={getCharStyle(phase, "fade", i, MOVIES_CHARS.length)}>
            {c}
          </span>
        ))}
      </>
    );
  }

  return null;
}

export function AnimatedTitle() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [active, setActive] = useState<AnimState | null>(null);

  const doneRef = useRef(localStorage.getItem(STORAGE_KEY) === "true");
  const queueRef = useRef<AnimState[]>([...STATE_ORDER]);
  const idxRef = useRef(0);
  const loopRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = (fn: () => void, ms: number) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fn();
    }, ms);
  };

  const startNext = () => {
    if (idxRef.current >= queueRef.current.length) {
      loopRef.current++;
      if (loopRef.current >= MAX_LOOPS) {
        doneRef.current = true;
        localStorage.setItem(STORAGE_KEY, "true");
        return;
      }
      queueRef.current = shuffle(STATE_ORDER);
      idxRef.current = 0;
    }
    const next = queueRef.current[idxRef.current];
    idxRef.current++;
    schedule(() => {
      setActive(next);
      setPhase("entering");
    }, GAP);
  };

  // Phase transitions
  useEffect(() => {
    if (doneRef.current || !active) return;

    if (phase === "entering") {
      schedule(() => setPhase("displaying"), animTime(elems(active)) + 30);
    } else if (phase === "displaying") {
      schedule(() => setPhase("exiting"), randHold());
    } else if (phase === "exiting") {
      schedule(() => {
        setPhase("idle");
        setActive(null);
        startNext();
      }, animTime(elems(active)) + 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active]);

  // Kick off animation on mount
  useEffect(() => {
    if (doneRef.current) return;
    const first = queueRef.current[0];
    idxRef.current = 1;
    schedule(() => {
      setActive(first);
      setPhase("entering");
    }, INITIAL_DELAY);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <span className={styles.title}>
        {"When"}
        {!active ? "?" : renderSuffix(active, phase)}
      </span>
    </>
  );
}
