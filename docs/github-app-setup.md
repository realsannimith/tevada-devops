# GitHub App setup (for "Connect GitHub" in Settings)

Tevada DevOps connects users' GitHub accounts through a **GitHub App**. Compared to
the classic OAuth flow, the user — not the app — decides which repositories are
reachable: during installation GitHub asks them to grant **All repositories** or
**Only select repositories**, and they can change that on GitHub at any time.
The app's tokens can only ever see what was granted.

You register the app **once** as its developer; every user of your build then
signs in against it. No backend server is required: Tevada DevOps uses the OAuth
**device flow**, which needs only the public client ID (never the client
secret or private key), including for token refreshes.

## 1. Register the app

GitHub → your profile picture → **Settings** → **Developer settings** →
**GitHub Apps** → **New GitHub App**, then fill in:

| Field | Value |
|---|---|
| **GitHub App name** | e.g. `Tevada DevOps` (globally unique, max 34 chars) |
| **Homepage URL** | your project/repo URL |
| **Callback URL** | leave **empty** — ignored for device flow |
| **Expire user authorization tokens** | leave **checked** (Tevada DevOps auto-refreshes) |
| **Request user authorization (OAuth) during installation** | unchecked |
| **Enable Device Flow** | **check this** — required |
| **Webhook → Active** | **uncheck** (no webhook needed) |

### Permissions (Repository permissions)

| Permission | Access | Why |
|---|---|---|
| **Contents** | **Read and write** | `git clone` / `pull` / `push` over HTTPS |
| **Metadata** | Read-only | mandatory baseline (GitHub forces it) |
| **Workflows** | Read and write *(optional)* | only if the agent should push changes to `.github/workflows/` files |

Everything else: **No access**.

### Where can this GitHub App be installed?

- **Any account** — required if you distribute Tevada DevOps to other people.
- **Only on this account** — fine while testing alone.

## 2. Wire it into Tevada DevOps

On the app's settings page (Developer settings → GitHub Apps → your app) copy
the **Client ID** (starts with `Iv…` — note: *not* the numeric App ID), and note
the **slug** from the app's public URL `https://github.com/apps/<slug>`.

In `.env`:

```
GITHUB_CLIENT_ID=Iv23xxxxxxxxxxxxxxxx
GITHUB_APP_SLUG=tevada-devops
```

The client ID and slug are public values — shipping them inside the packaged
app is fine. Do **not** put the app's client secret or private key anywhere
near Tevada DevOps; the device flow never needs them.

## 3. What users experience

1. **Settings → GitHub → Connect GitHub** — a one-time code opens github.com,
   the user authorizes, done (device flow).
2. **Grant repository access** — opens
   `https://github.com/apps/<slug>/installations/new`; the user picks their
   account/org and **All repositories** or **Only select repositories**.
   The Settings panel picks the new installation up automatically.
3. **Manage** next to an installation opens GitHub's page for changing the
   repo selection (or uninstalling) later.
4. **Server access** toggles put the user's GitHub token into that server's
   git credential store, so any `git` command against github.com — the user's
   or the agent's — authenticates automatically.

## Token lifecycle (handled automatically)

- User access tokens (`ghu_…`) expire after **8 hours**; the refresh token
  (`ghr_…`) lasts **6 months**. Tevada DevOps refreshes transparently before use
  and re-pushes the rotated token to every authorized server it can reach —
  plus, before each agent run, to the servers that run targets.
- If the refresh token itself expires (6 months without use) the Settings
  panel shows a **Reconnect** prompt.
- Tokens are stored with Electron `safeStorage` (OS keychain encryption) and
  never cross into the renderer process.

## Troubleshooting

- **"GitHub did not return a device code"** — Device Flow isn't enabled on the
  app (step 1).
- **"The GitHub App slug is not configured"** — set `GITHUB_APP_SLUG` in
  `.env`, or the user can install once via the app's public GitHub page after
  which the slug is learned automatically.
- **A private repo doesn't show up / clone fails with 404** — the user chose
  "Only select repositories" without it; use **Manage** to add the repo to the
  installation.
- **Push rejected touching `.github/workflows/`** — the app needs the
  optional **Workflows: Read and write** permission; after adding it, users
  must approve the new permission on the installation.
