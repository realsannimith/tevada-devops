---
name: deploy-ruby
description: Ruby specifics for a Docker deploy — Rails, Sinatra, Rack apps. Use with docker-deploy whenever the app being deployed is Ruby (repo has a Gemfile).
---

# Deploy a Ruby app (Rails, Sinatra)

`docker-deploy` owns the overall flow. This skill supplies the Ruby specifics.

**Rails 7.1+ generates a production Dockerfile** — if the repo has one, use it
(it's better tuned than anything generic). Only write a Dockerfile when the
repo lacks one.

## 1. Inspect the repo

- `bin/rails` / `config/application.rb` → Rails (port 3000, puma).
- `config.ru` without Rails → Sinatra/Rack (`rackup`, port 9292, or check the
  app file for `set :port`).
- Ruby version: `.ruby-version` or Gemfile `ruby "..."` — match the image tag.
- Database: `config/database.yml`. Postgres/MySQL → the db belongs in a
  compose stack (`docker-compose-stack`). SQLite → named volume over
  `/app/storage` (Rails 8 default) or wherever the .sqlite3 lives.
- **Uploads**: ActiveStorage with the `:local` service (check
  `config/storage.yml`) writes uploaded files to `storage/` — the same named
  volume protects them. CarrierWave/Paperclip default to `public/uploads` /
  `public/system` → volume those paths too (docker-deploy § "Persistent
  data"), or every redeploy erases user files.

## 2. Dockerfile (Rails without one of its own)

```dockerfile
FROM ruby:3.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git libpq-dev libyaml-dev pkg-config curl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV RAILS_ENV=production BUNDLE_DEPLOYMENT=1 BUNDLE_WITHOUT="development test"
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
RUN SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile
RUN useradd -m appuser && chown -R appuser /app
USER appuser
ENV RAILS_SERVE_STATIC_FILES=1 RAILS_LOG_TO_STDOUT=1
EXPOSE 3000
CMD ["bundle", "exec", "puma", "-b", "tcp://0.0.0.0:3000"]
```

Sinatra/Rack: drop the rails-specific lines; `CMD ["bundle", "exec", "rackup",
"-o", "0.0.0.0", "-p", "9292"]`.

- `SECRET_KEY_BASE_DUMMY=1` lets asset precompile run without the real secret
  (Rails 7.1+; older Rails: pass a throwaway `SECRET_KEY_BASE=dummy`).
- Node/esbuild-based assets (jsbundling) → precompile needs node: add a build
  stage `FROM node:22-alpine` for the JS build, or apt-get install nodejs.

## 3. Env & first run

- `--env-file` with `SECRET_KEY_BASE` (generatePassword, 128 hex chars) or
  `RAILS_MASTER_KEY` (contents of `config/master.key` — ask the user for it;
  it is never in the repo).
- Migrations as a one-off, not on boot:
  `sudo docker run --rm --env-file /opt/<app>/.env <app>:latest bundle exec rails db:migrate`
  (needs `db:create` first on a fresh database).

## 4. Verify (in addition to docker-deploy's checks)

- `curl -sI http://127.0.0.1:<port>/` → 200/302, not 500. Rails 500s are in
  `sudo docker logs` thanks to RAILS_LOG_TO_STDOUT.
- A page with CSS/JS actually loads assets: curl one asset URL from the HTML —
  404s mean precompile output didn't make it into the image or
  RAILS_SERVE_STATIC_FILES is unset.
- `Blocked host` error in logs → add the domain/IP to
  `config.hosts` or set `RAILS_DEVELOPMENT_HOSTS`-equivalent for the app's
  Rails version (Rails host authorization).
