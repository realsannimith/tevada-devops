import { describe, expect, it } from 'vitest';
import { parseArtifacts } from './artifacts';

const SEP = '===EH-ART===';

const SAMPLE = [
  // docker ps
  [
    'myapp-db\tpostgres:16\tUp 3 days\t127.0.0.1:5432->5432/tcp',
    'cache\tredis:7\tExited (0) 2 hours ago\t',
    'web\tnginx:alpine\tUp 5 minutes\t0.0.0.0:8080->80/tcp, [::]:8080->80/tcp',
    'app-mysql\tmysql:8\tUp 1 day\t0.0.0.0:3306->3306/tcp',
  ].join('\n'),
  SEP,
  // nginx sites
  [
    '@@FILE /etc/nginx/sites-enabled/example.com',
    'listen 80;',
    'listen 443 ssl;',
    'server_name example.com www.example.com;',
    'root /var/www/example;',
    '@@FILE /etc/nginx/sites-enabled/api',
    'listen 80;',
    'server_name _;',
    'proxy_pass http://127.0.0.1:3000;',
  ].join('\n'),
  SEP,
  // systemd services
  [
    'nginx.service loaded active running A high performance web server',
    'postgresql.service loaded active running PostgreSQL RDBMS',
    'redis-server.service loaded inactive dead Advanced key-value store',
  ].join('\n'),
  SEP,
  // ss -tlnp (header already stripped)
  [
    'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=800,fd=6))',
    'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=900,fd=5))',
  ].join('\n'),
  SEP,
  // cron
  [
    '@@FILE /etc/cron.d/easyhost-backup',
    '0 2 * * * root /usr/local/bin/easyhost-backup.sh >> /var/log/backup.log',
    '@@FILE crontab',
    '*/5 * * * * /usr/bin/uptime-check.sh',
  ].join('\n'),
].join('\n');

describe('parseArtifacts', () => {
  const artifacts = parseArtifacts(SAMPLE);

  it('classifies docker containers, flagging database images', () => {
    const db = artifacts.find((a) => a.name === 'myapp-db');
    expect(db).toMatchObject({
      kind: 'database',
      engine: 'postgresql',
      status: 'running',
      detail: 'postgres:16',
      ports: [5432],
    });
    const cache = artifacts.find((a) => a.name === 'cache');
    expect(cache).toMatchObject({ kind: 'database', status: 'stopped' });
    const web = artifacts.find((a) => a.name === 'web' && a.kind === 'container');
    expect(web).toMatchObject({ engine: 'web', ports: [8080] });
  });

  it('flags remote-accessible ports (bound to 0.0.0.0/:: rather than loopback)', () => {
    const db = artifacts.find((a) => a.name === 'myapp-db');
    expect(db).toMatchObject({ remoteAccessible: false });
    const mysql = artifacts.find((a) => a.name === 'app-mysql');
    expect(mysql).toMatchObject({
      kind: 'database',
      engine: 'mysql',
      ports: [3306],
      remoteAccessible: true,
    });
    const web = artifacts.find((a) => a.name === 'web' && a.kind === 'container');
    expect(web).toMatchObject({ remoteAccessible: true });
  });

  it('parses nginx sites with names, ports and doc root / proxy target', () => {
    const site = artifacts.find((a) => a.name === 'example.com');
    expect(site).toMatchObject({
      kind: 'website',
      status: 'running',
      detail: '/var/www/example',
      ports: [80, 443],
    });
    const api = artifacts.find((a) => a.id === 'website:/etc/nginx/sites-enabled/api');
    expect(api).toMatchObject({
      name: 'api', // falls back to filename when server_name is "_"
      detail: 'proxy → http://127.0.0.1:3000',
    });
  });

  it('maps systemd services and attaches listening ports', () => {
    const pg = artifacts.find((a) => a.id === 'service:postgresql');
    expect(pg).toMatchObject({
      kind: 'database',
      engine: 'postgresql',
      status: 'running',
      ports: [5432],
      remoteAccessible: false, // ss shows it bound to 127.0.0.1
    });
    const redis = artifacts.find((a) => a.id === 'service:redis-server');
    expect(redis).toMatchObject({ kind: 'database', status: 'stopped' });
    const nginx = artifacts.find((a) => a.id === 'service:nginx');
    expect(nginx).toMatchObject({ kind: 'service', ports: [80] });
  });

  it('extracts cron backup jobs but ignores unrelated cron lines', () => {
    const backup = artifacts.find((a) => a.kind === 'backup');
    expect(backup).toMatchObject({
      name: 'easyhost-backup.sh',
      status: 'scheduled',
    });
    expect(backup?.detail).toContain('/usr/local/bin/easyhost-backup.sh');
    expect(backup?.meta).toContain('0 2 * * *');
    expect(artifacts.filter((a) => a.kind === 'backup')).toHaveLength(1);
  });

  it('returns an empty inventory for empty probe output', () => {
    expect(parseArtifacts('')).toEqual([]);
  });
});
