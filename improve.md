# Tevada DevOps — Improvement & DevOps Roadmap

**Prepared:** 2026-07-08 · **Commit audited:** `f216370` · **Advisor pass:** read-only survey (no source changed)

Tevada DevOps is an Electron desktop app that manages remote Linux servers over SSH and drives
them with a full-auto AI agent (SSH terminals, live monitoring, deploy skills, wizards). This
document answers two questions:

1. **What DevOps / infrastructure-management features should the app add next** to be a credible
   production-grade server-management product (§ 1).
2. **What has to harden for the app *itself* to be production-ready** to ship to users — security,
   correctness, and release engineering (§ 2–4).

Verification baseline is healthy: `bun run test` → **172 tests pass** (19 files), `bun run typecheck`
→ **clean**. The gaps below are about *coverage* and *capability*, not a broken build.

Everything is evidence-cited (`file:line`). Effort is S (hours) / M (a day-ish) / L (multi-day).
Nothing here has been implemented — these are handoff plans.

---

## How to read the priority

The single most important theme: **this app runs privileged, autonomous commands on production
servers, and several of its safety and lifecycle guarantees don't hold up under the code.** Those
come first. Feature expansion (§ 1) is where the *product* wins, but the correctness/security items
in § 2–3 are what keep it from hurting a user's server.

Suggested order:

