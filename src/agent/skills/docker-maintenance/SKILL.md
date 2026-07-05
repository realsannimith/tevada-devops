---
name: docker-maintenance
description: Update, inspect, restart, or clean up Docker workloads and reclaim disk space — container logs, image updates, pruning, log rotation, crash loops. Use for "update my app", "disk is full", "what's running on this server", "the container keeps restarting", or any routine care of a Docker host.
---

# Docker host maintenance

## Inventory — always look before touching

```
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
sudo docker system df        # where the disk went: images / containers / volumes / build cache
```

Compose-managed containers (label `com.docker.compose.project`) must be maintained
through their compose file (`docker-compose-stack` skill), not with raw docker
commands — otherwise the next `compose up` reverts your change.

## Updating a container to a new image

**Registered app? Use its own pipeline.** Before touching docker by hand,
check `sudo cat /etc/easyhost/deploys/<app>.json 2>/dev/null`. If it exists
and has a `"script"` field, update/redeploy with
`sudo /usr/local/bin/<app>-deploy.sh --force` and stop — it rebuilds,
health-checks, rolls back on failure, and reports to the app's Deploys tab +
Telegram on its own. Hand-rolled docker commands on such an app bypass all of
that and the user sees nothing.

A container's config is immutable — "updating" means recreating with the same
settings and a new image. **Capture the current settings first**, they are the
recipe:

```
sudo docker inspect <app> --format 'image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}}
ports={{json .HostConfig.PortBindings}} mounts={{json .Mounts}} env-file/cmd: check .Config.Env and .Config.Cmd'
```

Then:

```
sudo docker pull <image>                                  # or rebuild from /opt/<app>
sudo docker stop <app> && sudo docker rename <app> <app>-old
sudo docker run -d --name <app> ...same flags, new image...
curl -sSI http://127.0.0.1:<port>                          # verify BEFORE cleaning up
sudo docker rm <app>-old                                   # only after it works
```

The rename keeps the old container as an instant rollback
(`docker rm -f <app> && docker rename <app>-old <app> && docker start <app>`).
Data in named volumes is untouched by recreation.

After a manual update, make it visible: when
`/usr/local/bin/easyhost-notify` exists, run
`sudo /usr/local/bin/easyhost-notify <app> ok "Updated to <image/tag> (via agent)"`
(or `failed "<reason>"` if you rolled back) — that's what feeds the app's
Deploys tab history and the user's Telegram.

## Crash loop ("Restarting (1) X seconds ago")

```
sudo docker logs --tail 100 <app>                              # the actual error
sudo docker inspect <app> --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
```

- `OOMKilled=true` → the server is out of memory or the container needs a limit;
  check `free -m` and the `troubleshoot-server` skill.
- Exit code 1 + stack trace → app bug or bad config/env; fix the cause, don't just restart.
- "port is already allocated" → `sudo ss -tlnp | grep <port>` to find the squatter.

## Reclaiming disk space

Safe (removes only stopped containers, dangling images, unused networks and build cache):

```
sudo docker system prune -f
```

More aggressive — `-a` also removes images not used by any *running* container,
meaning stopped-but-wanted apps lose their image and rollback tags disappear.
Check `docker ps -a` first and confirm with the user.

**Volume pruning deletes data permanently.** `docker volume prune` / `down -v`
only with the user's explicit, informed confirmation — name the volumes that will
be destroyed before running it.

## Stop logs from eating the disk

Unbounded container logs are the #1 silent disk-filler. Set global rotation once
(writeRemoteFile sudo=true to `/etc/docker/daemon.json`):

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

Then `sudo systemctl restart docker` — brief downtime for all containers; they
come back thanks to `--restart unless-stopped`. Rotation applies to containers
created after the restart; recreate chronic offenders.

Finish with a plain summary: what was updated/cleaned, space reclaimed
(`docker system df` before/after), anything the user should decide (volumes,
unused images kept).
