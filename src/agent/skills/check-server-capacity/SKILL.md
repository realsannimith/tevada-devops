---
name: check-server-capacity
description: Pre-flight capacity check — verify a server has enough disk, memory, and CPU headroom BEFORE starting any deploy, install, build, or other heavy work, and add swap for safety when the box has little or no swap. Use at the start of every job that installs packages, pulls Docker images, builds code, or runs databases.
---

# Check server capacity (and add swap if needed)

Small VPSes die mid-deploy in two boring ways: the disk fills up, or the OOM
killer shoots the build/database because there is no swap. Both are cheap to
prevent and expensive to clean up. Run this check FIRST, fix what it finds,
then start the real job.

## 1. Take the measurements

```
df -h /                                  # root filesystem usage
free -m                                  # RAM + swap in MB
nproc && uptime                          # cores vs load average
swapon --show                            # existing swap devices (empty = none)
```

Read the results against these floors:

| Check | Red line | Why |
|---|---|---|
| Disk free on `/` | < 2 GB free, or ≥ 90% used | apt, docker pull, and builds all need scratch space; certs and DBs break on a full disk |
| RAM available (`free -m` "available") | < 300 MB | the next build or `docker pull` will trigger the OOM killer |
| Swap total | 0, and RAM ≤ 4 GB | one memory spike kills a service instead of just slowing down |
| Load average (1 min) | > 2 × core count | box is already saturated — heavy work now makes an outage |

## 2. Fix disk first (swap needs disk too)

If the disk is at the red line, free space before anything else — the usual
eaters, biggest wins first:

```
sudo docker system df                            # if Docker is installed
sudo docker system prune -af --volumes=false     # unused images/containers (keeps volumes)
sudo journalctl --vacuum-size=200M
sudo apt-get clean || sudo dnf clean all || true
sudo du -xh / --max-depth=2 2>/dev/null | sort -rh | head -15   # find anything else
```

Do NOT create a swap file on a disk that would drop under ~2 GB free after
creating it — report the constraint to the user instead (bigger disk or smaller
swap).

## 3. Add swap if the box has little or none

Create swap when `swapon --show` is empty (or swap < 1 GB) AND RAM ≤ 4 GB.
Size it: RAM ≤ 2 GB → swap = 2 GB; RAM 2–4 GB → swap = RAM (cap 4 GB). This is
a safety net against OOM kills, not a substitute for enough RAM — say so in
your summary if the workload clearly needs a bigger instance.

```
sudo swapon --show | grep -q . && echo "swap already active" || {
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
}
```

(Adjust `2G` / `count=2048` to the size chosen above. The `dd` fallback covers
filesystems where `fallocate` can't make swap, e.g. XFS quirks; on btrfs the
swapfile needs `chattr +C` on a fresh zero-length file first.)

Persist it across reboots — idempotently, never duplicating the fstab line:

```
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Tune swappiness so swap is a parachute, not a slow-motion default (server
workloads want RAM hot, swap for emergencies):

```
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
```

## 4. Verify and report

```
free -m            # swap line now shows the new total
swapon --show      # swapfile listed
df -h /            # disk still has headroom
```

Tell the user in one or two plain sentences what you found and changed, e.g.
"Your server has 1 GB RAM and had no swap, so I added a 2 GB swap file as a
safety net — installs and builds won't crash the server if memory spikes." If
capacity is fundamentally too small for the job (e.g. building a large app on
512 MB RAM), warn them BEFORE burning time on a deploy that will crawl or fail,
and suggest the concrete next size up.
