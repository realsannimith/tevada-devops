# EASY-HOST

An AI-powered server management desktop app — like Termius, but the AI agent does
the DevOps work for you. Connect to your Linux servers over SSH, open interactive
terminals, watch live monitoring dashboards, and tell an AI agent to set up hosting,
configure backups, or run any command — it executes over SSH and shows you every
step live.

Built with Electron + Vite + React + Tailwind + shadcn, the Vercel AI SDK, and
Google Gemini.

## Features

- **Multi-server management** — save any number of servers (password or SSH key),
  connect/disconnect, live status indicators.
- **Interactive terminals** — a real remote PTY per server (xterm.js), with
  scrollback preserved across tab switches. `htop`, `vim`, resize — all work.
- **AI DevOps agent** — a Gemini tool-loop agent with tools to run commands, read/
  write files (SFTP), and read stats over SSH. Runs **full-auto** by default; every
  command it runs is shown live with its output and exit code.
- **Monitoring dashboards** — per-server live CPU / memory / disk / network charts,
  uptime, load, and top processes, polled over SSH. Pauses when the tab is hidden.
- **Wizards** — guided, AI-driven playbooks: *Host a website/app* (nginx + TLS +
  deploy) and *Set up automated backups* (script + cron + test run).

## Safety

- The agent runs in **full-auto (YOLO)** mode: it executes without asking. You can
  switch to **approval mode** in Settings to confirm every state-changing command.
- A small hard **blacklist** (e.g. `rm -rf /`, `mkfs`, `dd` to a disk, fork bombs,
  `shutdown`) always requires confirmation, even in full-auto — a seatbelt, not a
  security boundary.
- **Credentials** are encrypted with your OS keychain (`safeStorage`) and stored as
  opaque blobs under the app's user-data directory. They are decrypted only in the
  main process and never cross into the renderer or the AI provider.

## Setup

1. Add a Google Gemini API key to `.env` (see `.env.example`):
   ```
   GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
   # AGENT_MODEL=gemini-3.1-pro   # optional override
   ```
   Get a key at https://aistudio.google.com/apikey
2. Install dependencies with [Bun](https://bun.sh): `bun install`
3. Run in development: `bun run start`

## Scripts

| Command | What it does |
|---|---|
| `bun run start` | Launch the app in development (hot reload) |
| `bun run package` | Build production bundles + package the app |
| `bun run make` | Build distributables (zip/dmg/etc.) |
| `bun run lint` | ESLint |
| `npx tsc --noEmit` | Type-check |

## Architecture

```
Main process (Node)                        Renderer (React)
├── main/store.ts        profiles/settings ├── App.tsx            app shell + views
├── main/secrets.ts      safeStorage       ├── ServerSidebar      server list
├── main/connection-manager.ts  ssh2       ├── ServerFormDialog   add/edit + test
├── main/monitor.ts      stats polling     ├── TerminalView       xterm PTY
├── main/ipc.ts          all IPC wiring    ├── MonitoringView     recharts
├── agent/agent.ts       streaming run     ├── ChatPanel          agent chat
├── agent/tools.ts       SSH tools         ├── WizardsView        playbooks
├── agent/blacklist.ts   safety guard      ├── SettingsDialog
├── agent/playbooks.ts   wizards           └── hooks/             state + streams
└── shared/ipc-types.ts  ← shared types + channel constants →
```

The main process owns all SSH connections (one `ssh2` client per server,
multiplexing the interactive shell, agent exec channels, and monitoring polls). The
renderer talks to it only through the `window.easyhost` bridge (see
`src/preload.ts`). The API key, the AI SDK, and `ssh2` never reach the renderer.

## End-to-end test

Against a scratch Linux VPS:

1. Add the server (password or key), click **Test connection**, save.
2. Open its **Terminal** tab, run `htop` and `vim` to confirm the interactive PTY.
3. Open the **AI Agent**, target that server, and ask
   *"install nginx and host a hello-world page"* — watch each command run live.
4. Try a request that triggers the safety guard (e.g. mentioning `rm -rf /`) and
   confirm the approval dialog appears.
5. Open **Monitoring** and run `yes > /dev/null` on the server — CPU spikes.
6. Run the **Host a website** wizard on a test domain, then **Set up backups**.
