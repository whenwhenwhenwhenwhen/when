// The largest delay supported by browser timers.
export const MAX_NOMINATION_HOVER_DELAY_MS = 2_147_483_647;

export function isValidNominationHoverDelay(delayMs: number): boolean {
  return Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_NOMINATION_HOVER_DELAY_MS;
}
