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

const databaseInputs: PlaybookInput[] = [
  {
    key: 'engine',
    label: 'Database engine',
    type: 'select',
    options: ['PostgreSQL', 'MySQL/MariaDB', 'Redis', 'MongoDB'],
    required: true,
  },
  {
    key: 'method',
    label: 'Install method',
    type: 'select',
    options: ['Docker container (recommended)', 'Native install (system packages)'],
    required: true,
  },
  {
    key: 'dbName',
    label: 'Database name',
    type: 'text',
    placeholder: 'myapp (ignored for Redis)',
  },
  {
    key: 'dbUser',
    label: 'Database user',
    type: 'text',
    placeholder: 'myapp_user (ignored for Redis)',
  },
  {
    key: 'access',
    label: 'Who can connect',
    type: 'select',
    options: [
      'Local only — apps on this server (recommended)',
      'Remote — open the port to the internet',
    ],
    required: true,
  },
];

/** Internal engine key used by ServerArtifact.engine / DatabaseCredentialMeta.engine. */
type DbEngineKey = 'postgresql' | 'mysql' | 'redis' | 'mongodb';

const ENGINE_KEY: Record<string, DbEngineKey> = {
  PostgreSQL: 'postgresql',
  'MySQL/MariaDB': 'mysql',
  Redis: 'redis',
  MongoDB: 'mongodb',
};

const ENGINE_PORT: Record<DbEngineKey, number> = {
  postgresql: 5432,
  mysql: 3306,
  redis: 6379,
  mongodb: 27017,
};

export type DatabaseWizardTarget = {
  engine: DbEngineKey;
  port: number;
  database?: string;
  username?: string;
  /** Whether the wizard opened this database up to the internet. */
  remote: boolean;
};

/**
 * Deterministic connection shell for a "Set up a database" wizard run,
 * derived purely from the answers the user picked in the form — everything
 * except the password, which only exists once the agent calls
 * generatePassword mid-run. main/ipc.ts uses this to auto-save the credential
 * the moment a password is generated, without depending on the model
 * remembering to call the saveDatabaseCredential tool itself.
 */
export function databaseWizardTarget(
  values: Record<string, string>,
): DatabaseWizardTarget {
  const engine = ENGINE_KEY[values.engine ?? ''] ?? 'postgresql';
  const isRedis = engine === 'redis';
  return {
    engine,
    port: ENGINE_PORT[engine],
    database: isRedis ? undefined : values.dbName?.trim() || 'appdb',
    username: isRedis ? undefined : values.dbUser?.trim() || 'appuser',
    remote: (values.access ?? '').startsWith('Remote'),
  };
}

