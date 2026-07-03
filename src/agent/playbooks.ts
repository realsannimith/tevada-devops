/**
 * Wizards expressed as data, not code. Each playbook declares its input fields and
 * a buildPrompt() that turns the user's answers into a detailed instruction for the
 * agent. A wizard run is therefore just a normal agent run seeded with buildPrompt()
 * output — no bespoke execution logic.
 */
import { PlaybookInput, PlaybookMeta } from '../shared/ipc-types';

export type Playbook = PlaybookMeta & {
  buildPrompt: (values: Record<string, string>, serverName: string) => string;
};

const hostWebsiteInputs: PlaybookInput[] = [
  {
    key: 'domain',
    label: 'Domain name',
    type: 'text',
    placeholder: 'example.com (or leave blank for IP-only)',
  },
  {
    key: 'stack',
    label: 'Site type',
    type: 'select',
    options: ['Static HTML', 'Node.js app', 'Reverse proxy to a port'],
    required: true,
  },
  {
    key: 'source',
    label: 'Source',
    type: 'text',
    placeholder: 'git URL, local path note, or upstream port (e.g. 3000)',
  },
  {
    key: 'tls',
    label: 'Enable HTTPS (Let’s Encrypt)',
    type: 'select',
    options: ['Yes', 'No'],
    required: true,
  },
];

const backupsInputs: PlaybookInput[] = [
  {
    key: 'target',
    label: 'What to back up',
    type: 'select',
    options: ['Folders', 'PostgreSQL database', 'MySQL/MariaDB database'],
    required: true,
  },
  {
    key: 'paths',
    label: 'Paths / database name',
    type: 'text',
    placeholder: '/var/www, /etc/nginx  — or  mydb',
    required: true,
  },
  {
    key: 'schedule',
    label: 'Schedule',
    type: 'select',
    options: ['Hourly', 'Daily (2am)', 'Weekly (Sun 2am)'],
    required: true,
  },
  {
    key: 'destination',
    label: 'Destination',
    type: 'text',
    placeholder: '/var/backups/easyhost  — or  user@host:/backups (rsync)',
    required: true,
  },
];

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'host-website',
    title: 'Host a website / app',
    description:
      'Install and configure a web server, deploy your site, and optionally set up HTTPS.',
    inputs: hostWebsiteInputs,
    buildPrompt: (v, serverName) => {
      const tls = v.tls === 'Yes';
      const domain = v.domain?.trim();
      return [
        `You are setting up web hosting on the server "${serverName}".`,
        `First call listServers and connect to it.`,
        ``,
        `Requirements:`,
        `- Site type: ${v.stack}`,
        `- Source: ${v.source || '(none specified — create a simple hello-world page)'}`,
        domain ? `- Domain: ${domain}` : `- No domain (serve on the server's IP).`,
        `- HTTPS: ${tls ? 'yes' : 'no'}`,
        ``,
        `Steps to perform, verifying the exit code after each command:`,
        `1. Detect the OS/package manager (cat /etc/os-release).`,
        `2. Install nginx (use DEBIAN_FRONTEND=noninteractive apt-get -y, or dnf/yum as appropriate).`,
        v.stack === 'Node.js app'
          ? `3. Install Node.js and a process manager (pm2 or a systemd unit); deploy and start the app; reverse-proxy nginx to it.`
          : v.stack === 'Reverse proxy to a port'
            ? `3. Configure nginx as a reverse proxy to the upstream: ${v.source || 'the specified port'}.`
            : `3. Deploy the static site into the web root (create a hello-world index.html if no source was given).`,
        `4. Write the nginx server block${domain ? ` for ${domain}` : ''}, enable it, test with 'nginx -t', and reload.`,
        `5. Open the firewall for HTTP${tls ? '/HTTPS' : ''} if ufw/firewalld is active.`,
        tls && domain
          ? `6. Install certbot and obtain a certificate non-interactively: certbot --nginx -d ${domain} --non-interactive --agree-tos -m admin@${domain} --redirect. If DNS is not yet pointing here, note that and skip the cert.`
          : tls
            ? `6. HTTPS was requested but no domain was given — explain that Let's Encrypt needs a domain and skip it.`
            : ``,
        `7. Verify the site responds (curl -I localhost) and report the final URL and a summary of what you did.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    id: 'setup-backups',
    title: 'Set up automated backups',
    description:
      'Create a backup script and schedule it with cron, then run it once to verify.',
    inputs: backupsInputs,
    buildPrompt: (v, serverName) => {
      const isRsync = /@|:/.test(v.destination || '');
      return [
        `You are configuring automated backups on the server "${serverName}".`,
        `First call listServers and connect to it.`,
        ``,
        `Requirements:`,
        `- Back up: ${v.target}`,
        `- Source (paths or database): ${v.paths}`,
        `- Schedule: ${v.schedule}`,
        `- Destination: ${v.destination} ${isRsync ? '(remote rsync target)' : '(local directory)'}`,
        ``,
        `Steps, verifying exit codes:`,
        `1. Ensure required tools exist (tar/gzip, and pg_dump or mysqldump if a database; rsync if the destination is remote).`,
        `2. Create the destination directory if local.`,
        `3. Write an idempotent backup script to /usr/local/bin/easyhost-backup.sh that:`,
        v.target === 'PostgreSQL database'
          ? `   - runs pg_dump of "${v.paths}" gzipped to a timestamped file,`
          : v.target.startsWith('MySQL')
            ? `   - runs mysqldump of "${v.paths}" gzipped to a timestamped file,`
            : `   - tars+gzips the paths "${v.paths}" to a timestamped archive,`,
        isRsync
          ? `   - then rsyncs the archive to ${v.destination},`
          : `   - stores the archive under ${v.destination},`,
        `   - and prunes archives older than 14 days.`,
        `4. chmod +x the script.`,
        `5. Install a cron entry matching the schedule "${v.schedule}" (write to /etc/cron.d/easyhost-backup).`,
        `6. Run the script once now to verify it succeeds, list the resulting backup file, and report a summary.`,
      ].join('\n');
    },
  },
];

export function playbookMeta(): PlaybookMeta[] {
  return PLAYBOOKS.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    inputs: p.inputs,
  }));
}

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}
