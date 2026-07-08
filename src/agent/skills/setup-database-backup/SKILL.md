---
name: setup-database-backup
description: Schedule automatic database backups using an on-screen form the user fills in (engine, database, schedule, retention, optional off-site S3 copy), then install a backup script + cron job from their answers. Use whenever the user wants to back up, protect, or schedule dumps of a database (PostgreSQL, MySQL/MariaDB, MongoDB, Redis). This is the form-first entry point; it hands off-site copies to setup-s3-storage.
---

# Set up database backups (form-first)

Your users are not sysadmins — collecting the engine, schedule and retention
through an on-screen form is far easier for them than answering questions in
chat. So this job starts with the `requestDatabaseBackupSetup` tool, not with
questions.

## 1. Find the database FIRST — that's your job, not the user's

The user should never have to identify their own database engine. Detect it
before showing the form:

```
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'   # containerised databases
ss -tlnp                                                   # native ones (5432/3306/27017/6379)
```

Note whether the database runs **in Docker** (remember the container name — every
dump command below changes) or natively. Pass the engine as `detectedEngine` so
the form is pre-selected; pass `suggestedDatabase` if you know the app's database
name. If several engines run on the server, ask the user which one first (one
short question), then open the form.

## 2. Open the form

Call `requestDatabaseBackupSetup`. It returns `values`: `engine`, `database`
(empty = all databases), `schedule` ('Every hour' | 'Every day (03:00)' |
'Every week (Sun 03:00)'), `retentionDays`, `offsite` ('true'/'false'). If the
user cancelled (`submitted:false`), ask how they'd like to proceed instead of
guessing.

## 3. Install the backup script

Write `/usr/local/bin/easyhost-backup-db.sh` with `writeRemoteFile` (sudo=true,
mode 700). Backups go to `/var/backups/easyhost/<engine>/` (mkdir -p, chmod 700),
named `<db-or-all>-YYYYmmdd-HHMMSS.<ext>.gz`.

Credentials must NOT appear in the script, the cron line, or shell history. Put
them in `/etc/easyhost/backup-db.env` (writeRemoteFile, sudo=true, mode 600) and
have the script `source` it. Reuse the credentials you saved earlier with
saveDatabaseCredential where possible; ask the user only if none exist.

Per engine (left: native; right: dockerised — `docker exec <container> …`):

- **postgresql**: all → `pg_dumpall -U postgres`; one → `pg_dump -U postgres <db>`.
  Native: run as the postgres user (`sudo -u postgres`); Docker: `docker exec <c> pg_dumpall -U postgres`.
- **mysql / mariadb**: all → `mysqldump --all-databases --single-transaction`;
  one → `mysqldump --single-transaction <db>`. Pass the password via
  `--defaults-extra-file` (a mode-600 file with `[client]\npassword=…`), never `-p<pass>`.
- **mongodb**: `mongodump --archive` (add `--db <db>` for one). Docker: `docker exec <c> mongodump --archive`.
- **redis**: trigger `redis-cli BGSAVE`, wait for `redis-cli LASTSAVE` to change,
  then copy `dump.rdb` (Docker: `docker cp <c>:/data/dump.rdb …`). The `database`
  field is ignored.

Pipe dumps through `gzip`. End the script with retention cleanup:
`find /var/backups/easyhost/<engine> -name '*.gz' -mtime +<retentionDays> -delete`
(and `*.rdb.gz` for Redis). Fail loudly: the script already runs under
`set -euo pipefail` if you use runScript to test it; keep `set -euo pipefail` at
the top of the installed script too.

## 4. Schedule it with cron

Write `/etc/cron.d/easyhost-backup-db` (sudo=true, mode 644), mapping the form
choice:

- 'Every hour' → `0 * * * *`
- 'Every day (03:00)' → `0 3 * * *`
- 'Every week (Sun 03:00)' → `0 3 * * 0`

Line format: `<cron> root /usr/local/bin/easyhost-backup-db.sh >> /var/log/easyhost/backup-db.log 2>&1`
(mkdir -p /var/log/easyhost first). Ensure cron is running (`systemctl is-active cron || systemctl is-active crond`).

## 5. Off-site copy (when `offsite` is true)

Call `requestS3StorageSetup` with purpose `backups`, then load **setup-s3-storage**
and follow it. Its final step appends the upload (`aws s3 cp` with the root-only
env file) to the backup script — the local backup must still succeed even if the
upload fails (upload errors log a warning, they don't abort retention cleanup).

## 6. Verify and report — a backup that was never restored is not a backup

Run the script once now (`sudo /usr/local/bin/easyhost-backup-db.sh`) and verify:

```
ls -lh /var/backups/easyhost/<engine>/        # file exists and is not ~0 bytes
gunzip -t <newest-file>                        # archive is intact
```

For SQL dumps also spot-check content (`zcat <file> | head -20` shows CREATE/INSERT
statements). Then tell the user in plain language: what gets backed up, on what
schedule, where the files live, how long they're kept, whether an off-site copy
is on, and the one-line restore command for their engine (e.g.
`zcat <file> | psql -U postgres`) so they know recovery is real.
