---
name: github-auto-deploy
description: Deploy an app from a GitHub repository and keep it deploying automatically on every push — clone, build with Docker, and set up auto-redeploy via a polling script. Use when the user wants to deploy from GitHub / "my repo", or wants pushes to main to go live automatically (CI/CD, continuous deployment).
---

# Deploy from GitHub with auto-redeploy

Two phases: get the repo deployed the standard way (Docker), then make pushes to
the branch redeploy themselves. The result is push-to-deploy without any external
CI service.

## 1. Get the repo onto the server

- Call `listGithubRepos` first when the user says "my repo" or names a repo
  loosely: it returns the exact `owner/repo` names the user granted to this
  app, each repo's default branch, and `authorizedServerIds` — the servers
  whose git credential store already holds the user's GitHub token.
- **Public repo**: `git clone https://github.com/<owner>/<repo>.git /opt/<app>`
  (install git first if missing).
- **Private repo**: the app has a GitHub integration (a GitHub App the user
  installs, choosing all or selected repositories) — the user connects their
  account in Settings → GitHub and toggles this server on; cloning then works
  through the server's git credential store. If the target server is not in
  `authorizedServerIds`, ask the user to enable it there rather than handling
  raw tokens in shell commands (tokens pasted into commands end up in shell
  history and logs).
- If a private repo is missing from `listGithubRepos`, the user likely picked
  "Only select repositories" without it — tell them to add it via Settings →
  GitHub → "Manage repository access" (it opens the GitHub installation page).

