# CI builds & release, and keeping the OAuth secret out of the repo

Two workflows build the desktop app for **all platforms** (macOS arm64 + x64,
Windows x64, Linux x64):

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/build-desktop.yml` | every push to `main` (+ manual) | builds every platform, uploads the installers as build artifacts (unsigned) |
| `.github/workflows/release.yml` | pushing a `vX.Y.Z` tag (+ manual) | runs lint/typecheck/test, builds every platform, and publishes a **GitHub Release** with all installers attached |

Each platform runner produces its native distributables via `bun run make`
(electron-forge): `.zip` (macOS), Squirrel `.exe` + `.nupkg` (Windows), and
`.deb` + `.rpm` (Linux).

## Keeping the Google OAuth secret (and GitHub App config) out of the repo

The app reads these at runtime from `process.env` (in dev, from a local `.env`
via dotenv). A packaged app ships no `.env`, so `vite.main.config.ts` **bakes
them into the production main bundle at build time from the build environment**.
In CI that environment comes from **GitHub repository secrets** — the values are
never committed.

### Secrets to add (Settings → Secrets and variables → Actions → New repository secret)

| Secret name | Maps to app env var | Purpose |
|---|---|---|
| `GOOGLE_DRIVE_CLIENT_ID` | `GOOGLE_DRIVE_CLIENT_ID` | Google Drive sync OAuth client id |
| `GOOGLE_DRIVE_CLIENT_SECRET` | `GOOGLE_DRIVE_CLIENT_SECRET` | Google Drive sync OAuth client secret |
| `APP_GITHUB_CLIENT_ID` | `GITHUB_CLIENT_ID` | one-click "Connect GitHub" client id (optional) |
| `APP_GITHUB_APP_SLUG` | `GITHUB_APP_SLUG` | GitHub App slug for the install button (optional) |

> **Why the `APP_` prefix?** GitHub reserves the `GITHUB_` prefix for secret
> names — you cannot create a secret called `GITHUB_CLIENT_ID`. The workflow maps
> `APP_GITHUB_CLIENT_ID` → the `GITHUB_CLIENT_ID` env var the app actually reads.

If a secret is unset, the build still succeeds and that feature is simply
disabled (e.g. Google Drive sync stays off) — nothing crashes.

### Rotate the local secret

The Google client secret that previously lived in a working-tree `.env` should be
**rotated** in Google Cloud Console (treat any shared value as burned). Keep the
new value only in your local `.env` for development and in the GitHub secret for
CI — never commit it. (For a Google "Desktop app" client the secret is not truly
confidential — the flow is PKCE-protected — but it still must not live in the
repo.)

## Signing (later)

These builds are **unsigned**, so macOS Gatekeeper and Windows SmartScreen will
warn on first launch. Adding Apple Developer ID notarization and Windows signing
(certs + `osxSign`/`osxNotarize` in `forge.config.ts`, plus the signing secrets)
is a separate follow-up — see `improve.md` § REL-01.
