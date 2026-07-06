---
name: server-hardening
description: Secure a Linux server — firewall (ufw/firewalld), SSH hardening, fail2ban brute-force protection, automatic security updates. Use when the user asks to secure/harden/protect a server, right after a fresh server is first connected, or after exposing anything to the internet.
---

# Server security baseline

Goal: firewall on with only needed ports, SSH resistant to brute force, security
patches automatic. Work in this order — each step protects the next.

**This skill APPLIES fixes.** To first *find* what's wrong (weak points, signs
of compromise) without changing anything, use `security-audit` — it's the
read-only detection pass. If the user asked to "check if my server is safe / has
been hacked", start with `security-audit` and only come here once they approve
the fixes it recommends.

**Lockout rule (read first):** Tevada DevOps itself is connected over SSH right now.
Never disable the auth method or port this session is using. Before touching sshd
config, check how the current connection authenticates (password vs key) — if the
saved profile uses a password, do NOT disable password auth; offer to set up key
auth first instead.

## 1. Firewall — allow SSH BEFORE enabling

Enabling a firewall that doesn't allow SSH kills this connection and locks the
user out of their own server. Order is everything:

```
sudo ufw allow 22/tcp        # or the custom port from `sudo ss -tlnp | grep sshd`
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp    # only if a web server runs here
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw --force enable
sudo ufw status verbose
```

RHEL-family uses firewalld instead:
`sudo firewall-cmd --permanent --add-service=ssh` (+ http/https as needed) then `--reload`.

Add only ports for services that must be public. Databases stay closed — apps on
the same box reach them via localhost.

Note for Docker hosts: published container ports (`-p 0.0.0.0:...`) bypass ufw via
iptables. That is why the standard deploy binds to 127.0.0.1 — mention this if you
find publicly published ports.

## 2. SSH hardening

Back up first: `sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)`.

Set in `/etc/ssh/sshd_config` (writeRemoteFile sudo=true, or targeted `sed`):

```
PermitRootLogin prohibit-password    # root only with a key — or "no" if user logs in as non-root
MaxAuthTries 3
PasswordAuthentication no            # ONLY if key auth is confirmed working — see lockout rule
```

If disabling password auth: first verify a key actually works — the profile
connects with authType "key", or `~/.ssh/authorized_keys` contains the user's key
and they've confirmed a key login. Some distros also override this in
`/etc/ssh/sshd_config.d/*.conf` — check those files too or your change silently loses.

**Validate, then reload — never restart blind:**

```
sudo sshd -t && sudo systemctl reload sshd
```

`reload` keeps existing connections alive, so even a mistake here doesn't cut this
session. Test a fresh connection before ending the task.

## 3. fail2ban — ban brute-forcers

```
DEBIAN_FRONTEND=noninteractive sudo apt-get install -y fail2ban   # or dnf equivalent
```

Write `/etc/fail2ban/jail.local`:

```ini
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
```

```
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd     # verify the jail is live
```

## 4. Automatic security updates

Debian/Ubuntu:

```
DEBIAN_FRONTEND=noninteractive sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

RHEL-family: `sudo dnf install -y dnf-automatic && sudo systemctl enable --now dnf-automatic.timer`.

## 5. Verify and report

```
sudo ufw status verbose               # or firewall-cmd --list-all
sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication|maxauthtries'
sudo fail2ban-client status sshd
sudo ss -tlnp                         # anything unexpectedly listening on 0.0.0.0?
```

Report in plain language: what is now blocked/allowed, what changed in SSH (and
that their current login method still works), that brute-forcers get banned
automatically, and that security patches install themselves. Flag anything you
found listening publicly that probably shouldn't be.
