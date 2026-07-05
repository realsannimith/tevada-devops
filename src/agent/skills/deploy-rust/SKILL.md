---
name: deploy-rust
description: Rust specifics for a Docker deploy — Axum, Actix Web, Rocket, Warp, or any Rust binary. Use with docker-deploy whenever the app being deployed is Rust (repo has Cargo.toml).
---

# Deploy a Rust app (Axum, Actix, Rocket…)

`docker-deploy` owns the overall flow. This skill supplies the Rust specifics.
Like Go: compile once, ship a small binary. Unlike Go: release builds are
slow — set runCommand timeoutSec to 900 for the image build, and warn the user
a first build can take several minutes.

## 1. Inspect the repo

- Binary name: `[package] name` in Cargo.toml (dashes in the name become the
  binary name as-is). A workspace (`[workspace]` + `members`) → find the
  server crate and build with `-p <crate>`.
- Port + bind address: grep for `bind(`, `Server::` and `PORT`. Axum/Actix
  examples default to 3000/8080 and often bind `127.0.0.1` — inside a
  container it **must** bind `0.0.0.0` or nothing outside the container can
  reach it. If the code hardcodes 127.0.0.1 and reads no env, tell the user
  it needs a one-line change (or an env like `HOST`).
- Rocket: binds 127.0.0.1 by default — always set `ROCKET_ADDRESS=0.0.0.0`
  (and `ROCKET_PORT`) in the image env.

## 2. Dockerfile

```dockerfile
FROM rust:1-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/* && useradd -m appuser
USER appuser
COPY --from=build /src/target/release/<binary> /usr/local/bin/app
EXPOSE 8080
CMD ["app"]
```

- Runtime stays debian-slim (glibc): the default Rust target links glibc, so
  a scratch/alpine runtime segfaults unless the app was built for musl. Don't
  bother with musl unless the user asks for a minimal image.
- `libssl3` + ca-certificates only if the app makes outbound TLS calls
  (native-tls); apps using rustls need only ca-certificates.
- Config: most Rust web apps read env vars (dotenvy) — `--env-file` per
  docker-deploy. Rocket also reads `Rocket.toml`; copy it into the image if
  present.
- **Uploads / writable data**: grep for `File::create`, `create_dir_all`,
  `tokio::fs::write` and multipart handling — typical dirs `uploads/`,
  `data/`; SQLite paths count too. Named volume over each
  (docker-deploy § "Persistent data") — the container filesystem is erased on
  every redeploy/auto-deploy.

## 3. Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` answers. Connection reset/refused with a
  running container almost always means the app bound 127.0.0.1 inside the
  container — see § 1.
- Logs: Rust apps that panic on missing env (`expect("DATABASE_URL")`) exit
  immediately — a Restarting container means read the first panic line.
