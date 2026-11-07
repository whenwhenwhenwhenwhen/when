export const NOMINATION_HOVER_STYLES = [
  "roster",
  "board",
  "ribbon",
  "inspector",
] as const;

export type NominationHoverStyle = typeof NOMINATION_HOVER_STYLES[number];
export const DEFAULT_NOMINATION_HOVER_STYLE = "board";

// Keep historical values valid in stored profiles and requests from older clients.
// Every profile now uses the status popover.
export function normalizeNominationHoverStyle(_style?: string): "board" {
  return DEFAULT_NOMINATION_HOVER_STYLE;
}

export const DEFAULT_NOMINATION_HOVER_DISTANCE_PX = 50;

export function isValidNominationHoverDistance(distancePx: number): boolean {
  return Number.isSafeInteger(distancePx) && distancePx >= 0;
}

// The largest delay supported by browser timers.
export const MAX_NOMINATION_HOVER_DELAY_MS = 2_147_483_647;

export function isValidNominationHoverDelay(delayMs: number): boolean {
  return Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_NOMINATION_HOVER_DELAY_MS;
}
