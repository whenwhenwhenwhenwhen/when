export const MOCK_ANONYMOUS_CLAIM = "d".repeat(64);

export function identityIdForClaim(claim: string): string {
  return `mock-anonymous:${claim}`;
}
