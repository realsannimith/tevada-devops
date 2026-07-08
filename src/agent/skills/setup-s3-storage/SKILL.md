---
name: setup-s3-storage
description: Connect an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO) using an on-screen form that collects the bucket, region, endpoint, and access keys with the secret masked — then store the credentials in a root-only file, verify access, and wire the bucket to an app's image/file uploads or to off-site backup copies. Use whenever the user wants S3, object storage, a place for uploaded images/files, or off-site backups.
---

# Connect S3-compatible storage (form-first)

Access keys must never be typed into chat. This job starts with the
`requestS3StorageSetup` tool — its form collects the keys with the secret
masked. Call it with `serverId` (the target server) plus `purpose`
`image-uploads` (an app stores uploaded files in the bucket; pass `appName` too)
or `backups` (database backups get copied there).

## 1. The tool has already stored the secret — you never see it

The tool writes the access keys **itself**, straight to a root-only env file on
the server (mode 600, root-owned), and returns:

- `envPath` — where it wrote them, e.g. `/etc/easyhost/s3-uploads.env` or
  `/etc/easyhost/s3-backups.env`.
- `values` — the **non-secret** fields only: `provider`, `bucket`, `region`,
  `endpoint`, and for image-uploads `publicRead` ('true'/'false').
- `secretStored: true` on success. If `secretStored` is false, the write failed
  (`error` says why — usually the server isn't connected or sudo isn't
  available); fix and call the tool again. If the user cancelled
  (`submitted:false`), ask how they'd like to proceed instead of guessing.

The env file it wrote looks like:

```
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_DEFAULT_REGION=<region or us-east-1>
S3_BUCKET=<bucket>
S3_ENDPOINT=<endpoint, empty for AWS>
```

You never receive the access keys, so you cannot echo them. To USE them,
`source` `envPath` inside a `runScript` (sudo) — never re-collect them, never put
them on a command line, and never repeat them in chat or your final summary.
When you need to copy the keys into an app's own env file (step 3a), do it by
sourcing `envPath` inside a `runScript` and writing the values from there, so the
secret stays off the command line and out of this conversation.

## 2. Install a client and verify access before wiring anything

Install the AWS CLI (`DEBIAN_FRONTEND=noninteractive apt-get install -y awscli`,
or the dnf/apk equivalent — it works with every S3-compatible provider). For
non-AWS providers append `--endpoint-url "$S3_ENDPOINT"` to every command.

Verify with a round-trip, sourcing the env file inside runScript (sudo) so the
keys stay off the command line:

```
set -a; . /etc/easyhost/s3-uploads.env; set +a
EP=${S3_ENDPOINT:+--endpoint-url $S3_ENDPOINT}
echo easyhost-test > /tmp/eh-s3-test
aws $EP s3 cp /tmp/eh-s3-test "s3://$S3_BUCKET/easyhost-connection-test"
aws $EP s3 rm "s3://$S3_BUCKET/easyhost-connection-test"
```

If this fails, diagnose before continuing: wrong endpoint/region (R2 wants
region `auto` + the account endpoint; B2 and Spaces need their regional
endpoint), or keys lacking write permission. Fix with the user — do not wire a
bucket you couldn't write to.

## 3a. Purpose = image-uploads: wire the app to the bucket

Find how the app is configured (you likely deployed it — check its compose file
/ env file). Add the standard variables to the app's env file (mode 600):
`S3_BUCKET`, `S3_REGION` (or `AWS_DEFAULT_REGION`), `S3_ENDPOINT`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — matching whatever names the app's
docs/code actually read (inspect its config or README; many apps use
`S3_ACCESS_KEY`/`S3_SECRET_KEY` style names). Restart the app (`docker compose up -d`)
and verify it came back healthy.

Then handle visibility per `publicRead`:

- **'true'** (images served to visitors): public access differs per provider —
  AWS: allow public read via bucket policy on the bucket (or keep the bucket
  private and let the app generate presigned URLs if it supports them);
  R2: enable the bucket's public development URL or attach a custom domain;
  Spaces/B2: enable public/website access in their console. If a console step is
  needed, give the user exact click-path instructions.
- **'false'**: keep the bucket private and confirm the app serves files itself
  or uses presigned URLs.

If the browser uploads directly to the bucket (not through the app's backend),
set CORS on the bucket (`aws s3api put-bucket-cors`) allowing the app's domain
with PUT/POST/GET.

Verify end-to-end: upload an image through the app (or curl its upload endpoint)
and confirm the object appears (`aws $EP s3 ls "s3://$S3_BUCKET/" --recursive | tail`)
and — when public — that its URL loads.

## 3b. Purpose = backups: add the upload to the backup job

Used from **setup-database-backup** § 5. Append to
`/usr/local/bin/easyhost-backup-db.sh`, after the dump succeeds:

```
set -a; . /etc/easyhost/s3-backups.env; set +a
EP=${S3_ENDPOINT:+--endpoint-url $S3_ENDPOINT}
aws $EP s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/db-backups/$(basename "$BACKUP_FILE")" \
  || echo "WARN: off-site upload failed" >&2
```

The `|| echo` matters: an upload failure must not abort the local backup or its
retention cleanup. Recommend the user set a lifecycle/retention rule on the
bucket in their provider's console (expire objects under `db-backups/` after
~30–90 days) instead of scripting remote deletion — it's one console setting and
can't mass-delete on a bug. Run the backup script once and confirm the object
landed in the bucket.

## 4. Report

Tell the user in plain language: which bucket is connected and for what, that
the connection was tested with a real upload, where the credentials live
(root-only file on the server — the secret won't be shown again), and what to
check in their provider's console (public access / lifecycle rule) if a step
needs their account.
