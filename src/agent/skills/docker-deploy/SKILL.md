---
name: docker-deploy
description: Deploy or host any single application (Node.js, Python, static site, or a prebuilt image) on a server as a Docker container — the standard Tevada DevOps way to run apps. Use whenever the user asks to deploy, host, run, ship, or containerize an app or service, including when Docker is not installed on the server yet.
---

# Deploy an app with Docker

Docker is the standard way to run apps on Tevada DevOps servers: it isolates the app from
the host, makes updates and rollbacks a tag swap, and works identically on every
distro. Prefer this over a native install unless the user explicitly asks otherwise.

When the app needs more than one container (app + database + cache), load the
`docker-compose-stack` skill instead. When the user mentions a domain, HTTPS, or
"make it public", finish with the `reverse-proxy-tls` skill.

## 1. Ensure Docker is installed

```
docker --version
```

If missing, install with the official convenience script (works on every major
distro, installs the compose plugin too), then enable it at boot:

```
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

Verify with `sudo docker info` (exit code 0). Use `sudo` for all docker commands —
do not add users to the docker group unless the user asks (it is root-equivalent).

## 2. Get the app onto the server

- Git URL given → `git clone <url> /opt/<app>` (install git if missing).
- Private GitHub repo → the user must authorize it in the app's GitHub panel; ask
  them to do that rather than fumbling with credentials yourself.
- Prebuilt image (e.g. `ghcr.io/user/app:1.2`) → skip to step 4.
- Nothing given → ask what to deploy; do not invent an app.

Use `/opt/<app>` as the conventional home for deployed apps so later maintenance
knows where to look.

## 3. Build the image

If the repo has a Dockerfile, use it. Otherwise load the framework skill that
matches the repo — it supplies a production-grade Dockerfile plus the stack's
build command, port, env, and migration specifics. Check the repo's files with
runCommand first, then route:

| Repo markers | Skill |
|---|---|
| `requirements.txt` / `pyproject.toml` / `Pipfile` (FastAPI, Django, Flask…) | `deploy-python` |
| `package.json`, server app (Express, NestJS, Fastify…) | `deploy-nodejs` |
| `package.json`, SSR frontend (Next.js, Nuxt, SvelteKit, Remix, Astro SSR) | `deploy-ssr-frontend` |
| static build (Vite/CRA/Angular SPA, Hugo, Jekyll, plain HTML) | `deploy-static-frontend` |
| `go.mod` | `deploy-go` |
| `pom.xml` / `build.gradle` (Spring Boot, Quarkus, Ktor…) | `deploy-jvm` |
| `composer.json` / `artisan` / WordPress | `deploy-php` |
| `Gemfile` (Rails, Sinatra) | `deploy-ruby` |
| `Cargo.toml` (Axum, Actix, Rocket) | `deploy-rust` |
| `*.csproj` / `*.sln` (ASP.NET Core) | `deploy-dotnet` |
| `mix.exs` (Phoenix) | `deploy-elixir` |
| unclear, or anything else | `deploy-any-stack` |

Write the Dockerfile (and any config it references) with writeRemoteFile, then
build with BOTH a timestamp tag and latest — the dated tag is your rollback point:

```
sudo docker build -t <app>:$(date +%Y%m%d-%H%M) -t <app>:latest /opt/<app>
```

Builds can be slow: raise timeoutSec (up to 900).

## 4. Run the container

```
sudo docker run -d --name <app> \
  --restart unless-stopped \
  -p 127.0.0.1:<port>:<containerPort> \
  <app>:latest
