# AGENTS.md

## Project Snapshot

EASY-HOST is an Electron desktop app for AI-driven server management (SSH terminals,
monitoring, DevOps agent, wizards). Stack: Electron + Vite + React + Tailwind v4 +
shadcn + Gemini agent loop.

Design reference: **FCode / Codex** — see `../FCode/design.md` and `src/index.css`.
When building or changing UI, match existing surfaces in `ChatPanel.tsx`,
`WizardsView.tsx`, and `AgentFeed.tsx` before inventing new patterns.

## UI Design System (Required)

EASY-HOST follows the FCode “quietly-confident native developer tool” look. **Do not
ship generic admin/form UI** (heavy borders, blue primary CTAs, floating input boxes,
full-strength pane dividers).

### Surfaces & depth

| Role | Token / class | Use |
|------|----------------|-----|
| Canvas (main column) | `bg-background` | Chat, wizards, transcript — **not** `bg-card` |
| Raised control / composer | `--composer-surface`, `.composer` | Chat input, grouped form panels |
| Grouped settings / wizard fields | `.surface-panel` | Divided field groups on canvas |
| Elevated chips/cards | `bg-card` | Tool cards, wizard picker tiles |
| Sidebar / popovers | `.glass`, `.glass-popover` | Frosted chrome only |

Depth = **hairlines + soft surface shadow**, not drop shadows on every box.

### Dividers

- Header / footer hairlines: `.chat-surface-divider` (not `border-b border-border`)
- Vertical pane splits: `.chat-surface-divider-vertical` (not full `border-r`)
- Token: `--app-surface-divider` (60% mix of `--border`)

### Color vocabulary

- **Codex blue** (`--primary`): links, focus rings, small accents — **not** full-width primary CTAs
- **Ink prominent** (`Button variant="prominent"`): send, run wizard, stop — rounded-full, `bg-ink`
- **Skill violet** (`--skill`, `.skill-chip`): agent/wizard affordances only
- **Success / destructive / warning**: status dots, exit codes, errors — scoped use
- User message bubbles: `bg-[var(--app-user-message-background)]` (= `var(--secondary)`)

### Typography

- Base UI: 12px, `tracking-[-0.015em]`, system sans (`body` / `font-sans`)
- Headings / emphasis: `text-ink`, weight 600 sparingly (prefer 500)
- Chat transcript prose: `font-sans text-xs leading-relaxed` via `CHAT_TRANSCRIPT_TEXT_CLASS_NAME`
- Labels in forms: `text-[11px] text-muted-foreground`
- **JetBrains Mono** only on: `input`, `textarea`, `pre`, `code`, terminal — not chat bubbles

### Chat & agent surfaces

Reuse shared pieces:

- `AgentFeed` — transcript + tool cards + approval dialog (chat **and** wizards)
- `chat/chatTypography.ts` — user bubble radius/padding tokens
- Header row: skill chip + title + subtitle + `.chat-surface-divider`
- Composer footer: `.composer` shell, ghost picker triggers, `prominent` send/stop

### Wizards & forms

- Config column: `surface-panel` with `divide-y divide-border` rows — not loose stacked inputs
- Controls: full width, `bg-secondary border-border` — avoid `bg-card` / `dark:bg-input/32` boxes on canvas
- Run/stop in header as `prominent` (match `ChatPanel`), not `default` (blue) or `destructive`
- Agent output pane: same `AgentFeed` + `bg-background` as chat

### Anti-patterns (reject in review)

```tsx
// ❌ Canvas as white card, harsh split, blue CTA
<div className="bg-card border-r border-border">
  <Button className="w-full">Run</Button>
</div>

// ✅ Canvas, soft divider, ink CTA, grouped panel
<div className="bg-background chat-surface-divider-vertical">
  <div className="surface-panel divide-y divide-border">…</div>
  <Button variant="prominent" className="rounded-full">Run wizard</Button>
</div>
```

### Theme

