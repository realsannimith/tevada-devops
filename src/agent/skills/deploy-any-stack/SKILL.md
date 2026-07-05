---
name: deploy-any-stack
description: Identify any app's language/framework from its files and route to the right deploy skill — or derive a best-practice Dockerfile for stacks with no dedicated skill (Deno, Kotlin, Scala, Clojure, Haskell, Swift, Dart, C++, Zig, OCaml, R…). Use when it's unclear what kind of app is being deployed, or when no framework-specific deploy skill matches.
---

# Deploy any stack — detect, route, or derive

`docker-deploy` owns the overall flow. Use this skill when you don't yet know
what the app is, or when nothing else matches. Never guess a stack — the repo
always tells you.

## 1. Detect and route

`ls -la` the repo root (runCommand) and match marker files:

| Marker | Stack | Load |
|---|---|---|
| `requirements.txt`, `pyproject.toml`, `Pipfile` | Python | `deploy-python` |
| `package.json` + next/nuxt/sveltekit/remix/astro | SSR frontend | `deploy-ssr-frontend` |
| `package.json` + vite/react-scripts/angular.json, or pure content site | static frontend | `deploy-static-frontend` |
| `package.json` (server frameworks / anything else Node) | Node.js | `deploy-nodejs` |
| `go.mod` | Go | `deploy-go` |
| `pom.xml`, `build.gradle(.kts)` | JVM (Java/Kotlin/Scala) | `deploy-jvm` |
| `composer.json`, `artisan`, `wp-config.php` | PHP | `deploy-php` |
| `Gemfile` | Ruby | `deploy-ruby` |
| `Cargo.toml` | Rust | `deploy-rust` |
| `*.csproj`, `*.sln` | .NET | `deploy-dotnet` |
| `mix.exs` | Elixir | `deploy-elixir` |
| `docker-compose.yml` in repo | pre-made stack | `docker-compose-stack` |
| `Dockerfile` in repo | any | just build it (docker-deploy § 3) |

Several markers at once (monorepo)? Ask the user which app to deploy, or look
for `apps/`/`services/` and deploy the one they named.

## 2. No match — derive a Dockerfile from first principles

For anything else (Deno, Bun-only, Swift/Vapor, Dart, Haskell, Clojure, C++,
Zig, OCaml, Crystal, Perl, R…), the recipe is always derivable:

1. **Find the run instructions the project already wrote**: README build/run
   sections, `Makefile`, `Procfile` (`web:` line is the exact start command),
   `.github/workflows/*.yml` (CI shows the real build commands), existing
   `fly.toml`/`render.yaml`/`app.json` (they name build+start commands and
   the port).
2. **Pick the official image** for the language, pinned to the version the
   repo declares (version files like `.tool-versions`, `dvm`, `stack.yaml`
   count). Starting points: Deno → `denoland/deno` (`deno task start` or
   `deno run -A main.ts`); Swift/Vapor → `swift:5.10-slim` build →
   `swift:slim` run; Dart → `dart:stable` `dart compile exe` → copy the exe
   onto `debian:bookworm-slim`; Clojure → `clojure:temurin-21-tools-deps`
   build an uberjar → JRE runtime (then it's just `deploy-jvm` § 2's runtime
   half); Haskell → `haskell:9` stack/cabal build → slim runtime; C/C++ →
   build with `gcc:14`/cmake → `debian:bookworm-slim` + needed shared libs.
3. **Compiled language → multi-stage** (build stage + minimal runtime);
   **interpreted → single stage** with deps installed from the lockfile.
4. **Find the port**: grep the source for `listen`, `serve`, `bind`, `PORT`.
   The app must bind `0.0.0.0` inside the container, not 127.0.0.1.
5. **Apply the universal rules** — these are what "best practice" means here:
   - Pin image versions; never bare `latest` for the base image.
   - Copy dependency manifests first, install, then copy source (layer cache).
   - Run as a non-root user in the final stage.
   - Exec-form CMD (`["bin", "arg"]`) so signals reach the process.
   - Secrets only via `--env-file` (mode 600), never in image or CLI.
   - `EXPOSE` the real port; publish on 127.0.0.1 per docker-deploy.
   - Writable data paths → named volumes, or data dies with the container.
     Upload folders are the classic miss: many projects save user uploads in
     the project tree (`uploads/`, `media/`, `storage/`, `files/`) — grep the
     source for its file-write/upload API before first run and volume every
     hit (docker-deploy § "Persistent data"), or the next redeploy/
     auto-deploy erases the users' files.
6. Build, run, verify per docker-deploy §§ 3–5 — and iterate: a failed build
   names the missing tool; install it in the correct stage, don't bloat the
   runtime.

If after reading README + CI you still can't determine how to build or start
the app, ask the user for the start command instead of inventing one —
report exactly what you looked at.
