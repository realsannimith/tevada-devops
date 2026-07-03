/**
 * A small seatbelt against catastrophic commands. This is NOT a security
 * boundary (an adversarial model could trivially evade it) — it exists to catch
 * obviously destructive commands even in full-auto mode and force a human
 * confirmation. Keep the list short and high-signal.
 */
const CATASTROPHIC: { pattern: RegExp; reason: string }[] = [
  {
    // rm -rf / (or /* , with any flag ordering)
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*\/(\s|\*|$)/,
    reason: 'Recursive delete targeting the filesystem root (rm -rf /).',
  },
  {
    pattern: /\bmkfs(\.\w+)?\s+\/dev\//,
    reason: 'Formatting a block device (mkfs on /dev/*).',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/,
    reason: 'Writing raw data directly to a disk device (dd of=/dev/*).',
  },
  {
    // classic fork bomb :(){ :|:& };:
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Fork bomb.',
  },
  {
    pattern: /\bchmod\s+-R\s+0?777\s+\/(\s|$)/,
    reason: 'Recursively making the entire filesystem world-writable.',
  },
  {
    pattern: /\b(shutdown|halt|poweroff|reboot|init\s+0)\b/,
    reason: 'Powering off or rebooting the server.',
  },
  {
    pattern: />\s*\/dev\/(sd|nvme|vd|hd)[a-z]/,
    reason: 'Redirecting output onto a raw disk device.',
  },
];

export function isCatastrophic(command: string): {
  blocked: boolean;
  reason?: string;
} {
  for (const { pattern, reason } of CATASTROPHIC) {
    if (pattern.test(command)) return { blocked: true, reason };
  }
  return { blocked: false };
}
