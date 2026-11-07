export const NOMINATION_HOVER_STYLES = [
  "roster",
  "board",
  "ribbon",
  "inspector",
] as const;

export type NominationHoverStyle = typeof NOMINATION_HOVER_STYLES[number];
export const DEFAULT_NOMINATION_HOVER_STYLE: NominationHoverStyle = "roster";

export function normalizeNominationHoverStyle(style?: string): NominationHoverStyle {
  return NOMINATION_HOVER_STYLES.find((candidate) => candidate === style) ?? DEFAULT_NOMINATION_HOVER_STYLE;
}

// The largest delay supported by browser timers.
export const MAX_NOMINATION_HOVER_DELAY_MS = 2_147_483_647;

export function isValidNominationHoverDelay(delayMs: number): boolean {
  return Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_NOMINATION_HOVER_DELAY_MS;
}
