---
name: troubleshoot-server
description: Systematically diagnose a broken or degraded server — site down, 502/504 errors, service failing to start, out of disk or memory, port conflicts, container crash loops, slow server. Use whenever the user reports that something is down, broken, erroring, or slow, BEFORE attempting any fix.
---

# Troubleshoot a server

Resist the urge to restart things at random. Diagnose top-down, find the actual
cause, fix that, then verify. A restart that "fixes" an OOM kill just schedules
the next outage.

## 1. Resource floor first — many mysteries are just "disk full"

```
df -h                                    # any filesystem ≥ 95%?
free -m                                  # available memory near zero?
sudo dmesg -T | grep -i 'out of memory' | tail -5   # OOM killer strikes
uptime                                   # load vs CPU count
```

- **Disk full** breaks everything downstream (DBs stop, logs fail, certs can't
  renew). Find the eater: `sudo du -xh / --max-depth=2 2>/dev/null | sort -rh | head -15`.
  Usual suspects: container logs (see `docker-maintenance` log rotation), old
  journals (`sudo journalctl --vacuum-size=200M`), apt/dnf caches, orphaned images
  (`sudo docker system df`).
- **OOM kills** → identify the killed process in dmesg; either the app leaks, the
  box is too small, or something else hogs (check `getServerStats` / `ps aux --sort=-%mem | head`).

## 2. Which layer is broken?

Walk the request path from inside out; the failure layer is where behavior changes:

```
sudo systemctl --failed                          # anything red?
sudo ss -tlnp                                    # is the app even listening on its port?
curl -sSI http://127.0.0.1:<appPort>             # app answers locally?
curl -sSI http://127.0.0.1                       # nginx answers locally?
curl -sSI https://<domain>                       # reachable from outside path?
```

Interpretation:
- App port not listening → app/container is down (step 3).
- App answers but nginx 502/504 → nginx points at the wrong port or app is slow:
  `sudo nginx -t`, `sudo tail -30 /var/log/nginx/error.log`, compare `proxy_pass`
  port with the real one from `ss`.
- Local works, domain doesn't → DNS (`getent hosts <domain>` vs server IP),
  firewall (`sudo ufw status`), or expired cert
  (`echo | openssl s_client -connect <domain>:443 2>/dev/null | openssl x509 -noout -dates`).

## 3. Failing service or container — read the log, not the tea leaves

systemd service:

```
sudo systemctl status <svc> --no-pager
sudo journalctl -u <svc> -n 50 --no-pager       # the real error is here
```

Docker container:

```
sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}'
sudo docker logs --tail 100 <name>
sudo docker inspect <name> --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
```

Common causes, in rough order of frequency: config typo from a recent change
(restore the `.bak` you/others made), port already taken (`ss -tlnp | grep <port>`),
disk full (step 1), missing env/secret file, OOMKilled, expired certificate.

## 4. Fix, verify, and close the loop

- Fix the root cause. If a recent config edit broke it, restore the backup, reload,
  and re-apply the change correctly.
- Re-run the exact check that failed in step 2 and confirm it passes.
- If the cause was resource exhaustion, add the guard so it doesn't recur (log
  rotation, journal vacuum, prune schedule — see `docker-maintenance`;
  monitoring — see `monitoring-uptime`).

Report to the user in plain language: what was broken (symptom), why (root cause),
what you changed (fix), proof it works now (the passing check), and what will
prevent a repeat.
