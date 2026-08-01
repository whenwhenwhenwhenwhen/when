export const DISCORD_REQUIRED_PERMISSIONS = [
  { bit: 1n << 10n, label: "View Channels" },
  { bit: 1n << 11n, label: "Send Messages" },
  { bit: 1n << 14n, label: "Embed Links" },
  { bit: 1n << 16n, label: "Read Message History" },
] as const;

export const DISCORD_REQUIRED_PERMISSION_BITS = DISCORD_REQUIRED_PERMISSIONS
  .reduce((permissions, permission) => permissions | permission.bit, 0n)
  .toString();

export function getMissingDiscordPermissions(
  grantedPermissions: string | null,
): string[] {
  let granted: bigint;
  try {
    granted = BigInt(grantedPermissions ?? "");
  } catch {
    return DISCORD_REQUIRED_PERMISSIONS.map((permission) => permission.label);
  }

  return DISCORD_REQUIRED_PERMISSIONS.filter(
    (permission) => (granted & permission.bit) !== permission.bit,
  ).map((permission) => permission.label);
}