- `next-themes` with `class` on `<html>`; tokens in `src/index.css` (`:root` / `.dark`)
- Light canvas `#fcfcfc`, dark `#0e0e0e` — keep in sync with FCode defaults when adding tokens

## Agent skills

The DevOps agent uses the standard Agent Skills pattern (progressive disclosure):

- Bundled skills live in `src/agent/skills/<name>/SKILL.md` — frontmatter
  (`name`, `description`) + markdown instructions, compiled in via Vite `?raw`.
  Register new ones in the import list in `src/agent/skills.ts`.
- Only the one-line descriptions enter the system prompt; the agent loads a
  skill's full body on demand through the `skill` tool (defined in `skills.ts`,
  merged with the server tools in `agent.ts`).
- Users can add or override skills at `<EASYHOST_HOME>/skills/` (re-read every
  run, no restart needed).
- Docker is the standard deployment path — new deploy-ish skills should build on
  `docker-deploy` / `docker-compose-stack` rather than native installs.
- Framework coverage: `docker-deploy` owns the deploy flow and routes (§ 3) to
  per-stack skills that supply the production Dockerfile + framework specifics —
  `deploy-python`, `deploy-nodejs`, `deploy-ssr-frontend`,
  `deploy-static-frontend`, `deploy-go`, `deploy-jvm`, `deploy-php`,
  `deploy-ruby`, `deploy-rust`, `deploy-dotnet`, `deploy-elixir`, and
  `deploy-any-stack` (detects/derives a recipe for anything without a dedicated
  skill). New stack skills should follow that shape: detection → Dockerfile →
  env/migrations → verify.
- Write descriptions with an explicit trigger ("Use when…") — the description is
  the only thing the model sees when deciding to load a skill. Keep bodies
  imperative, explain the why, and end with verify + report steps.

## Auto-deploy visibility (Deploys tab + Telegram)

`github-auto-deploy` wires every automated deployment into the app via a
server-side contract owned by `src/main/deployments.ts`:

- `/usr/local/bin/easyhost-notify` — installed by the agent's
  `setupDeployNotifications` tool (never hand-written by the model). The
  redeploy script calls `easyhost-notify <app> start|ok|failed|rollback "<msg>"`;
  the helper appends a JSON line to `/var/log/easyhost/deploy-events.jsonl`
  and mirrors ok/failed/rollback/test to Telegram when configured. It always
  exits 0 — notifications must never break a deploy.
- `/etc/easyhost/telegram.env` (root, 600) — bot token + chat id, provisioned
  by main directly from the encrypted alert config (Settings → Alerts) so the
  token never enters the LLM context, and deploy notifications work while the
  app is closed (deploys run from cron, not from us).
- `/etc/easyhost/deploys/<app>.json` — registry entry (no secrets) the skill
  writes per deployment; feeds the server view's **Deploys tab**
  (`DeploymentsView.tsx` → `deploys:list` / `deploys:log` IPC), which shows
  status, event history and a searchable tail of `/var/log/<app>-deploy.log`.
- The **Environment (.env) editor** lives in the **Artifacts tab**
  (`EnvFileDialog.tsx`, opened by the ".env" button on any container that
  matches a registered deployment — NOT in the Deploys tab, which stays
  history + logs). It resolves the path from the registry's `envFile`, or
  falls back to `<dir>/.env` (docker-deploy convention) and creates the file
  on first save. `deploys:env-read` / `env-write` via `lib/envFile.ts` (raw
  opaque values, comment-preserving). Its **Redeploy** / "Save & redeploy"
  button calls `deploys:redeploy`, which runs the app's own deploy script
  with `--force`, detached — so deploy scripts must support `--force` and take
  a `flock` (both in the skill's template). Redeploy is only offered when the
  registry entry has a `script`.

Changing the helper script, event format or registry shape means updating
`deployments.ts` (+ its tests) AND the github-auto-deploy skill together.

## Dev

- Isolated dev: `bun run electron:dev` (data under `./.easyhost/electron-dev`)
- Do not commit secrets (`.env`, credentials)

