---
name: docker-compose-stack
description: Run a multi-service application (app + database + cache, WordPress, or any repo that ships a compose.yaml) with Docker Compose. Use whenever a deployment involves more than one container, the user mentions docker-compose / compose, or the repo already contains a compose/docker-compose file.
---

# Run a multi-service stack with Docker Compose

One compose file declares the whole stack — services, volumes, networks, restart
policy — so the entire deployment is reproducible and updatable with one command.
Use this instead of hand-running multiple `docker run` commands that nobody can
reconstruct later.

Docker's compose v2 plugin ships with the get.docker.com install (see the
`docker-deploy` skill for installing Docker). Verify with `sudo docker compose version`.

## 1. Project layout

Keep each stack in its own directory — compose uses the directory name as the
project name:

```
/opt/<app>/
  compose.yaml
  .env          # secrets, mode 600
```

If the repo already has a compose file, read it first (readRemoteFile) and check:
port bindings, volumes for data services, and where secrets come from. Fix gaps
rather than blindly running it.

## 2. Write the compose file

Conventions that prevent 3am pages:

```yaml
services:
  app:
    build: .                        # or image: ghcr.io/user/app:1.2
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"      # localhost only — nginx is the front door
    env_file: .env
    depends_on:
      db:
        condition: service_healthy  # app waits for a *ready* db, not just a started one
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data   # named volume = data survives recreation
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  db-data:
```

- **Databases get NO `ports:` entry at all** — services on the same compose network
  reach each other by service name (`db:5432`). Only publish a DB port if the user
  explicitly asked for external access, bound to 127.0.0.1 unless they insisted on
  public, with a clear warning.
- Every password in `.env`, generated with generatePassword, written via
  writeRemoteFile with mode 600. Never inline secrets in compose.yaml.
- **The app service needs volumes for its writable paths too, not just the db.**
  Uploads folders (`uploads/`, `public/uploads`, `media/`, `storage/`) live in
  the app container and are erased every `up -d --build` unless volume-backed:
  add `- app-uploads:/app/uploads` (and the volume under `volumes:`). Find the
  paths per docker-deploy § "Persistent data" / the app's framework deploy skill.

## 3. Start and verify

```
cd /opt/<app> && sudo docker compose up -d
sudo docker compose -f /opt/<app>/compose.yaml ps      # every service Up / healthy
curl -sSI http://127.0.0.1:<port>                       # the app actually answers
```

A service stuck in "restarting" or "unhealthy" → `sudo docker compose logs --tail 50 <service>`,
diagnose, fix, re-run `up -d`. Compose only recreates what changed, so re-running is safe.

## 4. Updating the stack

```
cd /opt/<app> && sudo docker compose pull && sudo docker compose up -d   # image-based
cd /opt/<app> && git pull && sudo docker compose up -d --build           # built from repo
```

Then verify as in step 3.

## Danger zone

- `docker compose down` stops and REMOVES containers (data in named volumes
  survives). Fine for a rebuild; confirm with the user first.
- `docker compose down -v` DELETES the volumes — the database. Never run it unless
  the user explicitly asks to destroy the data, and repeat the consequence back to
  them before doing it.

Finish by reporting: services running, the app URL, where the data volumes live,
and the one-line update command. Offer the `reverse-proxy-tls` skill if the stack
should be reachable on a domain.
