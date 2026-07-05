---
name: deploy-elixir
description: Elixir specifics for a Docker deploy — Phoenix or any Mix project. Use with docker-deploy whenever the app being deployed is Elixir (repo has mix.exs).
---

# Deploy an Elixir app (Phoenix)

`docker-deploy` owns the overall flow. This skill supplies the Elixir
specifics. Elixir ships as an OTP release: compile in a build stage, run the
release in a slim runtime — no Erlang/Elixir installed at runtime.

**Prefer the generated Dockerfile**: if the repo has one (Phoenix projects
often do, via `mix phx.gen.release --docker`), use it — it pins matching
Elixir/OTP/Debian versions. If the repo lacks one, write the Dockerfile below;
do not run generators against the user's repo.

## 1. Inspect the repo

- Phoenix: `phoenix` in mix.exs deps. Port 4000 by default; production reads
  `PORT` in `config/runtime.exs` — check that file for which env vars the app
  expects (`SECRET_KEY_BASE`, `DATABASE_URL`, `PHX_HOST` are standard).
- Release name: `def project` → `app:` atom in mix.exs — the start script is
  `bin/<app>`.
- Assets: Phoenix ≥1.6 uses esbuild via Mix — `mix assets.deploy` handles it,
  no Node needed. A `package.json` in `assets/` with webpack (older Phoenix)
  needs a node build step.

## 2. Dockerfile

```dockerfile
FROM elixir:1.17-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile
COPY config config
COPY lib lib
COPY priv priv
COPY assets assets
RUN mix assets.deploy && mix compile && mix release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 locales ca-certificates && \
    rm -rf /var/lib/apt/lists/* && useradd -m appuser
USER appuser
WORKDIR /app
COPY --from=build /app/_build/prod/rel/<app> ./
ENV PHX_SERVER=true
EXPOSE 4000
CMD ["bin/<app>", "start"]
```

- `PHX_SERVER=true` is required for releases — without it the release boots
  but Phoenix never starts its HTTP endpoint (silent, maddening).
- Non-Phoenix Mix apps: drop the assets lines; same release pattern.

## 3. Env & migrations

- `--env-file` with: `SECRET_KEY_BASE` (64+ chars, generatePassword),
  `PHX_HOST=<domain-or-ip>`, `DATABASE_URL=ecto://user:pass@host/db`, `PORT`.
- Database → compose stack (`docker-compose-stack`); Postgres is the Ecto
  default.
- **Uploads**: Waffle/Arc (check deps) or manual `File.cp!` handling — default
  destinations are `uploads/` or `priv/static/uploads`. `priv/static` inside a
  release is rebuilt on every deploy, so uploads there are doubly doomed:
  point the app at a stable dir if configurable, and mount a named volume over
  it (docker-deploy § "Persistent data").
- Migrations (releases have no mix): Phoenix generates a Release module —
  `sudo docker run --rm --env-file /opt/<app>/.env <app>:latest bin/<app> eval "MyApp.Release.migrate"`
  (find the real module in `lib/*/release.ex`; if absent, tell the user the
  app has no release migration path and add one is a code change).

## 4. Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` returns the app (not a Bandit/Cowboy
  404) — a running container with connection refused = PHX_SERVER unset
  (§ 2) or the app crashed post-boot: `sudo docker logs`.
- Logs free of `(RuntimeError) environment variable X is missing` — that's
  runtime.exs telling you exactly which env var to add.