1. **DEVOPS-FEAT before anything the user sees** — but land the two red-flag correctness fixes
   (CORE-01 "Stop" doesn't stop, CORE-02 store wipe) first; they're small and they protect data.
2. **SEC-01 (SSH host-key verification)** and **SEC-02 (credentials in plaintext transcript)** —
   highest-leverage security, contained fixes.
3. Then the feature roadmap in § 1, which the existing architecture makes cheap.
4. Release engineering (§ 4) before the first real external release.

---

## § 1 — DevOps & Infrastructure features to add next

These are grounded in what the code *already half-builds*. Each is disproportionately cheap because
the data model, connection layer, or agent skills already exist — the gap is the last mile.

### [FEAT-01] Database restore — the missing half of backups · Effort M · Confidence HIGH

The app schedules and runs database backups (`src/agent/playbooks.ts:337` `setup-backups`;
`src/agent/skills/setup-database-backup/SKILL.md`) and even surfaces backup cron jobs as artifacts
(`src/main/artifacts.ts:238`, `kind:'backup'`). But there is **no restore** — no skill, no wizard,
no action. The backup skill itself states "a backup that was never restored is not a backup"
(`setup-database-backup/SKILL.md:85`) then only prints a one-line manual restore command.

**Why it matters:** the product creates backups but can't use them. The single most valuable moment
for this tool — a bad migration, a dropped table — is exactly when it goes silent and hands the user
a raw dump file. Create-without-consume asymmetry.

**Sketch:** a `restore-database` skill that lists discoverable dump files (local dir + S3 via the
existing `setup-s3-storage` credentials), confirms the target, and restores into a fresh DB by
default; optionally a "Restore" button on `backup`/`database` artifact rows, surfaced the way
`setup-domain` is surfaced today. Destructive → explicit confirm required.

### [FEAT-02] One-click rollback in the Deploys tab · Effort M · Confidence HIGH

Deploy scripts already auto-rollback on a failed health check
(`src/agent/skills/github-auto-deploy/SKILL.md:125`), the event stream carries a `rollback` status
(`src/shared/ipc-types.ts:750`), and `DeploymentsView.tsx:66` already renders a rollback chip. But
the only user-driven deploy action is `forceRedeploy` (`src/main/deployments.ts:395`), which
re-runs the *latest* build. There is no manual rollback IPC anywhere.

**Why it matters:** when a pushed commit is bad, the user's only self-serve option is to push a
revert and wait for the poller. "Roll back to the previous good deploy" is the headline feature of
every deploy product (Render, Vercel, Dokploy) and it's one action away from plumbing that exists.

**Sketch:** have the redeploy script tag the prior image `previous`; add a `deploys:rollback` IPC
mirroring `deploysRedeploy`, plus a Deploys-tab button gated on a retained prior version. Must reuse
the deploy path's flock + health-check discipline.

### [FEAT-03] Fleet operations — the app has fleet *visibility* but no fleet *actions* · Effort L · Confidence HIGH

`DashboardView.tsx` is an explicit "all servers at a glance" roll-up, the connection manager
multiplexes many servers, and projects already group servers with `allowedServerIds`
(`src/agent/tools.ts:99`). But every *mutating* surface is single-server: agent tools each take one
`serverId`, and artifacts/deploys/monitor IPC are all per-server. There is no batch path.

**Why it matters:** managing 10 servers means repeating every task 10×. The credible next tier for a
server-management product is fleet ops — "run this across the project", "apply security updates to
all", "which servers are missing a firewall". The data model (projects) and connection layer already
support the fan-out.

**Sketch:** start **read-only** ("run this diagnostic across the project") to prove a fan-out UI that
aggregates N parallel per-server results, then extend to state-changing batch ops behind the same
approval seatbelt. This is a design/spike, not a one-shot build.

### [FEAT-04] Secure DB tunnelling instead of exposing ports to the internet · Effort M · Confidence HIGH

The `enable-db-remote-access` playbook (`src/agent/playbooks.ts:303`) republishes DB ports on
`0.0.0.0` and finishes by *warning the user* the database is now "reachable from the internet and
protected only by its password" (`playbooks.ts:330`). Meanwhile `connection-manager.ts` has SSH but
no port forwarding (no `forwardOut`/tunnel anywhere).

**Why it matters:** the app's own remote-DB story is a security-poor pattern it apologises for.
Termius — the stated comparison — sells SSH tunnelling precisely so a remote DB never faces the
internet. A local port-forward over the *existing* SSH connection lets the user point DBeaver/psql at
`localhost:5432` with zero exposure — a strictly safer productization of a flow that already exists.

**Sketch:** `ssh2` supports `forwardOut`; add a tunnelling method to `ConnectionManager` and a
"Connect locally" action on database artifacts that opens a local `net.createServer` bridge and shows
the `localhost` connection string. Additive — doesn't touch the existing exposure path.

### [FEAT-05] Firewall / exposure control panel · Effort M · Confidence HIGH

`artifacts.ts` already parses every listening port (`parsePorts`, `artifacts.ts:172`) and flags
`remoteAccessible` (`artifacts.ts:87`); the Artifacts tab renders an "Exposure strip" from this.
`server-hardening` configures ufw/firewalld. But there is **no firewall-state view and no control** —
the exposure strip's only remediation is "Review with agent" (hands the user back to chat).

**Why it matters:** the app detects "your database is open to the internet" but can't show the
firewall rules or let the user close the port. A firewall panel (read ufw/firewalld state, one-click
close a port) turns *detection* into *remediation* — what a security-conscious hosting tool needs.

**Sketch:** a `firewall:scan` IPC (mirroring the combined-exec pattern in `artifacts.ts`) + a rules
view; wire the exposure strip's "close this port" to a close-port action. **Guardrail:** never touch
the SSH port — closing the wrong port locks the user out.

### [FEAT-06] Alert history & incident/uptime timeline · Effort M · Confidence HIGH

`AlertEvent` is pushed to the renderer "for a live activity log" (`src/shared/ipc-types.ts:860`) and
`AlertEngine` already computes incident duration via `RuleState.firedAt` (`src/main/alerts.ts:48`).
But **nothing persists it** — `store.ts` stores no alert history, and metric history is a 60-sample
in-memory buffer that resets on every server switch (`src/hooks/useMonitorStats.ts:9`). Tellingly,
the `monitoring-uptime` skill offloads history to a *separate* Uptime Kuma container because the app
can't do it itself.

**Why it matters:** no uptime %, no incident timeline, no trend charts, no "when did this start" —
the observability table stakes for server management. Everything needed (event stream, durations) is
already computed and thrown away.

**Sketch:** append `AlertEvent`s to a JSONL/store, optionally down-sample metrics; render an incidents
list + uptime rollup on the Dashboard/Monitoring view. Additive persistence, LOW risk.

### [FEAT-07] General scheduled-task (cron) manager · Effort M · Confidence HIGH

`artifacts.ts:238` only surfaces cron lines matching `BACKUP_HINT` (`backup|dump|rsync|restic|borg`)
— every other scheduled job on the box is invisible. There is no IPC to add/edit/remove/run-now a
cron entry. The `setup-backups` flow writes `/etc/cron.d/easyhost-backup` but nothing reads it back
generically.

**Why it matters:** scheduled tasks are core DevOps surface (renewals, cleanups, jobs). The scanner
is already half-parsing crontab; showing *all* jobs and letting the user toggle/run/edit one is a
natural, cheap productization.

**Sketch:** promote cron parsing into its own scan (drop the backup-only filter) + a "Scheduled tasks"
panel with view/toggle/run-now. Editing crontab needs safe write-back (stage + validate).

### [FEAT-08] Live log follow + cross-service search · Effort M · Confidence MED

`artifacts.ts:309` (`LOG_TAIL_LINES = 200`) and `deployments.ts:41` tail a fixed window and both
views *poll every 4s* rather than streaming; search is single-source
(`DeploymentsView.tsx:491`). No live follow (`journalctl -f` / `docker logs -f`), no aggregation
across app + proxy + DB logs.

**Why it matters:** real debugging needs a live tail and grep across services at once. The current
fixed-tail-poll is fine for a glance but not for chasing a live incident — the moment a practitioner
most needs the tool.

**Sketch:** a follow-mode log stream (main→renderer events) reusing the artifact-log command builders;
later merge multiple sources.

### [FEAT-09] DNS automation — the app already knows the exact record it wants · Effort L · Confidence MED-HIGH

`setup-domain` renders a *manual* DNS guide: `DnsGuideConfig` (`src/shared/ipc-types.ts:438`) +
`lib/dns.ts` `computeDnsRecordName` produce the exact A-record (name/value/TTL) and registrar steps
the user must type **by hand**. The agent even passes the server's public IP so the guide is fully
specified — it just can't create the record.

**Why it matters:** the single biggest friction in the domain flow is the human copy-pasting into
their registrar and waiting for propagation. A DNS-provider integration (start with Cloudflare token
auth, reuse the `secrets.ts` storage pattern) to auto-create the record — and then verify propagation
and proceed straight to TLS without a manual pause — is textbook "friction worth productizing."

**Sketch:** design a DNS-provider interface (create/verify A record), start with Cloudflare, let the
domain form auto-apply instead of only instructing. Opt-in per provider.

**Also weighed, lower leverage:** surfacing Docker `HEALTHCHECK` state + restart/crash-loop counts in
the Artifacts UI (fold into FEAT-06/07 observability work); a cross-server secrets vault with rotation
(env editing is per-deployment only today, `deployments.ts:331` — real but a larger, later spike).

---

## § 2 — Security hardening (ship-blockers for a privileged remote tool)

Positive controls first, so the findings read as the exceptions: SSH secrets and API keys are
encrypted via `safeStorage` and never cross IPC to the renderer (`src/main/secrets.ts`), private keys
stay in main behind a `keyRef`, GitHub tokens are redacted from surfaced errors (`github.ts:635`),
the Telegram token flows main→server and never enters the model, `shell.openExternal`/window-open are
correctly constrained (`src/main.ts:93`), and Electron fuses are hardened (`forge.config.ts:67` —
`RunAsNode:false`, ASAR integrity on). The items below are the gaps.

### [SEC-01] SSH connections perform no host-key verification · Effort M · Risk MED · Confidence HIGH

`src/main/connection-manager.ts:67` `buildConfig` builds the ssh2 connect config with no
`hostVerifier`/`hostHash` callback and no known-hosts store — for `testConnection`, `connect`, and
therefore every agent, monitor, terminal, GitHub, and deploy operation. ssh2 does **not** verify the
server's host key unless a `hostVerifier` is supplied.

**Impact:** the app authenticates to — and sends the user's SSH password or key auth to — *any* host
answering on the configured address, with no MITM detection and no trust-on-first-use pinning. For a
tool whose entire purpose is privileged remote administration, an on-path attacker can impersonate a
managed server and capture credentials.

**Fix sketch:** implement a `hostVerifier` that checks the presented key against a persisted
known-hosts store, prompts the user on first connect (TOFU), and hard-fails on a changed key.

### [SEC-02] DB credentials persist in plaintext chat history and sync to Google Drive · Effort M · Risk MED · Confidence HIGH

The system prompt instructs the model to print credentials to the user (`src/agent/agent.ts:240`,
"exact URLs / connection strings / credentials they need to copy"). Assistant text is stored as
`ChatSession.items` in the plaintext store (`src/main/store.ts:233`, `JSON.stringify` →
`easyhost.json`). That file is then uploaded to Google Drive with only the `googleDrive` key stripped
(`src/main/googleDriveSync.ts:485` `readStoreData`, verified — deletes only `parsed.googleDrive`).

**Impact:** every database password / connection string the agent surfaces is retained in cleartext
in `easyhost.json` and copied into the Drive `appDataFolder` backup. The "passwords live encrypted"
guarantee (`store.ts` secrets are `safeStorage`-encrypted) does **not** extend to the transcript copy
of the same secret.

**Fix sketch:** keep credentials out of persisted transcript items (reference a saved credential id
rather than the value), or encrypt chat `items` at rest and scrub them from the Drive snapshot.

### [SEC-03] "Masked" agent-form secrets are transmitted to the AI provider · Effort L · Risk MED · Confidence HIGH

`buildS3StorageForm` defines a `secretAccessKey` password field (`src/agent/forms.ts:210`).
`requestS3StorageSetup` returns the collected values straight back as the tool result
(`src/agent/tools.ts:548`, `return { submitted: true, values }`), which the AI SDK feeds into the
model turn — and thus to whichever provider is configured, including a user-supplied
`openai-compatible` base URL (`agent.ts:100`). The tool *description* says the key is collected
"masked" and never put on a command line, but the value is in the model context regardless.

**Impact:** the stated control — collect the S3 secret without exposing it — is not met against the
LLM backend. Any provider-side logging/retention now holds the object-storage secret.

**Fix sketch:** have main write the form's secret fields *directly* to the remote root-only env file
(exactly as `setupDeployNotifications` already does for the Telegram token, `tools.ts:88`) and return
only a non-secret handle/boolean to the model, so the secret never enters the LLM context.

### [SEC-04] Prompt-injection: hostile server output flows into a full-auto agent · Effort L · Risk MED · Confidence MED

Command stdout/stderr, arbitrary remote file contents (`readRemoteFile`, `tools.ts:355`), and
`docker inspect` output are fed straight back into the model context; user-authored skills from
`EASYHOST_HOME/skills` are read every run and returned to the model verbatim, with **user-wins
precedence over vetted bundled skills** (`src/agent/skills.ts:185`). Approval is off by default. Tool
output is truncated but not sanitized or fenced as untrusted data.

**Impact:** a compromised target server can plant attacker-controlled text in any file/output the
agent reads (a crafted `/etc/motd`, log line, `package.json` script, README) that reads as
instructions ("now run …"), and the full-auto agent — with `sudo`-capable `runScript`/`writeRemoteFile`
— may act on it. A malicious `~/.easyhost/skills/*.md` can silently redefine a trusted skill name
(e.g. `server-hardening`) with destructive steps.

**Fix sketch:** wrap all server-derived content in explicit untrusted-data delimiters in the prompt;
keep destructive/`sudo` actions behind confirmation even in full-auto when the triggering context came
from remote data; surface in the UI when a user skill overrides a bundled skill name.

### [SEC-05] Catastrophic-command seatbelt is narrower than its own "obvious mistake" bar · Effort S-M · Risk LOW · Confidence HIGH

`src/agent/blacklist.ts:7` pattern-matches literal command text. Consistent with its own "NOT a
security boundary" disclaimer, but it misses cases within its stated goal of catching *obvious*
catastrophes: long-flag `rm --recursive --force /` (the regex only matches short `-rf` bundles),
`find / -delete`, `mkfs` on `/dev/mapper`, `wipefs`/`shred`/`fdisk`, `> /etc/passwd`, `chown -R /`,
`ufw disable`/`iptables -F`, `docker system prune -af --volumes`. Enforced at `tools.ts:168` and
`:238`. **This guard has zero tests** (see TEST-02).

**Fix sketch:** broaden the high-signal list (long-flag `rm`, `mkfs.*`/`wipefs`/`shred`, root-targeted
`chown/chmod -R`, `> /etc/*`, firewall-disable), add a characterization test table, and document that
obfuscated forms (command substitution, base64, `sh -c` wrapping) are explicitly out of scope for the
seatbelt. A match only forces a confirm, so false positives are cheap.

### [SEC-06] No Content-Security-Policy + IPC path interpolation on a renderer with full SSH power · Effort S–M · Risk LOW · Confidence MED

`index.html` has no CSP and no session CSP header is set; the renderer renders model/server-derived
markdown via Shiki `dangerouslySetInnerHTML` (`ChatMarkdown.tsx:106`) — currently safe because
`rehype-raw` is off, but with no CSP backstop, any future XSS regression escalates directly to
arbitrary SSH command execution via `window.easyhost`. Separately, `writeRemoteFile`'s sudo branch
single-quote-interpolates a model-controlled `path` into a `sudo mv`/`chmod` shell string
(`tools.ts:395`) — a `path` containing a single quote breaks the quoting. (Deploy-tab paths *are*
soundly validated via `deployments.isSafeRemotePath`, `deployments.ts:291`.)

**Fix sketch:** add a restrictive CSP for the packaged app (`default-src 'self'`, no remote script),
pin `sandbox: true` explicitly on the window, and validate/normalize `path` in `writeRemoteFile`
(reject shell-metacharacters or pass via argv/heredoc rather than interpolation).

### [SEC-07] Rotate the working-tree Google OAuth client secret · Effort S · Risk LOW · Confidence HIGH

`.env` holds a non-placeholder Google OAuth client id + secret (Google Drive sync). **Good news,
correcting the brief:** the file is gitignored and **not** in git history (`git log --all -- .env`
empty) and is not packaged (`forge.config.ts` ships only `resources/`) — blast radius is local
working-tree access only, not the public repo. For a Google "Desktop app" client the secret isn't
truly confidential and the flow already uses PKCE, but any value shared for audit should be treated as
burned.

**Fix sketch:** rotate the secret in Google Cloud Console, keep it only in a developer-local file that
never travels with the repo, and confirm the PKCE flow works without an embedded client secret.

*(Minor, noted not planned: Codex `respondPage` interpolates title/body into HTML unescaped —
`codexAuth.ts:147` — currently only app-constant strings; keep it escaped to match the Drive helper.)*

---

## § 3 — Correctness (production-server safety)

### [CORE-01] "Stop" does not kill the in-flight remote command · Effort M · Risk MED · Confidence HIGH

`abort.signal` is passed only to `agent.stream(...)` (`src/agent/agent.ts:401`). The tool `execute`
functions never receive or check an abort signal (`src/agent/tools.ts:160`, `runCommand`; `:226`,
`runScript`), and the ssh2 exec channel is closed only by its own timeout timer, never by
cancellation. `cancelAgentRun` (`agent.ts:494`) aborts the SDK loop but the already-running tool
promise keeps awaiting `cm.exec`.

**Impact:** a user hitting **Stop** on a run that is mid-`apt upgrade`, `docker pull`, migration, or
`rm` leaves that command running to completion (up to the 900 s tool timeout) on a production server,
with no channel close and no SIGINT sent. The UI says "cancelled" while the server keeps mutating.
This is the most dangerous gap for a tool whose purpose is executing commands on prod.

**Fix sketch:** give each run's `toolContext` the `abort.signal`; thread it into `cm.exec` → `execNow`;
on abort call `channel.close()` (or `channel.signal('INT')`) and reject, mirroring the existing timeout
path.

### [CORE-02] A corrupt store silently wipes all servers, settings and credential metadata · Effort S · Risk LOW · Confidence HIGH

`read()` wraps the entire parse in `try/catch` and on *any* failure returns `EMPTY`
(`src/main/store.ts:69`, verified — the catch returns an all-empty store). The next mutation writes
that empty object over `easyhost.json`. The atomic temp-file+rename protects only against a crash
*during* write, not against reading back a file corrupted otherwise (disk-full mid-write from another
process, power loss, a bad Google-Drive restore via `restoreStoreData`).

**Impact:** if `easyhost.json` is ever truncated/corrupted, the app silently boots with zero
servers/projects/DB-credential-metadata, and the first settings toggle or chat save permanently
overwrites the recoverable file with empty data. No backup, no user-visible error.

**Fix sketch:** on parse failure, rename the bad file to `easyhost.json.corrupt-<ts>` and surface an
error instead of returning `EMPTY`; keep one prior-good backup and refuse to overwrite a non-empty
store with an all-empty one.

### [CORE-03] Monitoring polls head-of-line-block behind long agent commands · Effort M · Risk MED · Confidence HIGH

`ConnectionManager.exec` serializes *all* execs per server onto one `execQueue`
(`connection-manager.ts:195`). Agent commands run with `timeoutMs` up to 900 s; `monitor.ts:200` uses
the same `cm.exec`, and its timeout timer only starts *after* dequeue — so a queued monitor poll has
no timeout while it waits.

**Impact:** while the agent runs a long command, every monitoring poll sits queued behind it — live
CPU/mem/disk charts freeze for up to 900 s, `getServerStats` returns stale data, and the alert engine
can miss or misfire during exactly the window a heavy operation is most likely to stress the box.

**Fix sketch:** give monitoring its own concurrency budget or a dedicated exec lane (bounded by
OpenSSH `MaxSessions`) so a long command can't starve the poller; start the exec timeout when queued.

### [CORE-04] Cancelling mid-approval leaks the pending resolver (and suspends the tool forever) · Effort S · Risk LOW · Confidence MED

`requestApproval`/`requestForm` register a resolver in `pendingApprovals`/`pendingForms` and return a
Promise (`src/main/ipc.ts:418`). `agentCancel` (`ipc.ts:538`) only calls `cancelAgentRun` — it never
resolves/clears the pending maps, which drain only on navigation/window-close. The awaiting tool
`execute` is suspended on a Promise that is now never resolved.

**Impact:** cancelling (or a stream error) while the agent is blocked awaiting an approval or form
leaks the resolver permanently and leaves a suspended async tool frame alive for the app's lifetime;
the renderer's approval/form card is left dangling. Accumulates across a session.

**Fix sketch:** track a run's outstanding approval/form ids and, in `cancelAgentRun`/on error, resolve
them (denied/null) and delete the map entries.

### [CORE-05] Monitor pollers survive SSH drops and ignore interval changes · Effort S · Risk LOW · Confidence HIGH

`monitor.start` no-ops if a state exists (`src/main/monitor.ts:193`), so a changed `pollIntervalMs`
never reconfigures a running poller. On an *unexpected* connection `close`
(`connection-manager.ts:146`) nothing calls `monitor.stop`; the `setInterval` fires forever, each
tick short-circuiting on `getStatus !== 'connected'`.

**Impact:** after a network drop the interval spins indefinitely until the user explicitly
disconnects; lowering the polling interval in Settings has no effect on open monitors until restart.

**Fix sketch:** restart the interval on interval-change; stop/reset the poller from the
connection-manager `close` path.

### [CORE-06] `/tmp` staging files leak on timeout/disconnect · Effort S · Risk LOW · Confidence MED

`runScript` writes `/tmp/easyhost-script-*.sh` and relies on `rm -f` chained *inside the same exec*
(`src/agent/tools.ts:254`); sudo `writeRemoteFile` stages content in `/tmp/easyhost-*` cleaned only by
the `sudo mv` in the same exec (`tools.ts:390`). If the exec times out or the connection drops, the
file — which may hold sensitive config staged for a root-owned destination — remains.

**Fix sketch:** clean up in a `finally` (best-effort `rm -f`) rather than an in-band chain that may
never run.

### [CORE-07] Concurrent runs against one server have no logical mutual exclusion · Effort M · Risk MED · Confidence MED

Several chat sessions (and wizard runs) can run at once (`src/lib/chatRunManager.ts:82`), all sharing
one `cm`/server. The per-server `execQueue` serializes individual *commands*, not logical
*operations*. Two simultaneous runs editing the same server interleave at command granularity — both
rewriting `nginx.conf`, both touching package state — with one run's backup/validation racing the
other's edits.

**Fix sketch:** add an advisory per-server "a run is operating here" lock (or serialize runs per
server), warning when a second run targets a server already in use.

---

## § 4 — Production-readiness (release engineering, testing, DX)

### [REL-01] No code signing / notarization, and no release automation · Effort L · Risk MED · Confidence HIGH

`forge.config.ts` `packagerConfig` has no `osxSign`/`osxNotarize` and no Windows signing; the only
match for "sign" is a comment (`forge.config.ts:66`). `.github/workflows/ci.yml` runs
lint→typecheck→test→build but has **no `make`/`publish` job, no release trigger, no artifact upload**.
`package.json` has a `publish` script nothing invokes.

**Impact:** unsigned/un-notarized macOS builds are blocked by Gatekeeper ("app is damaged"), Windows
SmartScreen warns on every install — a hard blocker for shipping to real users — and there is no
automated path from green CI to a distributable artifact.

**Fix sketch:** add Apple `osxSign`+`osxNotarize` and a Windows signer to `forge.config.ts`, a
publisher, and a tag-triggered CI release job that signs and uploads artifacts.

### [REL-02] No auto-update mechanism for the packaged app · Effort M · Risk MED · Confidence HIGH

No `autoUpdater`/`update-electron-app`/`electron-updater`/`feedURL` anywhere in `src/`. `forge.config.ts`
declares makers but no update feed; version is hardcoded `1.0.0`.

**Impact:** once shipped, users are frozen on whatever version they installed — no way to push fixes to
the SSH/agent seatbelt (SEC-05) or a security patch. An un-updatable client that runs an autonomous
agent against production servers is a serious operational liability.

**Fix sketch:** wire `autoUpdater` against a release feed (GitHub Releases or Squirrel/S3) + an in-app
"update available/restart" flow. Gated on REL-01 (signing).

### [REL-03] No global crash handling or structured logging — production crashes vanish · Effort M · Risk LOW · Confidence HIGH

No `uncaughtException`/`unhandledRejection`/`crashReporter` anywhere in `src/`. Logging is ~11
scattered `console.warn`/`console.error` with no log file, no correlation IDs, no severity structure.

**Impact:** in a packaged build, `console.*` is invisible (no attached terminal) and an unhandled
rejection terminates/hangs the app with nothing captured. Diagnosing a shipped user's crash requires a
code change and rebuild.

**Fix sketch:** install `process.on('uncaughtException'/'unhandledRejection')` early in `src/main.ts`,
add a rotating file logger writing to `userData/logs`, route existing `console.*` through it, and
optionally wire a crash-report sink.

### [TEST-01] SSH lifecycle, the command seatbelt, and the IPC boundary have zero tests · Effort M–L · Risk LOW · Confidence HIGH

Highest-blast-radius modules are untested: `connection-manager.ts` (402 lines, the SSH core every
operation flows through — no test file), `blacklist.ts` (the last line of defense before a full-auto
agent runs a destructive command — no test file; `isCatastrophic` is never referenced in any
`.test.ts`), and `ipc.ts` (866 lines, the entire renderer↔main trust boundary) + `monitor.ts`.

**Impact:** a refactor that breaks `isCatastrophic` or the gate at `tools.ts:169` would silently let
`rm -rf /` execute without confirmation and no test would catch it. Connection leaks, missing teardown
on error, and monitor timer leaks all ship undetected.

**Fix sketch (do the seatbelt first — it's S and it's the safety net):**
- `blacklist.test.ts`: a table asserting each pattern matches representative dangerous strings and
  rejects benign near-misses; a `tools.test.ts` case proving the `cat.blocked || ctx.approvalMode`
  branch forces confirmation for a blocked command even in full-auto.
- `connection-manager.test.ts`: characterization tests against a mocked `ssh2.Client` — connect
  success/failure, no pooled-entry leak on failed connect, teardown removes listeners.
- `monitor.test.ts`: timers cleared on stop/disconnect.

### [DX-01] Toolchain & dependency hygiene · Effort S–M · Confidence HIGH

- **ESLint 8 is end-of-life** (`package.json`, `"eslint": "^8.57.1"`; v8 EOL Oct 2024) on a required
  CI gate, with legacy `.eslintrc.json`. Migrate to ESLint 9 flat config (`eslint.config.js`), verify
  rule parity. *Effort M.*
- **`shadcn` (the scaffolding CLI) is a runtime `dependency` but never imported** at runtime — move to
  `devDependencies` to shrink the shipped `asar`. *Effort S.*
- **No dependency-update automation** (no `dependabot.yml`/`renovate.json`) on an app pinned to
  `electron@43.0.0`, `ssh2@^1.17`, `ai@^7` — security patches must be tracked by hand. Add Dependabot
  scoped to the security-relevant deps. *Effort S.*

### [DEBT-01] Larger structural debt (schedule deliberately, not urgently) · Confidence HIGH

- **`strictNullChecks` is off repo-wide** (`tsconfig.json` sets only `noImplicitAny`), compensated by
  ~199 `as`/`!` escape hatches — the compiler enforces no null-safety on the SSH/store/agent data
  flows where a missed null crashes main. Enable `strictNullChecks` then full `strict`, module-by-module
  starting with `main/` and `agent/`. *Effort L.*
- **`ipc.ts` is a god module** mixing transport wiring with domain logic (the DB-credential auto-save
  state machine `ipc.ts:335`, playbook seeding `ipc.ts:459`, provider resolution `ipc.ts:501` all live
  inline in `agentStart`). Extract an `AgentRunCoordinator`. *Effort M.*
- **Pervasive micro-duplication**: `err instanceof Error ? err.message : String(err)` (~40×) and
  ad-hoc `${prefix}_${Date.now()}_${n}` id generation (~10 sites, divergent schemes). Add
  `toErrorMessage(err)` + a single `genId(prefix)` util and codemod. *Effort S.*

---

## Recommended sequencing

| Wave | Items | Rationale |
|------|-------|-----------|
| **0 — safety net** | CORE-01, CORE-02, TEST-01 (seatbelt tests) | Small, protect data & prod servers; unblock risky work |
| **1 — security** | SEC-01, SEC-02, SEC-03, SEC-05 | Highest-leverage, mostly contained fixes |
| **2 — flagship features** | FEAT-01, FEAT-02, FEAT-05, FEAT-06 | Cheap given existing plumbing; visible product wins |
| **3 — release-ready** | REL-01, REL-02, REL-03, DX-01 | Required before first external release |
| **4 — depth** | FEAT-03, FEAT-04, FEAT-07/08/09, SEC-04/06, CORE-03/07, DEBT-01 | Bigger design/spike work; schedule deliberately |

## What was NOT audited

- **Renderer UI/UX and design-system conformance** — out of scope for this DevOps/production-readiness
  pass (the app already has a documented design system in `AGENTS.md`).
- **`.env` secret values** — referenced by type and location only, never read or reproduced.
- **Runtime behavior against a live server** — this was a static read-only survey; the "Stop doesn't
  stop" (CORE-01) and monitor-starvation (CORE-03) findings are code-verified but not reproduced live.
- **The three sibling repos** (`FCode`, `EASY-HOST`, `cmux-main`) — this pass was scoped to
  `Tevada DevOps` only, per your instruction.
