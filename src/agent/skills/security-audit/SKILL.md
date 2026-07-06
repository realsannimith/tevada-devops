---
name: security-audit
description: Read-only security check of a hosted server — find weak points (exposed ports/databases, weak SSH, missing firewall, out-of-date packages) and signs of compromise (rogue processes, suspicious cron/SSH keys, unexpected listeners, high egress). Use when the user asks to check/audit/scan a server for security, whether it's safe, if it's been hacked/exploited/compromised, or after exposing something to the internet. Reports findings ranked by severity; does NOT change anything — hand fixes to server-hardening.
---

# Security audit — find weak points & signs of compromise

You are the DevOps agent auditing a server the user hosts. Your job is to
**observe and report**, not to fix. This is the detection counterpart to
`server-hardening` (which applies fixes) — run that only after reporting, and
only with the user's go-ahead.

**Golden rule — READ-ONLY.** Every command here only reads state. Do NOT
install, modify configs, kill processes, delete files, ban IPs, or change the
firewall during an audit. If you find something dangerous, report it and offer
to fix it via `server-hardening` — the user decides. Never touch a process or
file you merely suspect: a wrong `kill`/`rm` on a false positive breaks a
healthy service. The one exception is if the user explicitly said "and fix
it" — even then, audit and report the full picture FIRST, then fix.

**Don't lock yourself out.** Tevada DevOps is connected over SSH right now.
Auditing never changes auth or firewall, so this is safe — but if the user
approves hardening afterward, follow server-hardening's lockout rule.

Work top to bottom. Each section prints; you interpret. Prefer `sudo -n`
(non-interactive) and fall back to the unprivileged read if sudo isn't
available — note in the report when a check couldn't see everything for lack of
privilege (an incomplete audit must never masquerade as a clean one).

## 1. Exposure — what the internet can reach

The single most common weakness: something bound to `0.0.0.0` that should be
local-only (a database, an admin panel, a debug port).

```
sudo ss -tlnp 2>/dev/null || ss -tln     # listening TCP sockets + owning process
```

For every socket on `0.0.0.0`/`::` (not `127.0.0.1`/`::1`), decide: does this
NEED to be public? Flag as HIGH any database or cache exposed publicly:

- Postgres 5432, MySQL/MariaDB 3306, MongoDB 27017, Redis 6379,
  Memcached 11211, Elasticsearch 9200 — these should bind to `127.0.0.1`.
- Admin/debug surfaces public: 8080/9000 dashboards, 15672 RabbitMQ, 9090
  Prometheus, 5601 Kibana, Docker API 2375/2376, `.git` served by a web root.

Docker note: `-p 0.0.0.0:<port>` publishes through iptables and **bypasses
ufw** — a port can be firewalled in ufw yet still reachable. Cross-check
published container ports:

```
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null
```

## 2. Firewall — is anything actually filtering?

```
sudo ufw status verbose 2>/dev/null || sudo firewall-cmd --list-all 2>/dev/null || sudo iptables -S 2>/dev/null
```

No firewall active, or `default allow incoming`, is a MEDIUM finding (HIGH if §1
found sensitive services exposed). Note the gap between "ports open in the
firewall" and "ports actually listening" — both directions matter.

## 3. SSH exposure — the most attacked door

```
sudo sshd -T 2>/dev/null | grep -Ei 'permitrootlogin|passwordauthentication|maxauthtries|pubkeyauthentication|permitemptypasswords|x11forwarding'
```

Flag: `permitrootlogin yes` (HIGH), `passwordauthentication yes` on an
internet-facing host (MEDIUM — brute-force surface), `permitemptypasswords yes`
(CRITICAL), `maxauthtries` high or unset. Is fail2ban (or equivalent) running?

```
sudo fail2ban-client status 2>/dev/null || echo "fail2ban not installed"
```

No brute-force protection + password auth on 22 = a real risk — call it out.

## 4. Signs of compromise — has it already been hit?

Weak points are potential; these are active. Treat any hit here as HIGH/CRITICAL
and be specific.

**Unexpected authorized SSH keys** (a backdoor key is the classic persistence):
```
sudo find /root /home -name authorized_keys -exec ls -l {} \; -exec cat {} \; 2>/dev/null
```
List every key with its comment. Ask the user to confirm each one is theirs — a
key they don't recognize is a likely backdoor.