const remoteAccessInputs: PlaybookInput[] = [
  {
    key: 'engine',
    label: 'Database engine',
    type: 'select',
    options: ['PostgreSQL', 'MySQL/MariaDB', 'Redis', 'MongoDB'],
    required: true,
  },
  {
    key: 'port',
    label: 'Port it runs on',
    type: 'text',
    placeholder: 'e.g. 5432',
    required: true,
  },
  {
    key: 'identifier',
    label: 'Container or service name',
    type: 'text',
    placeholder: 'optional — leave blank and the agent will find it',
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
    id: 'setup-database',
    title: 'Set up a database',
    description:
      'Install PostgreSQL, MySQL, Redis or MongoDB — secured with a strong password and ready to use in minutes.',
    inputs: databaseInputs,
    buildPrompt: (v, serverName) => {
      const engine = v.engine || 'PostgreSQL';
      const docker = (v.method || '').startsWith('Docker');
      const target = databaseWizardTarget(v);
      const { port, database: dbName, username: dbUser, remote } = target;
      const isRedis = target.engine === 'redis';
      return [
        `You are setting up a ${engine} database on the server "${serverName}".`,
        `First call listServers and connect to it.`,
        ``,
        `Requirements:`,
        `- Engine: ${engine} (default port ${port})`,
        `- Install method: ${docker ? 'Docker container' : 'native system packages'}`,
        isRedis
          ? `- Redis needs no database/user — secure it with a required password instead.`
          : `- Database name: ${dbName}, user: ${dbUser}`,
        remote
          ? `- Remote access requested: the port must accept connections from the internet.`
          : `- Local only: the database must listen on 127.0.0.1 (or the Docker port must be published on 127.0.0.1 only). Do NOT expose it publicly.`,
        ``,
        `Rules:`,
        `- Generate every password with the generatePassword tool — never invent one.`,
        `- Verify exit codes after each step; diagnose and fix failures before moving on.`,
        `- Once the database is up and you've verified it works, call saveDatabaseCredential with the exact serverId (from listServers), engine "${target.engine}", host (${remote ? "this server's host from listServers" : "'127.0.0.1'"}), port ${port}${isRedis ? '' : `, database "${dbName}", username "${dbUser}"`}, and the exact password — this lets the user retrieve the credentials later from the Artifacts tab, so do it in ADDITION to reporting them in your final summary, not instead. (The app also auto-saves the first password you generate as a safety net, but call the tool yourself so the details are exact.)`,
        ``,
        `Steps:`,
        docker
          ? [
              `1. Check if Docker is installed (docker --version). If not, install it from the distro packages or the official get.docker.com script, then 'systemctl enable --now docker'.`,
              `2. If a container for this engine already exists, report that and stop rather than clobbering it.`,
              `3. Run the current official image (postgres / mariadb / redis / mongo) with: a named volume for data, --restart unless-stopped, the generated password via the image's env vars${isRedis ? " (for Redis pass '--requirepass <password>' as the command)" : ` and create database "${dbName}" + user "${dbUser}"`}, and the port published as ${remote ? `0.0.0.0:${port}:${port}` : `127.0.0.1:${port}:${port}`}.`,
              `4. Wait until the container is ready (poll with docker exec + the engine's client, e.g. pg_isready / mysqladmin ping / redis-cli ping / mongosh --eval), then run a real test query as the new user.`,
            ].join('\n')
          : [
              `1. Detect the OS and install the server package (postgresql / mariadb-server / redis-server / MongoDB from its official repo — MongoDB is not in most distro repos).`,
              `2. systemctl enable --now the service and confirm it is active.`,
              isRedis
                ? `3. Set 'requirepass' to the generated password in the Redis config (back it up first) and restart Redis.`
                : `3. Create the database "${dbName}" and user "${dbUser}" with the generated password, granting that user full rights on that database only${engine === 'MongoDB' ? '; also create a root user and enable authorization in mongod.conf' : ''}.`,
              remote
                ? `4. Configure the engine to listen on all interfaces (listen_addresses / bind-address / bind — back up configs first, restart, verify with ss -tlnp), require password auth for remote connections${engine === 'PostgreSQL' ? ' (add a scram-sha-256 pg_hba.conf entry)' : ''}, and open port ${port} in ufw/firewalld if active.`
                : `4. Confirm the engine only listens on 127.0.0.1 (ss -tlnp) — tighten the config if it does not.`,
              `5. Verify by running a real test query over a fresh connection as the new user.`,
            ].join('\n'),
        ``,
        `Finish with a plain-language summary for a non-expert: connection details (host, port${isRedis ? '' : ', database, user'}, password), a ready-to-paste connection string (e.g. postgres://user:pass@host:${port}/${dbName}), one example command to connect, and — if remote access was enabled — a clear warning that the database is reachable from the internet and is protected only by its password.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    id: 'enable-db-remote-access',
    title: 'Allow remote database access',
    description:
      'Open up an existing database to connections from outside this server — same username and password, just reachable remotely.',
    inputs: remoteAccessInputs,
    buildPrompt: (v, serverName) => {
      const engineLabel = v.engine || 'PostgreSQL';
      const defaultTarget = databaseWizardTarget(v);
      const port = Number(v.port) || defaultTarget.port;
      const identifier = v.identifier?.trim();
      return [
        `You are enabling REMOTE access to an existing ${engineLabel} database on the server "${serverName}", currently listening on port ${port}.`,
        `First call listServers and connect to it.`,
        ``,
        `Find it:`,
        identifier
          ? `- It should be the container or service named "${identifier}" — confirm with 'docker ps' / 'systemctl status ${identifier}'.`
          : `- Find it yourself: check 'docker ps' for a container publishing port ${port}, or 'systemctl list-units' + 'ss -tlnp' for a native install listening on that port.`,
        ``,
        `Critical rule: do NOT change, reset, or regenerate the existing password or user. This is a networking-only change — remote clients must be able to connect with the exact same credentials that already work locally.`,
        ``,
        `Steps, verifying each before moving on:`,
        `1. If it's a Docker container: run 'docker inspect' first and note the image, env vars, volumes, and restart policy. Stop and remove the container, then recreate it identically except publish the port as 0.0.0.0:${port}:${port} instead of 127.0.0.1:${port}:${port}. Reuse the same named volume so no data is lost, then confirm a local test query still works with the existing credentials.`,
        `2. If it's a native install: back up its config first, then change listen_addresses / bind-address / bind to accept connections on all interfaces, and add a remote authentication rule for the existing user (e.g. a scram-sha-256 pg_hba.conf entry for PostgreSQL, a '%'-host grant for MySQL/MariaDB, keep 'requirepass' but set 'protected-mode no' for Redis, or 'bindIp: 0.0.0.0' for MongoDB). Restart the service.`,
        `3. Open port ${port} in the firewall (ufw/firewalld) if one is active — that port only.`,
        `4. Verify with 'ss -tlnp' that the process is now listening on 0.0.0.0 (or ::) on port ${port}, not just 127.0.0.1.`,
        ``,
        `Finish with a plain-language summary: confirm the SAME username/password as before still works, now remotely; give this server's public host/IP and port ${port} for connecting; and a clear, explicit warning that this database is now reachable from the internet and protected only by its existing password.`,
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
