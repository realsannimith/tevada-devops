# AGENTS.md

## Project Snapshot

Tevada DevOps is an Electron desktop app for AI-driven server management (SSH terminals,
monitoring, DevOps agent, wizards). Stack: Electron + Vite + React + Tailwind v4 +
shadcn + Gemini agent loop.

Design reference: **FCode / Codex** — see `../FCode/design.md` and `src/index.css`.
When building or changing UI, match existing surfaces in `ChatPanel.tsx`,
`WizardsView.tsx`, and `AgentFeed.tsx` before inventing new patterns.

## UI Design System (Required)

Tevada DevOps follows the FCode “quietly-confident native developer tool” look. **Do not
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
- Security is a two-skill pair: `security-audit` is the **read-only** detection
  pass (finds weak points + compromise indicators, changes nothing, reports
  ranked by severity) and `server-hardening` **applies** the fixes (firewall,
  SSH, fail2ban, auto-updates). "Is my server safe / has it been hacked?" →
  audit first, harden only on the user's go-ahead. Any new read-only diagnostic
  skill must keep that firewall: observe and report, never mutate on a suspicion.

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

**Telegram message standard** (alerts + deploys share one Render-style shape,
pinned by alerts.test.ts / deployments.test.ts):

```
<icon> <b>Event title</b>          🔴 High memory usage   /  ✅ Deploy succeeded
<b>subject</b> · detail            E · Memory at 95% (threshold 90%)
<i>context · readable time</i>     recovered after 12m · Jul 6, 1:24 PM
```

Times are always human-readable 12-hour ("Jul 6, 1:24 PM"), never ISO — the
JSONL event stream keeps `date -Is` (the app parses it). App-side messages are
built by `renderAlertHtml` (alerts.ts, with incident duration from
`RuleState.firedAt`); server-side by the notify helper's `WHEN=$(date '+%b %-d,
%-I:%M %p' ...)`. Existing servers keep the old helper until the agent re-runs
`setupDeployNotifications` (install is an overwrite, safe to re-run).

## Agent task list (todo checklist)

The DevOps agent can maintain a live task checklist the user watches — like
Claude Code / Cursor's todo panel. The `updateTodos` tool (tools.ts) takes the
full ordered list every call (`{ text, status: pending|in_progress|completed }[]`)
and emits a `todos` AgentEvent — it does NOT emit tool-start/tool-end, so no
generic command row appears. The system prompt tells the agent to use it for any
job over ~3 steps, keeping exactly one item `in_progress`.

Reduction is shared: `applyTodos` (useAgentRun.ts) folds a `todos` event into
the feed as ONE evolving `ChatTodoHistoryItem` — it updates the existing card in
place (stable id → stable React key) instead of appending, so boxes tick off
without spamming the transcript. Used by both the foreground reducer
(useAgentRun) and background runs (chatRunManager). Persisted via the `todos`
case in store.ts `isChatHistoryItem` (add-only validation — forgetting it
silently drops the item on save).

Two-part render in AgentFeed.tsx, matching how Claude Code + RooCode reconcile a
task list with a streaming transcript (research-grounded — both keep ONE current
list, always visible):
- `TodoStatusBar` — a **pinned summary bar above the scroll area** (RooCode's
  "task header" pattern), always showing progress (N/total + progress track) and
  the in-flight task, so the checklist stays in view while text/tool cards stream
  past and scroll it off. Click to expand the full list inline.
- `TodoCard` — the **in-transcript record** (in-place updating) marking where the
  plan was laid out, the way Claude Code renders it inline.
Both use the shared `TodoRows` (glyphs: completed = filled check + strikethrough,
in_progress = spinner + bold, pending = hollow circle — no bare status dots) and
`todoProgress` helper. The bar reads `feed.find(kind==='todos')` so it updates
live as the reducer patches the single todos item.

## Steer & queue messages (send during a run)

