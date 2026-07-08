/**
 * A small seatbelt against catastrophic commands. This is NOT a security
 * boundary (an adversarial model could trivially evade it) — it exists to catch
 * obviously destructive commands even in full-auto mode and force a human
 * confirmation. Keep the list short and high-signal.
 *
 * Explicitly out of scope: obfuscated forms (command substitution, base64
 * pipelines, `sh -c` wrappers, variable indirection). The seatbelt matches the
 * plain literal command text only; defeating it is trivial and not the point.
 * A match forces a confirmation, it does not hard-block — so the bar for adding
 * a pattern is "an honest operator would want to be asked", not zero false
 * positives.
 */
const CATASTROPHIC: { pattern: RegExp; reason: string }[] = [
  {
    // rm -rf / (or /* , with any short-flag ordering)
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*\/(\s|\*|$)/,
    reason: 'Recursive delete targeting the filesystem root (rm -rf /).',
  },
  {
    // Same, but with GNU long flags only (rm --recursive --force /), which the
    // short-flag pattern above doesn't match. The target must be exactly `/`.
    pattern: /\brm\s+(?:-{1,2}[a-zA-Z][\w-]*\s+)+\/(\s|\*|$)/,
    reason: 'Recursive delete targeting the filesystem root (rm --recursive --force /).',
  },
  {
    // A whole-root sweep: find / … -delete (or -exec rm).
    pattern: /\bfind\s+\/\s+[^\n]*(-delete\b|-exec\s+rm\b)/,
    reason: 'Deleting files across the entire filesystem (find / -delete).',
  },
  {
    // Allow flags between mkfs and the device (mkfs.ext4 -F /dev/sda).
    pattern: /\bmkfs(\.\w+)?\b[^\n]*\/dev\//,
    reason: 'Formatting a block device (mkfs on /dev/*).',
  },
  {
    pattern: /\b(wipefs|shred)\b[^\n]*\/dev\/(sd|nvme|vd|hd|mmcblk|mapper|disk)/,
    reason: 'Destroying a disk/partition (wipefs/shred on /dev/*).',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk|mapper|disk)/,
    reason: 'Writing raw data directly to a disk device (dd of=/dev/*).',
  },
  {
    // classic fork bomb :(){ :|:& };:
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Fork bomb.',
  },
  {
    pattern: /\bchmod\s+-R[a-zA-Z]*\s+(?:\S+\s+)*\/(\s|$)/,
    reason: 'Recursively changing permissions of the entire filesystem (chmod -R /).',
  },
  {
    pattern: /\bchown\s+-R[a-zA-Z]*\s+[^\n]*\s\/(\s|$)/,
    reason: 'Recursively changing ownership of the entire filesystem (chown -R … /).',
  },
  {
    pattern: />>?\s*\/etc\/(passwd|shadow|sudoers|fstab)\b/,
    reason: 'Overwriting a critical system file (/etc/passwd, shadow, sudoers, fstab).',
  },
  {
    pattern: /\bufw\s+disable\b|\biptables\s+(-F|--flush)\b|\bnft\s+flush\s+ruleset\b/,
    reason: 'Disabling the firewall / flushing all firewall rules.',
  },
  {
    pattern: /\bdocker\s+system\s+prune\b[^\n]*--volumes\b/,
    reason: 'Pruning Docker including named volumes (deletes container data).',
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