```

- `--restart unless-stopped` so a reboot or crash doesn't take the app down.
- Publish on **127.0.0.1** by default — nginx (reverse-proxy-tls skill) is the
  front door. Only bind 0.0.0.0 if the user explicitly wants the raw port public,
  and warn them.
- Secrets/config → generate with generatePassword, write an env file with
  writeRemoteFile (mode 600) and pass `--env-file /opt/<app>/.env`. Never bake
  secrets into the image or the command line.
- Container name already in use? An old deployment exists — confirm with the user
  before replacing it: `sudo docker rm -f <app>` then re-run.

### Persistent data: find every writable path BEFORE the first run

Containers are disposable — every redeploy (a manual rebuild, and especially the
`github-auto-deploy` loop) deletes the container and everything the app wrote
inside it. User uploads are the classic casualty: many projects save uploaded
files right in the project tree (`uploads/`, `public/uploads`, `media/`,
`storage/`, `files/`, `data/`), which lives in the container's writable layer
once deployed. Skipping this step means the user's files vanish on the next push.

1. Hunt for writable paths before running: `ls` the repo for the dirs above, and
   grep the code for the stack's upload/write APIs — the framework skill you
   loaded lists the usual suspects for that stack (multer dest, `MEDIA_ROOT`,
   `move_uploaded_file`, `MultipartFile.transferTo`, `os.Create`…).
2. Mount a named volume over **each** writable path:
   `-v <app>-uploads:/app/uploads -v <app>-data:/app/data`
3. SQLite databases count too — volume over the directory holding the `.sqlite`
   file, not just uploads.

Named volumes survive `docker rm`, image rebuilds, and auto-redeploys. When
unsure whether a path is written at runtime, mount a volume anyway — an unused
volume is harmless, lost user files are not. Every `-v` flag you use here must
be carried verbatim into any redeploy automation (github-auto-deploy § 3) and
into your final report.

## 5. Verify — never declare success without this

```
sudo docker ps --filter name=<app>        # status Up, not Restarting
curl -sSI http://127.0.0.1:<port>         # app answers
sudo docker logs --tail 30 <app>          # no crash/stack trace
```

If the container is restarting or curl fails, read the logs, fix, and retry —
do not report success on a broken deploy.

## 6. Make the deploy visible in the app (ALWAYS — first deploys AND redeploys)

Every deploy you perform must show up in the app's **Deploys tab** and (when
the user connected Telegram) ping them. This is not optional polish — a deploy
nobody can see didn't happen, as far as the user is concerned.

**Redeploying an app that is already registered?** Check first:

```
sudo cat /etc/easyhost/deploys/<app>.json 2>/dev/null
```

If that file has a `"script"` field, the app has auto-deploy automation — do
NOT hand-roll docker stop/rename/run. Redeploy with:

```
sudo /usr/local/bin/<app>-deploy.sh --force
```

That one command reuses the app's own build → health-check → rollback pipeline
and reports to the Deploys tab + Telegram by itself. Done.

Otherwise (first deploy, or no automation yet):

1. Call the `setupDeployNotifications` tool once for this server (installs
   `/usr/local/bin/easyhost-notify`; the app provisions Telegram itself —
   never handle bot tokens in commands).
2. Append your build/deploy output to the app's log so the Deploys tab can
   show it: run builds as `docker build … 2>&1 | sudo tee -a /var/log/<app>-deploy.log`
   (and echo a `$(date -Is) …` marker line before them).
3. Register the app (writeRemoteFile, sudo, mode 644, single-line JSON —
   no secrets). Include `repo`/`branch` when the dir is a git checkout,
   `envFile` when the container uses `--env-file`, omit `script` unless
   github-auto-deploy automation exists:

   ```json
   {"app":"<app>","repo":"<owner>/<repo>","branch":"<branch>","dir":"/opt/<app>","port":<port>,"log":"/var/log/<app>-deploy.log","envFile":"/opt/<app>/.env","createdAt":"<date -Is output>"}
   ```

4. Report the outcome:

   ```
   sudo /usr/local/bin/easyhost-notify <app> ok "Deployed <tag> (via agent)"      # success
   sudo /usr/local/bin/easyhost-notify <app> failed "<one-line reason>"           # had to roll back
   ```

If the user wants pushes to deploy automatically, offer the
`github-auto-deploy` skill — it builds on this same registration.

## 7. Report

Tell the user: what was deployed, image tag, the URL (or that it's local-only
pending a domain — offer the reverse-proxy-tls skill), where data lives, and the
rollback command:

```
sudo docker stop <app> && sudo docker rm <app> && sudo docker run ... <app>:<previous-tag>
```
