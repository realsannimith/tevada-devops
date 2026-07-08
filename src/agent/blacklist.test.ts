import { describe, it, expect } from 'vitest';
import { isCatastrophic } from './blacklist';

/**
 * The seatbelt is the last line of defense between a full-auto agent and a
 * destructive command (tools.ts gates confirmation on isCatastrophic even when
 * approval mode is off). These tests pin the high-signal patterns so a refactor
 * can't silently let `rm -rf /` through un-confirmed.
 */
describe('isCatastrophic — blocks catastrophic commands', () => {
  const blocked = [
    // whole-filesystem deletes, short and long flags
    'rm -rf /',
    'rm -fr /',
    'rm -rf /*',
    'sudo rm -rf --no-preserve-root /',
    'rm --recursive --force /',
    'rm --force --recursive /*',
    'find / -name "*.log" -delete',
    'find / -type f -exec rm {} \\;',
    // disk destruction
    'mkfs.ext4 /dev/sda1',
    'mkfs.ext4 -F /dev/sda1',
    'wipefs -a /dev/nvme0n1',
    'shred -n 3 /dev/sdb',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'dd if=/dev/zero of=/dev/mapper/vg-root',
    'echo x > /dev/sda',
    // fork bomb
    ':(){ :|:& };:',
    // filesystem-wide perms/ownership
    'chmod -R 777 /',
    'chmod -R 755 /',
    'chown -R nobody /',
    // critical system files
    'echo "" > /etc/passwd',
    'cat evil >> /etc/shadow',
    // firewall / power
    'ufw disable',
    'iptables -F',
    'nft flush ruleset',
    'shutdown -h now',
    'reboot',
    // docker data loss
    'docker system prune -af --volumes',
  ];

  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      const res = isCatastrophic(cmd);
      expect(res.blocked).toBe(true);
      expect(typeof res.reason).toBe('string');
    });
  }
});

describe('isCatastrophic — allows routine DevOps commands', () => {
  const allowed = [
    'rm -rf /tmp/build',
    'rm -rf ./node_modules',
    'rm -rf /var/www/old-site/',
    'find /var/log -name "*.gz" -delete',
    'chmod -R 755 /var/www/html',
    'chown -R www-data:www-data /var/www',
    'apt-get -y install nginx',
    'docker system prune -f',
    'systemctl restart nginx',
    'dd if=/dev/zero of=/swapfile bs=1M count=1024',
    'echo "server { }" > /etc/nginx/sites-available/app',
    'ufw allow 443/tcp',
    'mkfs.ext4 /mnt/data/image.img',
  ];

  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      expect(isCatastrophic(cmd).blocked).toBe(false);
    });
  }
});