Record the branch to track (default: the repo's default branch, usually `main`).

## 2. First deploy

**Already deployed?** If the app is already running from a git checkout (a
container exists and `/opt/<app>/.git` is present — common when you deployed
it in an earlier session), there is no first deploy to do: verify it's
healthy, do the data-loss check below, then continue from § 3. The same
applies when the user asks to "add notifications / auto-deploy" to an
existing app. If an old `/usr/local/bin/<app>-deploy.sh` from a previous
setup lacks `notify()`, `flock`, or `--force`, rewrite it with the current
template in § 3 (keeping its real docker run flags) — legacy scripts deploy
silently, which users experience as "it didn't work".

Otherwise, load the `docker-deploy` skill (or `docker-compose-stack` if the
repo has a compose file) and deploy from `/opt/<app>`. Get it verified and
working BEFORE adding automation — automating a broken deploy just breaks it
repeatedly.

**Data-loss check — do this now, not after the first lost upload.** The
automation below deletes and recreates the container on every push. Any file
the app writes inside the container (uploads folders like `uploads/`,
`public/uploads`, `media/`, `storage/`, SQLite files…) is erased each time
unless it sits on a named volume. Follow docker-deploy § "Persistent data"
before automating, and confirm the running container's mounts cover every
writable path:

```
sudo docker inspect <app> --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```

If a writable path has no volume, fix the deploy first (`docker rm` + re-run
with the `-v` flags) — named volumes keep their data across that recreation.

## 3. The redeploy script

One idempotent script does fetch → compare → rebuild → verify. Write it with
writeRemoteFile to `/usr/local/bin/<app>-deploy.sh` (mode 755). Polling is the
standard choice here: unlike GitHub webhooks it needs no public endpoint, no
secret validation, and survives IP changes — at the cost of up to a minute of
delay, which is fine for almost everyone.

```bash
#!/bin/bash
set -euo pipefail
APP=<app>
DIR=/opt/$APP
BRANCH=main
PORT=<port>
LOG=/var/log/$APP-deploy.log
# Reports each transition to the app's Deploys tab + Telegram (see § 4).
# Guarded so a missing helper can never break a deploy.
notify() { [ -x /usr/local/bin/easyhost-notify ] && /usr/local/bin/easyhost-notify "$APP" "$1" "$2" || true; }

# One deploy at a time: a build slower than the 1-minute cron tick must not
# race a second copy of itself (or a --force run from the app).
exec 9>"/var/lock/$APP-deploy.lock"
flock -n 9 || exit 0

# --force skips the up-to-date early exit — the app's Deploys tab uses this to
# apply .env changes through the normal build → health-check → rollback path.
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

cd "$DIR"
git fetch origin $BRANCH --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/$BRANCH)
[ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = "0" ] && exit 0   # nothing new — the common case

echo "$(date -Is) deploying $REMOTE" >> "$LOG"
notify start "Deploying ${REMOTE:0:7} from $BRANCH"
git reset --hard "$REMOTE"
TAG=$(date +%Y%m%d-%H%M)
if ! docker build -t $APP:$TAG -t $APP:latest "$DIR" >> "$LOG" 2>&1; then
  notify failed "Build of ${REMOTE:0:7} failed — previous version still running (see $LOG)"
  exit 1
fi

docker stop $APP && docker rename $APP $APP-old
docker run -d --name $APP --restart unless-stopped \
  -p 127.0.0.1:$PORT:$PORT $APP:latest >> "$LOG" 2>&1
  # ^ carry over the REAL flags from the working deploy in step 2 (env-file, volumes…)

sleep 5
if curl -fsS "http://127.0.0.1:$PORT" > /dev/null; then
  docker rm $APP-old
  echo "$(date -Is) OK $REMOTE" >> "$LOG"
  notify ok "Deployed ${REMOTE:0:7} from $BRANCH"
else
  echo "$(date -Is) FAILED — rolling back" >> "$LOG"
  notify failed "Deploy of ${REMOTE:0:7} failed its health check — rolling back"
  docker rm -f $APP || true
  docker rename $APP-old $APP
  docker start $APP
  notify rollback "Previous version of $APP restored"
  exit 1
fi
```

Adapt the `docker run` line to match the flags the verified deploy from step 2
actually used (env files, volumes, container port) — reconstruct them from the
live container if needed:

```
sudo docker inspect <app> --format '{{json .Mounts}}'      # every -v flag
sudo docker inspect <app> --format '{{json .Config.Env}}'  # env (use --env-file, not inline)
```

A redeploy that drops the env file is an outage; one that drops a `-v` flag is
worse — it doesn't error, the app just starts with an **empty uploads dir** and
the user discovers the loss days later. Every volume from step 2 must appear in
the script's `docker run` line. Never put `docker volume rm`, `docker system
prune --volumes`, or `docker compose down -v` in an automated script — those
delete the data the volumes exist to protect. For compose repos the script
simplifies to `git reset --hard` + `docker compose up -d --build` + the same
curl check (named volumes in the compose file survive `up --build`) — keep the
same `notify` calls around it.

Run it once by hand (runCommand, sudo) and confirm it exits 0 before scheduling.

## 4. Notifications + the app's Deploys tab (do not skip)

Auto-deploys run from cron while nobody is watching — visibility is part of
the deliverable, not a nice-to-have. Two steps:

**a. Call the `setupDeployNotifications` tool** (pass the serverId). It
installs `/usr/local/bin/easyhost-notify` — the helper the script's `notify()`
calls — which records every deploy event for the app's **Deploys tab** and,
when the user has Telegram connected, messages them on every deploy
success/failure/rollback. The app provisions the bot token itself; never
handle Telegram tokens in commands.

- `telegramConfigured: true` → confirm it end-to-end:
  `sudo /usr/local/bin/easyhost-notify <app> test "Auto-deploy for <app> is live — deploy results will arrive here."`
  and ask the user if the Telegram message arrived.
- `telegramConfigured: false` → deploy history in the app still works; tell
  the user to connect a bot under **Settings → Alerts** (then re-run this
  tool) to also get Telegram notifications.

**b. Register the deployment** so it shows in the Deploys tab: write
`/etc/easyhost/deploys/<app>.json` (writeRemoteFile, sudo, mode 644) as a
single line of JSON — no secrets in it:

```json
{"app":"<app>","repo":"<owner>/<repo>","branch":"main","dir":"/opt/<app>","port":<port>,"script":"/usr/local/bin/<app>-deploy.sh","log":"/var/log/<app>-deploy.log","envFile":"/opt/<app>/.env","createdAt":"<date -Is output>"}
```

Include `envFile` whenever the app runs with `--env-file` (per docker-deploy
that is `/opt/<app>/.env`) — it powers the **Environment editor** on the app's
container in the **Artifacts tab**, where the user changes variables and hits
"Save & redeploy" (which runs your script with `--force`; that's why the
script must support it). Omit the field only if the app genuinely has no env
file.

## 5. Schedule it

Write `/etc/cron.d/<app>-deploy` (sudo):

```
* * * * * root /usr/local/bin/<app>-deploy.sh
```

Every minute is safe: the no-change path is a single `git fetch`.

## 6. Verify end-to-end and report

- Run the script manually once more; confirm "nothing new" exits 0 quietly.
- **Prove uploads survive a redeploy** (when the app has writable paths): drop a
  marker file into the volume-backed dir, force one redeploy cycle, confirm the
  marker is still there:

  ```
  sudo docker exec <app> sh -c 'echo ok > /app/uploads/.deploy-persist-test'
  sudo git -C /opt/<app> reset --hard HEAD~1   # pretend we're a commit behind…
  sudo /usr/local/bin/<app>-deploy.sh          # …so the script does a real rebuild + container swap
  sudo docker exec <app> cat /app/uploads/.deploy-persist-test   # must print "ok"
  sudo docker exec <app> rm /app/uploads/.deploy-persist-test
  ```

  If the marker is gone, a writable path is missing its volume — fix before
  handing over.
- If the user can push a trivial commit now, watch `tail -f /var/log/<app>-deploy.log`
  through one cycle.

Tell the user: pushes to `<branch>` go live within ~1 minute; failed deploys
roll back automatically to the previous version; every deploy shows up in this
app under the server's **Deploys tab** (history, status and the build log) and
— when Telegram is connected in Settings → Alerts — as a Telegram message on
every success, failure and rollback. The raw log also lives in
`/var/log/<app>-deploy.log`; to change the branch, edit `BRANCH=` in
`/usr/local/bin/<app>-deploy.sh`.