**Suspicious cron jobs** (miners/backdoors persist via cron — often piping
`curl … | sh`):
```
for u in $(cut -d: -f1 /etc/passwd); do sudo crontab -l -u "$u" 2>/dev/null | sed "s/^/[$u] /"; done
sudo cat /etc/crontab /etc/cron.d/* 2>/dev/null
ls -la /etc/cron.*/ 2>/dev/null
```
Flag anything fetching-and-executing from the internet, base64-decoding to a
shell, or writing to `/tmp`/`/dev/shm`.

**High-CPU / masquerading / deleted-binary processes** (crypto miners peg the
CPU; malware often runs from `/tmp` or as a deleted binary):
```
ps aux --sort=-%cpu | head -15
sudo ls -l /proc/*/exe 2>/dev/null | grep -E '/tmp/|/dev/shm/|\(deleted\)' || echo "none running from tmp/deleted"
```

**Outbound connections** (data exfil, miner pool, C2 beacon):
```
sudo ss -tnp state established 2>/dev/null | grep -vE '127.0.0.1|::1' | head -30
```
Unexpected established connections to unknown IPs on odd ports warrant a closer
look — correlate the owning process with what should be running.

**World-writable & SUID surprises** (privilege-escalation footholds):
```
sudo find / -xdev -perm -0002 -type f -not -path '/proc/*' 2>/dev/null | head -20
sudo find / -xdev -perm -4000 -type f 2>/dev/null
```
Compare SUID binaries against the normal set (`sudo`, `su`, `passwd`,
`mount`, `ping`, `chsh`, `newgrp`…); flag SUID in `/tmp`, `/home`, or an app dir.

**Recently modified system binaries / new users**:
```
sudo find /usr/bin /usr/sbin /bin /sbin -mtime -14 -type f 2>/dev/null    # changed in last 2 weeks
awk -F: '$3>=1000 && $3<65534 {print $1" (uid "$3")"}' /etc/passwd         # human/login accounts
awk -F: '$3==0 {print $1}' /etc/passwd                                     # anything with uid 0 besides root = CRITICAL
sudo lastlog 2>/dev/null | grep -v 'Never logged in' | head
```

## 5. Patch level — known-CVE exposure

Unpatched packages are exploitable weak points:

```
# Debian/Ubuntu
apt-get -s upgrade 2>/dev/null | grep -iE '^Inst.*security' | wc -l   # count of pending SECURITY updates
# RHEL family
sudo dnf updateinfo list security 2>/dev/null | tail -n +2 | wc -l
```
Report the count of pending security updates and whether automatic security
updates are enabled (`unattended-upgrades` / `dnf-automatic.timer`).

## 6. App-level quick wins

- Exposed secrets: `.env`, `id_rsa`, `*.pem`, `.git/config` under a web root
  (`/var/www`, nginx `root`) — served files leak credentials. Check the doc
  roots you find in nginx/apache configs.
- Default/weak DB passwords, `.env` files world-readable (`ls -l` the app dir).
- Directory listing on / debug mode on in a public app (spot-check with a
  `curl -sI` to a known route, read-only).

## 7. Report — ranked, plain language, actionable

Summarize as a prioritized list. For each finding give: **severity**
(CRITICAL / HIGH / MEDIUM / LOW), **what** it is, **why** it matters in plain
words, and the **one concrete fix**. Lead with a one-line verdict.

Example shape:

> **Verdict: 1 critical, 2 high — needs attention before this stays public.**
>
> 🔴 CRITICAL — PostgreSQL is open to the internet on 0.0.0.0:5432. Anyone can
> attempt to connect. Fix: bind it to 127.0.0.1 (or firewall the port).
> 🔴 HIGH — SSH allows password login and fail2ban isn't installed — open to
> brute force. Fix: key-only auth + fail2ban.
> 🟠 MEDIUM — 12 pending security updates. Fix: enable unattended-upgrades.
> ✅ No signs of compromise found (no rogue cron, no unknown SSH keys, no
> processes from /tmp).

Be honest about coverage: if a section couldn't run for lack of sudo, say the
audit was partial and which checks were skipped. Distinguish clearly between
**weak points** (could be exploited) and **compromise indicators** (may already
have been) — they call for different urgency.

**After reporting:** offer next steps. For weak points, offer to run
`server-hardening` (firewall, SSH, fail2ban, auto-updates). For likely
compromise, advise the user directly: rotate credentials and keys, and for a
confirmed breach the only safe path is often to rebuild the server from a clean
image and restore data from a known-good backup — malware persistence is hard
to fully remove in place. Do not attempt cleanup/removal yourself unless the
user explicitly asks and understands the risk.