The composer stays enabled while a run streams (FCode's model). `TurnDispatchMode`
= 'queue' | 'steer'. **Enter** while running → QUEUE (parks the message in the
`ComposerQueuedHeader` above the composer, with Send-now/Edit/Delete; auto-sent
when the run ends via ChatPanel's drain effect). **Cmd/Ctrl+Enter** → STEER
(injected into the live run now).

- Mid-run steer: `steerAgentRun(runId, items)` (agent.ts) pushes onto a per-run
  `steerQueue`; the ToolLoopAgent's `prepareStep` folds them in as fresh user
  messages at the next reasoning step (`injectSteerMessages`) — redirects without
  aborting work. `agent:steer` IPC. A steer that lands after the final step is
  returned via a `steer-unconsumed` event; chatRunManager `resendSteers` sends it
  as a fresh turn so it's never lost.
- chatRunManager.`steer(sessionId, item)` echoes the message (dispatchMode:'steer'
  → "Steering" chip in AgentFeed) then injects; falls back to a fresh turn if the
  run already ended. `start({echoUser:false})` continues from a feed that already
  has the user bubble. Message-building lives in `lib/chatMessages.ts`
  (`buildAgentMessages` / `feedToMessages`), shared by ChatPanel and the resend.

**VERIFY WARNING (learned the hard way):** contextBridge FREEZES
`window.easyhost.*`, so you CANNOT stub `agent.start`/`steer` in a CDP script —
the reassignment is a silent no-op and a REAL run fires (which hit prod server E
once). To verify chat UI, INJECT persisted sessions + screenshot only (never call
`send()`/dispatch a real message), or target a disposable server — never
"All servers"/E.

## Chat attachments (files & images)

The composer accepts files/images (attach button, paste, drag-drop). Images go
to the model as vision input; text/config/code files are inlined into the prompt
so the agent can read and deploy them.

- `ChatAttachment` (ipc-types) on `ChatTextHistoryItem.attachments` +
  `AgentStartRequest.attachments`; caps in `ATTACHMENT_LIMITS` (5 files, 5MB
  image, 128KB text). `src/lib/attachments.ts` (renderer): classifyFile
  (image/text/unsupported by MIME then extension), readFileAttachment (enforces
  caps, image→dataUrl / text→content), formatBytes.
- `src/agent/attachments.ts` (main): `buildModelMessages(textMsgs, attachments)`
  folds the turn's attachments into the LAST user message as multimodal
  ModelMessage content (images → image parts, text files inlined). Only the
  current turn carries attachments — history stays text-only so big images
  aren't re-sent. Called in ipc.ts before startAgentRun; agent.ts ChatMessage is
  now `ModelMessage`.
- ChatPanel composer: attach state, addFiles (reads BEFORE the setState updater
  — side effects in a state updater double-fire under StrictMode and staged
  every file twice), AttachmentChip previews, paperclip button, onPaste/onDrop.
  chatRunManager.start carries attachments onto the user feed item + req.
  AgentFeed `MessageAttachments` renders image thumbnails + file chips on user
  bubbles. Persisted automatically (text item's optional attachments field).

## Agent-requested forms (generative UI) + domain setup

The agent can render an interactive FORM in the chat and pause until the user
fills it in — instead of asking for each value in plain text. The plumbing
mirrors the approval flow (agent pauses, user responds, agent continues):

- `requestForm(spec)` in AgentToolContext (ipc.ts) returns a Promise resolved
  with the user's values (or null on cancel). It emits a `form-required`
  AgentEvent and parks a resolver in `pendingForms` keyed by formId; the
  `agent:respond-form` IPC handler resolves it. Cleared (resolve null) on
  nav/close, same as pendingApprovals.
- Field defs live in CODE (`src/agent/forms.ts`), NOT in the model's tool args
  — keeps the agent tool schemas flat (Gemini constraint) and lets us design
  each form. `buildDomainForm({appName, suggestedPort})` builds the domain form.
- Tool: `requestDomainSetup(appName?, suggestedPort?)` (tools.ts) — the agent
  MUST detect the service port itself (`docker ps`/`ss`) and pass suggestedPort;
  the form shows the user the detected port pre-filled (the user never types a
  port). Returns `{submitted, values}` or `{submitted:false}` on cancel.
- Feed item `ChatFormHistoryItem` (kind:'form', status pending→submitted/
  cancelled + values). Reduced by `form-required` in BOTH useAgentRun and
  chatRunManager; settled by `resolveFormItem` (shared) via respondForm.
  Rendered by `FormCard` in AgentFeed (text/number/select/toggle fields; live
  Submit/Cancel when pending, read-only record once settled). Persisted via the
  `form` case in store.ts isChatHistoryItem (allowlist — MUST add new kinds or
  they're silently dropped). markInterruptedToolsDone also cancels a form frozen
  at 'pending' (dead run).
- `setup-domain` skill = the form-first entry point (call requestDomainSetup,
  then delegate the nginx/certbot work to the existing reverse-proxy-tls skill).
  Artifacts rows (website/container/service) have a "Domain" button that
  prefills the chat via CHAT_PREFILL_EVENT.
- **In-form DNS guide**: the domain form carries `dnsGuide {serverIp,
  domainField, wwwField}` (AgentFormSpec + ChatFormHistoryItem). The agent passes
  its `serverIp` to requestDomainSetup; `FormCard`'s `DnsGuidePanel` renders a
  live A-record table (Type A / Name computed from the typed domain via
  `computeDnsRecordName` in lib/dns.ts — "@" for bare, label for subdomain, +
  a www row when the www toggle is on / Value=serverIp / TTL 3600) plus
  registrar steps. Reducers copy `dnsGuide` onto the feed item. So the "how do I
  point my domain here" guidance is IN the form, not just in a later chat reply.

## Artifacts tab operations (actions, logs, exposure)

The Artifacts tab is operable, not just an inventory (`ArtifactsView.tsx` +
`src/main/artifacts.ts`):

- **Row actions** — Start/Stop/Restart on container (`docker`) and service
  (`systemctl`) rows via `artifacts:action`; icon-only ghost buttons with
  tooltips (labels crowded names off the row). Runtime is derived from the
  artifact id prefix (`container:` / `service:`). Names are validated against
  `isSafeUnitName` (single-quoted in the command; escaping pinned by
  `artifacts.test.ts`) and execs try plain first, `sudo -n` second — the
  deployments.ts idiom.
- **Logs** — `artifacts:logs` tails `docker logs --tail 200` / `journalctl -u`
  into an expandable per-row panel (same searchable 4s-polling pattern as the
  Deploys tab's build log). journalctl goes sudo-first: non-root gets an
  empty-but-exit-0 result.
- **Exposure strip** — aggregates `remoteAccessible` artifacts at the top of
  the tab (one entry per port; databases win the tone and tint it warning).
  "Review with agent" opens the chat pre-filled via `CHAT_PREFILL_EVENT`
  (`lib/chatHistory.ts`) — always a fresh session, target scoped to the server.
- The tab auto-rescans every 60s while open (silent scan keeps the list on
  screen); website rows get an "Open" button (main.ts `setWindowOpenHandler`
  routes any renderer `window.open`/`target=_blank` http(s) URL to the real
  browser and denies child windows).

## Dev

- Isolated dev: `bun run electron:dev` (data under `./.easyhost/electron-dev`)
- Do not commit secrets (`.env`, credentials)

