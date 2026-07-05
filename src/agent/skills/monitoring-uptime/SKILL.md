---
name: monitoring-uptime
description: Set up uptime monitoring and alerting with Uptime Kuma (Docker), plus lightweight disk-space alerts. Use when the user wants to monitor a site or server, get alerted when something goes down, set up health checks or a status page.
---

# Monitoring & uptime alerts

EASY-HOST's Monitoring view already shows live CPU / memory / disk while the app
is open. What it doesn't do is watch 24/7 and alert. The standard fix is
**Uptime Kuma** — a self-hosted uptime monitor that runs as a single Docker
container and can ping sites, ports, and containers, then notify via email,
Telegram, Discord, Slack, webhooks and ~90 other channels.

## 1. Run Uptime Kuma

Docker must be installed (see `docker-deploy` skill, step 1).

```
sudo docker run -d --name uptime-kuma \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v uptime-kuma:/app/data \
  louislam/uptime-kuma:2
```

Verify:

```
sudo docker ps --filter name=uptime-kuma
curl -sSI http://127.0.0.1:3001        # expect 200
```

## 2. Make the dashboard reachable

It's bound to localhost, so the user can't open it yet. Two options — ask which
they prefer if the task doesn't say:

- **Public with a domain + HTTPS** (recommended if they'll check it from anywhere):
  load the `reverse-proxy-tls` skill and proxy a subdomain like
  `status.<domain>` to 127.0.0.1:3001. Uptime Kuma uses WebSockets — the standard
  server block in that skill already includes the required Upgrade headers.
- **Private via SSH tunnel** (zero exposure): tell the user to run
  `ssh -L 3001:127.0.0.1:3001 <user>@<host>` on their machine and open
  http://localhost:3001.

On first visit Uptime Kuma asks to create an admin account — the user does this
in the browser. Tell them clearly: pick a strong password; this page controls
their alerting.

## 3. Tell the user what to monitor

You cannot click the UI for them, so hand them a concrete checklist:

- One HTTP(S) monitor per site: URL = `https://<domain>`, interval 60s.
- A TCP monitor per critical non-HTTP service if any port is intentionally public.
- A notification channel (Settings → Notifications): email is simplest; Telegram
  is quickest. Attach it to every monitor.
- Optional: a status page (Status Pages → New) if they want a public
  "is it up" page.

## 4. Disk-space alert — the outage Kuma won't see coming

Uptime Kuma notices when things are already down. Disk filling up is the most
common *cause*, so add a tiny early-warning cron (writeRemoteFile then a
`/etc/cron.d` entry):

```bash
#!/bin/bash
# /usr/local/bin/disk-alert.sh — warn at 85% usage
THRESHOLD=85
df -P | awk 'NR>1 {gsub("%","",$5); if ($5+0 > '"$THRESHOLD"') print $6" at "$5"%"}' | while read -r line; do
  logger -t disk-alert "WARNING: $line"
  # If Uptime Kuma is set up: push to a "Push" type monitor so it alerts:
  # curl -fsS "http://127.0.0.1:3001/api/push/<token>?status=down&msg=$line" >/dev/null
done
```

Cron entry (`/etc/cron.d/disk-alert`): `*/30 * * * * root /usr/local/bin/disk-alert.sh`.
If the user sets up a Push monitor in Kuma (type "Push", copy its token), wire the
curl line to it — then disk warnings arrive on the same channel as downtime alerts.

## 5. Report

Summarize: where the dashboard lives (URL or tunnel command), that they must
create the admin account on first open, the monitor checklist from step 3, and
that disk usage above 85% will warn automatically.
